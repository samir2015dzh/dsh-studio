/**
 * ：技能自动优化回路（R5 + G1 评估门 + G3 自治分级 + G9 节奏 / 成本 / 报告）。
 *
 * 全在伪 HOME 里跑：技能根、版本史、遥测、优化回路数据都落临时目录。
 * 模型一律是可注入的假模型（purpose = cases | judge | mutate），离线、确定；
 * 另有一条用假的宿主 llm 服务（prepareCall + stream）验证生产接线与 usage 计数。
 *
 *   [1] 全链：候选 → 变异 → 评估 → 低风险自动应用（版本记录带 eval，可回滚）+ 故意做坏的变异被门挡下并留丢弃记录
 *   [2] 结构性改动只出提案；批准后出 optimize-approved 版本，可回滚；拒绝 / 过期
 *   [3] 红线：碰权限 / 安全段落直接丢弃，不出提案、不可点名放行
 *   [4] 所有者点名放行未过门候选：必须写理由，留 overrides 记录与 optimize-override 版本
 *   [5] 成本 / 时长 / 次数上限触发自动停轮（报告写明是哪一项）
 *   [6] 冲突迹象停手报告：模型报告职责冲突 / 同名技能多处存在 / 本轮期间文件被改
 *   [7] 候选挑选只看遥测；无遥测的技能不进自动优化；高频 + 高失败率优先
 *   [8] 闲时节奏：默认关；窗口外 / 不够闲 / 间隔不够都不跑
 *   [9] G3 分级规则（配置可查可改）与红线清单（内置不可删、只能追加）
 *   [10] 宿主模型接线：ctx.llm 的 usage 分片计入 token 预算；工具 / 路由经注册层可用
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-optimizer-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
delete process.env.DSH_STUDIO_HISTORY_DIR;
delete process.env.DSH_STUDIO_OPTIMIZER_DIR;
delete process.env.DSH_AGENTS_HOME;
const telemetryDir = join(fakeHome, "telemetry");
process.env.DSH_STUDIO_TELEMETRY_DIR = telemetryDir;

const { createOptimizer } = await import(modUrl("lib/optimizer.js"));
const { OPTIMIZER_DEFAULTS, optimizerRoot, resolveOptimizerConfig, inIdleWindow } = await import(modUrl("lib/optimizer-config.js"));
const { classifyChange } = await import(modUrl("lib/optimizer-classify.js"));
const { BUILTIN_REDLINES, checkRedlines, effectiveRedlines } = await import(modUrl("lib/skill-redlines.js"));
const { createHostModel, createBudget, callWithBudget, BudgetStop } = await import(modUrl("lib/optimizer-model.js"));
const { gateVerdict } = await import(modUrl("lib/optimizer-eval.js"));
const { readVersionRecords, rollbackSkill } = await import(modUrl("lib/versions.js"));
const { configureTelemetry } = await import(modUrl("lib/telemetry.js"));
const { buildOptimizerTools, buildOptimizerRoutes, OPTIMIZER_API } = await import(modUrl("lib/optimizer-tools.js"));
const { runWithWriteContext } = await import(modUrl("lib/write-context.js"));

const telemetry = configureTelemetry({ dir: telemetryDir });
const quiet = { info() {}, warn() {}, error() {} };
const dshSkills = join(fakeHome, ".dsh", "skills");
const agentSkills = join(fakeHome, ".agents", "skills");

test.after(async () => {
	await telemetry.flush();
	rmSync(fakeHome, { recursive: true, force: true });
});

// ── 夹具 ────────────────────────────────────────────────────────────────

/** 一份「真实形态」的技能：frontmatter、步骤、代码块、安全段（红线）。 */
function skillText(name, { step2 = "2. 写提交信息。", step1 = "1. 运行 `git status` 看改动。", extraSteps = [], description = "帮用户写 git 提交信息并提交", safety = "- 绝不使用 git push --force。" } = {}) {
	return [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		"---",
		"# 写提交信息",
		"",
		step1,
		step2,
		"3. 提交。",
		...extraSteps,
		"",
		"## 示例",
		"",
		"```text",
		"fix: 修正登录超时",
		"```",
		"",
		"## 安全",
		"",
		safety,
		""
	].join("\n");
}

function writeSkill(root, name, text) {
	mkdirSync(join(root, name), { recursive: true });
	const file = join(root, name, "SKILL.md");
	writeFileSync(file, text);
	return file;
}

/** 评估集：每条场景挂一个关键字，假评委按「技能文本里有没有这个关键字」打分。 */
const CASES = [
	{ id: "c1", scenario: "帮我写个提交信息", expect: "标题用祈使句", critical: true, kw: "祈使" },
	{ id: "c2", scenario: "提交信息要短", expect: "标题不超过 50 字", critical: false, kw: "50" },
	{ id: "c3", scenario: "先看改了什么再提交", expect: "先运行 git status", critical: true, kw: "git status" }
];
const KW = new Map(CASES.map((c) => [c.id, c.kw]));
const defaultJudge = (text, c) => (text.includes(KW.get(c.id) ?? "\u0000") ? 9 : 4);

const mut = (content, { summary = "改写", conflict = "none" } = {}) => `<summary>${summary}</summary>\n<conflict>${conflict}</conflict>\n<skill>\n${content}\n</skill>`;

function fakeModel({ mutations = [], judge = defaultJudge, delayMs = 0, usage = null } = {}) {
	const calls = [];
	return {
		calls,
		async complete(req) {
			calls.push({ purpose: req.purpose, label: req.meta?.label ?? null, mode: req.meta?.mode ?? null });
			if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
			let text = "";
			if (req.purpose === "cases") text = "```json\n" + JSON.stringify({ cases: CASES.map(({ kw, ...c }) => c) }) + "\n```";
			else if (req.purpose === "judge") text = JSON.stringify({ scores: req.meta.cases.map((c) => ({ id: c.id, score: judge(req.meta.skillText, c), reason: "fake" })) });
			else if (req.purpose === "mutate") {
				const fn = mutations.shift();
				text = typeof fn === "function" ? fn(req.meta) : typeof fn === "string" ? fn : mut(req.meta.skillText, { summary: "原样" });
			}
			return { text, usage };
		}
	};
}

