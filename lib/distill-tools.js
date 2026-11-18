/**
 * 对话蒸馏硬化的对外面。
 *   模型工具（3）：skillmgr_distill_status（只读：队列 / 草稿 / 过门与淘汰记录 / 报告；给 id 看单份草稿与出处）
 *                 skillmgr_distill_run（手动跑一批；可点名会话先蒸馏）
 *                 skillmgr_distill_decide（所有者淘汰 / 重排草稿；没有直接放行）
 *   面板路由（4）：GET  /api/dsh-studio/distill/status?id=
 *                 POST /api/dsh-studio/distill/run
 *                 POST /api/dsh-studio/distill/decide
 *                 GET  /api/dsh-studio/distill/source?id=   （来源跳转：会话日志里关键轮次前后的消息）
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isLocalRequest } from "./guard.js";
import { ErrorMsg, handle, queryValue, readJsonBody, text, writeJson } from "./route-util.js";

export const DISTILL_API = {
	status: "/api/dsh-studio/distill/status",
	run: "/api/dsh-studio/distill/run",
	decide: "/api/dsh-studio/distill/decide",
	source: "/api/dsh-studio/distill/source"
};

const looseObject = { type: "object", additionalProperties: true };
const clean = (value) => JSON.parse(JSON.stringify(value ?? null));
const STATUS_LABEL = { queued: "排队", published: "已入库", failed: "已淘汰", "merge-proposed": "待批合并", merged: "已并入", "merge-rejected": "合并被拒", discarded: "所有者淘汰" };

function renderStatus(s) {
	const c = s.config;
	const counts = Object.entries(s.counts).map(([k, n]) => `${STATUS_LABEL[k] ?? k} ${n}`).join(" · ") || "无";
	const lines = [
		`对话蒸馏：产物一律先成草稿，过 #3 评估门（均分 ≥ ${c.gate.minMean}、关键场景 ≥ ${c.gate.minCritical}）才入库；与库里相似度 ≥ ${c.dedupe.minScore} 的转 #4 合并提案。`,
		`闲时批量${c.enabled ? "已开启" : "未开启（默认关；手动 skillmgr_distill_run）"}；窗口 ${c.idleWindow.start}–${c.idleWindow.end}；每批 ≤ ${c.limits.maxDrafts} 份 · 模型 ${c.limits.maxModelCalls} 次 · ${c.limits.maxTokens} token`,
		`草稿：${counts}。数据目录：${s.dir}`,
		`上一批：${s.schedule.lastRoundId ?? "—"} ${s.schedule.lastStatus ?? ""}`
	];
	if (s.queue.length > 0) {
		lines.push("", `队列（${s.queue.length}）：`);
		for (const d of s.queue.slice(0, 15)) lines.push(`- ${d.id} · ${d.name} · 来源 ${d.sessions.map((x) => x.id + (x.turns.length ? "#" + x.turns.join(",") : "")).join("、") || "—"}`);
	}
	if (s.drafts.length > 0) {
		lines.push("", "最近处理：");
		for (const d of s.drafts.slice(0, 10)) lines.push(`- ${d.id} · ${d.name} · ${STATUS_LABEL[d.status] ?? d.status}${d.eval ? ` · 均分 ${d.eval.mean}` : ""}${d.merge ? ` · → ${d.merge.into}（${d.merge.proposalId}）` : ""}${d.failure ? " · " + d.failure.reasons.join("；") : ""}${d.published ? " · 版本 " + d.published.versionId : ""}`);
	}
	if (s.reports.length > 0) {
		const r = s.reports[0];
		lines.push("", `最近一批 ${r.roundId}：处理 ${r.counts.processed}、入库 ${r.counts.published}、过门率 ${r.passRate === null ? "—" : Math.round(r.passRate * 100) + "%"}、合并去向 ${r.merges.map((m) => m.name + "→" + m.into).join("、") || "无"}`);
	}
	if (s.draft) {
		const d = s.draft;
		lines.push("", `草稿 ${d.id}「${d.name}」：${STATUS_LABEL[d.status] ?? d.status}；蒸馏于 ${d.provenance?.extractedAt ?? "—"}`);
		for (const x of d.provenance?.sessions ?? []) lines.push(`- 会话 ${x.id}${x.file ? `（${x.file}）` : ""}：关键轮次 ${x.turns.map((t) => `#${t.turn} ${t.role === "user" ? "用户" : "助手"}「${t.excerpt}」`).join("；") || "未定位"}`);
		lines.push("（跳回来源：GET /api/dsh-studio/distill/source?id=" + d.id + "）");
	}
	return lines.join("\n");
}

/** @param {{distill: ReturnType<import("./distill.js").createDistill>}} options */
export function buildDistillTools({ distill }) {
	return [
		defineTool({
			name: "skillmgr_distill_status",
			description:
				"只读：对话蒸馏的状态——草稿队列、最近处理过的草稿（入库 / 未过门淘汰原因 / 转合并提案的去向）、淘汰记录、最近几批报告（处理条数、过门率、合并去向）；给 id 时附带这份草稿的全文与出处（会话 id、时间、关键轮次）。",
			parameters: {
				id: { type: "string", description: "可选：草稿 id（draft-…）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						dir: { type: "string" },
						config: looseObject,
						schedule: looseObject,
						counts: looseObject,
						queue: { type: "array", items: looseObject },
						drafts: { type: "array", items: looseObject },
						discards: { type: "array", items: looseObject },
						reports: { type: "array", items: looseObject },
						draft: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const s = await distill.status({ id: typeof args?.id === "string" && args.id.trim() !== "" ? args.id.trim() : undefined });
					return clean({ ok: true, message: renderStatus(s), dir: s.dir, config: s.config, schedule: s.schedule, counts: s.counts, queue: s.queue, drafts: s.drafts, discards: s.discards, reports: s.reports, draft: s.draft });
				} catch (error) {
					return { ok: false, message: "读取蒸馏状态失败：" + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_distill_run",
			description:
				"手动跑一批蒸馏（所有者要求时才调用）：给 sessionId 时先把那个会话蒸馏成草稿；然后对草稿逐份 查重（与库里高度相似 → 出合并提案，所有者批准才写）→ 评估门（过门才按版本化写进技能库，不过门淘汰并记原因）。受每批成本上限约束，返回本批报告。",
			parameters: {
				sessionId: { type: "string", description: "可选：点名蒸馏这个会话（会话 id）" },
				extract: { type: "boolean", description: "可选：不点名时也先按提取器窗口蒸馏一轮再处理（默认只处理已有队列）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						roundId: { type: "string" },
						status: { type: "string" },
						counts: looseObject,
						passRate: { type: "number" },
						merges: { type: "array", items: looseObject },
						stop: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const r = await distill.runManual({ sessionId: args?.sessionId, extract: args?.extract === true ? true : undefined });
					return clean({ ok: r.status !== "error" && r.status !== "extract-failed", message: r.markdown, roundId: r.roundId ?? undefined, status: r.status, counts: r.counts ?? undefined, passRate: typeof r.passRate === "number" ? r.passRate : undefined, merges: r.merges, ...(r.stop ? { stop: r.stop } : {}) });
				} catch (error) {
					return { ok: false, message: "蒸馏批次未能启动：" + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_distill_decide",
			description:
				"所有者处理蒸馏草稿（只在所有者明确表态时调用）：discard（淘汰，留记录）/ requeue（重新排队；合并提案被拒的草稿重排后跳过查重、直接过评估门）。没有直接放行：草稿进库只能过评估门；转了合并提案的用 skillmgr_governance_decide 处理。",
			parameters: {
				id: { type: "string", description: "草稿 id（draft-…）", required: true },
				decision: { type: "string", description: "discard / requeue", required: true },
				reason: { type: "string", description: "备注" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						draft: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const r = await distill.decide({ id: args?.id, decision: args?.decision, reason: args?.reason });
					return clean({ ok: true, message: `草稿 ${r.draft.id}（${r.draft.name}）已${r.draft.status === "discarded" ? "淘汰" : "重新排队"}`, draft: r.draft });
				} catch (error) {
					return { ok: false, message: "处理失败：" + ErrorMsg(error) };
				}
			}
		})
	];
}

export function buildDistillRoutes(ctx, { distill }) {
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
	const body = async (req, res) => {
		const parsed = await readJsonBody(req);
		if (parsed === undefined) writeJson(res, 400, { error: "请求体不是合法 JSON" });
		return parsed;
	};
	return [
		{
			kind: "exact",
			path: DISTILL_API.status,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, clean(await distill.status({ id: queryValue(req, "id") || undefined })));
			})
		},
		{
			kind: "exact",
			path: DISTILL_API.run,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const b = await body(req, res);
				if (b === undefined) return;
				writeJson(res, 200, clean(await distill.runManual({ sessionId: b.sessionId, extract: b.extract === true ? true : undefined })));
			})
		},
		{
			kind: "exact",
			path: DISTILL_API.decide,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const b = await body(req, res);
				if (b === undefined) return;
				writeJson(res, 200, clean(await distill.decide({ id: b.id, decision: b.decision, reason: b.reason })));
			})
		},
		{
			kind: "exact",
			path: DISTILL_API.source,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, clean(await distill.source(queryValue(req, "id"))));
			})
		}
	];
}
