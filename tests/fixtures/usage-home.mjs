// N-03 真实使用信号 fixture：会话日志全部按 extractor 的解析口径**合成**（JSONL 行），
// 不读、不复制真机会话文件。所有演练都在伪 HOME + 伪造会话根里进行。
//
// 覆盖：核心判档、回归对照、会话内去重、跨会话累计、乱序/坏行、增量幂等、新增会话、
//       best-effort 隔离、提及不算、firstUsedAt 不覆盖、存量 useCount 过渡、名字归一、quality 口径。
// 用法：node tests/fixtures/usage-home.mjs <fakeHome> <fixedNowMs>
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { utimesSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = process.argv[2];
const NOW = Number(process.argv[3]);
const DAY = 86_400_000;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const mod = (rel) => import(pathToFileURL(path.join(pluginRoot, "lib", rel)).href);

const extractor = await mod("extractor.js");
const lifecycle = await mod("lifecycle.js");
const quality = await mod("quality.js");
const signals = await mod("usage-signals.js");

const skillsRoot = path.join(home, ".agents", "skills");
const sessionsRoot = path.join(home, ".dsh", "sessions");

// ---------- 建盘：技能目录 + mtime ----------
function writeSkill(name, mtime) {
	const dir = path.join(skillsRoot, name);
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "SKILL.md");
	writeFileSync(file, `---\nname: ${name}\ndescription: 演示 ${name}\n---\n# ${name}\n正文\n`, "utf8");
	const sec = Math.round(mtime / 1000);
	utimesSync(file, sec, sec);
	return file;
}
const MTIME = {
	"alpha-skill": NOW - 200 * DAY,
	"fresh-skill": NOW - 200 * DAY,
	"my-skill": NOW - 200 * DAY,
	"order-skill": NOW - 200 * DAY,
	"beta-stale": NOW - 100 * DAY,
	"beta-archive": NOW - 200 * DAY,
	"mention-only": NOW - 200 * DAY
};
for (const [name, mtime] of Object.entries(MTIME)) writeSkill(name, mtime);

