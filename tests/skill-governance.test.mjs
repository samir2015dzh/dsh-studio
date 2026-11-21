/**
 * ：技能库治理（R6 合并提案 / G7 冲突检测 / G8 教训 / 展示未用 / G9 轮次报告）。
 *
 * 全在伪 HOME 里跑，技能库是合成夹具，模型一律是假模型（purpose = merge | cases | judge），离线、确定。
 *
 *   [1] 可合并的一对：候选证据（触发 / 步骤 / 工具 / 同会话共触发）、合并稿、两份差异、#3 门预演（两源分 + 合并稿分）→ 待批提案；
 *       批准 → 保留方出 governance-merge 新版本（溯源两个来源），来源 merge-archive 入回收站；查来源能看到去向；可回滚、可恢复
 *   [2] 预演不过门：gate-failed，留丢弃记录，不可批准；碰红线（丢了来源的禁令行）：blocked，不花评估调用
 *   [3] 冲突：同名多根 / 触发重叠 / 指令矛盾 / 工具冲突，证据原文与行号准确；修掉后下一轮标 resolved；增量检查只查相关对
 *   [4] 教训：遥测失败（引用到具体事件）/ #3 丢弃记录 / 所有者裁决过的冲突 → 补丁提案；重复合并计数、升版本；撤回留痕并出撤回提案
 *   [5] 无候选时不产出：没有提案、没有冲突、没有教训
 *   [6] 节奏与上限：默认关；预算到顶停轮、不写任何东西
 *   [7] 展示未用报告（按 MCP server × 会话、在库未触发技能）
 *   [8] 工具 / 路由经注册层可用；非 loopback 403
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-governance-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
delete process.env.DSH_STUDIO_HISTORY_DIR;
delete process.env.DSH_AGENTS_HOME;
const telemetryDir = join(fakeHome, "telemetry");
process.env.DSH_STUDIO_TELEMETRY_DIR = telemetryDir;

const { createGovernance } = await import(modUrl("lib/governance.js"));
const { GOVERNANCE_DEFAULTS } = await import(modUrl("lib/governance-config.js"));
const { loadLibrary, detectConflicts, discoverMergeCandidates, usageFromEvents, checkMergeRedlines } = await import(modUrl("lib/governance-scan.js"));
const { buildGovernanceTools, buildGovernanceRoutes, GOVERNANCE_API } = await import(modUrl("lib/governance-tools.js"));
const { readVersionRecords, rollbackSkill, onSkillVersion, versionedSkillWrite } = await import(modUrl("lib/versions.js"));
const { restoreTrash } = await import(modUrl("lib/trash.js"));
const { configureTelemetry } = await import(modUrl("lib/telemetry.js"));
const { effectiveRedlines } = await import(modUrl("lib/skill-redlines.js"));
const { runWithWriteContext } = await import(modUrl("lib/write-context.js"));

const telemetry = configureTelemetry({ dir: telemetryDir });
const quiet = { info() {}, warn() {}, error() {} };
const dshSkills = join(fakeHome, ".dsh", "skills");
const agentSkills = join(fakeHome, ".agents", "skills");

test.after(async () => {
	await telemetry.flush();
	rmSync(fakeHome, { recursive: true, force: true });
});

// ── 合成技能库 ───────────────────────────────────────────────────────────
const A_TEXT = [
	"---",
	"name: git-commit-helper",
	"description: 帮用户写 git 提交信息并提交改动，生成规范的 commit message",
	"---",
	"# Git 提交助手",
	"",
	"1. 运行 `git status` 查看改动",
	"2. 运行 `git diff` 阅读改动内容",
	"3. 按约定式提交写 commit message",
	"4. 执行 `git_commit` 提交",
	"",
	"## 安全",
	"",
	"- 提交前确认没有把密钥文件加进暂存区",
	""
].join("\n");
const B_TEXT = [
	"---",
	"name: commit-message-writer",
	"description: 帮用户写规范的 git commit message 并提交改动",
	"---",
	"# 提交信息撰写",
	"",
	"1. 运行 `git status` 查看改动",
	"2. 运行 `git diff` 查看改动内容",
	"3. 写约定式提交的 commit message",
	"4. 调用 `git_commit` 完成提交",
	"",
	"绝不使用 git push --force 覆盖远端",
	""
].join("\n");
const MERGED_TEXT = [
	"---",
	"name: git-commit-helper",
	"description: 帮用户写规范的 git 提交信息（commit message）并提交改动",
	"---",
	"# Git 提交助手",
	"",
	"1. 运行 `git status` 查看改动",
	"2. 运行 `git diff` 阅读改动内容",
	"3. 按约定式提交写 commit message",
	"4. 执行 `git_commit` 提交",
	"",
	"绝不使用 git push --force 覆盖远端",
	"",
	"## 安全",
	"",
	"- 提交前确认没有把密钥文件加进暂存区",
	""
].join("\n");
const WEATHER = "---\nname: weather-report\ndescription: 查询城市天气预报\n---\n# 天气\n\n1. 调用 `weather_api` 查天气\n";
const DEPLOY = "---\nname: deploy-prod\ndescription: 把服务部署到生产环境\n---\n# 生产部署\n\n1. 必须先跑 npm test 再部署\n2. 用 `rsync_push` 同步构建产物\n";
const QUICK = "---\nname: quick-deploy\ndescription: 临时快速发布一个预览版本到测试机\n---\n# 快速发布\n\n1. 不要先跑 npm test 再部署，直接发\n2. 避免使用 rsync_push，改用 scp\n";
const NOTES_A = "---\nname: notes-taker\ndescription: 把会议要点整理成笔记\n---\n# 笔记\n\n1. 列出要点\n";
const NOTES_B = "---\nname: notes-taker\ndescription: 记录读书笔记\n---\n# 读书笔记\n\n1. 摘录金句\n";

const put = (root, name, text) => {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), text);
	return join(root, name, "SKILL.md");
};
let caseNo = 0;
/** 每个测试一套干净的技能根 + 治理 / 优化回路数据目录 + 遥测目录。 */
function fresh(skills) {
	caseNo += 1;
	rmSync(dshSkills, { recursive: true, force: true });
	rmSync(agentSkills, { recursive: true, force: true });
	mkdirSync(dshSkills, { recursive: true });
	mkdirSync(agentSkills, { recursive: true });
	process.env.DSH_STUDIO_GOVERNANCE_DIR = join(fakeHome, "gov-" + caseNo);
	process.env.DSH_STUDIO_OPTIMIZER_DIR = join(fakeHome, "opt-" + caseNo);
	const files = {};
	for (const [root, name, text] of skills) files[name + (root === dshSkills ? "@dsh" : "")] = put(root, name, text);
	return files;
}
async function resetTelemetry(events = []) {
	await telemetry.flush();
	rmSync(telemetryDir, { recursive: true, force: true });
	for (const [type, fields] of events) telemetry.record(type, fields);
	await telemetry.flush();
}

