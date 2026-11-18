#!/usr/bin/env node
/**
 * 优化回路离线演示（假模型，临时 HOME，不联网、不碰真实 ~/.dsh / ~/.dsh-studio）。
 *
 *   node scripts/optimizer-demo.mjs [--keep]
 *
 * 依次演示：
 *   ① 全链 + 低风险自动应用 + 故意做坏的变异被评估门挡下（丢弃记录）+ 回滚
 *   ② 结构性改动只出提案 → 批准 → optimize-approved 版本 → 回滚
 *   ③ 次数 / token / 时长上限触发自动停轮
 * 每段打印本轮报告（Markdown）。--keep 保留临时目录，便于翻 reports/ discards.jsonl / 版本史。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "dsh-optimizer-demo-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, ".dsh");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(home, "telemetry");
delete process.env.DSH_STUDIO_HISTORY_DIR;
delete process.env.DSH_STUDIO_OPTIMIZER_DIR;
delete process.env.DSH_AGENTS_HOME;
const lib = (name) => import(pathToFileURL(join(root, "lib", name)).href);
const { createOptimizer } = await lib("optimizer.js");
const { rollbackSkill } = await lib("versions.js");
const { optimizerRoot } = await lib("optimizer-config.js");

const skill = (name, { step1 = "1. 运行 `git status` 看改动。", step2 = "2. 写提交信息。", extra = [] } = {}) =>
	["---", `name: ${name}`, "description: 帮用户写 git 提交信息并提交", "---", "# 写提交信息", "", step1, step2, "3. 提交。", ...extra, "", "## 安全", "", "- 绝不使用 git push --force。", ""].join("\n");
const write = (name, text) => {
	const dir = join(home, ".dsh", "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), text);
	return join(dir, "SKILL.md");
};
const CASES = [
	{ id: "c1", scenario: "帮我写个提交信息", expect: "标题用祈使句", critical: true, kw: "祈使" },
	{ id: "c2", scenario: "提交信息要短", expect: "标题不超过 50 字", critical: false, kw: "50" },
	{ id: "c3", scenario: "先看改了什么", expect: "先运行 git status", critical: true, kw: "git status" }
];
const mut = (content, summary) => `<summary>${summary}</summary>\n<conflict>none</conflict>\n<skill>\n${content}\n</skill>`;
const fake = (mutations, { delayMs = 0, usage = null } = {}) => ({
	async complete(req) {
		if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
		if (req.purpose === "cases") return { text: JSON.stringify({ cases: CASES.map(({ kw, ...c }) => c) }), usage };
		if (req.purpose === "judge") return { text: JSON.stringify({ scores: req.meta.cases.map((c) => ({ id: c.id, score: req.meta.skillText.includes(CASES.find((x) => x.id === c.id).kw) ? 9 : 4 })) }), usage };
		return { text: mutations.shift() ?? mut(req.meta.skillText, "原样"), usage };
	}
});
const opt = (model, name, limits = {}) =>
	createOptimizer({
		pluginConfig: { limits: { generations: 1, population: 2, ...limits } },
		model,
		telemetry: () => ({ stats: async () => ({ weeks: [{ skills: [{ skill: name, triggers: 8, injections: 0, failures: 2 }] }] }) }),
		logger: console
	});
const banner = (t) => console.log("\n" + "═".repeat(8) + " " + t + " " + "═".repeat(8));

try {
	banner("① 全链 + 低风险自动应用 + 劣化被挡");
	const f1 = write("commit-helper", skill("commit-helper"));
	const r1 = await opt(fake([mut(skill("commit-helper", { step2: "2. 写提交信息：标题用祈使句，不超过 50 字。" }), "第 2 步补祈使句与长度"), mut(skill("commit-helper", { step1: "1. 看一眼改动。" }), "（故意做坏）删掉 git status")]), "commit-helper").runRound();
	console.log(r1.markdown);
	const s1 = r1.skills[0];
	console.log(`→ 写盘后包含「祈使句」：${readFileSync(f1, "utf8").includes("祈使句")}`);
	await rollbackSkill({ key: s1.rollback.target, versionId: s1.rollback.versionId, actor: "demo" });
	console.log(`→ 回滚到 ${s1.rollback.versionId} 后回到基线：${readFileSync(f1, "utf8") === skill("commit-helper")}`);

	banner("② 结构性改动只出提案 → 批准 → 回滚");
	const f2 = write("release-notes", skill("release-notes"));
	const o2 = opt(fake([mut(skill("release-notes"), "原样"), mut(skill("release-notes", { step2: "2. 写提交信息：标题用祈使句，不超过 50 字。", extra: ["4. 用 `git log -1` 复核。"] }), "加一步复核")]), "release-notes");
	const r2 = await o2.runRound();
	console.log(r2.markdown);
	const d = await o2.decide({ id: r2.skills[0].proposalId, decision: "approve", reason: "演示批准" });
	console.log(`→ 批准后新版本 ${d.proposal.versionId}，文件含第 4 步：${readFileSync(f2, "utf8").includes("4. 用")}`);
	await rollbackSkill({ key: d.proposal.rollback.target, versionId: d.proposal.rollback.versionId, actor: "demo" });
	console.log(`→ 回滚后回到基线：${readFileSync(f2, "utf8") === skill("release-notes")}`);

	banner("③ 上限触发自动停轮");
	write("budget-demo", skill("budget-demo"));
	for (const [label, model, limits] of [
		["次数", fake([]), { maxModelCalls: 2 }],
		["token", fake([], { usage: { inputTokens: 900, outputTokens: 200 } }), { maxTokens: 1000 }],
		["时长", fake([], { delayMs: 400 }), { maxDurationMs: 150 }]
	]) {
		const r = await opt(model, "budget-demo", limits).runRound();
		console.log(`- ${label}上限：status=${r.status} limit=${r.stop?.limit} 用量=${JSON.stringify({ calls: r.budget.calls, tokens: r.budget.tokens, ms: r.budget.ms })}`);
	}
	console.log(`\n数据目录：${optimizerRoot()}`);
} finally {
	if (process.argv.includes("--keep")) console.log(`临时 HOME 保留在 ${home}`);
	else rmSync(home, { recursive: true, force: true });
}
