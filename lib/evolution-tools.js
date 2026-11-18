/**
 * 进化地基的对外面：遥测周统计、版本史查询、回滚。
 *   - 模型工具：skillmgr_stats / skillmgr_history / skillmgr_rollback
 *   - 面板路由：GET /api/dsh-studio/telemetry/stats、GET /api/dsh-studio/history、POST /api/dsh-studio/history/rollback
 * 只读两项不写任何文件；回滚会写 skill 目录或 mcp.json，并且回滚本身记一条版本。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isLocalRequest } from "./guard.js";
import { ErrorMsg, handle, queryValue, readJsonBody, text, writeJson } from "./route-util.js";
import { getTelemetry } from "./telemetry.js";
import { REGISTRY_KEY, listVersions, publicRecord, resolveSkillKey, rollbackRegistry, rollbackSkill } from "./versions.js";
import { historyRoot } from "./history-paths.js";
import { currentWriteContext } from "./write-context.js";

export const EVOLUTION_API = {
	stats: "/api/dsh-studio/telemetry/stats",
	history: "/api/dsh-studio/history",
	rollback: "/api/dsh-studio/history/rollback"
};

const isRegistryTarget = (value) => {
	const s = String(value ?? "").trim();
	return s === REGISTRY_KEY || s === "mcp-registry" || s === "mcp.json" || s === "mcp";
};

function renderStats(value) {
	const lines = [];
	const week = value.weeks?.[0];
	if (week === undefined) return "没有统计数据";
	lines.push(`遥测周统计（${week.from.slice(0, 10)} ~ ${week.to.slice(0, 10)}${value.sid ? "，会话 " + value.sid : ""}；共 ${value.events} 个事件，保留 ${value.retentionDays} 天）`);
	lines.push("", "Skill：");
	if (week.skills.length === 0) lines.push("- （本周无触发）");
	for (const s of week.skills.slice(0, 30)) {
		lines.push(`- ${s.skill}：触发 ${s.triggers}，注入 ${s.injections}，失败率 ${(s.failureRate * 100).toFixed(1)}%，最近 ${s.lastTriggeredAt ?? "—"}`);
	}
	lines.push("", "MCP：");
	if (week.mcp.length === 0) lines.push("- （本周无调用）");
	for (const m of week.mcp.slice(0, 30)) {
		lines.push(`- ${m.server}：调用 ${m.calls}，失败率 ${(m.failureRate * 100).toFixed(1)}%，平均 ${m.avgMs ?? "—"} ms，最近 ${m.lastCalledAt ?? "—"}`);
		for (const t of m.tools.slice(0, 10)) lines.push(`  - ${t.tool}：${t.calls} 次，失败率 ${(t.failureRate * 100).toFixed(1)}%，平均 ${t.avgMs ?? "—"} ms`);
	}
	if (week.catalog.length > 0) {
		lines.push("", "工具目录（看了 / 用了 / 看了没用，按轮计）：");
		for (const c of week.catalog.slice(0, 30)) lines.push(`- ${c.server}：${c.shownTurns} / ${c.usedTurns} / ${c.unusedTurns}`);
	}
	// · D：按需加载账本（加载 = 真正建立一条上游连接）与闲置项
	if ((week.loads ?? []).length > 0) {
		lines.push("", "MCP 加载（加载 / 失败 / 断开；验证 成功/失败；熔断次数；注册表写入）：");
		for (const l of week.loads.slice(0, 30)) {
			const causes = Object.entries(l.unloadCauses ?? {}).map(([k, v]) => `${k}×${v}`).join(" ");
			lines.push(`- ${l.server}：${l.loads} / ${l.failedLoads} / ${l.unloads}${causes ? `（${causes}）` : ""}；验证 ${l.verifyOk}/${l.verifyFailed}；熔断 ${l.breakerOpens}；注册表 ${l.registryWrites}；最近加载 ${l.lastLoadedAt ?? "—"}`);
		}
	}
	if ((week.idle ?? []).length > 0) {
		lines.push("", "闲置（目录里出现、但本周一次都没加载）：" + week.idle.map((i) => `${i.server}（出现 ${i.shownTurns} 轮）`).join("、"));
	}
	return lines.join("\n");
}

function renderHistory(value) {
	if (value.records.length === 0) return "没有版本记录" + (value.filter ? "（" + value.filter + "）" : "");
	return [
		`版本记录 ${value.records.length}/${value.total} 条（新的在前，目录 ${value.dir}）：`,
		...value.records.map((r) => `- ${r.id} · ${r.at} · ${r.name} · ${r.action} · ${r.actor}${r.sessionId ? " · 会话 " + r.sessionId : ""} · ${r.diff?.summary ?? ""}`)
	].join("\n");
}

async function historyQuery({ name, kind, limit }) {
	const filter = {};
	if (isRegistryTarget(name)) filter.key = REGISTRY_KEY;
	else if (typeof name === "string" && name.trim() !== "") filter.key = await resolveSkillKey(name);
	if (kind === "skill" || kind === "mcp-registry") filter.kind = kind;
	filter.limit = limit;
	const result = await listVersions(filter);
	return { ok: true, dir: historyRoot(), filter: name ? String(name) : "", total: result.total, records: result.records.map(publicRecord) };
}

/**
 * @param {{registryPath: () => string, onRegistryChange?: () => void}} options
 */
async function doRollback(options, { target, versionId, reason }) {
	const ctx = currentWriteContext();
	if (isRegistryTarget(target)) {
		const result = await rollbackRegistry({ versionId, file: options.registryPath(), reason, actor: ctx.actor, sessionId: ctx.sessionId });
		try {
			options.onRegistryChange?.();
		} catch {
			/* 重挂失败不影响回滚结果；下次注册表变化会再挂 */
		}
		return result;
	}
	const key = String(target ?? "").trim();
	return rollbackSkill({ ...(key.startsWith("skill:") ? { key } : { name: key }), versionId, reason, actor: ctx.actor, sessionId: ctx.sessionId });
}