function fakeModel({ merged = MERGED_TEXT, judge } = {}) {
	const calls = [];
	return {
		calls,
		async complete(req) {
			calls.push({ purpose: req.purpose, label: req.meta?.label ?? null });
			if (req.purpose === "merge") return { text: `<summary>把 commit-message-writer 并入 git-commit-helper</summary>\n<skill>\n${merged}</skill>` };
			if (req.purpose === "cases") return { text: JSON.stringify({ cases: [{ id: "c1", scenario: "帮我提交改动", expect: "先看 git status", critical: true }, { id: "c2", scenario: "写个 commit message", expect: "约定式提交", critical: false }] }) };
			if (req.purpose === "judge") {
				const label = req.meta?.label;
				const score = typeof judge === "function" ? judge(label) : label?.startsWith("merged") ? 8 : 7;
				return { text: JSON.stringify({ scores: req.meta.cases.map((c) => ({ id: c.id, score, reason: "fake" })) }) };
			}
			return { text: "" };
		}
	};
}
const gov = (model, pluginConfig = {}, extra = {}) => createGovernance({ pluginConfig, model, logger: quiet, ...extra });
const coTrigger = [
	["skill.trigger", { sid: "s1", skill: "git-commit-helper", ok: true }],
	["skill.trigger", { sid: "s1", skill: "commit-message-writer", ok: true }],
	["skill.trigger", { sid: "s2", skill: "git-commit-helper", ok: true }],
	["skill.trigger", { sid: "s2", skill: "commit-message-writer", ok: true }],
	["skill.trigger", { sid: "s3", skill: "git-commit-helper", ok: true }]
];

