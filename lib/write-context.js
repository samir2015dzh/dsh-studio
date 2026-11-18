/**
 * 写操作的「谁在写」上下文。
 *
 * 技能库与 MCP 注册表的写入口散在十几处（面板路由、模型工具、提取器、生命周期巡检……），
 * 逐个往下传 actor / 会话 id 会改动大量既有签名。这里用 AsyncLocalStorage 挂一份环境上下文：
 *   - 外层（tools/execute 包装、面板路由包装、提取器）用 runWithWriteContext 声明「谁、为哪个会话」；
 *   - 最内层的写入点（versions.js）只读 currentWriteContext()，拿不到就记 actor = "unknown"。
 * 嵌套时内层覆盖外层同名字段，并把外层 actor 留在 trigger 里（例如模型调 skillmgr_extract_run
 * 触发了提取器合并：actor = "extractor"，trigger = "model:skillmgr_extract_run"）。
 *
 * 纯旁路：上下文只影响版本记录 / 遥测里的归属字段，不改变任何写入行为。
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/**
 * @typedef {{actor?: string, trigger?: string, sessionId?: string, sessionIds?: string[], turn?: number, via?: string}} WriteContext
 */

/** 当前上下文（没有时返回空对象，调用方不必判空）。 */
export function currentWriteContext() {
	return storage.getStore() ?? {};
}

/**
 * 在 meta 声明的上下文里执行 fn，返回 fn 的结果（同步值或 Promise 原样透传）。
 * @template T
 * @param {WriteContext} meta
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithWriteContext(meta, fn) {
	const parent = storage.getStore() ?? {};
	const next = { ...parent, ...(meta ?? {}) };
	if (typeof parent.actor === "string" && parent.actor !== "" && meta?.actor !== undefined && meta.actor !== parent.actor) {
		next.trigger = parent.trigger ?? parent.actor;
	}
	return storage.run(next, fn);
}

/** 从宿主 Agent 对象里取会话 id（Agent.id 即 SessionId；兼容 agent.session.id 形态）。 */
export function sessionIdOf(agent) {
	if (agent === null || typeof agent !== "object") return "";
	const id = agent.id ?? agent.sessionId ?? agent.session?.id;
	return typeof id === "string" ? id : "";
}