const looseObject = { type: "object", additionalProperties: true };

/** @param {{registryPath: () => string, onRegistryChange?: () => void}} options */
export function buildEvolutionTools(options) {
	return [
		defineTool({
			name: "skillmgr_stats",
			description:
				"只读的遥测周统计：按滚动 7 天窗口给出每个 skill 的触发数 / 注入数 / 失败率 / 最近触发时间，每个 MCP server 与其工具的调用数 / 失败率 / 平均耗时 / 错误类分布，以及工具目录「看了没用」（本轮目录里有、但没被调用）的轮次计数。数据只含 id、名称、计数、耗时、错误类，不含对话正文。session 可只看某个会话。",
			parameters: {
				weeks: { type: "number", description: "要几周（1–13，默认 1：最近 7 天）" },
				session: { type: "string", description: "可选：只统计这个会话 id" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						sid: { type: "string" },
						retentionDays: { type: "number" },
						dir: { type: "string" },
						files: { type: "number" },
						badLines: { type: "number" },
						events: { type: "number" },
						health: looseObject,
						weeks: { type: "array", items: looseObject }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const stats = await getTelemetry().stats({ weeks: args?.weeks, sid: args?.session });
					const { sid, ...rest } = stats;
					return { ...rest, ...(sid ? { sid } : {}), message: renderStats(stats) };
				} catch (error) {
					return { ok: false, message: "遥测统计失败：" + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_history",
			description:
				"只读查询版本史：技能库两个 store 与 MCP 注册表的每次写入（蒸馏新建 / 语义合并 / 改写 / 分组变更 / 闲置回收 / 回收站 / 注册表增删改 / 回滚）各一条记录，含时间、actor、diff 摘要、来源会话 id、评测结果空位。name 填 skill 名（同名在两个 store 时填 key），或填 mcp-registry 看注册表；不填看全部最近记录。",
			parameters: {
				name: { type: "string", description: "skill 名 / key（skill:~/.agents/skills/<名>）/ mcp-registry；省略 = 全部" },
				kind: { type: "string", description: "可选：skill 或 mcp-registry" },
				limit: { type: "number", description: "最多返回几条，默认 50" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						dir: { type: "string" },
						filter: { type: "string" },
						total: { type: "number" },
						records: { type: "array", items: looseObject }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const value = await historyQuery({ name: args?.name, kind: args?.kind, limit: args?.limit });
					return { ...value, message: renderHistory(value) };
				} catch (error) {
					return { ok: false, message: "查询版本史失败：" + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_rollback",
			description:
				"把单个 skill 或整份 MCP 注册表恢复到某个历史版本（versionId 用 skillmgr_history 查）。回滚本身也生成一条版本记录，可以再回滚回来。回到「不存在」的版本时 skill 目录进回收站而不是硬删；注册表回滚不会动凭据（凭据从不进版本史，按本机现值保留）。注册表改动需重启 DSH 才影响原生 MCP 行，插件自己的按需加载立即生效。",
			parameters: {
				target: { type: "string", description: "skill 名 / key，或 mcp-registry", required: true },
				versionId: { type: "string", description: "要回到的版本 id", required: true },
				reason: { type: "string", description: "可选：为什么回滚（写进版本记录）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						key: { type: "string" },
						target: { type: "string" },
						restoredTo: { type: "string" },
						version: looseObject,
						skippedLarge: { type: "array", items: { type: "string" } },
						trashed: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const result = await doRollback(options, { target: args?.target, versionId: args?.versionId, reason: args?.reason });
					const { trashed, version, ...rest } = result;
					return {
						...rest,
						...(version ? { version: JSON.parse(JSON.stringify(version)) } : {}),
						...(trashed ? { trashed: JSON.parse(JSON.stringify(trashed)) } : {}),
						message: `已把 ${result.key} 回滚到 ${result.restoredTo}` + (version ? `，新版本 ${version.id}` : "") + (result.skippedLarge?.length ? `；${result.skippedLarge.length} 个大文件只有指纹、保持现状` : "") + (result.missingCredentials?.length ? `；${result.missingCredentials.length} 处凭据本机没有现值、未补回：${result.missingCredentials.map((m) => `${m.server} · ${m.field}`).join("，")}` : "")
					};
				} catch (error) {
					return { ok: false, message: "回滚失败：" + ErrorMsg(error) };
				}
			}
		})
	];
}

/** @param {object} ctx 宿主 ctx（只用 logger）@param {{registryPath: () => string, onRegistryChange?: () => void}} options */
export function buildEvolutionRoutes(ctx, options) {
	const guard = (req, res, method) => {
		if (!isLocalRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: "method not allowed: " + req.method });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: EVOLUTION_API.stats,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, await getTelemetry().stats({ weeks: Number(queryValue(req, "weeks") ?? 1), sid: queryValue(req, "sid") }));
			})
		},
		{
			kind: "exact",
			path: EVOLUTION_API.history,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, await historyQuery({ name: queryValue(req, "name"), kind: queryValue(req, "kind"), limit: Number(queryValue(req, "limit") ?? 50) }));
			})
		},
		{
			kind: "exact",
			path: EVOLUTION_API.rollback,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === undefined) {
					writeJson(res, 400, { error: "请求体不是合法 JSON" });
					return;
				}
				writeJson(res, 200, await doRollback(options, { target: body.target, versionId: body.versionId, reason: body.reason }));
			})
		}
	];
}
