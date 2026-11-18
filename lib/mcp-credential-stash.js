/**
 * 被删掉的 MCP server 的凭据暂存。
 *
 * 版本史里的注册表是脱敏的（凭据值换成占位符，见 versions.js）。#1 的回滚口径是「凭据以本机现值补回」，
 * 但 server 被注销之后本机 mcp.json 里已经没有它了——这时回滚把它恢复回来，凭据就只剩占位符可补，
 * 结果是条目回来了、鉴权没回来。所以注销（以及任何让 server 从注册表消失的写入，包括回滚）
 * 都先把被删条目的原值记到这里，回滚恢复时按名字取回。
 *
 * 位置：`~/.dsh/dsh-studio/mcp-credential-stash.json`（0600，与 mcp.json 同目录、同权限）。
 * 只留本机：快照把这个文件加进了 dsh-studio 跳过名单，不进备份包、不随 WebDAV 出机，
 * 也从不进版本史。只存「看起来像凭据的键」所在的完整条目（回滚时 mergeRedacted 只从这里取占位符位置的值）。
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hasEmbeddedSecret, isSensitiveField } from "./redact.js";
import { CREDENTIAL_FILE_MODE, hardenPermissions } from "./fs-perms.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { CorruptFileError, readJsonState } from "./json-file.js";
import { withFileLock } from "./state-lock.js";

export const STASH_FILE = "mcp-credential-stash.json";
/** 每个名字只留最近一份；整份最多这么多个名字（防无限增长）。 */
const MAX_ENTRIES = 200;

export function stashPath() {
	return resolve(homedir(), ".dsh", "dsh-studio", STASH_FILE);
}

/**
 * 这个条目里有没有值非空的凭据（任意深度）：凭据键，或参数 / URL 里内嵌的凭据（——
 * 版本史把它们也换成了占位符，注销后回滚得靠暂存补回）。
 */
export function hasCredentials(node) {
	if (typeof node === "string") return hasEmbeddedSecret(node);
	if (Array.isArray(node)) return hasEmbeddedSecret(node) || node.some(hasCredentials);
	if (node === null || typeof node !== "object") return false;
	for (const [key, value] of Object.entries(node)) {
		if (isSensitiveField(key, value)) return true;
		if (hasCredentials(value)) return true;
	}
	return false;
}

const stashShape = (v) => (v && typeof v === "object" && !Array.isArray(v) && v.servers && typeof v.servers === "object" ? undefined : "缺少 servers 字典");

/**
 * 读暂存。不存在 → 空暂存；存在但解析失败 → 抛 CorruptFileError（审计 2：原文件保留并留档，
 * 不静默当空——否则下一次暂存写入会把里面还没取回的凭据整份覆盖掉）。
 */
export async function readStash() {
	const read = await readJsonState(stashPath(), { validate: stashShape });
	if (read.status === "missing") return { version: 1, servers: {} };
	if (read.status === "corrupt") throw new CorruptFileError(stashPath(), read);
	return read.value;
}

/** 只读取用：暂存坏了就当没有（并已留档、记日志），不连累回滚本身。 */
export async function readStashLenient() {
	try {
		return await readStash();
	} catch (error) {
		if (error instanceof CorruptFileError) return { version: 1, servers: {}, corrupt: error.info };
		throw error;
	}
}

/**
 * 把这些（即将从注册表消失的）条目记进暂存。没有凭据的条目不记。永不抛：暂存失败只意味着
 * 将来回滚恢复时凭据要手工补，不该连累注销本身。读-改-写套 withFileLock（跨进程 / 并发注销不互相覆盖）；
 * 暂存文件损坏时不写（不覆盖坏文件），只记日志。
 * @param {object[]} removed 被删条目的原值（未脱敏）
 * @returns {Promise<string[]>} 实际记下的名字
 */
export async function stashRemovedServers(removed) {
	try {
		const list = (Array.isArray(removed) ? removed : []).filter((s) => s && typeof s.name === "string" && hasCredentials(s));
		if (list.length === 0) return [];
		return await withFileLock(stashPath(), async () => {
			const stash = await readStash();
			for (const server of list) stash.servers[server.name] = { at: new Date().toISOString(), server };
			const names = Object.keys(stash.servers);
			if (names.length > MAX_ENTRIES) {
				const oldest = names.sort((a, b) => String(stash.servers[a].at).localeCompare(String(stash.servers[b].at))).slice(0, names.length - MAX_ENTRIES);
				for (const n of oldest) delete stash.servers[n];
			}
			await atomicWriteFile(stashPath(), JSON.stringify(stash, null, 2) + "\n", { encoding: "utf8", mode: CREDENTIAL_FILE_MODE });
			await hardenPermissions(stashPath());
			return list.map((s) => s.name);
		});
	} catch (error) {
		if (error instanceof CorruptFileError) console.error("[dsh-studio] 凭据暂存未写入：" + error.message);
		return [];
	}
}

/** 按名字取暂存的原条目（没有返回 undefined）。 */
export async function stashedServer(name) {
	const stash = await readStashLenient();
	return stash.servers?.[name]?.server;
}

/** 两份 servers 数组 → 在 before 里有、after 里没有的条目（按 name）。 */
export function removedServers(beforeServers, afterServers) {
	const keep = new Set((Array.isArray(afterServers) ? afterServers : []).map((s) => s?.name));
	return (Array.isArray(beforeServers) ? beforeServers : []).filter((s) => s && typeof s.name === "string" && !keep.has(s.name));
}