// ---------- 建盘：合成会话日志（按 extractor.readSessionLog 的解析口径） ----------
const header = (id, createdAt) => JSON.stringify({ type: "session", version: 4, id, createdAt, cwd: "C:\\demo\\" + id });
const toolCall = (seq, time, tool, args) =>
	JSON.stringify({ type: "tool/call", seq, time, data: { turn: 1, step: 1, callId: "c" + seq, name: tool, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const toolResult = (seq, time) => JSON.stringify({ type: "tool/result", seq, time, data: { turn: 1, step: 1, callId: "c" + seq, message: { role: "tool", content: [{ type: "text", text: "ok" }] } } });
const spliced = (seq, time, text) =>
	JSON.stringify({ type: "agent/inbox/spliced", seq, time, data: { target: "next-turn", start: 0, inserted: [{ role: "user", content: [{ type: "text", text }] }] } });
const load = (seq, time, name) => toolCall(seq, time, "skill", { name });

function writeSession(id, mtime, lines, file = "session.v4.jsonl") {
	const dir = path.join(sessionsRoot, id);
	mkdirSync(dir, { recursive: true });
	const target = path.join(dir, file);
	writeFileSync(target, lines.join("\n") + "\n", "utf8");
	const sec = Math.round(mtime / 1000);
	utimesSync(target, sec, sec);
	return target;
}

const tA = NOW - 3 * DAY;
const tB = NOW - 1 * DAY;

// 会话 A：order-skill 三次加载且时间乱序；alpha-skill 两次（会话内去重）；坏行/未知类型穿插；
//         消息正文提到 alpha-skill / mention-only（提及不算）；还混一条非 skill 工具调用（不许误采）。
writeSession("sess-A", tA, [
	header("sess-A", tA - 1000),
	load(1, tA + 2000, "order-skill"),
	"{ this is not json",
	load(2, tA + 0, "order-skill"),
	JSON.stringify({ type: "future/thing", data: { note: "未知类型行" } }),
	load(3, tA + 1000, "order-skill"),
	load(4, tA + 500, "alpha-skill"),
	toolCall(5, tA + 700, "bash", { command: "echo skill" }),
	spliced(6, tA + 800, "刚才用 alpha-skill 和 mention-only 试过，效果不错"),
	load(7, tA + 600, "alpha-skill"),
	toolResult(8, tA + 900)
]);

// 会话 B：alpha 第二次（跨会话累计）；fresh-skill 首次；"My Skill" 归一形态；arguments 已是对象。
writeSession("sess-B", tB, [
	header("sess-B", tB - 1000),
	load(1, tB, "alpha-skill"),
	load(2, tB + 10, "fresh-skill"),
	toolCall(3, tB + 20, "skill", { name: "My Skill" }),
	toolResult(4, tB + 30)
]);

// 会话 C：只在消息正文提到 mention-only，没有任何加载记录。
writeSession("sess-C", NOW - 2 * DAY, [
	header("sess-C", NOW - 2 * DAY - 1000),
	spliced(1, NOW - 2 * DAY, "想再用一次 mention-only，但这次没加载它")
]);

// 会话 D：损坏的 .zstd —— 解压必失败，只能跳过。
writeSession("sess-D", NOW - 2 * DAY, ["\u0000\u0001not a zstd frame"], "session.v4.jsonl.zstd");

// 会话 E：以目录冒充日志文件（枚举时按目录走，不能被当成会话）。
mkdirSync(path.join(sessionsRoot, "sess-E", "session.jsonl"), { recursive: true });

// 会话 Z：窗口外（30 天前，提取窗口 7 天）→ 不补计，beta-stale 不被这个信号救活。
writeSession("sess-Z", NOW - 30 * DAY, [header("sess-Z", NOW - 30 * DAY), load(1, NOW - 30 * DAY, "beta-stale")]);

// ---------- 存量状态：alpha 带旧口径 useCount（写路径计数），my-skill 由写路径建过一次 ----------
const T0 = NOW - 30 * DAY;
await lifecycle.saveState({
	"alpha-skill": { firstUsedAt: T0, lastUsedAt: T0, useCount: 5, status: "active", lastCheckAt: T0 }
});
await lifecycle.markSkillUsed("my-skill", NOW - 5 * DAY);

const cfg = {
	...extractor.defaults(),
	enabled: true,
	windowDays: 7,
	agentSkillDir: skillsRoot,
	staleAfterDays: 90,
	archiveAfterDays: 180,
	llmBaseUrl: "",
	llmApiKey: "",
	llmModel: ""
};

// ---------- 阶段 1：第一次提取周期（无模型通道 → 早退，但采集已完成） ----------
const run1 = await extractor.runExtraction(cfg, sessionsRoot, { now: NOW, llm: null });
const state1 = await lifecycle.loadState();
const loadCountOf = (logEntries, name) =>
	logEntries.reduce((sum, entry) => sum + (entry.log?.skillLoads ?? []).filter((item) => item?.name === name).length, 0);
const rawEntries = await extractor.collectSessionLogs(sessionsRoot, cfg.windowDays);
const rawLoads = {
	alpha: loadCountOf(rawEntries, "alpha-skill"),
	order: loadCountOf(rawEntries, "order-skill")
};
const rawFiles = rawEntries.map((e) => path.basename(path.dirname(e.file)) + "/" + path.basename(e.file));

// ---------- 阶段 2：同一批日志再跑一遍（幂等） ----------
const stateBefore2 = readFileSync(lifecycle.lifecyclePath(), "utf8");
const run2 = await extractor.runExtraction(cfg, sessionsRoot, { now: NOW + 1000, llm: null });
const stateAfter2 = readFileSync(lifecycle.lifecyclePath(), "utf8");

// ---------- 阶段 2.5：删掉水位线再跑一遍 —— 靠 loadSessions 去重兜底，状态仍不变 ----------
rmSync(signals.usageSignalsPath());
const stateBefore25 = readFileSync(lifecycle.lifecyclePath(), "utf8");
const run25 = await extractor.runExtraction(cfg, sessionsRoot, { now: NOW + 1500, llm: null });
const stateAfter25 = readFileSync(lifecycle.lifecyclePath(), "utf8");

// ---------- 阶段 3：新增一个会话文件，只有它的事件被计入 ----------
const tG = NOW - 3600_000;
writeSession("sess-G", tG, [header("sess-G", tG - 1000), load(1, tG, "alpha-skill")]);
const run3 = await extractor.runExtraction(cfg, sessionsRoot, { now: NOW + 2000, llm: null });
const state3 = await lifecycle.loadState();

// ---------- 阶段 4：巡检（先只读预览，再真跑；确认归档只搬不删） ----------
const preview = await lifecycle.scanLifecycle(cfg, { now: NOW + 3000, apply: false });
const applied = await lifecycle.scanLifecycle(cfg, { now: NOW + 4000, apply: true });
const archiveDirs = readdirSync(path.join(home, ".dsh")).filter((n) => n.startsWith("skill-archive-"));
const archiveCopies = archiveDirs.flatMap((dir) =>
	readdirSync(path.join(home, ".dsh", dir)).map((name) => ({
		name,
		hasSkillFile: existsSync(path.join(home, ".dsh", dir, name, "SKILL.md"))
	}))
);
const skillsAfterApply = readdirSync(skillsRoot);

// ---------- 阶段 5：quality 口径（平均使用次数按加载会话数） ----------
await extractor.writeProvenance({ name: "alpha-skill", action: "SAVE", at: NOW - 10 * DAY, rationale: "入库" });
await extractor.writeProvenance({ name: "my-skill", action: "SAVE", at: NOW - 10 * DAY, rationale: "入库" });
const qualityMetrics = await quality.collectQualityMetrics({ now: NOW + 5000, skillRoots: [skillsRoot] });

// ---------- 阶段 6：best-effort 隔离（独立子 HOME，构造「水位线写不进去」） ----------
const boHome = home + "-bo";
mkdirSync(path.join(boHome, ".dsh", "dsh-studio", "usage-signals.json"), { recursive: true }); // 目录冒充文件
process.env.USERPROFILE = boHome;
process.env.HOME = boHome;
const boIngest = await signals.ingestUsageSignals(
	[{ file: path.join(boHome, "s.jsonl"), mtime: NOW, size: 10, log: { session: { id: "bo-1" }, skillLoads: [{ name: "bo-skill", at: NOW }] } }],
	{ now: NOW }
);
const weirdIngest = await signals.ingestUsageSignals(
	[null, { file: 123, log: null }, { log: { skillLoads: [null, { name: null }, { name: "   ", at: "bad" }] } }],
	{ now: NOW }
);
const boScan = await lifecycle.scanLifecycle({ agentSkillDir: path.join(boHome, "no-such-dir") }, { now: NOW, apply: true });
process.env.USERPROFILE = home;
process.env.HOME = home;

// ---------- 旧公式回退抽查：基线代码下这些技能会落哪一档 ----------
const legacyVerdictOf = (name) =>
	lifecycle.classifySkill({ ageDays: (NOW - MTIME[name]) / DAY, staleAfterDays: 90, archiveAfterDays: 180 });

process.stdout.write(
	JSON.stringify({
		now: NOW,
		t0: T0,
		tA,
		tB,
		tG,
		rawLoads,
		rawFiles,
		legacyVerdicts: {
			alpha: legacyVerdictOf("alpha-skill"),
			fresh: legacyVerdictOf("fresh-skill"),
			order: legacyVerdictOf("order-skill"),
			my: legacyVerdictOf("my-skill"),
			mention: legacyVerdictOf("mention-only"),
			stale: legacyVerdictOf("beta-stale"),
			archive: legacyVerdictOf("beta-archive")
		},
		phase1: { ok: run1.ok, message: run1.message, usageSignals: run1.usageSignals, state: state1 },
		phase2: { usageSignals: run2.usageSignals, sameState: stateBefore2 === stateAfter2 },
		phase25: { usageSignals: run25.usageSignals, sameState: stateBefore25 === stateAfter25 },
		phase3: { usageSignals: run3.usageSignals, state: state3 },
		scan: {
			previewStale: preview.stale.map((s) => s.name),
			previewArchived: preview.archived.map((s) => s.name),
			previewSkipped: preview.skipped,
			appliedArchived: applied.archived.map((s) => s.name),
			archiveCopies,
			skillsAfterApply,
			stateAfterApply: await lifecycle.loadState()
		},
		quality: {
			avgUseCount: qualityMetrics.cohort.avgUseCount,
			used: qualityMetrics.cohort.used,
			cohortN: qualityMetrics.cohort.n,
			summary: qualityMetrics.summary,
			unavailable: qualityMetrics.unavailable.map((u) => u.metric)
		},
		bestEffort: { boIngest, weirdIngest, boScan }
	})
);