const statsOf = (rows) => ({ stats: async () => ({ weeks: [{ skills: rows.map((r) => ({ skill: r[0], triggers: r[1], injections: 0, failures: r[2] ?? 0 })) }] }) });

function makeOptimizer({ model, rows = [], config = {}, now } = {}) {
	return createOptimizer({
		pluginConfig: { limits: { generations: 1, population: 2, maxModelCalls: 20, maxTokens: 1e6, maxDurationMs: 60_000 }, selection: { minUses: 1 }, ...config },
		model,
		telemetry: () => statsOf(rows),
		logger: quiet,
		...(now ? { now } : {})
	});
}

const recordsOf = async (name) => (await readVersionRecords()).filter((r) => r.name === name);
const discards = () => {
	const file = join(optimizerRoot(), "discards.jsonl");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// ── [1] 全链 + 低风险自动应用 + 劣化被挡 ─────────────────────────────────

test("[1] 全链：候选 → 变异 → 评估 → 低风险自动应用（带版本 + eval，可回滚）；故意做坏的变异被门挡下并留丢弃记录", async () => {
	const name = "commit-helper";
	const baseline = skillText(name);
	const file = writeSkill(dshSkills, name, baseline);
	const improved = skillText(name, { step2: "2. 写提交信息：标题用祈使句，不超过 50 字。" });
	const degraded = skillText(name, { step1: "1. 看一眼改动。" });
	const model = fakeModel({ mutations: [mut(improved, { summary: "第 2 步补上祈使句与长度要求" }), mut(degraded, { summary: "精简第 1 步" })] });
	const opt = makeOptimizer({ model, rows: [[name, 12, 3]] });
	const report = await opt.runRound({ trigger: "manual" });

	assert.equal(report.status, "completed");
	assert.equal(report.skills.length, 1);
	const s = report.skills[0];
	assert.equal(s.selection, "telemetry");
	assert.equal(s.outcome, "applied", JSON.stringify(s));
	assert.equal(s.tier, "low");
	assert.deepEqual(s.kinds, ["wording"]);
	assert.ok(s.after > s.before, `${s.before} → ${s.after}`);
	assert.equal(s.evalSet.generated, true, "第一次优化：按基线生成评估集并冻结");
	assert.ok(existsSync(s.evalSet.file));
	assert.deepEqual(model.calls.map((c) => c.purpose), ["cases", "judge", "mutate", "judge", "mutate", "judge"]);
	assert.equal(readFileSync(file, "utf8"), improved, "低风险候选已写盘");

	// 劣化变异：关键场景 c3 回退 → 门挡下，丢弃记录写明原因
	assert.equal(s.discards.length, 1);
	assert.equal(s.discards[0].kind, "gate");
	assert.ok(s.discards[0].reasons.some((r) => r.includes("关键场景 c3 回退")), s.discards[0].reasons.join("；"));
	const disc = discards().find((d) => d.id === s.discards[0].id);
	assert.ok(disc && disc.kind === "gate" && disc.overridable === true && existsSync(disc.candidateFile), "discards.jsonl 有完整记录（含候选正文）");

	// 版本记录：baseline + optimize（eval 带 before/after/verdict）
	const recs = await recordsOf(name);
	const opRec = recs.find((r) => r.action === "optimize");
	assert.ok(opRec, "出 action=optimize 版本记录");
	assert.equal(opRec.actor, "optimizer:auto");
	assert.equal(opRec.eval.verdict, "pass");
	assert.equal(opRec.eval.before, s.before);
	assert.equal(opRec.eval.after, s.after);
	assert.equal(opRec.eval.tier, "low");
	assert.equal(opRec.id, s.versionId);

	// 报告：计数 + 回滚入口；JSON 与 Markdown 都落盘
	assert.deepEqual({ a: report.counts.applied, p: report.counts.proposed, d: report.counts.discardedCandidates }, { a: 1, p: 0, d: 1 });
	assert.equal(s.rollback.tool, "skillmgr_rollback");
	assert.ok(existsSync(join(optimizerRoot(), "reports", report.roundId + ".json")));
	const md = readFileSync(join(optimizerRoot(), "reports", report.roundId + ".md"), "utf8");
	assert.ok(md.includes("自动应用 1") && md.includes("回滚入口") && md.includes("关键场景 c3 回退"), md);
	assert.ok(report.budget.calls === 6 && report.budget.tokens > 0, JSON.stringify(report.budget));

	// 回滚入口真能用
	const back = await rollbackSkill({ key: s.rollback.target, versionId: s.rollback.versionId, actor: "test" });
	assert.equal(back.ok, true);
	assert.equal(readFileSync(file, "utf8"), baseline, "回滚后回到基线");

	// 第二轮复用冻结的评估集（不再调 cases）
	const model2 = fakeModel({ mutations: [mut(improved), mut(improved)] });
	const opt2 = makeOptimizer({ model: model2, rows: [[name, 12, 3]] });
	const r2 = await opt2.runRound();
	assert.equal(r2.skills[0].evalSet.generated, false);
	assert.ok(!model2.calls.some((c) => c.purpose === "cases"));
});

// ── [2] 结构性 → 提案 ───────────────────────────────────────────────────

test("[2] 结构性改动只出提案；批准后出 optimize-approved 版本并可回滚；拒绝只标记；文件变了提案作废", async () => {
	const name = "release-notes";
	const baseline = skillText(name);
	const file = writeSkill(dshSkills, name, baseline);
	const structural = skillText(name, { step2: "2. 写提交信息：标题用祈使句，不超过 50 字。", extraSteps: ["4. 用 `git log -1` 复核。"] });
	const model = fakeModel({ mutations: [mut(baseline), mut(structural, { summary: "加一步复核" })] });
	const opt = makeOptimizer({ model, rows: [[name, 5, 0]] });
	const report = await opt.runRound();
	const s = report.skills[0];
	assert.equal(s.outcome, "proposed", JSON.stringify(s));
	assert.equal(s.tier, "structural");
	assert.ok(s.kinds.includes("steps"), s.kinds.join(","));
	assert.equal(readFileSync(file, "utf8"), baseline, "提案不写盘");
	assert.ok(s.discards.some((d) => d.kind === "static" && d.reasons[0].includes("完全相同")), "原样输出记 static 丢弃");
	assert.equal((await recordsOf(name)).filter((r) => r.action.startsWith("optimize")).length, 0);

	const status = await opt.status();
	assert.ok(status.proposals.some((p) => p.id === s.proposalId));

	// 待批准时同一技能不再重复出提案
	const again = await makeOptimizer({ model: fakeModel(), rows: [[name, 5, 0]] }).runRound();
	assert.equal(again.skills[0].outcome, "skipped");

	const decided = await runWithWriteContext({ actor: "panel" }, () => opt.decide({ id: s.proposalId, decision: "approve", reason: "看过了" }));
	assert.equal(decided.proposal.status, "approved");
	assert.equal(readFileSync(file, "utf8"), structural);
	const rec = (await recordsOf(name)).find((r) => r.action === "optimize-approved");
	assert.ok(rec && rec.actor === "panel" && rec.eval.proposalId === s.proposalId && rec.eval.after === s.after);
	await assert.rejects(() => opt.decide({ id: s.proposalId, decision: "approve" }), /已是 approved/);
	const back = await rollbackSkill({ key: decided.proposal.rollback.target, versionId: decided.proposal.rollback.versionId, actor: "test" });
	assert.equal(back.ok, true);
	assert.equal(readFileSync(file, "utf8"), baseline);

	// 拒绝 + 过期
	const name2 = "pr-helper";
	const base2 = skillText(name2);
	const file2 = writeSkill(dshSkills, name2, base2);
	const mk = () => makeOptimizer({ model: fakeModel({ mutations: [mut(base2), mut(skillText(name2, { step2: "2. 写提交信息：标题用祈使句，不超过 50 字。", extraSteps: ["4. 复核。"] }))] }), rows: [[name2, 5, 0]] });
	const p1 = (await mk().runRound()).skills[0].proposalId;
	const rej = await opt.decide({ id: p1, decision: "reject", reason: "不需要" });
	assert.equal(rej.proposal.status, "rejected");
	assert.equal(readFileSync(file2, "utf8"), base2);
	const p2 = (await mk().runRound()).skills[0].proposalId;
	writeFileSync(file2, base2 + "\n手工加的一行\n");
	await assert.rejects(() => opt.decide({ id: p2, decision: "approve" }), /提案作废/);
	assert.equal(JSON.parse(readFileSync(join(optimizerRoot(), "proposals", p2 + ".json"), "utf8")).status, "stale");
});

// ── [3] 红线 ────────────────────────────────────────────────────────────

test("[3] 红线：碰安全段 / 权限键直接丢弃（不评分、不出提案、不可放行）", async () => {
	const name = "redline-demo";
	const baseline = skillText(name);
	const file = writeSkill(dshSkills, name, baseline);
	const touchSafety = skillText(name, { step2: "2. 写提交信息：标题用祈使句，不超过 50 字。", safety: "- 必要时可以 git push --force。" });
	const addTools = baseline.replace("description:", "allowed-tools: Bash\ndescription:").replace("2. 写提交信息。", "2. 写提交信息：标题用祈使句，不超过 50 字。");
	const model = fakeModel({ mutations: [mut(touchSafety), mut(addTools)] });
	const report = await makeOptimizer({ model, rows: [[name, 5, 0]] }).runRound();
	const s = report.skills[0];
	assert.equal(s.outcome, "discarded");
	assert.deepEqual(s.discards.map((d) => d.kind), ["redline", "redline"]);
	assert.ok(s.discards[0].reasons.some((r) => r.includes("section")), s.discards[0].reasons.join("；"));
	assert.ok(s.discards[1].reasons.some((r) => r.includes("allowed-tools")), s.discards[1].reasons.join("；"));
	assert.equal(model.calls.filter((c) => c.purpose === "judge").length, 1, "红线候选不进评估（只有基线打了一次分）");
	assert.equal(readFileSync(file, "utf8"), baseline);
	const disc = discards().find((d) => d.id === s.discards[0].id);
	assert.equal(disc.overridable, false);
	const opt = makeOptimizer({ model: fakeModel() });
	await assert.rejects(() => opt.override({ discardId: disc.id, reason: "我就要" }), /红线类丢弃不可放行/);
});

// ── [4] 点名放行 ────────────────────────────────────────────────────────

test("[4] 所有者点名放行未过门候选：必须写理由；留 overrides 记录 + optimize-override 版本；不能重复放行", async () => {
	const name = "override-demo";
	const baseline = skillText(name);
	const file = writeSkill(dshSkills, name, baseline);
	const degraded = skillText(name, { step1: "1. 看一眼改动。" });
	const report = await makeOptimizer({ model: fakeModel({ mutations: [mut(degraded), mut(degraded + "\n")] }), rows: [[name, 5, 0]] }).runRound();
	const gateDisc = report.skills[0].discards.find((d) => d.kind === "gate");
	assert.ok(gateDisc);
	const opt = makeOptimizer({ model: fakeModel() });
	await assert.rejects(() => opt.override({ discardId: gateDisc.id, reason: "" }), /必须写理由/);
	const res = await runWithWriteContext({ actor: "panel" }, () => opt.override({ discardId: gateDisc.id, reason: "这一版我手工核过，c3 场景用不到" }));
	assert.equal(res.ok, true);
	assert.equal(readFileSync(file, "utf8").trim(), degraded.trim());
	const rec = (await recordsOf(name)).find((r) => r.action === "optimize-override");
	assert.ok(rec && rec.eval.verdict === "override" && rec.reason.includes("手工核过") && rec.actor === "panel");
	const log = readFileSync(join(optimizerRoot(), "overrides.jsonl"), "utf8");
	assert.ok(log.includes(gateDisc.id) && log.includes("手工核过"));
	await assert.rejects(() => opt.override({ discardId: gateDisc.id, reason: "再来" }), /已在 .* 放行过/);
});

// ── [5] 上限 ────────────────────────────────────────────────────────────

test("[5] 次数 / token / 时长上限：到顶自动停轮，报告写明是哪一项，进行中的技能不改动", async () => {
	const name = "budget-demo";
	const baseline = skillText(name);
	const file = writeSkill(dshSkills, name, baseline);
	const better = skillText(name, { step2: "2. 写提交信息：标题用祈使句，不超过 50 字。" });

	const byCalls = await makeOptimizer({ model: fakeModel({ mutations: [mut(better)] }), rows: [[name, 5, 0]], config: { limits: { maxModelCalls: 2, maxTokens: 1e6, maxDurationMs: 60_000 } } }).runRound();
	assert.equal(byCalls.status, "budget-stop");
	assert.equal(byCalls.stop.limit, "calls");
	assert.equal(byCalls.skills[0].outcome, "stopped");
	assert.equal(byCalls.budget.calls, 2);
	assert.equal(readFileSync(file, "utf8"), baseline);
	assert.ok(byCalls.markdown.includes("budget-stop") && byCalls.markdown.includes("calls"));

	const byTokens = await makeOptimizer({ model: fakeModel({ usage: { inputTokens: 900, outputTokens: 200 } }), rows: [[name, 5, 0]], config: { limits: { maxModelCalls: 50, maxTokens: 1000, maxDurationMs: 60_000 } } }).runRound();
	assert.equal(byTokens.status, "budget-stop");
	assert.equal(byTokens.stop.limit, "tokens");
	assert.equal(byTokens.budget.tokens, 1100, "token 按宿主 usage 计");

	const t0 = Date.now();
	const byTime = await makeOptimizer({ model: fakeModel({ delayMs: 400 }), rows: [[name, 5, 0]], config: { limits: { maxModelCalls: 50, maxTokens: 1e6, maxDurationMs: 150 } } }).runRound();
	assert.equal(byTime.status, "budget-stop");
	assert.equal(byTime.stop.limit, "duration");
	assert.ok(Date.now() - t0 < 1500, "进行中的慢调用到点就放弃，不等它跑完");
	assert.equal(readFileSync(file, "utf8"), baseline);

	// 预算本身的单元行为
	const clock = { t: 0 };
	const b = createBudget({ maxModelCalls: 1, maxTokens: 10, maxDurationMs: 100 }, () => clock.t);
	b.check();
	b.charge(null, 8);
	assert.throws(() => b.check(), (e) => e instanceof BudgetStop && e.limit === "calls");
	const b2 = createBudget({ maxModelCalls: 9, maxTokens: 1e6, maxDurationMs: 100 }, () => clock.t);
	clock.t = 100;
	await assert.rejects(() => callWithBudget(fakeModel(), b2, { purpose: "judge", prompt: "x", meta: { cases: [] } }), (e) => e instanceof BudgetStop && e.limit === "duration");
});

// ── [6] 冲突 ────────────────────────────────────────────────────────────

test("[6] 冲突迹象停手报告：模型报告职责冲突 / 同名技能多处存在 / 本轮期间文件被改——都不写盘、不裁决", async () => {
	const name = "conflict-demo";
	const baseline = skillText(name);
	const file = writeSkill(dshSkills, name, baseline);
	writeSkill(dshSkills, "git-commit", skillText("git-commit", { description: "帮用户写 git 提交信息" }));
	const r1 = await makeOptimizer({ model: fakeModel({ mutations: [mut(baseline, { conflict: "与 git-commit 的职责重叠：两者都负责写提交信息" })] }), rows: [[name, 5, 0], ["other", 4, 0]], config: { limits: { maxSkills: 2, generations: 1, population: 2, maxModelCalls: 20, maxTokens: 1e6, maxDurationMs: 60_000 } } }).runRound();
	assert.equal(r1.status, "conflict-stop");
	assert.equal(r1.skills.length, 1, "停在第一个冲突，不再处理后面的技能");
	assert.equal(r1.skills[0].conflict.signal, "model-reported");
	assert.ok(r1.skills[0].conflict.peers.includes("git-commit"), "相邻技能已喂给模型做自查");
	assert.equal(readFileSync(file, "utf8"), baseline);

	const dup = "dup-demo";
	writeSkill(dshSkills, dup, skillText(dup));
	writeSkill(agentSkills, dup, skillText(dup, { step2: "2. 另一份。" }));
	const r2 = await makeOptimizer({ model: fakeModel(), rows: [[dup, 5, 0]] }).runRound();
	assert.equal(r2.status, "conflict-stop");
	assert.equal(r2.skills[0].conflict.signal, "duplicate-name");

	const changing = "changing-demo";
	const base3 = skillText(changing);
	const file3 = writeSkill(dshSkills, changing, base3);
	const better = skillText(changing, { step2: "2. 写提交信息：标题用祈使句，不超过 50 字。" });
	const sneaky = fakeModel({
		mutations: [
			() => {
				writeFileSync(file3, base3 + "\n别人刚改的\n");
				return mut(better);
			}
		]
	});
	const r3 = await makeOptimizer({ model: sneaky, rows: [[changing, 5, 0]], config: { limits: { generations: 1, population: 1, maxModelCalls: 20, maxTokens: 1e6, maxDurationMs: 60_000 } } }).runRound();
	assert.equal(r3.status, "conflict-stop");
	assert.equal(r3.skills[0].conflict.signal, "changed-during-round");
	assert.ok(readFileSync(file3, "utf8").includes("别人刚改的"), "不覆盖别人的改动");
});

// ── [7] 候选挑选 ────────────────────────────────────────────────────────

test("[7] 候选只来自遥测：高频 + 高失败率优先；低于门槛 / 排除名单 / 无遥测的不进；真实遥测模块端到端", async () => {
	for (const n of ["hot", "flaky", "rare"]) writeSkill(dshSkills, n, skillText(n));
	for (let i = 0; i < 10; i++) await telemetry.record("skill.trigger", { sid: "s1", skill: "hot", via: "skill-tool", ok: true });
	for (let i = 0; i < 4; i++) await telemetry.record("skill.trigger", { sid: "s1", skill: "flaky", via: "skill-tool", ok: i >= 2, err: i >= 2 ? undefined : "timeout" });
	await telemetry.record("skill.trigger", { sid: "s1", skill: "rare", via: "skill-tool", ok: true });
	for (let i = 0; i < 5; i++) await telemetry.record("skill.trigger", { sid: "s1", skill: "darwin-skill", via: "skill-tool", ok: true });
	await telemetry.flush();
	const { getTelemetry } = await import(modUrl("lib/telemetry.js"));
	const opt = createOptimizer({ pluginConfig: {}, model: fakeModel(), telemetry: () => getTelemetry(), logger: quiet });
	const sel = await opt.selectCandidates();
	assert.deepEqual(sel.picked.map((p) => p.skill), ["flaky", "hot"], JSON.stringify(sel.picked));
	assert.ok(sel.picked[0].failureRate === 0.5 && sel.picked[0].priority === 24);
	assert.ok(sel.ignored.some((i) => i.skill === "rare" && i.why.includes("门槛")));
	assert.ok(sel.ignored.some((i) => i.skill === "darwin-skill" && i.why.includes("排除")));
	assert.ok(!sel.picked.some((p) => p.skill === "commit-helper"), "没有遥测的技能不进候选");

	const empty = await makeOptimizer({ model: fakeModel(), rows: [] }).runRound();
	assert.equal(empty.status, "no-candidates");
	assert.ok(empty.markdown.includes("无遥测的技能不进自动优化"));
	// 手动点名一个无遥测的技能：标为 manual（所有者明确要求，不是自动轮次）
	const manual = await makeOptimizer({ model: fakeModel(), rows: [] }).selectCandidates("rare-unknown");
	assert.equal(manual.picked[0].selection, "manual");
});

// ── [8] 节奏 ────────────────────────────────────────────────────────────

test("[8] 闲时节奏：默认关；开了也要在窗口内、空闲够久、距上一轮够远才跑", async () => {
	assert.equal(OPTIMIZER_DEFAULTS.enabled, false, "自动轮次默认关");
	const at = (h, m = 0, d = 16) => new Date(2026, 10, d, h, m).getTime();
	assert.equal(inIdleWindow({ start: "02:00", end: "06:00" }, at(3)), true);
	assert.equal(inIdleWindow({ start: "02:00", end: "06:00" }, at(7)), false);
	assert.equal(inIdleWindow({ start: "23:00", end: "05:00" }, at(1)), true, "跨午夜窗口");
	assert.equal(inIdleWindow({ start: "23:00", end: "05:00" }, at(12)), false);

	// 独立数据目录：前面几条用例的轮次写过 state.json（lastRoundAt），这里要从零开始数间隔
	process.env.DSH_STUDIO_OPTIMIZER_DIR = join(fakeHome, "optimizer-tick");
	const clock = { t: at(12, 0, 15) };
	const model = fakeModel();
	const off = createOptimizer({ pluginConfig: {}, model, telemetry: () => statsOf([]), logger: quiet, now: () => clock.t });
	assert.equal((await off.tick()).reason, "disabled");

	const on = createOptimizer({ pluginConfig: { enabled: true, checkEveryMinutes: 0, idleMinutes: 30, minIntervalHours: 20 }, model, telemetry: () => statsOf([]), logger: quiet, now: () => clock.t });
	assert.equal((await on.tick()).reason, "outside-window");
	clock.t = at(3);
	on.noteActivity(at(2, 50));
	assert.equal((await on.tick()).reason, "busy");
	clock.t = at(3, 30);
	const ran = await on.tick();
	assert.equal(ran.ran, true);
	assert.equal(ran.status, "no-candidates");
	clock.t = at(4, 30);
	assert.equal((await on.tick()).reason, "too-soon");
	assert.equal(model.calls.length, 0);
	delete process.env.DSH_STUDIO_OPTIMIZER_DIR;
});

// ── [9] 分级规则与红线清单 ──────────────────────────────────────────────

test("[9] G3 分级（配置驱动）与红线清单（内置不可删，只能追加）", async () => {
	const { config } = resolveOptimizerConfig({}, null);
	const red = effectiveRedlines(config.redlines);
	const base = skillText("cls");
	const cls = (after, cfg = config) => classifyChange(base, after, cfg, red);
	assert.deepEqual(cls(skillText("cls", { step2: "2. 认真写提交信息。" })).kinds, ["wording"]);
	assert.equal(cls(skillText("cls", { step2: "2. 认真写提交信息。" })).tier, "low");
	const reordered = base.replace("1. 运行 `git status` 看改动。\n2. 写提交信息。", "2. 写提交信息。\n1. 运行 `git status` 看改动。");
	assert.deepEqual(cls(reordered).kinds, ["order"]);
	assert.equal(cls(base.replace("fix: 修正登录超时", "feat: 新增导出")).tier, "low", "改示例 = 低风险");
	assert.equal(cls(base.replace("fix: 修正登录超时", "feat: 新增导出")).kinds[0], "example");
	assert.equal(cls(skillText("cls", { extraSteps: ["4. 推送。"] })).tier, "structural");
	assert.ok(cls(skillText("cls", { extraSteps: ["4. 推送。"] })).kinds.includes("steps"));
	assert.ok(cls(base.replace("2. 写提交信息。", "2. 用 `skillmgr_save` 写提交信息。")).kinds.includes("tools"));
	assert.ok(cls(base.replace("description:", "when_to_use: 提交前\ndescription:")).kinds.includes("trigger"));
	assert.equal(cls(skillText("cls", { description: "帮用户写好 git 提交信息并提交" })).tier, "low", "description 润色");
	assert.ok(cls(skillText("cls", { description: "部署到生产环境" })).kinds.includes("trigger"), "description 面目全非 = 改触发条件");
	assert.ok(cls(base.replace("description:", "metadata:\n  group: 写作\ndescription:")).kinds.includes("frontmatter"));
	// 规则可改：把 order 划为结构性
	const strict = resolveOptimizerConfig({ autonomy: { lowRisk: ["wording"], structural: ["order", "steps"] } }, null).config;
	assert.equal(cls(reordered, strict).tier, "structural");
	// 未知 kind 一律从严
	const noFormat = resolveOptimizerConfig({ autonomy: { lowRisk: ["wording"], structural: [] } }, null).config;
	assert.equal(cls(base.replace("fix: 修正登录超时", "feat: 新增导出"), noFormat).tier, "structural");

	// 红线清单：内置项永远在；配置只能追加
	const extra = effectiveRedlines({ extraHeadingPatterns: ["发布流程"], extraFrontmatterKeys: ["owner"] });
	for (const k of BUILTIN_REDLINES.frontmatterKeys) assert.ok(extra.frontmatterKeys.includes(k));
	assert.ok(extra.frontmatterKeys.includes("owner") && extra.headingPatterns.includes("发布流程"));
	const fileCfg = resolveOptimizerConfig({}, { redlines: { extraLinePatterns: ["内部域名"] } }).config;
	assert.deepEqual(fileCfg.redlines.extraLinePatterns, ["内部域名"]);
	// 红线检查本身：权限句（段外）也受保护；新增禁令行也算违反
	const withRule = base.replace("3. 提交。", "3. 提交。\n不得跳过 pre-commit 钩子。");
	assert.equal(checkRedlines(withRule, withRule.replace("不得跳过 pre-commit 钩子。", "跳过 pre-commit 也行。"), red).ok, false);
	assert.equal(checkRedlines(base, withRule, red).ok, false, "新增红线内容同样拦下");
	assert.equal(checkRedlines(base, reordered, red).ok, true);
	// 门本身
	const mk = (scores) => ({ mean: scores.reduce((a, b) => a + b.s, 0) / scores.length, cases: scores.map((x) => ({ id: x.id, critical: x.c, score: x.s })) });
	const g = config.gate;
	assert.equal(gateVerdict(mk([{ id: "a", c: true, s: 8 }, { id: "b", c: false, s: 4 }]), mk([{ id: "a", c: true, s: 7 }, { id: "b", c: false, s: 9 }]), g).pass, false, "关键场景回退 1 分也不行");
	assert.equal(gateVerdict(mk([{ id: "a", c: true, s: 8 }]), mk([{ id: "a", c: true, s: 8 }]), g).pass, true, "持平过门（不低于基线）");
	assert.equal(gateVerdict(mk([{ id: "a", c: true, s: 8 }]), { mean: 0, cases: [{ id: "a", critical: true, score: null }] }, g).pass, false, "缺分不过");
});

// ── [10] 宿主接线 + 工具 / 路由 ─────────────────────────────────────────

test("[10] 宿主 ctx.llm 接线：usage 分片计入预算；三个工具与五条路由可用，放行只在面板路由上", async () => {
	const seen = [];
	const fakeLlm = {
		listProviders: () => [{ id: "p" }],
		listModels: async () => ["m"],
		prepareCall: async (config) => ({
			config,
			stream: async function* (options) {
				seen.push({ config, system: options.system });
				yield { type: "text-delta", text: '{"scores":[]}' };
				yield { type: "usage", usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 50 } };
				yield { type: "finish", reason: { kind: "stop" } };
			}
		})
	};
	const host = createHostModel({ llm: fakeLlm, agent: () => null, routeConfig: async () => ({ provider: "p", model: "m" }) });
	const budget = createBudget({ maxModelCalls: 5, maxTokens: 1e6, maxDurationMs: 60_000 });
	const textOut = await callWithBudget(host, budget, { purpose: "judge", system: "S", prompt: "P", maxTokens: 100 });
	assert.equal(textOut, '{"scores":[]}');
	assert.equal(budget.snapshot().tokens, 200, "输入 + 缓存读 + 输出");
	assert.equal(seen[0].config.provider, "p");
	assert.equal(seen[0].system, "S");

	const opt = makeOptimizer({ model: fakeModel(), rows: [] });
	const tools = new Map(buildOptimizerTools({ optimizer: opt }).map((t) => [t.name, t]));
	assert.deepEqual([...tools.keys()], ["skillmgr_optimize_status", "skillmgr_optimize_run", "skillmgr_darwin_submit", "skillmgr_optimize_decide"]);
	assert.ok(![...tools.keys()].some((n) => n.includes("override")), "模型工具没有点名放行入口");
	const st = await tools.get("skillmgr_optimize_status").execute({});
	assert.equal(st.ok, true);
	assert.ok(st.message.includes("未开启") && st.redlines.frontmatterKeys.includes("allowed-tools"));
	const run = await tools.get("skillmgr_optimize_run").execute({});
	assert.equal(run.status, "no-candidates");
	const bad = await tools.get("skillmgr_optimize_decide").execute({ id: "prop-x", decision: "approve" });
	assert.equal(bad.ok, false);

	const routes = buildOptimizerRoutes({ logger: quiet }, { optimizer: opt });
	assert.deepEqual(routes.map((r) => r.path), Object.values(OPTIMIZER_API));
	const call = async (path, method, body, remote = "127.0.0.1") => {
		const route = routes.find((r) => r.path === path.split("?")[0]);
		const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
		const req = { method, url: path, headers: { host: "127.0.0.1" }, socket: { remoteAddress: remote }, async *[Symbol.asyncIterator]() { yield* chunks; } };
		let status = 0;
		let payload = "";
		const res = { writeHead: (s) => (status = s), end: (p) => (payload = p) };
		await route.handler(req, res);
		return { status, body: JSON.parse(payload) };
	};
	const s1 = await call(OPTIMIZER_API.status, "GET");
	assert.equal(s1.status, 200);
	assert.equal(s1.body.config.enabled, false);
	const rep = await call(OPTIMIZER_API.report, "GET");
	assert.equal(rep.status, 200);
	assert.ok(rep.body.report.roundId.startsWith("opt-"));
	const ov = await call(OPTIMIZER_API.override, "POST", { discardId: "disc-none", reason: "x" });
	assert.equal(ov.status, 404);
	const remote = await call(OPTIMIZER_API.status, "GET", undefined, "10.0.0.8");
	assert.equal(remote.status, 403);
});

