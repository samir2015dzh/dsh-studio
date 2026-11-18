/**
 * 宿主事件 → 遥测与版本归属。全部是旁路：每个监听器自己 try/catch，
 * 出错只丢统计，绝不改变工具调用的结果，也不把异常抛回宿主。
 *
 *   - tools/execute（环绕）：记调用开始时间；把「谁、哪个会话」挂进写上下文，内层的
 *     skill / 注册表写入点据此填 actor 与来源会话 id；模型直接用 write/edit 类工具改
 *     skill 根下的 SKILL.md 时，前后各取一次状态记版本。
 *   - tools/result（只读通知）：skill 工具 → skill.trigger；DSH 原生 mcp__<server>__<tool>
 *     → mcp.call(via=native)。本插件自己的 mcp_call / eager 工具由 McpRuntime.call 计时记录，
 *     这里跳过，避免重复计数。
 *   - agent/inbox/claimed：轮次开始。用户显式调用 skill（消息 source.kind = skill-invocation）
 *     → skill.inject；同时记一次本轮模型可见的 MCP 目录候选（catalog.inject）。
 *   - agent/turn-stopping：轮次结束，出 catalog.outcome（看了 / 用了 / 看了没用）。
 */
import { isUnderSkillRoot } from "./scanner.js";
import { errorClassOf } from "./telemetry.js";
import { captureSkillBefore, recordSkillAfter } from "./versions.js";
import { runWithWriteContext, sessionIdOf } from "./write-context.js";

/** 会写文件的宿主工具名（与 darwin.js 的 WRITE_TOOLS 同口径）。 */
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "write_file", "multi_edit"]);
const START_CAP = 5000;

/** DSH 原生 MCP 工具名 `mcp__<server>__<tool>` → {server, tool}；不是这个形态返回 null。 */
export function parseNativeMcpName(name) {
	const m = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ""));
	return m ? { server: m[1], tool: m[2] } : null;
}

function skillFileOfArgs(args) {
	const file = typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
	return file !== "" && /(^|[\\/])SKILL\.md$/i.test(file) ? file : "";
}

/**
 * @param {object} ctx 宿主 ctx（需要 ctx.on）
 * @param {{
 *   telemetry: ReturnType<import("./telemetry.js").createTelemetry>,
 *   studioToolNames: Set<string>,
 *   catalogCandidates: () => Promise<{servers: string[], toolCount: number} | null>,
 *   logger?: object
 * }} deps
 */
export function installEvolutionHooks(ctx, deps) {
	if (typeof ctx?.on !== "function") return () => {};
	const { telemetry, studioToolNames, catalogCandidates } = deps;
	const starts = new Map();
	const disposers = [];
	const on = (event, fn) => {
		try {
			const d = ctx.on(event, fn);
			if (typeof d === "function") disposers.push(d);
		} catch {
			/* 旧宿主没有这个事件：放弃这一项统计 */
		}
	};
	const keyOf = (exec) => exec?.token ?? exec?.callId;

	on("tools/execute", (exec, next) => {
		let meta = null;
		let skillFile = "";
		try {
			const key = keyOf(exec);
			if (key !== undefined) {
				if (starts.size > START_CAP) starts.clear();
				starts.set(key, Date.now());
			}
			const sid = sessionIdOf(exec?.agent);
			meta = { actor: "model:" + String(exec?.name ?? "unknown"), ...(sid !== "" ? { sessionId: sid } : {}) };
			if (WRITE_TOOLS.has(String(exec?.name ?? ""))) skillFile = skillFileOfArgs(exec?.arguments);
		} catch {
			meta = null;
		}
		if (meta === null) return next();
		if (skillFile === "") return runWithWriteContext(meta, () => next());
		// 模型直接改 SKILL.md：前后各取一次状态（只在 skill 根之内才记）
		return runWithWriteContext(meta, async () => {
			let before = null;
			let root = null;
			try {
				root = await isUnderSkillRoot(skillFile);
				if (root !== null) before = await captureSkillBefore(skillFile);
			} catch {
				root = null;
			}
			const result = await next();
			if (root !== null && result?.isError !== true) {
				await recordSkillAfter(skillFile, before, { action: "edit", reason: "模型用 " + String(exec?.name) + " 工具直接改写" });
			}
			return result;
		});
	});

	on("tools/result", (exec, result) => {
		try {
			const name = String(exec?.name ?? "");
			const key = keyOf(exec);
			const started = key === undefined ? undefined : starts.get(key);
			if (key !== undefined) starts.delete(key);
			const ms = started === undefined ? undefined : Date.now() - started;
			const sid = sessionIdOf(exec?.agent);
			const ok = result?.isError !== true;
			const err = ok ? undefined : errorClassOf(result?.error);
			if (name === "skill") {
				const skill = typeof exec?.arguments?.name === "string" ? exec.arguments.name : "";
				if (skill !== "") void telemetry.record("skill.trigger", { sid, skill, via: "skill-tool", ok, ms, err });
				return;
			}
			if (name === "mcp_call" || studioToolNames.has(name)) return; // McpRuntime.call 已记
			const parsed = parseNativeMcpName(name);
			if (parsed !== null) void telemetry.record("mcp.call", { sid, server: parsed.server, tool: parsed.tool, via: "native", ok, ms, err });
		} catch {
			/* 旁路 */
		}
	});

	on("agent/inbox/claimed", (payload) => {
		try {
			const sid = sessionIdOf(payload?.agent);
			if (sid === "") return;
			const turn = Number(payload?.turn);
			const fresh = telemetry.beginTurn(sid, turn);
			const source = payload?.message?.source;
			if (source?.kind === "skill-invocation" && typeof source.name === "string") {
				void telemetry.record("skill.inject", { sid, turn, skill: source.name, via: "user-invocation", ok: true });
			}
			if (!fresh) return;
			void Promise.resolve()
				.then(() => catalogCandidates())
				.then((catalog) => {
					if (catalog !== null && catalog.servers.length > 0) return telemetry.noteCatalogShown(sid, turn, catalog.servers, catalog.toolCount);
					return false;
				})
				.catch(() => {});
		} catch {
			/* 旁路 */
		}
	});

	on("agent/turn-stopping", (payload) => {
		try {
			const sid = sessionIdOf(payload?.agent);
			if (sid !== "") void telemetry.endTurn(sid, payload?.turn);
		} catch {
			/* 旁路 */
		}
	});

	return () => {
		for (const d of disposers.splice(0)) {
			try {
				d();
			} catch {
				/* ignore */
			}
		}
	};
}
