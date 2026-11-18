/**
 * 同目录写临时文件再改名，避免写到一半进程挂了留下半份 SKILL.md。
 *
 * 借鉴 npm/write-file-atomic 的「先写 tmp 再 rename」和
 * isaacs/node-graceful-fs 在 Windows 上对 EPERM/EACCES/EBUSY 的短回退重试
 *（杀毒软件会短时间锁住刚写入的文件）。重试只重试改名，不删目标（见 renameOver）。
 * 来源：https://github.com/npm/write-file-atomic
 *      https://github.com/isaacs/node-graceful-fs/blob/master/polyfills.js
 *
 * 不引入依赖。临时文件写在目标同目录，失败会清掉临时文件。
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * 符号链接 → 它最终指向的路径（悬空链接也照着链走到底：普通 writeFile 会在那里新建文件）；
 * 不是链接 / 不存在 → 原样返回。最多跟 40 层，防环。
 */
async function followSymlink(file) {
	let current = file;
	for (let hop = 0; hop < 40; hop += 1) {
		let info;
		try {
			info = await lstat(current);
		} catch {
			return current;
		}
		if (!info.isSymbolicLink()) return current;
		try {
			return await realpath(current);
		} catch {
			current = resolve(dirname(current), await readlink(current));
		}
	}
	return current;
}

const WINDOWS_RETRY_MS = 2000;
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 原子写的临时文件名：`.<目标名>.<pid>.<毫秒>.<随机>.tmp`。
 * 快照 / 备份按 ATOMIC_TMP_RE 把它们排除在包外（崩在 writeFile 与 rename 之间会留下一份，凭据文件的残留就是明文）。
 */
export function atomicTmpName(file) {
	return join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
}

/** 匹配 atomicTmpName 产出的文件名（含旧格式：没有随机段）。只看 basename。 */
export const ATOMIC_TMP_RE = /^\..+\.\d+\.\d+(?:\.[0-9a-f]{8})?\.tmp$/;

/**
 * 把 tmp 改到 dest。
 *
 * Windows 上目标被短暂占用（杀毒 / 索引 / 另一个读者）时 rename 会报 EPERM / EACCES / EBUSY，
 * 这里只**重试改名**，最多约 2 秒，绝不先删目标：Node 的 rename 在 Windows 上本来就是覆盖语义
 *（MoveFileEx + REPLACE_EXISTING），「先删后改名」在改名持续失败时会把旧文件也弄没——
 * mcp.json / SKILL.md / versions.jsonl 都走这里，那等于把唯一一份真数据删掉。
 * 重试到期仍失败：抛错，目标保持原样（旧内容还在）。
 * @param {{rename?: typeof rename, platform?: string}} [deps] 测试注入
 */
export async function renameOver(tmp, dest, deps = {}) {
	const doRename = deps.rename ?? rename;
	const platform = deps.platform ?? process.platform;
	try {
		await doRename(tmp, dest);
		return;
	} catch (error) {
		if (platform !== "win32" || !RETRYABLE.has(error?.code)) throw error;
	}
	const deadline = Date.now() + (deps.retryMs ?? WINDOWS_RETRY_MS);
	let delay = 20;
	let lastError;
	while (Date.now() < deadline) {
		await sleep(delay);
		delay = Math.min(delay * 2, 200);
		try {
			await doRename(tmp, dest);
			return;
		} catch (error) {
			lastError = error;
			if (!RETRYABLE.has(error?.code)) throw error;
		}
	}
	throw lastError ?? new Error("atomic rename timed out: " + dest);
}

/**
 * 把 data 原子写入 file（utf8 字符串或 Buffer）。失败时目标文件保持写之前的样子。
 * @param {string} file
 * @param {string | Uint8Array} data
 * @param {import("node:fs").WriteFileOptions} [options]
 */
export async function atomicWriteFile(file, data, options) {
	// C3：目标是符号链接时写到链接指向的真实文件上（与普通 writeFile 的语义一致）。以前临时文件改名
	// 改在链接本身的位置，链接被换成一个普通文件，链接目标从此不再更新（技能库里 SKILL.md 链到别处的写法就此断开）。
	file = await followSymlink(file);
	await mkdir(dirname(file), { recursive: true });
	const tmp = atomicTmpName(file);
	try {
		await writeFile(tmp, data, options);
		await renameOver(tmp, file);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}