// ── [1] ──────────────────────────────────────────────────────────────────
test("[1] 可合并的一对 → 完整提案（证据 / 合并稿 / 差异 / 门预演）；批准后新版本溯源两个来源，来源入回收站可查去向", async () => {
	const files = fresh([[agentSkills, "git-commit-helper", A_TEXT], [dshSkills, "commit-message-writer", B_TEXT], [agentSkills, "weather-report", WEATHER]]);
	await resetTelemetry(coTrigger);
	const model = fakeModel();
	const g = gov(model);
	const r = await g.runRound({ only: ["merge"] });
	assert.equal(r.status, "completed", r.markdown);
	assert.equal(r.counts.mergeCandidates, 1, "只有这一对是候选（天气技能不相关）");
	assert.equal(r.counts.mergeProposals, 1);
	const [p] = await g.listProposals({ status: "pending" });
	assert.equal(p.type, "merge");
	assert.equal(p.keep.name, "git-commit-helper", "用得多的一方是保留方");
	assert.equal(p.drop.name, "commit-message-writer");
	// 证据
	assert.ok(p.evidence.trigger.sim > 0.3 && p.evidence.trigger.a.includes("git") && p.evidence.trigger.b.includes("commit"));
	assert.ok(p.evidence.steps.sim > 0.5 && p.evidence.steps.pairs.length > 0);
	assert.ok(p.evidence.tools.shared.includes("git_commit"), JSON.stringify(p.evidence.tools));
	assert.equal(p.evidence.coTrigger.sessions, 2, "s1 / s2 两个会话共触发");
	assert.ok(p.reasons.some((x) => x.includes("会话")));
	// 合并稿 + 两份差异
	assert.equal(readFileSync(p.candidateFile, "utf8"), MERGED_TEXT);
	assert.match(p.diff.keep, /^\+ 绝不使用 git push --force/m);
	assert.match(p.diff.drop, /^- name: commit-message-writer/m);
	// 门预演：两源分 + 合并稿分
	assert.equal(p.eval.verdict, "pass");
	assert.deepEqual([p.eval.keep.source, p.eval.keep.merged, p.eval.drop.source, p.eval.drop.merged], [7, 8, 7, 8]);
	assert.equal(model.calls.filter((c) => c.purpose === "judge").length, 4);
	assert.equal(p.redlines.ok, true);
	// 没有自动改任何东西
	assert.equal(readFileSync(files["git-commit-helper"], "utf8"), A_TEXT);
	assert.ok(existsSync(files["commit-message-writer@dsh"]));

	const res = await runWithWriteContext({ actor: "panel" }, () => g.decide({ id: p.id, decision: "approve", reason: "验收" }));
	const done = res.proposal;
	assert.equal(done.status, "approved");
	assert.equal(readFileSync(files["git-commit-helper"], "utf8"), MERGED_TEXT);
	assert.equal(existsSync(files["commit-message-writer@dsh"]), false, "来源移入回收站");
	const records = await readVersionRecords();
	const result = records.find((x) => x.id === done.versionId);
	assert.equal(result.action, "governance-merge");
	assert.deepEqual(result.merge.sources.map((s) => s.name), ["git-commit-helper", "commit-message-writer"]);
	assert.ok(result.merge.sources.every((s) => typeof s.key === "string" && typeof s.sha === "string"));
	assert.equal(result.eval.keep.after, 8);
	const archive = records.find((x) => x.id === done.archiveVersionId);
	assert.equal(archive.action, "merge-archive");
	assert.equal(archive.merge.into.versionId, done.versionId);
	assert.ok(archive.parent, "来源被合并前的那一版仍在版本链上");
	// 查来源 → 看得到合并去向
	const lin = await g.lineage("commit-message-writer");
	assert.ok(lin.some((x) => x.role === "source" && x.into.name === "git-commit-helper"));
	const st = await g.status({ skill: "commit-message-writer" });
	assert.ok(st.lineage.length >= 2);
	// 可回滚、可恢复
	await rollbackSkill({ key: done.rollback.target, versionId: done.rollback.versionId, reason: "验收回滚" });
	assert.equal(readFileSync(files["git-commit-helper"], "utf8"), A_TEXT);
	await restoreTrash(done.restore.id);
	assert.equal(readFileSync(files["commit-message-writer@dsh"], "utf8"), B_TEXT);
	// 同一对、同一内容不再重复出提案
	await assert.rejects(g.decide({ id: p.id, decision: "approve" }), /不能再处理/);
	const again = await g.runRound({ only: ["merge"] });
	assert.equal(again.counts.mergeProposals, 0);
	assert.equal(again.merges[0].outcome, "skipped");
});

