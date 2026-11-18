/**
 * 全库审查第三批：进化回路护栏 + MCP 稳定性 + 几条零散项。每条对应一个已复现的缺陷。
 *
 * 进化回路
 *   [1]  评估门：基线缺分不算「过门」；绝对线（蒸馏）不受影响
 *   [2]  评估集文件名：中文名 / 含分隔符的名字不再互相覆盖；文件里记的技能名对不上就当没有
 *   [3]  优化回路：基线评分解析不了 → 跳过，不自动应用；版本记录写不成 → 报错且文件原样
 *   [4]  冲突扫描：增量检查不吃上限；全量截断时按窗口轮转并报覆盖面
 *   [5]  治理轮次：没比到的冲突不会被标成已消失
 *   [6]  分级：改管道 / 换目标 / 跳过确认 / when→unless 不算措辞；补充细节仍算
 *   [7]  蒸馏：同批近似草稿不双双入库；必错草稿不卡队列；丢弃的草稿不原样回来
 *   [8]  Darwin：旧结果行不顶替新改动；巡检清单逐轮往后推；坏回复不清空家族表
 *   [9]  「记住」处理过一次就不再每轮重复触发
 * MCP
 *   [10] stdin 写失败不再是未捕获异常
 *   [11] stdout 超限后子进程被回收
 *   [12] 握手途中注销 / 卸载 / 改配置：连接不会装到没人管的 slot 上
 *   [13] HTTP 会话被服务端丢弃后自动重新握手
 *   [14] 目录段不做变量插值；状态变了只在挂着的时候重建
 *   [15] profile 导入：Windows 路径不吞下一行、行内注释不进值、不合规的行不接管、不产生重复 disabled 键
 *   [16] 空闲扫描顺带断开已不在注册表 / 已停用的 server
 * 零散
 *   [17] 文件锁：长临界区不被当成僵死锁收走；释放时不删别人的锁
 *   [18] 使用信号：同一会话后来加载的技能也计数
 *   [19] frontmatter：引号里的 # 不是注释
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const home = mkdtempSync(join(tmpdir(), "dsh-evo-mcp-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(home, "telemetry");
process.env.DSH_STUDIO_OPTIMIZER_DIR = join(home, "optimizer");
process.env.DSH_STUDIO_GOVERNANCE_DIR = join(home, "governance");
process.env.DSH_STUDIO_DISTILL_DIR = join(home, "distill");
process.env.DSH_SKILL_EXTRACTOR_SESSIONS = join(home, "sessions");
for (const k of ["DSH_AGENTS_HOME", "DSH_SKILL_MANAGER_SKILL_DIRS"]) delete process.env[k];
test.after(() => rmSync(home, { recursive: true, force: true }));

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const put = (abs, data) => {
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, data);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const evalMod = await import(modUrl("lib/optimizer-eval.js"));
const scan = await import(modUrl("lib/governance-scan.js"));
const { GOVERNANCE_DEFAULTS } = await import(modUrl("lib/governance-config.js"));
const { configureTelemetry } = await import(modUrl("lib/telemetry.js"));
const telemetry = configureTelemetry({ dir: process.env.DSH_STUDIO_TELEMETRY_DIR });
test.after(async () => {
	await telemetry.flush?.();
});

// ── 进化回路 ────────────────────────────────────────────────────────────

test("[1] 评估门：基线缺分 → 不过；绝对线不受影响", () => {
	const gate = { minDelta: 0, criticalTolerance: 0 };
	const cases = (scores) => scores.map((score, i) => ({ id: "c" + (i + 1), critical: i === 0, score }));
	// 基线评分解析不了时 scoreSkill 给的就是这个形状：均分 0、各场景 null
	const broken = { mean: 0, cases: cases([null, null]) };
	const weak = { mean: 1, cases: cases([1, 1]) };
	const v = evalMod.gateVerdict(broken, weak, gate);
	assert.equal(v.pass, false, "每个场景只得 1 分的候选不能靠「基线均分 0」过门");
	assert.ok(v.reasons.some((r) => r.includes("基线缺分")), v.reasons.join("；"));
	// 基线里根本没有这个场景
	assert.equal(evalMod.gateVerdict({ mean: 5, cases: cases([5]) }, { mean: 6, cases: cases([6, 6]) }, gate).pass, false);
	// 正常基线照常比
	assert.equal(evalMod.gateVerdict({ mean: 5, cases: cases([5, 5]) }, { mean: 6, cases: cases([6, 6]) }, gate).pass, true);
	assert.equal(evalMod.gateVerdict({ mean: 5, cases: cases([5, 5]) }, { mean: 5.5, cases: cases([4, 7]) }, gate).pass, false, "关键场景回退仍然挡");
	// 蒸馏的绝对线：非关键场景故意是 null
	const line = { mean: 6, cases: cases([7, null]) };
	assert.equal(evalMod.gateVerdict(line, { mean: 8, cases: cases([8, 8]) }, gate, { absoluteLine: true }).pass, true);
	assert.equal(evalMod.gateVerdict(line, { mean: 8, cases: cases([6, 10]) }, gate, { absoluteLine: true }).pass, false);
});

test("[2] 评估集文件名不互相覆盖；记的技能名对不上就当没有", async () => {
	const file = evalMod.evalFile;
	assert.notEqual(file("数据分析"), file("周报生成"));
	assert.notEqual(file("a/b"), file("a b"));
	assert.notEqual(file("a b"), file("a_b"));
	assert.ok(file("commit-helper").endsWith("commit-helper.json"), "纯 ASCII 安全名保持原文件名（既有评估集不失效）");
	for (const name of ["数据分析", "../../etc/passwd", "..", "a/b"]) assert.equal(dirname(file(name)), dirname(file("x")), name + " 不出 evals 目录");
	// 历史碰撞留下的文件：技能名对不上 → 不认
	put(file("周报生成"), JSON.stringify({ v: 1, skill: "数据分析", cases: [{ id: "c1", scenario: "s", expect: "e", critical: true }] }));
	assert.equal(await evalMod.loadEvalSet("周报生成"), null);
	put(file("周报生成"), JSON.stringify({ v: 1, skill: "周报生成", cases: [{ id: "c1", scenario: "s", expect: "e", critical: true }] }));
	assert.equal((await evalMod.loadEvalSet("周报生成")).cases.length, 1);
});

test("[3] 优化回路：基线评分坏了 → 跳过不应用；版本记录写不成 → 报错且文件原样", async () => {
	const { createOptimizer } = await import(modUrl("lib/optimizer.js"));
	const { readVersionRecords, setVersionLogger } = await import(modUrl("lib/versions.js"));
	setVersionLogger(quiet);
	const base = "---\nname: commit\ndescription: write commit messages\n---\n# Commit\n\n1. Run git status.\n2. Write the message.\n3. Commit.\n";
	const model = (mode, name) => ({
		async complete(req) {
			if (req.purpose === "cases") return { text: JSON.stringify({ cases: [{ id: "c1", scenario: "s", expect: "e", critical: true }, { id: "c2", scenario: "s2", expect: "e2" }] }) };
			if (req.purpose === "judge") {
				if (mode === "badbaseline" && req.meta.label === "baseline") return { text: 'Sure! {"scores":[{"id":"c1","score":9,"reason":"trunc' };
				const s = req.meta.label === "baseline" ? 5 : mode === "badbaseline" ? 1 : 6;
				return { text: JSON.stringify({ scores: [{ id: "c1", score: s }, { id: "c2", score: s }] }) };
			}
			const cand = base.replace("name: commit", "name: " + name).replace("2. Write the message.", "2. Write the message carefully.");
			return { text: `<summary>reword</summary>\n<conflict>none</conflict>\n<skill>\n${cand}</skill>` };
		}
	});
	const run = async (name, mode) => {
		const file = join(process.env.DSH_HOME, "skills", name, "SKILL.md");
		put(file, base.replace("name: commit", "name: " + name));
		const opt = createOptimizer({ pluginConfig: { limits: { generations: 1, population: 1 } }, model: model(mode, name), telemetry: () => telemetry, logger: quiet });
		const report = await opt.runRound({ trigger: "manual", skill: name });
		return { file, entry: report.skills[0], text: readFileSync(file, "utf8") };
	};

	const bad = await run("commit-bad", "badbaseline");
	assert.equal(bad.entry.outcome, "skipped", JSON.stringify(bad.entry));
	assert.match(bad.entry.note, /基线评分不完整/);
	assert.ok(bad.text.includes("2. Write the message.\n"), "文件没被改");

	const ok = await run("commit-ok", "ok");
	assert.equal(ok.entry.outcome, "applied", JSON.stringify(ok.entry));
	assert.equal(typeof ok.entry.versionId, "string", "正常路径：应用且带版本记录");

	// 版本史写不了（目录位置被一个文件占着）
	const before = (await readVersionRecords()).length;
	const realHistory = process.env.DSH_STUDIO_HISTORY_DIR;
	put(join(home, "blocker"), "x");
	process.env.DSH_STUDIO_HISTORY_DIR = join(home, "blocker", "history");
	try {
		const broken = await run("commit-norecord", "ok");
		assert.equal(broken.entry.outcome, "error", JSON.stringify(broken.entry));
		assert.ok(broken.text.includes("2. Write the message.\n") && !broken.text.includes("carefully"), "没有版本记录就不许留下改动");
	} finally {
		process.env.DSH_STUDIO_HISTORY_DIR = realHistory;
	}
	assert.equal((await readVersionRecords()).length, before);
});

const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango"];
const rnd = (i, k) => words[(i * 7 + k * 13) % words.length] + " " + words[(i * 3 + k * 5) % words.length] + " " + words[(i + k * 11) % words.length];
function bigLibrary(n) {
	const lib = [];
	for (let i = 0; i < n; i++) {
		const name = "skill-" + String(i).padStart(3, "0");
		const body = `---\nname: ${name}\ndescription: handles ${rnd(i, 1)} tasks number ${i} for the ${rnd(i, 2)} team\n---\n# ${name}\n\n1. ${rnd(i, 3)}.\n2. ${rnd(i, 4)}.\n`;
		lib.push(scan.describeSkill(body, { file: `/r/${name}/SKILL.md`, root: "/r", dirName: name, key: "skill:/r/" + name }));
	}
	const twin = (name) => scan.describeSkill(`---\nname: ${name}\ndescription: generate the weekly status report for the platform team every friday\n---\n# x\n\n1. Collect data.\n`, { file: `/r/${name}/SKILL.md`, root: "/r", dirName: name, key: "skill:/r/" + name });
	lib.push(twin("zz-weekly-a"), twin("zz-weekly-b"));
	return lib;
}

test("[4] 冲突扫描：增量不吃上限；全量截断按窗口轮转并报覆盖面", () => {
	const lib = bigLibrary(120);
	const cfg = GOVERNANCE_DEFAULTS;
	const hasTwin = (found) => found.some((c) => c.type === "trigger-overlap" && c.pair.some((p) => p.name === "zz-weekly-a") && c.pair.some((p) => p.name === "zz-weekly-b"));
	// 增量：排在库尾的技能也查得到自己的冲突（旧实现先数满 2000 对再过滤 focus，这里一对相关的都轮不到）
	const stats = {};
	const inc = scan.detectConflicts(lib, cfg.conflicts, { focus: "skill:/r/zz-weekly-b", maxPairs: 2000, stats });
	assert.ok(hasTwin(inc), "增量检查找到 zz-weekly-a ~ zz-weekly-b");
	assert.equal(stats.compared, lib.length - 1);
	assert.equal(stats.truncated, false);

	// 全量：总对数超过上限 → 截断并如实报告
	const total = scan.pairTotal(lib.length);
	const first = {};
	const head = scan.detectConflicts(lib, cfg.conflicts, { maxPairs: 2000, stats: first });
	assert.deepEqual([first.total, first.compared, first.truncated], [total, 2000, true]);
	assert.equal(hasTwin(head), false, "第一个窗口确实没覆盖到库尾这一对");
	assert.equal(first.pairKeys.has(scan.pairKeyOf("skill:/r/zz-weekly-a", "skill:/r/zz-weekly-b")), false);
	// 游标逐轮往前推，若干轮之内一定覆盖到
	let offset = 0;
	let found = false;
	for (let round = 0; round < Math.ceil(total / 2000) && !found; round++) {
		const st = {};
		found = hasTwin(scan.detectConflicts(lib, cfg.conflicts, { maxPairs: 2000, offset, stats: st }));
		offset = (offset + st.compared) % st.total;
	}
	assert.ok(found, "窗口轮转覆盖到了库尾的冲突");
	// 没超上限时不截断、不给 pairKeys
	const small = {};
	scan.detectConflicts(lib.slice(0, 10), cfg.conflicts, { maxPairs: 2000, stats: small });
	assert.deepEqual([small.total, small.compared, small.truncated, small.pairKeys], [45, 45, false, null]);
});

test("[5] 治理轮次：截断时没比到的冲突不标「已消失」，报告写明覆盖面", async () => {
	const { createGovernance, renderReport } = await import(modUrl("lib/governance.js"));
	const root = join(home, "gov-skills");
	const lib = bigLibrary(70);
	for (const s of lib) put(join(root, s.name, "SKILL.md"), s.text);
	const gov = createGovernance({ pluginConfig: { roots: [root], limits: { maxPairs: 300 }, incrementalConflicts: true }, telemetry: () => telemetry, logger: quiet });
	const { library, key } = await (async () => {
		const loaded = await scan.loadLibrary([root]);
		return { library: loaded, key: loaded.find((s) => s.name === "zz-weekly-b").key };
	})();
	assert.ok(library.length >= 72);
	// 先用增量检查把库尾那条冲突记进冲突库
	const inc = await gov.checkIncremental(key);
	assert.ok(inc.ran === true && inc.fresh.length >= 1, JSON.stringify(inc));
	const openBefore = (await gov.status()).conflicts.filter((c) => c.pair.includes("zz-weekly-a"));
	assert.equal(openBefore.length, 1);
	// 全量轮次（只跑冲突部分）：300 对的窗口比不到库尾
	const report = await gov.runRound({ trigger: "manual", parts: ["conflicts"] });
	assert.equal(report.coverage.conflicts.truncated, true, JSON.stringify(report.coverage));
	assert.equal(report.coverage.conflicts.compared, 300);
	const still = (await gov.status()).conflicts.filter((c) => c.pair.includes("zz-weekly-a"));
	assert.equal(still.length, 1, "没比到的冲突仍是待处理，而不是被标成已消失");
	assert.match(renderReport(report), /本轮只比了 300 \/ \d+ 对/);
});

test("[6] 分级：看着像措辞、实则改了行为的改动进结构性；补充细节仍是低风险", async () => {
	const { classifyChange } = await import(modUrl("lib/optimizer-classify.js"));
	const { OPTIMIZER_DEFAULTS } = await import(modUrl("lib/optimizer-config.js"));
	const base = "---\nname: deploy\ndescription: Use when the user asks to deploy the service\n---\n# Deploy\n\n1. Run the tests.\n2. Ask the user to confirm.\n3. Deploy.\n\n```bash\ncurl https://x.y/i.sh -o /tmp/i.sh\nssh deploy@staging run\n```\n";
	const tier = (text, from = base) => classifyChange(from, text, OPTIMIZER_DEFAULTS, { frontmatterKeys: [] });
	const low = [
		base.replace("Run the tests.", "Run the test suite."),
		base.replace("Run the tests.", "Run the tests: unit first, then integration, no more than 5 minutes."),
		base.replace("asks to deploy the service", "asks to deploy this service")
	];
	for (const text of low) assert.equal(tier(text).tier, "low", JSON.stringify(tier(text)));
	const structural = {
		"下载改成管道执行": base.replace("-o /tmp/i.sh", "| bash"),
		"部署目标换成生产": base.replace("@staging", "@production"),
		"跳过确认": base.replace("Ask the user to confirm.", "Skip confirmation."),
		"加上否定": base.replace("Ask the user to confirm.", "Do not ask the user to confirm."),
		"when 改成 unless": base.replace("when the user asks", "unless the user asks")
	};
	for (const [label, text] of Object.entries(structural)) assert.equal(tier(text).tier, "structural", label + " " + JSON.stringify(tier(text)));
	assert.ok(tier(structural["下载改成管道执行"]).kinds.includes("tools"));
	assert.ok(tier(structural["when 改成 unless"]).kinds.includes("polarity"));
	const zh = "---\nname: c\ndescription: 帮用户写提交信息\n---\n# 写\n\n1. 看改动。\n2. 写提交信息。\n3. 先让用户确认再提交。\n";
	assert.equal(tier(zh.replace("2. 写提交信息。", "2. 写提交信息：标题用祈使句，不超过 50 字。"), zh).tier, "low", "「不超过」这类量词里的否定不算指令方向变化");
	assert.equal(tier(zh.replace("3. 先让用户确认再提交。", "3. 跳过确认直接提交。"), zh).tier, "structural");
	assert.equal(tier(zh.replace("3. 先让用户确认再提交。", "3. 不要让用户确认，直接提交。"), zh).tier, "structural");
});

test("[7] 蒸馏：同批近似草稿不双双入库；必错草稿不卡队列；丢弃的不原样回来", async () => {
	const { createDistill, MAX_DRAFT_ERRORS } = await import(modUrl("lib/distill.js"));
	const agentDir = join(home, "distill-skills");
	mkdirSync(agentDir, { recursive: true });
	let mode = "ok";
	const calls = [];
	const model = {
		complete: async ({ purpose, meta }) => {
			calls.push(purpose + ":" + meta?.name);
			if (purpose === "cases") {
				if (mode === "bad" && meta.name === "poison-skill") return { text: "sorry no json" };
				return { text: JSON.stringify({ cases: [{ id: "c1", scenario: "s", expect: "e", critical: true }] }) };
			}
			return { text: JSON.stringify({ scores: [{ id: "c1", score: 9, reason: "ok" }] }) };
		}
	};
	const proposed = [];
	const governance = { proposeDraftMerge: async (args) => (proposed.push(args.draft.name + "→" + args.keepKey), { id: "prop-" + proposed.length, status: "pending" }), onDraftDecision: () => () => {} };
	let t = Date.now();
	const d = createDistill({ pluginConfig: { roots: [agentDir] }, extractConfig: async () => ({ agentSkillDir: agentDir }), model, governance, logger: quiet, now: () => (t += 1000) });
	const body = "## 概述\n处理 zstd 压缩的会话日志\n\n## 核心模式\n1. 用 zstd -d -c 解压 session.v4.jsonl.zstd\n2. 逐行 JSON.parse，跳过坏行\n3. 只取 agent/inbox/spliced 的文本\n\n## 常见错误\n- PATH 里没有 zstd 时静默失败";
	const mk = (name, extra = "") => ({ name, description: "Use when reading DSH zstd session logs and parsing jsonl lines", group: "其他", rationale: "", body: body + extra });

	// 两份内容相近、名字不同的草稿（对同一批会话提取两次的正常产物）
	await d.ingest([mk("read-dsh-session-logs")], {});
	await d.ingest([mk("parse-zstd-session-jsonl", "\n- 记得跳过空行")], {});
	const r1 = await d.runBatch({});
	const out1 = Object.fromEntries(r1.drafts.map((x) => [x.name, x.outcome]));
	assert.equal(out1["read-dsh-session-logs"], "published", JSON.stringify(r1.drafts));
	assert.equal(out1["parse-zstd-session-jsonl"], "merge-proposed", "第二份撞上了本批刚入库的第一份，转合并提案而不是再入库一份");
	assert.deepEqual(readdirSync(agentDir), ["read-dsh-session-logs"]);
	assert.equal(proposed.length, 1);

	// 必错草稿排在队首，后面跟一份正常的
	mode = "bad";
	await d.ingest([{ name: "poison-skill", description: "Use when rolling back a helm release on kubernetes", group: "其他", rationale: "", body: "## 概述\nhelm upgrade 回滚流程 kubernetes" }], {});
	await d.ingest([{ name: "good-skill", description: "Use when tuning postgres autovacuum settings", group: "其他", rationale: "", body: "## 概述\npostgres autovacuum 调参 步骤" }], {});
	const r2 = await d.runBatch({});
	const out2 = Object.fromEntries(r2.drafts.map((x) => [x.name, x.outcome]));
	assert.equal(out2["good-skill"], "published", "排在必错草稿后面的草稿照常处理：" + JSON.stringify(r2.drafts));
	assert.equal(out2["poison-skill"], "error");
	assert.equal(r2.status, "error", "批次仍如实报错");
	for (let i = 1; i < MAX_DRAFT_ERRORS; i++) await d.runBatch({});
	const poison = (await d.listDrafts()).find((x) => x.name === "poison-skill");
	assert.equal(poison.status, "failed", `连错 ${MAX_DRAFT_ERRORS} 次后判失败出队`);
	const before = calls.length;
	await d.runBatch({});
	assert.equal(calls.length, before, "出队之后不再为它花模型调用");

	// 所有者丢弃的草稿：同内容再来一次不收；同名但没有新出处会话也不收；用户点名的照收
	mode = "ok";
	const log = (id, text) => ({ file: id, log: { session: { id }, msgs: [{ role: "user", text }, { role: "assistant", text: "好" }] } });
	const cand = { name: "retry-skill", description: "Use when retrying flaky network downloads with backoff", group: "其他", rationale: "", body: "## 概述\n下载失败时指数退避重试 network download backoff" };
	const logs = [log("sess-1", "下载总是失败，帮我加个指数退避重试 network download backoff")];
	const i1 = await d.ingest([cand], { logs });
	assert.equal(i1.drafts.length, 1);
	await d.decide({ id: i1.drafts[0].id, decision: "discard", reason: "不需要" });
	assert.equal((await d.ingest([cand], { logs })).drafts.length, 0, "同内容：不再收");
	assert.equal((await d.ingest([{ ...cand, body: cand.body + "\n- 换了个说法" }], { logs })).drafts.length, 0, "同名、出处会话没有新的：不再收");
	assert.equal((await d.ingest([{ ...cand, body: cand.body + "\n- 新证据" }], { logs: [...logs, log("sess-2", "又遇到下载失败 network download backoff 重试")] })).drafts.length, 1, "有新的出处会话：收");
	assert.equal((await d.ingest([{ ...cand, name: "retry-skill-2" }], { logs, named: true })).drafts.length, 1, "用户点名要的不受此限");
});

test("[8] Darwin：旧结果行不顶替新改动；巡检清单往后推；坏回复不清空家族表", async () => {
	const darwin = await import(modUrl("lib/darwin.js"));
	// 结果行时间判定：产生与解析都跟随本机时区（所有者裁定），不依赖跑测试的机器在哪个时区
	const now = new Date(2026, 10, 17, 10, 0).getTime(); // 本机时间 2026-11-17 10:00
	assert.equal(darwin.resultIsAfter("2026-08-01T10:00", now), false, "三个月前的行不算这次改动的结果");
	assert.equal(darwin.resultIsAfter(darwin.localStamp(now + 5 * 60_000), now), true);
	assert.equal(darwin.resultIsAfter(darwin.localStamp(now - 6 * 3_600_000), now), false);
	assert.equal(darwin.resultIsAfter("2026-11-17", now), true, "只有日期：本机当天之内都算");
	assert.equal(darwin.resultIsAfter("2026-11-16", now), false, "昨天的日期不算");
	assert.equal(darwin.resultIsAfter("不是时间", now), true, "解析不了按旧行为放行，不卡住");
	// 带时区标记的串：标记不作数，字面钟点按本机时间理解（所有者裁定 2026-11-17，）
	assert.equal(darwin.resultIsAfter(darwin.localStamp(now + 5 * 60_000) + "Z", now), true, "本机钟点 + Z：标记不作数，算新行");
	assert.equal(darwin.resultIsAfter(darwin.localStamp(now - 6 * 3_600_000) + ":00Z", now), false, "本机钟点 6 小时前 + Z：照样挡");
	assert.equal(darwin.parseStamp("2026-11-17T10:00:00.123Z"), now, "Z 标记 + 毫秒");
	assert.equal(darwin.parseStamp("2026-11-17T10:00+08:00"), now, "+08:00 标记");
	assert.equal(darwin.parseStamp("2026-11-17T10:00:00-0530"), now, "-0530 标记");
	assert.equal(darwin.parseStamp("2026-11-17 10:00+09"), now, "+09 标记");
	// 逐个时区验：评审实证的故障是 UTC+8 下新鲜结果被当成 8 小时前的旧行。
	// 口径是「不带时区的串按本机时区理解」，所以每个时区下：本机产生的戳读回来就是那一刻（同一基准、没有固定偏移），
	// 新鲜的判新鲜、旧的照样挡。
	const realTz = process.env.TZ;
	try {
		for (const tz of ["Asia/Shanghai", "UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata"]) {
			process.env.TZ = tz;
			const at = Date.now();
			const stamp = darwin.localStamp(at);
			const d = new Date(at);
			assert.equal(stamp.slice(11, 13), String(d.getHours()).padStart(2, "0"), `${tz}：产生的戳是本机钟点`);
			assert.ok(Math.abs(darwin.parseStamp(stamp) - at) < 60_000, `${tz}：本机产生的戳读回来就是那一刻（${stamp}）`);
			assert.equal(darwin.resultIsAfter(stamp, at), true, `${tz}：刚写的结果 ${stamp}`);
			assert.equal(darwin.resultIsAfter(stamp.replace("T", " "), at), true, `${tz}：空格分隔的写法`);
			assert.equal(darwin.resultIsAfter(stamp.slice(0, 10), at), true, `${tz}：只有本机日期`);
			assert.equal(darwin.resultIsAfter(darwin.localStamp(at - 90 * 86_400_000), at), false, `${tz}：三个月前的行照样挡`);
			assert.equal(darwin.resultIsAfter(darwin.localStamp(at - 3 * 86_400_000).slice(0, 10), at), false, `${tz}：三天前的日期照样挡`);
			// 带时区标记：标记不作数，与不带标记的同一个串读出同一刻
			for (const mark of ["Z", "z", "+08:00", "-05:00", "+0000", "+14:00"]) {
				assert.equal(darwin.parseStamp(stamp + mark), darwin.parseStamp(stamp), `${tz}：${stamp}${mark} 按字面钟点作本机时间`);
				assert.equal(darwin.resultIsAfter(stamp + mark, at), true, `${tz}：刚写的结果带 ${mark} 仍算新行`);
			}
			assert.equal(darwin.resultIsAfter(darwin.localStamp(at - 90 * 86_400_000) + "Z", at), false, `${tz}：三个月前的行带 Z 照样挡`);
			// 日期按本机日历日算，不按 UTC 日算
			assert.equal(darwin.parseStamp(stamp.slice(0, 10)), new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), `${tz}：日期 = 本机当天零点`);
		}
		// 不带时区的串不会被当成 UTC：UTC+8 的机器上，一个「本机钟点 8 小时前」的戳就是 8 小时前
		process.env.TZ = "Asia/Shanghai";
		const at = Date.now();
		assert.equal(darwin.resultIsAfter(new Date(at).toISOString().slice(0, 16), at), false, "UTC 钟点的裸串在 UTC+8 的机器上按本机时间理解");
		assert.equal(darwin.resultIsAfter(new Date(at).toISOString(), at), false, "UTC 钟点带 Z 的串在 UTC+8 的机器上同样按本机时间理解（标记不作数）");
	} finally {
		if (realTz === undefined) delete process.env.TZ;
		else process.env.TZ = realTz;
	}

	const root = mkdtempSync(join(home, "darwin-"));
	const skills = join(root, "skills");
	const names = ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "darwin-skill"];
	for (const n of names) put(join(skills, n, "SKILL.md"), `---\nname: ${n}\ndescription: d\n---\nbody`);
	const mk = (cfg, state) => {
		const handlers = new Map();
		const ctx = { on: (event, fn) => handlers.set(event, fn), logger: quiet };
		const stateFile = join(root, "state-" + Math.random().toString(36).slice(2) + ".json");
		writeFileSync(stateFile, JSON.stringify(state));
		darwin.applyDarwin(ctx, { roots: [skills], stateFile, familyFile: join(root, "nofam.json"), familyRefreshDays: 0, lockFile: join(root, "nolock.json"), ...cfg }, {});
		return { handlers, stateFile };
	};
	const section = async (handlers) => ((await handlers.get("system-prompt/assemble")({}, {}, async () => ({ sections: [] }))).sections ?? []).find((s) => s.name === "darwin")?.text ?? "";
	const header = "timestamp\tcommit\tskill\told_score\tnew_score\tstatus\tdimension\tnote\teval_mode\n";

	// 刚改完 aa；results.tsv 里只有一条三个月前的 aa
	{
		const resultsFile = join(root, "results1.tsv");
		writeFileSync(resultsFile, header + "2026-08-01T10:00\tabc\taa\t58\t82\tkeep\tstructure\told\tpaired\n");
		const { handlers, stateFile } = mk({ resultsFile, sweepHours: 999 }, { scores: {}, lastSweep: Date.now() });
		await handlers.get("tools/post-execute")({ name: "edit", arguments: { file_path: join(skills, "aa", "SKILL.md") } }, {}, async () => {});
		assert.match(await section(handlers), /aa/, "新改动仍在待评估清单里");
		assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).scores, {}, "没有被旧结果行记成已评");
	}
	// 巡检：每次列 3 个，没人回写结果时也要逐轮往后推
	{
		const resultsFile = join(root, "results2.tsv");
		const { handlers } = mk({ resultsFile, sweepHours: 0, sweepLimit: 3 }, { scores: {}, lastSweep: 0 });
		const pick = (text) => (text.match(/skills[\\/](\w[\w-]*)[\\/]SKILL\.md/g) ?? []).map((x) => x.split(/[\\/]/)[1]);
		const first = pick(await section(handlers));
		await sleep(5);
		const second = pick(await section(handlers));
		assert.equal(first.length, 3);
		assert.equal(second.length, 3);
		assert.equal(second.filter((n) => first.includes(n)).length, 0, `第二轮列的是另外三个：${first} → ${second}`);
	}
	// 家族表：聚类回复不是 JSON → 不写
	{
		const familyFile = join(root, "families.json");
		const kept = JSON.stringify({ version: 1, updatedAt: "2026-11-01", families: [{ id: "hand", host: "aa", members: ["bb"], reason: "手工维护" }] });
		writeFileSync(familyFile, kept);
		const llm = { listProviders: () => [{ id: "p" }], listModels: async () => [{ id: "m" }], prepareCall: async () => ({ config: {}, stream: () => (async function* () { yield { type: "text-delta", text: "抱歉，我没法给出 JSON" }; yield { type: "finish", reason: { kind: "stop" } }; })() }) };
		const files = names.map((n) => join(skills, n, "SKILL.md"));
		const out = await darwin.clusterFamilies(llm, { familyFile, roots: [skills] }, files).catch((error) => error);
		assert.ok(out === null || out instanceof Error, "坏回复不产出家族表");
		assert.equal(readFileSync(familyFile, "utf8"), kept, "既有家族表原样保留");
	}
});

test("[9] 「记住」处理过一次就不再每轮重复触发", async () => {
	const extractor = await import(modUrl("lib/extractor.js"));
	const remember = await import(modUrl("lib/remember.js"));
	const file = join(home, "sessions", "sess-rem", "session.v4.jsonl");
	const line = (o) => JSON.stringify(o) + "\n";
	const msg = (role, text) => line({ type: "agent/inbox/spliced", data: { inserted: [{ role, content: [{ type: "text", text }] }] } });
	put(file, line({ type: "session", id: "sess-rem", createdAt: Date.now(), cwd: "/x" }) + msg("user", "记住：以后都用 pnpm"));
	let llmCalls = 0;
	const llm = { listProviders: () => [], prepareCall: async () => { llmCalls += 1; throw new Error("no llm"); } };
	const cfg = extractor.defaults();

	const first = await extractor.shouldExtract(cfg, { llm, handledRemember: await remember.loadHandledRemember() });
	assert.equal(first.remember, true);
	assert.deepEqual(Object.keys(first).sort(), ["remember", "rememberText", "worth"], "返回体的可见形态不变");
	assert.equal(await remember.savePendingRemember(first.rememberText, "agents", first.rememberKey), true);
	// 下一轮开头：请求被取走注入一次
	const taken = await remember.takePendingRemember(quiet);
	assert.equal(taken.text, first.rememberText);
	assert.equal(await remember.takePendingRemember(quiet), null, "只注入一次");

	// 之后的轮次：同一句话还在最后 20 条里，但不再命中，走正常判定（这里没有模型 → 判定失败，而不是又一次 remember）
	fs.appendFileSync(file, msg("assistant", "记好了") + msg("user", "顺便看下这个报错"));
	const second = await extractor.shouldExtract(cfg, { llm, handledRemember: await remember.loadHandledRemember() });
	assert.notEqual(second.remember, true, JSON.stringify(second));
	assert.ok(llmCalls >= 1 || second.error !== undefined || second.worth === false, "这一轮走了正常判定");

	// 用户又说了一句新的「记住」→ 照常命中；另一个会话里的同一句话也算新的
	fs.appendFileSync(file, msg("user", "记一下：提交前先跑 lint"));
	const third = await extractor.shouldExtract(cfg, { llm, handledRemember: await remember.loadHandledRemember() });
	assert.equal(third.remember, true);
	assert.match(third.rememberText, /lint/);
	assert.notEqual(remember.rememberKey("sess-rem", "记住：以后都用 pnpm"), remember.rememberKey("sess-other", "记住：以后都用 pnpm"));
});

// ── MCP ────────────────────────────────────────────────────────────────

const mcpClient = await import(modUrl("lib/mcp-client.js"));
const mcp = await import(modUrl("lib/mcp.js"));
const serverScript = ({ initDelay = 0, big = false } = {}) => `
let buf='';
process.stdin.on('data', (d) => { buf+=d; let i; while((i=buf.indexOf('\\n'))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1); if(!line.trim()) continue; const m=JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result})+'\\n');
  if (m.method==='initialize') setTimeout(()=>reply({serverInfo:{name:'x'}, capabilities:{}}), ${initDelay});
  else if (m.method==='tools/list') reply({tools:[{name:'get_a'}]});
  else if (m.method==='tools/call') reply({content:[{type:'text', text:${big ? "'A'.repeat(17*1024*1024)" : "'ok'"}}]});
}});
setInterval(()=>{}, 1000);`;
const stdioEntry = (name, options) => ({ name, tier: "on-demand", transport: "stdio", command: process.execPath, args: ["-e", serverScript(options)], env: {}, cwd: "", trial: false, toolCallTimeoutMs: 5000 });

test("[10] stdin 写失败不再是未捕获异常", async () => {
	let uncaught = 0;
	const onUncaught = () => { uncaught += 1; };
	process.on("uncaughtException", onUncaught);
	try {
		// 子进程答完 initialize 就不再读 stdin，然后被塞一个大于管道缓冲的请求
		const script = `process.stdin.once('data', (d) => { const m = JSON.parse(String(d).split('\\n')[0]); require('fs').writeSync(1, JSON.stringify({jsonrpc:'2.0', id:m.id, result:{serverInfo:{name:'x'}, capabilities:{}}})+'\\n'); process.stdin.pause(); const t = Date.now(); while (Date.now() - t < 20000) {} });`;
		const conn = new mcpClient.McpConnection({ transport: "stdio", command: process.execPath, args: ["-e", script], env: {}, cwd: "" }, { timeoutMs: 1000, connectTimeoutMs: 5000 });
		await conn.connect();
		await assert.rejects(conn.callTool("write_file", { content: "x".repeat(2 * 1024 * 1024) }));
		await conn.close();
		await sleep(300);
		assert.equal(uncaught, 0);
	} finally {
		process.off("uncaughtException", onUncaught);
	}
});

test("[11] stdout 超限后子进程被回收", async () => {
	const rt = new mcp.McpRuntime(quiet);
	const entry = stdioEntry("big", { big: true });
	const conn = await rt.ensure(entry);
	const pid = conn.channel.child.pid;
	await assert.rejects(rt.call(entry, "get_a", {}), /缓冲上限/);
	await rt.closeAll();
	for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
	assert.equal(alive(pid), false, "还在往外喷数据的子进程不能留在后台");
});

test("[12] 握手途中注销 / 卸载 / 改配置：连接不会装到没人管的 slot 上", async () => {
	const pidOf = (rt, name) => rt.slots.get(name)?.connecting?.channel?.child?.pid;
	// 注销
	{
		const rt = new mcp.McpRuntime(quiet);
		const pending = rt.ensure(stdioEntry("a", { initDelay: 600 })).catch((error) => error);
		await sleep(150);
		const pid = pidOf(rt, "a");
		assert.equal(typeof pid, "number");
		await rt.forget("a", "unregister");
		const result = await pending;
		assert.ok(result instanceof Error && result.cancelled === true, "等连接的调用方拿到的是「被取消」");
		for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
		assert.equal(alive(pid), false, "注销之后子进程被关掉");
		assert.equal(rt.slots.has("a"), false);
		assert.equal(rt.breaker.snapshot("a").failures ?? 0, 0, "取消不计入熔断");
	}
	// 插件卸载
	{
		const rt = new mcp.McpRuntime(quiet);
		const pending = rt.ensure(stdioEntry("b", { initDelay: 600 })).catch((error) => error);
		await sleep(150);
		const pid = pidOf(rt, "b");
		await rt.closeAll();
		await pending;
		for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
		assert.equal(alive(pid), false, "卸载之后握手才完成的连接不会留下子进程");
	}
	// 改配置：旧端点的连接不许顶着新配置变成 connected；紧跟着的新连接不受旧的那次影响
	{
		const rt = new mcp.McpRuntime(quiet);
		const pending = rt.ensure(stdioEntry("c", { initDelay: 600 })).catch((error) => error);
		await sleep(150);
		await rt.reclaim("c", "config");
		const fresh = await rt.ensure(stdioEntry("c"));
		assert.equal(fresh.closed, false);
		await pending;
		await sleep(700);
		assert.equal(rt.status("c"), "connected");
		assert.equal(rt.slots.get("c").conn, fresh, "slot 上是新配置的那条连接");
		await rt.closeAll();
	}
});

test("[13] HTTP 会话被服务端丢弃后自动重新握手", async () => {
	let valid = "s1";
	let inits = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const m = JSON.parse(body);
			if (m.method === "initialize") {
				inits += 1;
				res.writeHead(200, { "content-type": "application/json", "mcp-session-id": valid });
				return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "h" }, capabilities: {} } }));
			}
			if (req.headers["mcp-session-id"] !== valid) {
				res.writeHead(404, { "content-type": "application/json" });
				return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } }));
			}
			if (m.id === undefined) {
				res.writeHead(202);
				return res.end();
			}
			const result = m.method === "tools/list" ? { tools: [{ name: "get_a" }] } : m.method === "ping" ? {} : { content: [{ type: "text", text: "ok" }] };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	try {
		const rt = new mcp.McpRuntime(quiet);
		const entry = { name: "h", tier: "on-demand", transport: "streamable-http", url: `http://127.0.0.1:${server.address().port}/mcp`, headers: {}, trial: false, idleTimeout: 0 };
		assert.equal((await rt.call(entry, "get_a", {})).content[0].text, "ok");
		valid = "s2"; // 服务端重启，旧会话没了
		// · A5：撞上 404 的那一次就重新握手并重试，不再把这一次失败甩给模型
		assert.equal((await rt.call(entry, "get_a", {})).content[0].text, "ok", "撞上 404 的那一次调用也成功");
		for (let i = 0; i < 3; i++) assert.equal((await rt.call(entry, "get_a", {})).content[0].text, "ok", "之后照常，不再一直 404 到熔断");
		assert.equal(inits, 2);
		assert.equal(rt.breaker.snapshot("h").state, "closed");
		// 只重试一次：重新握手后会话又立刻失效，就照常报错，不无限重连
		const realInit = valid;
		let rotate = 0;
		const origEmit = server.emit.bind(server);
		server.emit = (ev, req, res) => {
			if (ev === "request" && req.headers["mcp-session-id"] !== undefined) valid = `rot-${++rotate}`;
			return origEmit(ev, req, res);
		};
		await assert.rejects(rt.call(entry, "get_a", {}), /404/);
		server.emit = origEmit;
		valid = realInit;
		// verify 成功后，slot 上那条已失效的连接一并丢掉（A5）
		const slot = rt.slot("h");
		slot.conn = { closed: true, close: async () => {} };
		const v = await rt.verify(entry);
		assert.equal(v.verify.status, "verified");
		assert.equal(slot.conn, undefined, "失效连接不再挂在 slot 上");
		await rt.closeAll();
	} finally {
		server.close();
	}
});

test("[14] 目录段不做变量插值；状态变了只在挂着的时候重建", async () => {
	const { createMcpCatalogMount } = await import(modUrl("lib/index.js"));
	const { renderPrompt } = await import("@deepseek-ai/dsh-system-prompt");
	const specs = [];
	let disposed = 0;
	const ctx = { systemPrompt: { section: (spec) => (specs.push(spec), () => { disposed += 1; }) } };
	let builds = 0;
	const text = "## MCP\n- demo：renders {{ mustache }} templates";
	const mount = createMcpCatalogMount(ctx, { name: "plugin:dsh-studio:mcp", order: 9, build: async () => (builds += 1, text) });
	mount.refresh();
	await sleep(10);
	assert.equal(builds, 0, "没挂的时候 refresh 什么都不做");
	mount.mount();
	await sleep(10);
	assert.equal(specs.length, 1);
	assert.equal(specs[0].interpolate, false);
	// 宿主的渲染器：按我们登记的形态不抛；不带 interpolate:false 才会抛（这就是原来的故障）
	assert.doesNotThrow(() => renderPrompt({ sections: [specs[0]], variables: {} }));
	assert.throws(() => renderPrompt({ sections: [{ ...specs[0], interpolate: true }], variables: {} }));
	mount.refresh();
	await sleep(10);
	assert.equal(builds, 2, "挂着的时候 refresh 重建一次");
	assert.equal(disposed, 1, "旧段被换掉");
	mount.dispose();
	mount.refresh();
	await sleep(10);
	assert.equal(builds, 2, "卸载之后不再重建");

	// 熔断开合会通知上层
	const rt = new mcp.McpRuntime(quiet, { breaker: { threshold: 1, cooldownMs: 60_000 } });
	const stale = [];
	rt.onCatalogStale = (name, state) => stale.push(name + ":" + state);
	rt.breaker.failure("demo", "test");
	rt.breaker.reset("demo");
	assert.deepEqual(stale, ["demo:open", "demo:closed"]);
});

test("[15] profile 导入：路径、注释、接管前校验、disabled 键", async () => {
	const profile = await import(modUrl("lib/profile-mcp.js"));
	const row = "  name: '@deepseek-ai/dsh-mcp-client'";
	// Windows 路径以反斜杠结尾：不吞下一行
	const rows = profile.parseMcpRows(["- id: mcp-a", row, "  config:", "    serverName: alpha", "    command: node", '    args: [ "a.js" ]', "    cwd: D:\\tools\\alpha\\", "- id: mcp-b", row, "  config:", "    serverName: beta", "    command: python", ""].join("\r\n"));
	assert.deepEqual(rows.map((r) => [r.rowId, r.config.serverName, r.config.command]), [["mcp-a", "alpha", "node"], ["mcp-b", "beta", "python"]]);
	assert.equal(rows[0].config.cwd, "D:\\tools\\alpha\\");
	// 行内注释不进值；引号里的 # 保留
	const commented = profile.parseMcpRows(["- id: mcp-y", row, "  config:", "    serverName: y", '    command: "npx" # launcher', "    url: http://h/mcp # prod", '    cwd: "C:/a #1"', ""].join("\n"))[0].config;
	assert.deepEqual([commented.command, commented.url, commented.cwd], ["npx", "http://h/mcp", "C:/a #1"]);

	// 接管前校验：名字不合规的行不导入，原生行也不禁用
	const dir = mkdtempSync(join(home, "prof-"));
	const patch = join(dir, "cordis.patch.yml");
	writeFileSync(patch, ["- id: mcp-dotted", row, "  config:", "    serverName: my.server", "    command: node", '    args: [ "srv.js" ]', "- id: mcp-good", row, "  config:", "    serverName: good", "    command: node", ""].join("\n"));
	put(join(process.env.DSH_HOME, "dsh-studio", "mcp.json"), JSON.stringify({ version: 2, servers: [] }));
	const store = new mcp.McpStore({ logger: quiet });
	const r = await profile.reconcileProfileMcp(store, [patch], { overridePath: patch, autoTakeover: true, logger: quiet });
	assert.deepEqual(r.imported, ["good"]);
	assert.ok(r.skipped.some((s) => s.rowId === "mcp-dotted" && /无法接管/.test(s.reason)), JSON.stringify(r.skipped));
	const after = profile.parseMcpRows(readFileSync(patch, "utf8"));
	assert.equal(after.find((x) => x.rowId === "mcp-dotted").disabled, false, "验不过的行留给原生管理（没被禁用）");
	assert.equal(after.find((x) => x.rowId === "mcp-good").disabled, true);
	assert.deepEqual((await store.load()).servers.map((s) => s.name), ["good"]);

	// 行里本来写着 disabled: false：改值，不再插出第二个同名键
	const explicit = ["- id: mcp-x", row, "  disabled: false", "  config:", "    serverName: x", "    command: node", "- id: other", "  disabled: false", ""].join("\n");
	const off = profile.setRowDisabled(explicit, "mcp-x", true);
	assert.equal(off.changed, true);
	assert.equal(off.text.split("\n").filter((l) => /^ {2}disabled:/.test(l)).length, 2, "每行各一个 disabled 键：" + off.text);
	assert.ok(off.text.includes("- id: mcp-x\n" + row + "\n  disabled: true\n"));
	assert.ok(off.text.includes("- id: other\n  disabled: false\n"), "别的行不受影响");
	assert.equal(profile.setRowDisabled(off.text, "mcp-x", true).changed, false, "幂等");
	const plain = "- id: a\n  name: x\n- id: b\n  name: y\n";
	assert.equal(profile.setRowDisabled(profile.setRowDisabled(plain, "a", true).text, "a", false).text, plain);
});

test("[16] 空闲扫描顺带断开已不在注册表 / 已停用的 server", async () => {
	const rt = new mcp.McpRuntime(quiet);
	const gone = stdioEntry("gone");
	const off = stdioEntry("off");
	const keep = stdioEntry("keep");
	for (const entry of [gone, off, keep]) await rt.ensure(entry);
	// idleTimeoutMinutes: 0 = 不做空闲回收；孤儿清理与它无关
	const reclaimed = await rt.sweep({ idleTimeoutMinutes: 0, servers: [{ ...off, tier: "disabled" }, keep] });
	assert.deepEqual(reclaimed.sort(), ["gone", "off"]);
	assert.equal(rt.connected("keep"), true);
	assert.equal(rt.connected("gone"), false);
	assert.equal(rt.connected("off"), false);
	await rt.closeAll();
});

// ── 零散 ────────────────────────────────────────────────────────────────

test("[17] 文件锁：长临界区不被当成僵死锁收走；释放时不删别人的锁", async () => {
	const { withFsLock } = await import(modUrl("lib/state-lock.js"));
	const lock = join(home, "locks", "ops.lock");
	const opts = { staleMs: 1200, timeoutMs: 10000, pollMs: 20 };
	let inside = 0;
	let overlap = false;
	const critical = (ms) => withFsLock(lock, async () => {
		inside += 1;
		if (inside > 1) overlap = true;
		await sleep(ms);
		inside -= 1;
	}, opts);
	// 第一个持有者在临界区里待的时间是 staleMs 的两倍多
	await Promise.all([critical(2800), sleep(50).then(() => critical(50))]);
	assert.equal(overlap, false, "持有者还活着、还在续期，后来者要等");
	assert.equal(existsSync(lock), false);

	// 读不懂的锁（建锁写到一半 / 续期中途）不等于僵死：新鲜的不许收，放久了才收
	put(lock, "");
	await assert.rejects(withFsLock(lock, async () => {}, { staleMs: 5000, timeoutMs: 300, pollMs: 20 }), { code: "DSH_STUDIO_LOCK_TIMEOUT" });
	assert.equal(existsSync(lock), true, "空锁文件还在，没被当成僵死锁收走");
	const longAgo = new Date(Date.now() - 60_000);
	fs.utimesSync(lock, longAgo, longAgo);
	let ranAfterStale = false;
	await withFsLock(lock, async () => { ranAfterStale = true; }, { staleMs: 5000, timeoutMs: 2000, pollMs: 20 });
	assert.ok(ranAfterStale, "超过 staleMs 没动静的才回收");

	// 持锁很久之后被别人按过期接管（锁文件已换成别人的身份）：原持有者释放时不许删掉接管者的锁
	let stolen = false;
	await withFsLock(lock, async () => {
		writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: "someone-else" }));
		stolen = true;
		await sleep(350);
	}, { staleMs: 400, timeoutMs: 5000, pollMs: 20 });
	assert.ok(stolen);
	assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "someone-else", "别人的锁还在");
	rmSync(lock);
});

test("[18] 使用信号：同一会话后来加载的技能也计数", async () => {
	const usage = await import(modUrl("lib/usage-signals.js"));
	const lifecycle = await import(modUrl("lib/lifecycle.js"));
	const entry = (loads, size) => ({ file: join(home, "sessions", "s-usage", "session.v4.jsonl"), mtime: 1794000000000 + size, size, log: { session: { id: "s-usage" }, skillLoads: loads.map((name) => ({ name, at: Date.now() })) } });
	const first = await usage.ingestUsageSignals([entry(["skill-a"], 100)]);
	assert.equal(first.newSessions, 1);
	// 同一个文件没变：不重复处理
	assert.equal((await usage.ingestUsageSignals([entry(["skill-a"], 100)])).newSessions, 0);
	// 会话续写（文件变大），又加载了 skill-b
	const second = await usage.ingestUsageSignals([entry(["skill-a", "skill-b"], 180)]);
	assert.equal(second.ok, true, second.error);
	const state = await lifecycle.loadState();
	const keys = Object.keys(state).join(",");
	assert.ok(/skill-a/.test(keys) && /skill-b/.test(keys), "skill-b 也有了使用记录：" + keys);
	const a = Object.entries(state).find(([k]) => /skill-a/.test(k))[1];
	assert.equal((a.loadSessions ?? []).length ?? a.useCount, 1, "skill-a 在这个会话里仍只计一次：" + JSON.stringify(a));
});

test("[19] frontmatter：引号里的 # 不是注释", async () => {
	const { parseSkillFile } = await import(modUrl("lib/scanner.js"));
	const desc = (raw) => parseSkillFile("---\nname: x\ndescription: " + raw + "\n---\nbody\n").fields.description;
	assert.equal(desc('"Use when fixing issue #123"'), "Use when fixing issue #123");
	assert.equal(desc("'it''s # fine' # trailing"), "it's # fine");
	assert.equal(desc('"say \\"hi\\" to C:\\\\dir"'), 'say "hi" to C:\\dir', "JSON.stringify 写出的转义读回来是原文");
	assert.equal(desc("Use when fixing # a comment"), "Use when fixing", "不带引号时 ` #` 仍是注释");
	assert.equal(parseSkillFile('---\nname: x\ndisable-model-invocation: "true"\n---\nb\n').fields.disableModelInvocation ?? parseSkillFile('---\nname: x\ndisable-model-invocation: "true"\n---\nb\n').disableModelInvocation, true);
});
