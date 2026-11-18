/**
 * 版本史的落盘位置与日志合并。
 *
 * 版本史**刻意不放在 `~/.dsh` 里**：2026-11-08 `.dsh` 被整个清空过，状态目录陪葬的
 * 东西不能再包括「能把状态找回来」的那份历史。默认落在与 `.dsh` 平级的
 * `~/.dsh-studio/history/`，可用环境变量 `DSH_STUDIO_HISTORY_DIR` 改到别处（例如 D 盘）。
 *
 * 只放本机：这里没有任何 git remote / 推送逻辑；出机只走既有快照（快照把本目录挂在
 * `dsh-studio-history/` 前缀下，随每日备份与 WebDAV 一起走）。
 *
 * 本文件不 import snapshot.js / versions.js，两者都从这里取路径，避免循环依赖。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 版本日志文件名（append-only JSONL，一行一条版本记录）。 */
export const HISTORY_LOG = "versions.jsonl";
/** 内容寻址的对象目录（sha256 → gzip 后的原始字节）。 */
export const HISTORY_OBJECTS = "objects";

/** 版本史根目录。 */
export function historyRoot() {
	const override = typeof process.env.DSH_STUDIO_HISTORY_DIR === "string" ? process.env.DSH_STUDIO_HISTORY_DIR.trim() : "";
	if (override !== "") return resolve(override);
	return resolve(homedir(), ".dsh-studio", "history");
}

export function historyLogPath() {
	return join(historyRoot(), HISTORY_LOG);
}

/** 解析 JSONL 版本日志：坏行跳过，不抛。 */
export function parseVersionLog(text) {
	const out = [];
	for (const line of String(text ?? "").split(/\r?\n/)) {
		if (line.trim() === "") continue;
		try {
			const rec = JSON.parse(line);
			if (rec && typeof rec === "object" && typeof rec.id === "string" && rec.id !== "") out.push(rec);
		} catch {
			/* 半行 / 坏行：跳过 */
		}
	}
	return out;
}

/**
 * 两份版本日志按 id 取并集（快照恢复用）：快照里的旧日志不许把本机更新的记录冲掉，
 * 本机缺的（.dsh/历史目录被清过）从快照补回来。按 (at, id) 排序后输出。
 * @param {string} incoming 快照里的日志文本
 * @param {string} current 本机现有日志文本（没有就传 ""）
 */
export function mergeVersionLogText(incoming, current) {
	const byId = new Map();
	for (const rec of parseVersionLog(current)) byId.set(rec.id, rec);
	for (const rec of parseVersionLog(incoming)) if (!byId.has(rec.id)) byId.set(rec.id, rec);
	const all = [...byId.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
	return all.map((rec) => JSON.stringify(rec)).join("\n") + (all.length > 0 ? "\n" : "");
}