test("[11] 模型不可用：本轮 status=error、写明原因，技能不动", async () => {
	const name = "nomodel-demo";
	const baseline = skillText(name);
	const file = writeSkill(dshSkills, name, baseline);
	const broken = { async complete() { throw new Error("DSH 未配置任何模型供应商"); } };
	const r = await makeOptimizer({ model: broken, rows: [[name, 5, 0]] }).runRound();
	assert.equal(r.status, "error");
	assert.ok(r.stop.detail.includes("未配置任何模型供应商"), r.stop.detail);
	assert.equal(r.counts.errors, 1);
	assert.equal(readFileSync(file, "utf8"), baseline);
});

// ── ：自动应用后的回归监测 ───────────────────────────────────────

test("[#14] 自动应用后复评退化 → 自动回滚到应用前版本、留痕、此后只出提案；不退化的观察两轮结束、不被误回滚", async () => {
	const name = "regress-skill";
	const baseline = skillText(name, { description: "回归监测用例" });
	const file = writeSkill(dshSkills, name, baseline);
	const improved = skillText(name, { description: "回归监测用例", step2: "2. 写提交信息：标题用祈使句，不超过 50 字。" });
	// 第 1 轮：评估门照常，improved 过门、低风险自动应用
	const r1 = await makeOptimizer({ model: fakeModel({ mutations: [mut(improved, { summary: "补上祈使句与长度" })] }), rows: [[name, 9, 1]] }).runRound();
	const applied = r1.skills.find((s) => s.skill === name);
	assert.equal(applied.outcome, "applied", JSON.stringify(applied));
	assert.equal(readFileSync(file, "utf8"), improved);
	const before = applied.before;

	// 应用之后这个技能实际表现变差：复评时评委给应用版低分（应用前那版不受影响）
	const degradedJudge = (text, c) => (text === improved ? 2 : defaultJudge(text, c));
	const r2 = await makeOptimizer({ model: fakeModel({ judge: degradedJudge }), rows: [[name, 9, 1]] }).runRound();
	const row = r2.regression.find((r) => r.skill === name);
	assert.equal(row?.outcome, "rolled-back", JSON.stringify(r2.regression));
	assert.equal(r2.counts.rolledBack, 1);
	assert.equal(readFileSync(file, "utf8"), baseline, "回到应用前那一版");
	assert.equal(row.rolledBackTo, applied.rollback.versionId, "回滚目标就是应用前的版本指针");
	// 留痕：版本记录（何时、谁、因何分数、回到哪一版）+ 退化记录 + 报告 + status
	const rb = (await recordsOf(name)).find((r) => r.action === "rollback" && r.actor === "optimizer:regression");
	assert.ok(rb, "出 rollback 版本记录，actor=optimizer:regression");
	assert.equal(rb.rollbackOf, applied.rollback.versionId);
	assert.match(rb.reason, /回归监测.*复评退化.*应用前 [\d.]+ → 应用时 [\d.]+ → 现在 2/);
	const regs = readFileSync(join(optimizerRoot(), "regressions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const reg = regs.find((g) => g.skill === name);
	assert.equal(reg.appliedVersionId, applied.versionId);
	assert.equal(reg.rollbackVersionId, rb.id);
	assert.deepEqual(reg.scores, { beforeApply: before, atApply: applied.after, now: 2 });
	assert.ok(reg.reasons.length > 0);
	assert.match(r2.markdown, /回归监测[\s\S]*退化，已回滚/);
	const st = await makeOptimizer({ model: fakeModel(), rows: [] }).status();
	assert.ok(st.regression.recent.some((g) => g.skill === name), "status 里看得到退化回滚记录");
	assert.ok(Object.values(st.regression.blocked).some((b) => b.skill === name), "status 里看得到此后不再自动应用");

	// 回滚本身不再触发新一轮自动应用：同样的低风险改进再过门，只出提案
	const r3 = await makeOptimizer({ model: fakeModel({ mutations: [mut(improved, { summary: "再来一次" })] }), rows: [[name, 9, 1]] }).runRound();
	const again = r3.skills.find((s) => s.skill === name);
	assert.equal(again.outcome, "proposed", JSON.stringify(again));
	assert.equal(readFileSync(file, "utf8"), baseline, "没有被再次自动应用");
	const prop = JSON.parse(readFileSync(join(optimizerRoot(), "proposals", again.proposalId + ".json"), "utf8"));
	assert.match(prop.why, /退化.*回滚.*不再自动应用/);
	await makeOptimizer({ model: fakeModel(), rows: [] }).decide({ id: again.proposalId, decision: "reject", reason: "测试收尾" });

	// 不退化的技能：观察两轮后结束，文件不动
	const steadyName = "steady-skill";
	const steadyBase = skillText(steadyName, { description: "不退化用例" });
	const steadyFile = writeSkill(dshSkills, steadyName, steadyBase);
	const steadyBetter = skillText(steadyName, { description: "不退化用例", step2: "2. 写提交信息：标题用祈使句，不超过 50 字。" });
	const s1 = await makeOptimizer({ model: fakeModel({ mutations: [mut(steadyBetter)] }), rows: [[steadyName, 9, 1]] }).runRound();
	assert.equal(s1.skills[0].outcome, "applied");
	const s2 = await makeOptimizer({ model: fakeModel(), rows: [] }).runRound();
	assert.equal(s2.regression.find((r) => r.skill === steadyName)?.outcome, "ok");
	const s3 = await makeOptimizer({ model: fakeModel(), rows: [] }).runRound();
	assert.equal(s3.regression.find((r) => r.skill === steadyName)?.outcome, "confirmed", "连续两轮没退化，观察结束");
	assert.equal(readFileSync(steadyFile, "utf8"), steadyBetter, "不退化的不被误回滚");
	const s4 = await makeOptimizer({ model: fakeModel(), rows: [] }).runRound();
	assert.equal((s4.regression ?? []).some((r) => r.skill === steadyName), false, "结束观察后不再复评");
});

// ── ：darwin 无人值守提交走 G1 门 + G3 分级 ──────────────────────

test("[#15] darwin 无人值守提交：非最低档进待批不落地；最低档过门自动应用且留痕与优化回路一致；不过门不落地", async () => {
	const name = "darwin-target";
	const baseline = skillText(name, { description: "darwin 提交用例" });
	const file = writeSkill(dshSkills, name, baseline);
	const opt = makeOptimizer({ model: fakeModel(), rows: [] });

	// 结构性改动（加步骤）：过门也不落地，出现在待批列表
	const structural = skillText(name, { description: "darwin 提交用例", step2: "2. 写提交信息：标题用祈使句，不超过 50 字。", extraSteps: ["4. 用 `git log -1` 复核。"] });
	const r1 = await opt.submitCandidate({ skill: name, content: structural, summary: "加一步复核", source: "darwin" });
	const e1 = r1.skills[0];
	assert.equal(e1.outcome, "proposed", JSON.stringify(e1));
	assert.notEqual(e1.tier, "low");
	assert.equal(readFileSync(file, "utf8"), baseline, "非最低档不直接落地");
	const st = await opt.status();
	const pending = st.proposals.find((p) => p.id === e1.proposalId);
	assert.ok(pending, "出现在待批列表");
	assert.equal(pending.source, "darwin");
	await opt.decide({ id: e1.proposalId, decision: "reject", reason: "测试" });

	// 不过门（关键场景回退）：不落地，丢弃留记录
	const worse = skillText(name, { description: "darwin 提交用例", step1: "1. 看一眼改动。" });
	const r2 = await opt.submitCandidate({ skill: name, content: worse, summary: "精简第 1 步", source: "darwin" });
	assert.equal(r2.skills[0].outcome, "discarded");
	assert.ok(r2.skills[0].discards[0].reasons.some((x) => x.includes("关键场景")), JSON.stringify(r2.skills[0].discards));
	assert.equal(readFileSync(file, "utf8"), baseline, "不过门不落地");
	assert.equal(discards().find((d) => d.id === r2.skills[0].discards[0].id)?.source, "darwin");

	// 最低风险档（措辞）过门：自动应用；版本记录、评估信息、回归观察与优化回路同一口径
	const wording = skillText(name, { description: "darwin 提交用例", step2: "2. 写提交信息：标题用祈使句，不超过 50 字。" });
	const r3 = await opt.submitCandidate({ skill: name, content: wording, summary: "第 2 步补要求", source: "darwin" });
	const e3 = r3.skills[0];
	assert.equal(e3.outcome, "applied", JSON.stringify(e3));
	assert.equal(e3.tier, "low");
	assert.equal(readFileSync(file, "utf8"), wording);
	const rec = (await recordsOf(name)).find((r) => r.id === e3.versionId);
	assert.equal(rec.action, "optimize");
	assert.equal(rec.actor, "darwin:unattended");
	assert.equal(rec.eval.verdict, "pass");
	assert.equal(rec.eval.source, "darwin");
	assert.equal(rec.eval.before, e3.before);
	assert.equal(rec.eval.after, e3.after);
	assert.equal(e3.rollback.tool, "skillmgr_rollback");
	assert.ok(existsSync(join(optimizerRoot(), "reports", r3.roundId + ".json")), "与优化回路一样出报告");
	assert.match(r3.markdown, /darwin 无人值守提交/);
	const watching = (await opt.status()).regression.watching.find((w) => w.skill === name);
	assert.equal(watching?.source, "darwin", "进应用后回归监测");

	// 工具入口：参数不全拒收，不落地
	const tools = buildOptimizerTools({ optimizer: opt });
	const tool = tools.find((t) => t.name === "skillmgr_darwin_submit");
	assert.ok(tool, "注册了 skillmgr_darwin_submit");
	const bad = await tool.execute({ skill: name, content: "" }, {});
	assert.equal(bad.ok, false);
	assert.match(bad.message, /未落地/);
});
