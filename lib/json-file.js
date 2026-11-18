/**
 * 小 JSON 状态文件的读法统一（审计 2）：区分「不存在」与「存在但解析失败」。
 *
 * 旧写法 `try { JSON.parse(readFile) } catch { return 默认值 }` 把损坏当成不存在：下一次 save 就用默认值
 * 覆盖掉坏文件，凭据类文件（sync.json / 凭据暂存）里能救回来的内容随之消失，且无人察觉。
 *
 * 这里的口径：
 *   - missing：文件不存在 → 调用方按默认值起步（全新安装）；
 *   - ok：解析成功；
 *   - corrupt：原文件**原地保留**，另复制一份 `<file>.corrupt-<时间>` 留档（同一份坏内容只留一次），
 *     返回 corrupt 信息；调用方必须报错 / 拒绝覆盖写，不许静默回默认值。
 *
 * 留档是复制不是改名：原文件留在原位，后续每次读都还是 corrupt，写入一直被拒，直到有人修好或删掉它。
 */
import fs from "node:fs";
import { copyFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { atomicTmpName } from "./fs-atomic.js";

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");
const fingerprint = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

/** 解析失败的文件。 */
export class CorruptFileError extends Error {
	/** @param {string} file @param {{archivedTo: string|null, error: string, fingerprint: string}} info */
	constructor(file, info) {
		super(`${basename(file)} 无法解析（${info.error}）：原文件已原地保留${info.archivedTo ? "，留档 " + info.archivedTo : ""}；修好或删除该文件前拒绝覆盖写入`);
		this.name = "CorruptFileError";
		this.code = "STATE_FILE_CORRUPT";
		this.statusCode = 409;
		this.file = file;
		this.info = info;
	}
}

function parse(text, validate) {
	const value = JSON.parse(text.replace(/^﻿/, ""));
	if (typeof validate === "function") {
		const problem = validate(value);
		if (typeof problem === "string" && problem !== "") throw new Error(problem);
	}
	return value;
}

const archiveName = (file, fp) => `${basename(file)}.corrupt-${stamp()}-${fp}`;
const alreadyArchived = (names, file, fp) => names.some((n) => n.startsWith(basename(file) + ".corrupt-") && n.endsWith("-" + fp));

function warnOnce(logger, file, info) {
	const message = `[dsh-studio] ⚠ ${basename(file)} 无法解析（${info.error}），原文件保留不覆盖；留档：${info.archivedTo ?? "失败"}`;
	try {
		(logger?.error ?? console.error).call(logger ?? console, message);
	} catch {
		/* ignore */
	}
}

/**
 * @param {string} file
 * @param {{validate?: (v: unknown) => string|undefined, logger?: object}} [options]
 * @returns {Promise<{status: "missing"} | {status: "ok", value: any} | {status: "corrupt", archivedTo: string|null, error: string, fingerprint: string}>}
 */
export async function readJsonState(file, options = {}) {
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { status: "missing" };
		throw error;
	}
	try {
		return { status: "ok", value: parse(text, options.validate) };
	} catch (error) {
		const fp = fingerprint(text);
		let archivedTo = null;
		try {
			const names = await readdir(dirname(file)).catch(() => []);
			const existing = names.find((n) => n.startsWith(basename(file) + ".corrupt-") && n.endsWith("-" + fp));
			if (existing !== undefined) archivedTo = join(dirname(file), existing);
			else {
				archivedTo = join(dirname(file), archiveName(file, fp));
				await copyFile(file, archivedTo);
				warnOnce(options.logger, file, { error: error.message, archivedTo });
			}
		} catch {
			archivedTo = null;
		}
		return { status: "corrupt", archivedTo, error: error instanceof Error ? error.message : String(error), fingerprint: fp };
	}
}

/** readJsonState 的同步版（darwin 的状态文件走同步 fs）。 */
export function readJsonStateSync(file, options = {}) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { status: "missing" };
		throw error;
	}
	try {
		return { status: "ok", value: parse(text, options.validate) };
	} catch (error) {
		const fp = fingerprint(text);
		let archivedTo = null;
		try {
			let names = [];
			try {
				names = fs.readdirSync(dirname(file));
			} catch {
				names = [];
			}
			if (alreadyArchived(names, file, fp)) archivedTo = join(dirname(file), names.find((n) => n.startsWith(basename(file) + ".corrupt-") && n.endsWith("-" + fp)));
			else {
				archivedTo = join(dirname(file), archiveName(file, fp));
				fs.copyFileSync(file, archivedTo);
				warnOnce(options.logger, file, { error: error.message, archivedTo });
			}
		} catch {
			archivedTo = null;
		}
		return { status: "corrupt", archivedTo, error: error instanceof Error ? error.message : String(error), fingerprint: fp };
	}
}

const SYNC_RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 同步原子写（darwin 用）：同目录 tmp + rename。
 * Windows 上改名被短暂占用时只重试改名（约 1 秒），不删目标——见 fs-atomic.js 的 renameOver。
 * @param {{rename?: typeof fs.renameSync, platform?: string}} [deps] 测试注入
 */
export function atomicWriteFileSync(file, data, options, deps = {}) {
	const renameSync = deps.rename ?? fs.renameSync;
	const platform = deps.platform ?? process.platform;
	fs.mkdirSync(dirname(file), { recursive: true });
	const tmp = atomicTmpName(file);
	try {
		fs.writeFileSync(tmp, data, options);
		let delay = 20;
		const deadline = Date.now() + 1000;
		for (;;) {
			try {
				renameSync(tmp, file);
				break;
			} catch (error) {
				if (platform !== "win32" || !SYNC_RETRYABLE.has(error?.code) || Date.now() >= deadline) throw error;
				sleepSync(delay);
				delay = Math.min(delay * 2, 200);
			}
		}
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		throw error;
	}
}

export const isObjectJson = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? undefined : "顶层不是 JSON 对象");
