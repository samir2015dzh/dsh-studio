/**
 * MCP 注册表 schema 迁移。
 *
 * v1 → v2 只「加」不「改」：
 *   - 顶层 version: 1 → 2；
 *   - 每个 server 补 `catalog`（目录条目）：summary 用原 notes 播种（没有 notes 就不补）；
 *   - 每个 server 补 `trial: false`：迁移进来的都是已经在用的 server，不按「新登记」进试运行；
 *   - 其余字段（name / tier / transport / command / args / env / envPrefix / cwd / url / headers /
 *     notes / idleTimeout / tools / toolsCheckedAt / source / toolCallTimeoutMs / toolFilter /
 *     desiredNative 以及任何认不出的键）逐项原样保留。
 * 验证状态（verify）不在迁移里写：它是运行时观测，第一次真实握手时才有。
 *
 * 纯函数、幂等：已经是 v2 的注册表返回 null（不用迁）。
 */

export const MIGRATION_TARGET = 2;

/** 迁移会新增的 server 字段（等价对照时这些允许「前无后有」，其余字段必须逐项相同）。 */
export const MIGRATION_ADDED_KEYS = ["catalog", "trial"];

/**
 * @param {object} registry 已解析的注册表（McpStore.load() 的结果或文件 JSON）
 * @returns {object|null} 迁移后的整份注册表；不需要迁移时返回 null
 */
export function migrateRegistry(registry) {
	if (registry === null || typeof registry !== "object") return null;
	const version = Number(registry.version);
	if (Number.isFinite(version) && version >= MIGRATION_TARGET) return null;
	const servers = Array.isArray(registry.servers) ? registry.servers : [];
	return {
		...registry,
		version: MIGRATION_TARGET,
		servers: servers.map((server) => {
			if (server === null || typeof server !== "object") return server;
			const next = { ...server };
			if (next.catalog === undefined && typeof next.notes === "string" && next.notes.trim() !== "") next.catalog = { summary: next.notes.trim().slice(0, 300) };
			if (next.trial === undefined) next.trial = false;
			return next;
		})
	};
}

const stable = (value) =>
	JSON.stringify(value ?? null, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/**
 * 迁移前后逐项对照（测试与 scripts/mcp-migration-table.mjs 共用）。
 * @returns {{equivalent: boolean, rows: {server: string, field: string, before: unknown, after: unknown, verdict: "same"|"added"|"changed"|"missing"}[]}}
 */
export function compareMigration(before, after) {
	const rows = [];
	const beforeServers = Array.isArray(before?.servers) ? before.servers : [];
	const afterServers = new Map((Array.isArray(after?.servers) ? after.servers : []).map((s) => [s?.name, s]));
	let equivalent = beforeServers.length === afterServers.size;
	for (const server of beforeServers) {
		const next = afterServers.get(server?.name);
		if (next === undefined) {
			rows.push({ server: String(server?.name), field: "*", before: "present", after: "missing", verdict: "missing" });
			equivalent = false;
			continue;
		}
		const keys = [...new Set([...Object.keys(server), ...Object.keys(next)])];
		for (const field of keys) {
			const a = server[field];
			const b = next[field];
			let verdict = stable(a) === stable(b) ? "same" : a === undefined && MIGRATION_ADDED_KEYS.includes(field) ? "added" : "changed";
			if (verdict === "changed") equivalent = false;
			rows.push({ server: String(server.name), field, before: a, after: b, verdict });
		}
	}
	return { equivalent, rows };
}
