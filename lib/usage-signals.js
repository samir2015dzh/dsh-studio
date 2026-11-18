/**
 * 真实使用信号（N-03）：把「技能被真实加载进会话」从 DSH 会话日志里采出来，
 * 写进 lifecycle 状态，替代「只数写路径」的失真信号。
 *
 * 口径（与 extractor.findSessionFiles / readSessionLog 同一套解析，不另立格式）：
 *   - 加载事件 = 类型 `tool/call`、`data.name === "skill"`、`data.arguments` 里带 `name`
 *     的记录。DSH 的 skill 加载只有这一种可观测形态：模型调用 `skill` 工具取全文。
 *   - 事件时间 = 该记录的 `time`（会话日志 envelope 的毫秒时间戳）。
 *   - 消息正文里出现技能名（`agent/inbox/spliced` 等）**不算**加载事件。
 *   - 计数单位 = 会话：同一会话内同一技能重复加载只计一次。
 *
 * 增量与幂等：
 *   - 水位线 `~/.dsh/dsh-studio/usage-signals.json`：会话 id → 文件指纹，已见会话不再计。
 *   - lifecycle 状态里每个技能另存 `loadSessions`（已计入的会话 id 集合），
 *     `useCount` 就读它的长度。水位线丢失也不会二次计数 —— 重放是幂等的。
 *   - 全程 best-effort：日志坏行/坏文件只跳过；任何异常都转成返回值，绝不冒泡。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { recordSkillLoads } from "./lifecycle.js";
import { withFileLock } from "./state-lock.js";

export const USAGE_SIGNAL_VERSION = 1;
/** 水位线保留的会话条数上限；超出的按处理时间丢最旧（丢掉的会话靠 loadSessions 去重兜底）。 */
export const MAX_WATERMARK_SESSIONS = 2000;

/** 水位线文件（与 skill-lifecycle.json 同目录）。 */
export function usageSignalsPath() {
	return resolve(homedir(), ".dsh", "dsh-studio", "usage-signals.json");
}

export async function loadWatermark() {
	const empty = { version: USAGE_SIGNAL_VERSION, updatedAt: 0, sessions: {} };
	try {
		const parsed = JSON.parse(await readFile(usageSignalsPath(), "utf8"));
		const sessions = parsed && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions) ? parsed.sessions : {};
		return { version: USAGE_SIGNAL_VERSION, updatedAt: Number.isFinite(parsed?.updatedAt) ? parsed.updatedAt : 0, sessions };
	} catch {
		return empty;
	}
}

export async function saveWatermark(mark) {
	const file = usageSignalsPath();
	await mkdir(dirname(file), { recursive: true });
	// tmp + rename：写一半崩掉不会留下坏 JSON
	const tmp = file + ".tmp";
	await writeFile(tmp, JSON.stringify(mark, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	await rename(tmp, file);
	return mark;
}

/** 会话键：优先日志里的 session id，缺失时回落到文件路径。 */
export function sessionKeyOf(entry) {
	const id = entry?.log?.session?.id;
	if (typeof id === "string" && id !== "") return id;
	const file = entry?.file;
	return typeof file === "string" && file !== "" ? "file:" + file : "";
}

/** 文件指纹：内容变了（同 id 续写）也能看出来。 */
export function fingerprintOf(entry) {
	return `${Math.round(Number(entry?.mtime) || 0)}:${Number(entry?.size) || 0}`;
}

function trimWatermark(mark) {
	const keys = Object.keys(mark.sessions);
	if (keys.length <= MAX_WATERMARK_SESSIONS) return;
	keys.sort((a, b) => (mark.sessions[a]?.processedAt ?? 0) - (mark.sessions[b]?.processedAt ?? 0));
	for (const key of keys.slice(0, keys.length - MAX_WATERMARK_SESSIONS)) delete mark.sessions[key];
}

/**
 * 消费一轮会话日志解析结果，落加载信号。
 * @param {Array<{file:string, mtime:number, size?:number, log?:{session?:object, skillLoads?:Array}}>} entries
 * @returns {Promise<{ok:boolean, sessions:number, newSessions:number, loads:number, applied:number, error:string}>}
 */
export async function ingestUsageSignals(entries, { now = Date.now() } = {}) {
	let sessions = 0;
	let newSessions = 0;
	let loads = 0;
	let applied = 0;
	try {
		if (!Array.isArray(entries) || entries.length === 0) return { ok: true, sessions, newSessions, loads, applied, error: "" };
		const mark = await loadWatermark();
		const batch = [];
		const fresh = [];
		for (const entry of entries) {
			const list = Array.isArray(entry?.log?.skillLoads) ? entry.log.skillLoads : [];
			if (list.length === 0) continue;
			sessions += 1;
			const key = sessionKeyOf(entry);
			// 已处理且文件指纹没变才跳过。只按「见没见过」跳的话，会话第一次出现技能加载就被记上水位线、此后再也不看——
			// 逐轮提取在会话进行中就会跑，同一个会话后来加载的技能（以及隔天续写的会话）全都漏计，闲置判定因此偏早。
			// 重放是安全的：recordSkillLoads 对 (技能, 会话) 幂等。
			if (key === "") continue;
			if (Object.hasOwn(mark.sessions, key) && mark.sessions[key]?.fingerprint === fingerprintOf(entry)) continue;
			// 会话内去重：同一技能只留最大事件时间，与文件内事件顺序无关
			const latest = new Map();
			for (const item of list) {
				const name = typeof item?.name === "string" ? item.name.trim() : "";
				if (name === "") continue;
				const at = Number.isFinite(item?.at) ? item.at : entry.mtime;
				const prev = latest.get(name);
				if (prev === undefined || at > prev) latest.set(name, at);
			}
			if (latest.size === 0) continue;
			fresh.push({ key, fingerprint: fingerprintOf(entry) });
			for (const [name, at] of latest) batch.push({ name, sessionId: key, at });
		}
		if (fresh.length === 0) return { ok: true, sessions, newSessions, loads, applied, error: "" };
		newSessions = fresh.length;
		loads = batch.length;
		// N-06：recordSkillLoads 写的是另一个状态文件（skill-lifecycle.json），有自己的锁，
		// 留在水位线锁之外；水位线周期只包它自己的 load → 合并 → save。
		applied = await recordSkillLoads(batch, { now });
		// 水位线在状态写成功之后推进；即使这步失败，loadSessions 去重也能兜住重放
		await withFileLock(usageSignalsPath(), async () => {
			// 进锁后重新 load：并发周期各自算出的 fresh 在这里合并，谁都不丢
			const mark2 = await loadWatermark();
			for (const item of fresh) mark2.sessions[item.key] = { fingerprint: item.fingerprint, processedAt: now };
			mark2.version = USAGE_SIGNAL_VERSION;
			mark2.updatedAt = now;
			trimWatermark(mark2);
			await saveWatermark(mark2);
		});
		return { ok: true, sessions, newSessions, loads, applied, error: "" };
	} catch (error) {
		return { ok: false, sessions, newSessions, loads, applied, error: String(error?.message ?? error) };
	}
}
