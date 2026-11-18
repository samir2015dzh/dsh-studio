/**
 * 技能优化回路的对外面。
 *   模型工具（3）：skillmgr_optimize_status（只读）/ skillmgr_optimize_run（手动跑一轮）/ skillmgr_optimize_decide（批准 / 拒绝提案）
 *   面板路由（5）：GET  /api/dsh-studio/optimizer/status
 *                 POST /api/dsh-studio/optimizer/run
 *                 POST /api/dsh-studio/optimizer/decide
 *                 POST /api/dsh-studio/optimizer/override   ← 所有者点名放行未过门候选：只在面板（loopback）上，模型工具没有这个入口
 *                 GET  /api/dsh-studio/optimizer/report?id=
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isLocalRequest } from "./guard.js";
import { ErrorMsg, handle, queryValue, readJsonBody, text, writeJson } from "./route-util.js";

export const OPTIMIZER_API = {
	status: "/api/dsh-studio/optimizer/status",
	run: "/api/dsh-studio/optimizer/run",
	decide: "/api/dsh-studio/optimizer/decide",
	override: "/api/dsh-studio/optimizer/override",
	report: "/api/dsh-studio/optimizer/report"
};

const looseObject = { type: "object", additionalProperties: true };
const clean = (value) => JSON.parse(JSON.stringify(value ?? null));

function renderStatus(s) {
	const c = s.config;
	const lines = [
		`技能优化回路：自动轮次${c.enabled ? "已开启" : "未开启（默认关；只有手动 skillmgr_optimize_run）"}；闲时窗口 ${c.idleWindow.start}–${c.idleWindow.end}（现在${s.schedule.inWindowNow ? "在" : "不在"}窗口内），空闲 ≥ ${c.idleMinutes} 分钟、两轮间隔 ≥ ${c.minIntervalHours} 小时`,
		`每轮上限：${c.limits.maxSkills} 个技能 · ${c.limits.generations} 代 × ${c.limits.population} 个变异 · 模型 ${c.limits.maxModelCalls} 次 · ${c.limits.maxTokens} token · ${c.limits.maxDurationMs} ms`,
		`评估门：平均分 ≥ 基线 + ${c.gate.minDelta}，关键场景回退容差 ${c.gate.criticalTolerance}；低风险自动应用 ${c.autonomy.autoApplyLowRisk ? "开" : "关"}（低风险：${c.autonomy.lowRisk.join("、")}；结构性：${c.autonomy.structural.join("、")}）`,
		`红线：frontmatter 键 ${s.redlines.frontmatterKeys.length} 个、标题关键字 ${s.redlines.headingPatterns.length} 条、行关键字 ${s.redlines.linePatterns.length} 条（内置不可删，配置只能追加）`,
		`数据目录：${s.dir}；配置文件：${s.configFile}${s.configError ? "（" + s.configError + "）" : ""}`,
		`上一轮：${s.schedule.lastRoundId ?? "—"} ${s.schedule.lastStatus ?? ""}`
	];
	if (s.proposals.length > 0) {
		lines.push("", "待批准提案：");
		for (const p of s.proposals) lines.push(`- ${p.id} · ${p.skill}${p.source ? `（来自 ${p.source}）` : ""} · ${p.tier}（${(p.kinds ?? []).join("、")}）· ${p.before} → ${p.after} · ${p.summary}`);
	}
	// ：自动应用后的回归监测
	const r = s.regression;
	if (r && (r.watching.length > 0 || r.recent.length > 0)) {
		lines.push("", `回归监测：观察中 ${r.watching.length} 个（每个自动应用的技能复评 ${c.regression.checks} 轮）`);
		for (const w of r.watching) lines.push(`- 观察 ${w.skill} · 应用版本 ${w.appliedVersionId} · 已复评 ${w.checks} 轮 · 退化时回滚到 ${w.rollbackTo}`);
		for (const g of r.recent) lines.push(`- 退化回滚 ${g.at} · ${g.skill}：应用前 ${g.scores.beforeApply} → 应用时 ${g.scores.atApply} → 复评 ${g.scores.now}；回滚到 ${g.rolledBackTo}（回滚版本 ${g.rollbackVersionId ?? "—"}）；${(g.reasons ?? []).join("；")}`);
		const blocked = Object.values(r.blocked ?? {});
		if (blocked.length > 0) lines.push(`此后不再自动应用（只出提案）：${blocked.map((b) => b.skill).join("、")}`);
	}
	return lines.join("\n");
}

function runSummary(report) {
	return {
		ok: report.status !== "error",
		roundId: report.roundId,
		status: report.status,
		...(report.stop ? { stop: clean(report.stop) } : {}),
		counts: clean(report.counts),
		budget: clean(report.budget),
		skills: clean(report.skills),
		message: report.markdown ?? ""
	};
}

/** @param {{optimizer: ReturnType<import("./optimizer.js").createOptimizer>}} options */
export function buildOptimizerTools({ optimizer }) {
	return [
		defineTool({
			name: "skillmgr_optimize_status",
			description:
				"只读：技能自动优化回路的当前配置与状态——自动开关（默认关）、闲时窗口、每轮成本 / 时长上限、G1 评估门参数、G3 自治分级规则（哪些改动低风险自动应用、哪些结构性只出提案）、红线清单（权限 / 安全段落，永不自动修改）、待批准提案、最近几轮报告。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						dir: { type: "string" },
						configFile: { type: "string" },
						config: looseObject,
						redlines: looseObject,
						schedule: looseObject,
						proposals: { type: "array", items: looseObject },
						reports: { type: "array", items: looseObject },
						regression: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute() {
				try {
					const s = await optimizer.status();
					return clean({ ok: true, message: renderStatus(s), dir: s.dir, configFile: s.configFile, config: s.config, redlines: s.redlines, schedule: s.schedule, proposals: s.proposals, reports: s.reports, regression: s.regression });
				} catch (error) {
					return { ok: false, message: "读取优化回路状态失败：" + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_optimize_run",
			description:
				"手动跑一轮技能优化（所有者要求时才调用）：按遥测挑候选（或 skill 指定一个），达尔文式迭代「变异 → 评估 → 留最优」，过 G1 评估门后低风险改动自动应用（带版本记录，可 skillmgr_rollback），结构性改动只出提案等批准；未过门的候选丢弃并记原因。受每轮成本 / 时长上限约束，超限自动停轮。返回本轮变更报告。不改权限 / 安全段落。",
			parameters: {
				skill: { type: "string", description: "可选：只优化这个技能（名字）；省略 = 按遥测挑" }
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
						stop: looseObject,
						counts: looseObject,
						budget: looseObject,
						skills: { type: "array", items: looseObject }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					return runSummary(await optimizer.runRound({ trigger: "manual", skill: args?.skill }));
				} catch (error) {
					return { ok: false, message: "优化回路未能启动：" + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			// ：darwin 无人值守体检的落地入口——改写不再由模型直接写 SKILL.md，而是交给这里过 G1 门、按 G3 分级落地
			name: "skillmgr_darwin_submit",
			description:
				"darwin 无人值守体检专用：提交某个技能改进后的完整 SKILL.md 正文。插件先过 G1 评估门（与优化回路同一套评估集与门槛，不过门不落地、记丢弃原因），再按 G3 分级决定落地方式：最低风险档（措辞 / 示例 / 顺序 / 格式）自动应用（带版本记录、可 skillmgr_rollback，并进应用后回归监测），其余一律进待批提案。无人值守体检期间不要直接改写 SKILL.md，用本工具提交；红线（权限 / 安全段落）永不自动修改。",
			parameters: {
				skill: { type: "string", description: "技能名（不带路径）", required: true },
				content: { type: "string", description: "改进后的完整 SKILL.md 正文（含 frontmatter）", required: true },
				summary: { type: "string", description: "一句话说明改了什么" }
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
						stop: looseObject,
						counts: looseObject,
						budget: looseObject,
						skills: { type: "array", items: looseObject }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					return runSummary(await optimizer.submitCandidate({ skill: args?.skill, content: args?.content, summary: args?.summary, source: "darwin" }));
				} catch (error) {
					return { ok: false, message: "改写提交未受理（未落地）：" + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_optimize_decide",
			description:
				"所有者对优化提案做决定：decision=approve 按版本化写入（出 optimize-approved 版本记录，可 skillmgr_rollback 回去），decision=reject 只标记拒绝。只在所有者明确说了批准 / 拒绝某个提案时调用，不要替所有者决定。提案生成后技能文件被改过则作废（stale）。",
			parameters: {
				id: { type: "string", description: "提案 id（prop-…，见 skillmgr_optimize_status）", required: true },
				decision: { type: "string", description: "approve 或 reject", required: true },
				reason: { type: "string", description: "可选：备注（写进提案与版本记录）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						proposal: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const result = await optimizer.decide({ id: args?.id, decision: args?.decision, reason: args?.reason });
					const p = result.proposal;
					const msg =
						p.status === "approved"
							? `已批准并应用提案 ${p.id}（${p.skill}），新版本 ${p.versionId}` + (p.rollback ? `；回滚：skillmgr_rollback {"target":"${p.rollback.target}","versionId":"${p.rollback.versionId}"}` : "")
							: `已拒绝提案 ${p.id}（${p.skill}）`;
					return clean({ ok: true, message: msg, proposal: { ...p, scores: undefined } });
				} catch (error) {
					return { ok: false, message: "处理提案失败：" + ErrorMsg(error) };
				}
			}
		})
	];
}

/** @param {object} ctx 宿主 ctx（只用 logger）@param {{optimizer: object}} options */
export function buildOptimizerRoutes(ctx, { optimizer }) {
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
			path: OPTIMIZER_API.status,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, clean(await optimizer.status()));
			})
		},
		{
			kind: "exact",
			path: OPTIMIZER_API.run,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const b = await body(req, res);
				if (b === undefined) return;
				const report = await optimizer.runRound({ trigger: "manual", skill: b.skill });
				writeJson(res, 200, clean(report));
			})
		},
		{
			kind: "exact",
			path: OPTIMIZER_API.decide,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const b = await body(req, res);
				if (b === undefined) return;
				writeJson(res, 200, clean(await optimizer.decide({ id: b.id, decision: b.decision, reason: b.reason })));
			})
		},
		{
			kind: "exact",
			path: OPTIMIZER_API.override,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const b = await body(req, res);
				if (b === undefined) return;
				writeJson(res, 200, clean(await optimizer.override({ discardId: b.discardId, reason: b.reason })));
			})
		},
		{
			kind: "exact",
			path: OPTIMIZER_API.report,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, clean(await optimizer.getReport(queryValue(req, "id"))));
			})
		}
	];
}
