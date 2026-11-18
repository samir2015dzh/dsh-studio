/**
 * 技能库治理的对外面。
 *   模型工具（3）：skillmgr_governance_status（只读）/ skillmgr_governance_run（手动跑一轮，只出提案 / 报告）/
 *                 skillmgr_governance_decide（所有者批准 / 拒绝提案、裁决冲突、撤回教训）
 *   面板路由（4）：GET  /api/dsh-studio/governance/status?skill=
 *                 POST /api/dsh-studio/governance/run
 *                 POST /api/dsh-studio/governance/decide
 *                 GET  /api/dsh-studio/governance/report?id=
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isLocalRequest } from "./guard.js";
import { ErrorMsg, handle, queryValue, readJsonBody, text, writeJson } from "./route-util.js";

export const GOVERNANCE_API = {
	status: "/api/dsh-studio/governance/status",
	run: "/api/dsh-studio/governance/run",
	decide: "/api/dsh-studio/governance/decide",
	report: "/api/dsh-studio/governance/report"
};

const looseObject = { type: "object", additionalProperties: true };
const clean = (value) => JSON.parse(JSON.stringify(value ?? null));
const LABEL = { "duplicate-name": "同名多根", "trigger-overlap": "触发重叠", contradiction: "指令矛盾", "tool-conflict": "工具调用冲突" };

function renderStatus(s) {
	const c = s.config;
	const lines = [
		`技能库治理：自动轮次${c.enabled ? "已开启" : "未开启（默认关；只有手动 skillmgr_governance_run）"}；闲时窗口 ${c.idleWindow.start}–${c.idleWindow.end}（现在${s.schedule.inWindowNow ? "在" : "不在"}窗口内），空闲 ≥ ${c.idleMinutes} 分钟、两轮间隔 ≥ ${c.minIntervalHours} 小时；增量冲突检查${c.incrementalConflicts ? "开" : "关"}`,
		`每轮上限：合并提案 ${c.limits.maxMergeProposals} 份 · 教训补丁 ${c.limits.maxLessonProposals} 份 · 模型 ${c.limits.maxModelCalls} 次 · ${c.limits.maxTokens} token · ${c.limits.maxDurationMs} ms`,
		`只出提案与报告，不自动改技能；合并稿过 #3 评估门与红线，批准后才按版本化写入。数据目录：${s.dir}`,
		`上一轮：${s.schedule.lastRoundId ?? "—"} ${s.schedule.lastStatus ?? ""}`
	];
	if (s.conflicts.length > 0) {
		lines.push("", `待处理冲突（${s.conflicts.length}）：`);
		for (const x of s.conflicts.slice(0, 15)) lines.push(`- ${x.id} · ${LABEL[x.type] ?? x.type} · ${x.pair.join(" ↔ ")} · 「${x.evidence?.[0]?.quote ?? ""}」 vs 「${x.evidence?.[1]?.quote ?? ""}」 → ${x.suggestion?.note ?? ""}`);
	}
	if (s.proposals.length > 0) {
		lines.push("", "待批准提案：");
		for (const p of s.proposals) lines.push(`- ${p.id} · ${p.type} · ${p.type === "merge" ? `${p.skill} ← ${p.drop}（预演 ${p.eval?.keep?.join("→")} / ${p.eval?.drop?.join("→")}）` : p.summary}`);
	}
	if (s.lessons.length > 0) {
		lines.push("", "教训（按频次）：");
		for (const l of s.lessons.slice(0, 10)) lines.push(`- ${l.id} · ${l.skill} · ${l.kind} ×${l.count} v${l.version} · ${l.status}${l.applied ? " · 已写入 " + l.applied.versionId : ""} · 来源 ${l.sources.map((x) => x.source + ":" + x.ref).join("，")}`);
	}
	if (Array.isArray(s.lineage)) {
		lines.push("", "合并溯源：");
		if (s.lineage.length === 0) lines.push("- （没有合并记录）");
		for (const r of s.lineage) lines.push(r.role === "source" ? `- ${r.at} ${r.name} 被合并进「${r.into?.name}」（版本 ${r.into?.versionId}，提案 ${r.proposalId}）` : `- ${r.at} ${r.name} 是合并结果（版本 ${r.id}）：来源 ${(r.sources ?? []).map((x) => x.name).join(" + ")}`);
	}
	return lines.join("\n");
}

/** @param {{governance: ReturnType<import("./governance.js").createGovernance>}} options */
export function buildGovernanceTools({ governance }) {
	return [
		defineTool({
			name: "skillmgr_governance_status",
			description:
				"只读：技能库治理的状态——待处理的技能冲突（同名多根 / 触发重叠 / 指令矛盾 / 工具冲突，带证据原文与建议）、待批准的合并提案与教训补丁提案、按频次排列的教训（带来源事件）、最近几轮报告；给 skill 时附带这个技能的合并溯源（被合并去了哪 / 由哪两份合并而来）。",
			parameters: {
				skill: { type: "string", description: "可选：看这个技能（名字或 skill: key）的合并溯源" }
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
						conflicts: { type: "array", items: looseObject },
						conflictCounts: looseObject,
						proposals: { type: "array", items: looseObject },
						lessons: { type: "array", items: looseObject },
						reports: { type: "array", items: looseObject },
						lineage: { type: "array", items: looseObject }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const s = await governance.status({ skill: typeof args?.skill === "string" && args.skill.trim() !== "" ? args.skill.trim() : undefined });
					return clean({ ok: true, message: renderStatus(s), dir: s.dir, config: s.config, schedule: s.schedule, conflicts: s.conflicts, conflictCounts: s.conflictCounts, proposals: s.proposals, lessons: s.lessons, reports: s.reports, lineage: s.lineage });
				} catch (error) {
					return { ok: false, message: "读取治理状态失败：" + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_governance_run",
			description:
				"手动跑一轮技能库治理（所有者要求时才调用）：全库冲突检测（只报告）、相似技能合并候选 → 合并稿 + 差异 + #3 评估门预演（只出提案）、从遥测失败 / 优化回路丢弃与放行记录 / 所有者裁决过的冲突里整理教训 → 补丁提案、展示未用报告。不改任何技能；受每轮成本上限约束。返回本轮报告。",
			parameters: {
				only: { type: "array", items: { type: "string" }, description: "可选：只跑其中几项（conflicts / merge / lessons / unused）" }
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
						stop: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const only = Array.isArray(args?.only) ? args.only.filter((x) => ["conflicts", "merge", "lessons", "unused"].includes(x)) : undefined;
					const r = await governance.runRound({ trigger: "manual", only });
					return clean({ ok: r.status !== "error", message: r.markdown, roundId: r.roundId, status: r.status, counts: r.counts, ...(r.stop ? { stop: r.stop } : {}) });
				} catch (error) {
					return { ok: false, message: "治理轮次未能启动：" + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_governance_decide",
			description:
				"所有者对治理结果做决定（只在所有者明确表态时调用，不要替所有者决定）：提案 gprop-… 用 approve / reject（批准合并 = 合并稿按版本化写入保留方、来源移入回收站并留溯源，可 skillmgr_rollback / skillmgr_restore 撤回；批准教训补丁 = 版本化写入）；冲突 conf-… 用 rule（reason 写裁决，会成为教训来源）/ dismiss（误报）；教训 lesson-… 用 withdraw（reason 必填，留痕；已写入技能的会出撤回补丁提案）。",
			parameters: {
				id: { type: "string", description: "gprop-… / conf-… / lesson-…", required: true },
				decision: { type: "string", description: "approve / reject / rule / dismiss / withdraw", required: true },
				reason: { type: "string", description: "备注；rule 与 withdraw 必填" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						kind: { type: "string" },
						proposal: looseObject,
						conflict: looseObject,
						lesson: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const r = await governance.decide({ id: args?.id, decision: args?.decision, reason: args?.reason });
					let msg = "";
					if (r.kind === "proposal") {
						const p = r.proposal;
						msg =
							p.status === "rejected"
								? `已拒绝提案 ${p.id}`
								: p.type === "merge" && p.drop?.draft === true
									? `已合并：蒸馏草稿「${p.drop.name}」（${p.drop.draftId}）并入「${p.keep.name}」，新版本 ${p.versionId}；草稿记录保留、标为已并入` + (p.rollback ? `；回滚：skillmgr_rollback {"target":"${p.rollback.target}","versionId":"${p.rollback.versionId}"}` : "")
									: p.type === "merge"
									? `已合并：「${p.drop.name}」并入「${p.keep.name}」，新版本 ${p.versionId}；来源已移入回收站 ${p.trashId ?? "（失败：" + p.error + "）"}` + (p.rollback ? `；回滚：skillmgr_rollback {"target":"${p.rollback.target}","versionId":"${p.rollback.versionId}"}` : "") + (p.restore ? `；恢复来源：skillmgr_restore {"id":"${p.restore.id}"}` : "")
									: `已应用 ${p.id}（${p.skill}），新版本 ${p.versionId}` + (p.rollback ? `；回滚：skillmgr_rollback {"target":"${p.rollback.target}","versionId":"${p.rollback.versionId}"}` : "");
					} else if (r.kind === "conflict") msg = `冲突 ${r.conflict.id} 已${r.conflict.status === "ruled" ? "裁决" : "标为误报"}`;
					else msg = `教训 ${r.lesson.id} 已撤回` + (r.proposal ? `；它已写进技能，撤回补丁提案 ${r.proposal.id} 等批准` : "");
					return clean({ ok: true, message: msg, kind: r.kind, proposal: r.proposal ?? undefined, conflict: r.conflict, lesson: r.lesson });
				} catch (error) {
					return { ok: false, message: "处理失败：" + ErrorMsg(error) };
				}
			}
		})
	];
}

export function buildGovernanceRoutes(ctx, { governance }) {
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
			path: GOVERNANCE_API.status,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, clean(await governance.status({ skill: queryValue(req, "skill") || undefined })));
			})
		},
		{
			kind: "exact",
			path: GOVERNANCE_API.run,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const b = await body(req, res);
				if (b === undefined) return;
				writeJson(res, 200, clean(await governance.runRound({ trigger: "manual", only: Array.isArray(b.only) ? b.only : undefined })));
			})
		},
		{
			kind: "exact",
			path: GOVERNANCE_API.decide,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const b = await body(req, res);
				if (b === undefined) return;
				writeJson(res, 200, clean(await governance.decide({ id: b.id, decision: b.decision, reason: b.reason })));
			})
		},
		{
			kind: "exact",
			path: GOVERNANCE_API.report,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, clean(await governance.getReport(queryValue(req, "id"))));
			})
		}
	];
}