test("[2] 预演不过门 → gate-failed + 丢弃记录、不可批准；合并稿丢了来源的禁令行 → blocked、不花评估调用", async () => {
	fresh([[agentSkills, "git-commit-helper", A_TEXT], [dshSkills, "commit-message-writer", B_TEXT]]);
	await resetTelemetry(coTrigger);
	const g1 = gov(fakeModel({ judge: (label) => (label === "merged@drop" ? 5 : 7) }));
	const r1 = await g1.runRound({ only: ["merge"] });
	assert.equal(r1.counts.mergeBlocked, 1);
	const p1 = (await g1.listProposals({ type: "merge" }))[0];
	assert.equal(p1.status, "gate-failed");
	assert.ok(p1.blockReasons.some((x) => x.startsWith("commit-message-writer：") && x.includes("平均分")), p1.blockReasons.join("；"));
	const disc = readFileSync(join(process.env.DSH_STUDIO_GOVERNANCE_DIR, "discards.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(disc[0].kind, "gate");
	await assert.rejects(g1.decide({ id: p1.id, decision: "approve" }), /gate-failed/);

	fresh([[agentSkills, "git-commit-helper", A_TEXT], [dshSkills, "commit-message-writer", B_TEXT]]);
	const model = fakeModel({ merged: MERGED_TEXT.replace("绝不使用 git push --force 覆盖远端\n\n", "") });
	const g2 = gov(model);
	await g2.runRound({ only: ["merge"] });
	const p2 = (await g2.listProposals({ type: "merge" }))[0];
	assert.equal(p2.status, "blocked");
	assert.ok(p2.blockReasons.some((x) => x.includes("removed") && x.includes("绝不使用")));
	assert.equal(model.calls.filter((c) => c.purpose === "judge" || c.purpose === "cases").length, 0, "碰红线直接拦，不花评估调用");
	// 纯函数：保留方的受保护 frontmatter 键必须原样
	const rules = effectiveRedlines({});
	assert.equal(checkMergeRedlines(A_TEXT, B_TEXT, MERGED_TEXT.replace("name: git-commit-helper", "name: other"), rules).ok, false);
	assert.equal(checkMergeRedlines(A_TEXT, B_TEXT, MERGED_TEXT, rules).ok, true);
});

// ── [3] ──────────────────────────────────────────────────────────────────
test("[3] 冲突检测：四类冲突、证据原文 / 行号准确；修掉后 resolved；增量只查相关对", async () => {
	const files = fresh([[agentSkills, "deploy-prod", DEPLOY], [agentSkills, "quick-deploy", QUICK], [agentSkills, "notes-taker", NOTES_A], [dshSkills, "notes-taker", NOTES_B], [agentSkills, "git-commit-helper", A_TEXT], [dshSkills, "commit-message-writer", B_TEXT]]);
	await resetTelemetry();
	const model = fakeModel();
	const g = gov(model);
	const r = await g.runRound({ only: ["conflicts"] });
	assert.equal(model.calls.length, 0, "冲突检测不调模型");
	const st = await g.status();
	const byType = (t) => st.conflicts.filter((c) => c.type === t);
	const contra = byType("contradiction");
	assert.equal(contra.length, 1);
	assert.deepEqual(contra[0].pair, ["deploy-prod", "quick-deploy"]);
	assert.equal(contra[0].evidence[0].quote, "1. 必须先跑 npm test 再部署");
	assert.equal(contra[0].evidence[1].quote, "1. 不要先跑 npm test 再部署，直接发");
	assert.equal(contra[0].evidence[0].line, 3, "正文第 3 行（frontmatter 之后）");
	const tool = byType("tool-conflict");
	assert.equal(tool.length, 1);
	assert.deepEqual(tool[0].pair, ["quick-deploy", "deploy-prod"]);
	assert.equal(tool[0].evidence[0].quote, "2. 避免使用 rsync_push，改用 scp");
	assert.equal(tool[0].evidence[1].quote, "2. 用 `rsync_push` 同步构建产物");
	const dup = byType("duplicate-name");
	assert.equal(dup.length, 1);
	assert.deepEqual(dup[0].pair, ["notes-taker", "notes-taker"]);
	assert.ok(dup[0].evidence[0].file !== dup[0].evidence[1].file);
	const overlap = byType("trigger-overlap");
	assert.ok(overlap.some((c) => c.pair.includes("git-commit-helper") && c.pair.includes("commit-message-writer")));
	assert.ok(st.conflicts.every((c) => c.suggestion?.note), "每条都有建议动作");
	assert.equal(r.counts.conflictsNew, r.counts.conflictsFound);
	assert.equal(readFileSync(files["quick-deploy"], "utf8"), QUICK, "只报告，不改技能");

	// 修掉矛盾与工具冲突 → 下一轮 resolved
	writeFileSync(files["quick-deploy"], "---\nname: quick-deploy\ndescription: 临时快速发布一个预览版本到测试机\n---\n# 快速发布\n\n1. 用 scp 发到测试机\n");
	const r2 = await g.runRound({ only: ["conflicts"] });
	assert.equal(r2.counts.conflictsResolved, 2);
	assert.equal((await g.status()).conflictCounts.resolved, 2);

	// 增量：新增一份和 deploy-prod 矛盾的技能，只查与它相关的对
	const nf = put(agentSkills, "hotfix", "---\nname: hotfix\ndescription: 紧急修复线上问题\n---\n# 热修\n\n1. 禁止先跑 npm test 再部署\n");
	const lib = await loadLibrary([dshSkills, agentSkills]);
	const key = lib.find((s) => s.name === "hotfix").key;
	const inc = await g.checkIncremental(key);
	assert.equal(inc.ran, true);
	assert.ok(inc.fresh.length >= 1);
	assert.ok(detectConflicts(lib, GOVERNANCE_DEFAULTS.conflicts, { focus: key }).every((c) => c.pair.some((x) => x.key === key)));
	// 审计 3：批量队列只 loadLibrary 一次，逐 key 输出与逐个单独检查逐项对拍
	{
		const keys = lib.slice(0, 4).map((s) => s.key).concat([key, "no-such-key"]);
		let loads = 0;
		const counting = gov(null, { incrementalConflicts: true }, { loadLibrary: async (roots) => (loads++, loadLibrary(roots)) });
		const batch = await counting.checkIncrementalBatch(keys);
		assert.equal(loads, 1, "一批只读一次技能库");
		loads = 0;
		const single = {};
		for (const k of keys) single[k] = await counting.checkIncremental(k);
		assert.equal(loads, keys.length, "旧路径：每个 key 各读一次");
		for (const k of keys) {
			assert.equal(batch[k].ran, single[k].ran, k);
			assert.equal(batch[k].found, single[k].found, k + " 检出数一致");
			assert.equal(batch[k].reason, single[k].reason, k);
		}
	}
	// 版本监听确实会在新版本落地后回调（去抖之外的那一层）
	const seen = [];
	const off = onSkillVersion((info) => seen.push(info));
	await versionedSkillWrite(nf, { action: "edit", reason: "test" }, async () => writeFileSync(nf, readFileSync(nf, "utf8") + "\n2. 发布\n"));
	await new Promise((r3) => setTimeout(r3, 30));
	off();
	assert.ok(seen.some((x) => x.name === "hotfix" && x.action === "edit"));
});

// ── [4] ──────────────────────────────────────────────────────────────────
test("[4] 教训：有来源才成立、引用到来源事件；出补丁提案；重复合并计数升版本；撤回留痕", async () => {
	const files = fresh([[agentSkills, "git-commit-helper", A_TEXT], [agentSkills, "deploy-prod", DEPLOY], [agentSkills, "quick-deploy", QUICK], [agentSkills, "weather-report", WEATHER]]);
	await resetTelemetry([
		["skill.trigger", { sid: "f1", skill: "git-commit-helper", ok: false, err: "timeout" }],
		["skill.trigger", { sid: "f2", skill: "git-commit-helper", ok: false, err: "timeout" }],
		["skill.trigger", { sid: "f3", skill: "git-commit-helper", ok: false, err: "timeout" }],
		["skill.trigger", { sid: "w1", skill: "weather-report", ok: false, err: "ECONNRESET" }]
	]);
	mkdirSync(process.env.DSH_STUDIO_OPTIMIZER_DIR, { recursive: true });
	writeFileSync(join(process.env.DSH_STUDIO_OPTIMIZER_DIR, "discards.jsonl"), JSON.stringify({ id: "disc-20261116-000000-abc", at: "2026-11-16T00:00:00.000Z", skill: "deploy-prod", kind: "gate", reasons: ["关键场景 c3 回退：9 → 4"] }) + "\n");
	const g = gov(fakeModel(), { limits: { maxLessonProposals: 5 } });
	await g.runRound({ only: ["conflicts"] });
	const contra = (await g.status()).conflicts.find((c) => c.type === "contradiction");
	await assert.rejects(g.decide({ id: contra.id, decision: "rule" }), /裁决必须写明/);
	await g.decide({ id: contra.id, decision: "rule", reason: "以 deploy-prod 为准，quick-deploy 只用于测试机" });

	const r = await g.runRound({ only: ["lessons"] });
	const st = await g.status();
	const tele = st.lessons.find((l) => l.skill === "git-commit-helper");
	assert.equal(tele.kind, "precheck");
	assert.equal(tele.count, 3);
	assert.equal(tele.sources.length, 3);
	assert.ok(tele.sources.every((s) => s.source === "telemetry" && /^events-\d{4}-\d{2}-\d{2}\.jsonl@/.test(s.ref) && s.err === "timeout"), JSON.stringify(tele.sources));
	assert.ok(!st.lessons.some((l) => l.skill === "weather-report"), "只失败 1 次（低于门槛 2）不成教训");
	const disc = st.lessons.find((l) => l.skill === "deploy-prod" && l.kind === "counterexample");
	assert.equal(disc.sources[0].ref, "disc-20261116-000000-abc");
	const ruling = st.lessons.filter((l) => l.sources[0]?.source === "conflict.ruling");
	assert.deepEqual(ruling.map((l) => l.skill).sort(), ["deploy-prod", "quick-deploy"]);
	assert.ok(ruling.every((l) => l.text.includes("以 deploy-prod 为准")));
	// 补丁提案：每个技能一份（频次高的优先），都只是提案
	assert.equal(r.counts.lessonProposals, 3, r.markdown);
	const props = await g.listProposals({ status: "pending" });
	const pGit = props.find((p) => p.skill === "git-commit-helper");
	assert.equal(pGit.type, "lesson");
	assert.equal(pGit.lessonIds[0], tele.id);
	assert.match(pGit.diff, /\+ ## 经验教训/);
	assert.match(pGit.diff, /\+ - \[前置检查\].*timeout.*<!-- lesson:lesson-\w+ v1 x3 -->/);
	assert.equal(pGit.tier, "structural");
	assert.equal(readFileSync(files["git-commit-helper"], "utf8"), A_TEXT, "提案不写盘");

	const ok = await g.decide({ id: pGit.id, decision: "approve" });
	assert.match(readFileSync(files["git-commit-helper"], "utf8"), /<!-- lesson:lesson-\w+ v1 x3 -->/);
	const rec = (await readVersionRecords()).find((x) => x.id === ok.proposal.versionId);
	assert.equal(rec.action, "lesson-patch");
	assert.equal(rec.lesson.ids[0], tele.id);
	assert.ok(rec.lesson.versions[0].sources.every((s) => s.startsWith("telemetry:")));

	// 同类失败再来两次 → 合并计数、升版本，出更新提案
	for (const sid of ["f4", "f5"]) telemetry.record("skill.trigger", { sid, skill: "git-commit-helper", ok: false, err: "timeout" });
	await telemetry.flush();
	await g.runRound({ only: ["lessons"] });
	const l2 = (await g.status()).lessons.find((l) => l.id === tele.id);
	assert.equal(l2.count, 5);
	assert.equal(l2.version, 2);
	const upd = (await g.listProposals({ status: "pending" })).find((p) => p.skill === "git-commit-helper");
	assert.match(upd.diff, /- - \[前置检查\].*v1 x3/);
	assert.match(upd.diff, /\+ - \[前置检查\].*v2 x5/);
	await g.decide({ id: upd.id, decision: "reject", reason: "先不更新" });

	// 撤回：留痕 + 已写入的出撤回提案，批准后那一行消失
	const appendix = "\n## 示例\n后续用户正文必须保留。\n\n## 附录\n不能随教训撤回。\n";
	writeFileSync(files["git-commit-helper"], readFileSync(files["git-commit-helper"], "utf8") + appendix);
	await assert.rejects(g.decide({ id: tele.id, decision: "withdraw" }), /要写理由/);
	const w = await g.decide({ id: tele.id, decision: "withdraw", reason: "超时是网络问题，不是技能问题" });
	assert.equal(w.lesson.status, "withdrawn");
	assert.ok(w.lesson.history.some((h) => h.change === "withdrawn" && h.reason.includes("网络")));
	assert.equal(w.proposal.type, "lesson-withdraw");
	const wd = await g.decide({ id: w.proposal.id, decision: "approve" });
	assert.doesNotMatch(readFileSync(files["git-commit-helper"], "utf8"), /lesson:/);
	assert.equal(readFileSync(files["git-commit-helper"], "utf8"), A_TEXT + appendix, "撤回只移除教训段，后续普通章节保持原样");
	assert.equal((await readVersionRecords()).find((x) => x.id === wd.proposal.versionId).action, "lesson-withdraw");
	// 撤回后再有同类证据：只记痕，不再出提案
	telemetry.record("skill.trigger", { sid: "f6", skill: "git-commit-helper", ok: false, err: "timeout" });
	await telemetry.flush();
	await g.runRound({ only: ["lessons"] });
	assert.ok(!(await g.listProposals({ status: "pending" })).some((p) => p.skill === "git-commit-helper"));
});

// ── [5] ──────────────────────────────────────────────────────────────────
test("[5] 无候选时不产出：没有提案、冲突、教训", async () => {
	fresh([[agentSkills, "weather-report", WEATHER], [agentSkills, "deploy-prod", DEPLOY]]);
	await resetTelemetry();
	const model = fakeModel();
	const g = gov(model);
	const r = await g.runRound();
	assert.equal(r.status, "no-candidates", r.markdown);
	assert.equal(model.calls.length, 0);
	assert.equal((await g.listProposals()).length, 0);
	const st = await g.status();
	assert.equal(st.conflicts.length, 0);
	assert.equal(st.lessons.length, 0);
	assert.match(r.markdown, /什么都没产出/);
});

// ── [6] ──────────────────────────────────────────────────────────────────
test("[6] 节奏：默认关；开了只在闲时；预算到顶停轮、不写技能、不出提案", async () => {
	assert.equal(GOVERNANCE_DEFAULTS.enabled, false);
	assert.equal(GOVERNANCE_DEFAULTS.limits.maxMergeProposals, 1);
	fresh([[agentSkills, "git-commit-helper", A_TEXT], [dshSkills, "commit-message-writer", B_TEXT]]);
	await resetTelemetry(coTrigger);
	let t = new Date(2026, 10, 16, 3, 0, 0).getTime();
	const g0 = gov(fakeModel(), {}, { now: () => t });
	assert.equal((await g0.tick()).reason, "disabled");
	const g1 = gov(fakeModel(), { enabled: true, checkEveryMinutes: 0 }, { now: () => t });
	assert.equal((await g1.tick()).reason, "busy");
	t += 31 * 60_000;
	const ran = await g1.tick();
	assert.equal(ran.ran, true);
	t += 60_000;
	assert.equal((await g1.tick()).reason, "too-soon");
	const g2 = gov(fakeModel(), { enabled: true, idleWindow: { start: "12:00", end: "13:00" }, checkEveryMinutes: 0 }, { now: () => t + 3600_000 });
	assert.equal((await g2.tick()).reason, "outside-window");

	fresh([[agentSkills, "git-commit-helper", A_TEXT], [dshSkills, "commit-message-writer", B_TEXT]]);
	const g3 = gov(fakeModel(), { limits: { maxModelCalls: 2 } });
	const r = await g3.runRound({ only: ["merge"] });
	assert.equal(r.status, "budget-stop");
	assert.equal(r.stop.limit, "calls");
	assert.equal((await g3.listProposals({ status: "pending" })).length, 0);
	assert.equal(r.merges[0].outcome, "stopped");
});

// ── [7] ──────────────────────────────────────────────────────────────────
test("[7] 展示未用报告：MCP 按 server × 会话；技能按在库未触发", async () => {
	fresh([[agentSkills, "git-commit-helper", A_TEXT], [agentSkills, "weather-report", WEATHER]]);
	await resetTelemetry([
		["catalog.outcome", { sid: "u1", turn: 1, shown: ["docbase", "memory-bank"], used: ["memory-bank"], unused: ["docbase"] }],
		["catalog.outcome", { sid: "u1", turn: 2, shown: ["docbase"], used: [], unused: ["docbase"] }],
		["catalog.outcome", { sid: "u2", turn: 1, shown: ["docbase"], used: ["docbase"], unused: [] }],
		["skill.trigger", { sid: "u1", skill: "git-commit-helper", ok: true }]
	]);
	const g = gov(fakeModel());
	const r = await g.runRound({ only: ["unused"] });
	const ms = r.unused.mcp.find((m) => m.server === "docbase");
	assert.deepEqual([ms.shownTurns, ms.usedTurns, ms.unusedTurns], [3, 1, 2]);
	assert.deepEqual(ms.scenarios, [{ sid: "u1", turns: 2 }]);
	assert.ok(!r.unused.mcp.some((m) => m.server === "memory-bank"));
	assert.deepEqual(r.unused.skills.map((s) => s.skill), ["weather-report"]);
	assert.match(r.markdown, /展示未用/);
});

// ── [8] ──────────────────────────────────────────────────────────────────
test("[8] 工具 / 路由经注册层可用；路由只认 loopback", async () => {
	fresh([[agentSkills, "git-commit-helper", A_TEXT], [dshSkills, "commit-message-writer", B_TEXT]]);
	await resetTelemetry(coTrigger);
	const g = gov(fakeModel());
	const tools = Object.fromEntries(buildGovernanceTools({ governance: g }).map((t) => [t.name, t]));
	assert.deepEqual(Object.keys(tools), ["skillmgr_governance_status", "skillmgr_governance_run", "skillmgr_governance_decide"]);
	const run = await tools.skillmgr_governance_run.execute({ only: ["merge", "conflicts"] }, {});
	assert.equal(run.ok, true, run.message);
	assert.match(run.message, /合并提案 1/);
	const s = await tools.skillmgr_governance_status.execute({}, {});
	assert.match(s.message, /待批准提案/);
	const pid = s.proposals[0].id;
	const bad = await tools.skillmgr_governance_decide.execute({ id: "nope", decision: "approve" }, {});
	assert.equal(bad.ok, false);
	const okRes = await tools.skillmgr_governance_decide.execute({ id: pid, decision: "reject", reason: "不合" }, {});
	assert.match(okRes.message, /已拒绝/);

	const routes = buildGovernanceRoutes({ logger: quiet }, { governance: g });
	assert.deepEqual(routes.map((r) => r.path), Object.values(GOVERNANCE_API));
	const call = async (path, method, body, remote = "127.0.0.1") => {
		const route = routes.find((r) => r.path === path);
		const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
		const req = { method, url: path, headers: { host: "127.0.0.1" }, socket: { remoteAddress: remote }, [Symbol.asyncIterator]: async function* () { yield* chunks; }, on(ev, fn) { if (ev === "data") for (const c of chunks) fn(c); if (ev === "end") fn(); return this; } };
		let status = 0;
		let out = "";
		const res = { statusCode: 200, setHeader() {}, writeHead(c) { status = c; return this; }, end(d) { out = String(d ?? ""); if (!status) status = this.statusCode; } };
		await route.handler(req, res);
		return { status: status || res.statusCode, body: out ? JSON.parse(out) : null };
	};
	assert.equal((await call(GOVERNANCE_API.status, "GET", undefined, "10.0.0.2")).status, 403);
	const st = await call(GOVERNANCE_API.status, "GET");
	assert.equal(st.status, 200);
	assert.equal(st.body.ok, true);
	const rep = await call(GOVERNANCE_API.report, "GET");
	assert.equal(rep.status, 200);
	assert.match(rep.body.markdown, /技能库治理报告/);
});

// ── · A3 ─────────────────────────────────────────────────────────
test("[A3] 同名技能合并：被并方用自己的评估集，不吃保留方那份", async () => {
	const SAME_B = B_TEXT.replace("name: commit-message-writer", "name: git-commit-helper");
	fresh([[agentSkills, "git-commit-helper", A_TEXT], [dshSkills, "git-commit-helper", SAME_B]]);
	await resetTelemetry(coTrigger);
	const base = fakeModel();
	const casesFor = [];
	const model = {
		calls: base.calls,
		async complete(req) {
			if (req.purpose === "cases") casesFor.push(req.meta?.skillText ?? "");
			return base.complete(req);
		}
	};
	const g = gov(model);
	const r = await g.runRound({ only: ["merge"] });
	assert.equal(r.counts.mergeProposals, 1, r.markdown);
	const [p] = await g.listProposals({ type: "merge" });
	assert.equal(p.keep.name, p.drop.name, "前提：同名的两份");
	assert.notEqual(p.keep.key, p.drop.key);
	assert.equal(casesFor.length, 2, "两份各生成一套评估场景（旧码第二份直接读到第一份的文件）");
	assert.ok(casesFor.includes(A_TEXT) && casesFor.includes(SAME_B), "场景分别依据两份各自的正文生成");
	// 落盘的只有一份（evals/<名字>.json 属于先占着它的那份），另一份只在内存里用、不覆盖
	const evalsDir = join(process.env.DSH_STUDIO_OPTIMIZER_DIR, "evals");
	const files = readdirSync(evalsDir);
	assert.equal(files.length, 1);
	const stored = JSON.parse(readFileSync(join(evalsDir, files[0]), "utf8"));
	const transientSide = stored.key === p.keep.key ? "drop" : "keep";
	assert.equal(p.eval[transientSide].suite, null, "未落盘的那份不冒充文件路径");
	assert.ok(typeof p.eval[transientSide === "drop" ? "keep" : "drop"].suite === "string");
});
