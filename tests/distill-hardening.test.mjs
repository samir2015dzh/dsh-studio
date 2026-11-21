/**
 * ：对话蒸馏硬化（草稿 → 查重 / 评估门 → 入库或合并提案；出处可跳回；节奏与上限；报告；面板）。
 *
 * 全在伪 HOME 里跑：会话日志是合成夹具（按 extractor.readSessionLog 的口径），
 * 提取模型与评估模型都是假模型，离线、确定。
 *
 *   [1] 提取候选 → 草稿（不写库、不调评估模型）；出处 = 会话 id / 时间 / 关键轮次（定位到相关消息、不带无关消息）；守门命中直接淘汰留记录
 *   [2] 过门 → 按 #1 版本化写进技能库：版本记录 actor=distill:gate-pass、带 distill 出处；评估集冻结在 #3 目录；报告过门率
 *   [3] 不过门 → 淘汰，记录口径同 #3 discards（kind=gate、reasons、eval）；不写库；所有者只能 discard / requeue，没有直接放行
 *   [4] 与库里高度相似 → 不新建，出 #4 合并提案（草稿作来源、合并稿过门预演）；批准 → 保留方新版本溯源到草稿，草稿标已并入，不进回收站；
 *       拒绝 → merge-rejected，requeue 后跳过查重直接过门
 *   [5] 节奏与上限：默认关；每批上限留队列；预算到顶停批、不写库
 *   [6] 来源跳转：读会话日志给出关键轮次前后的消息
 *   [7] 点名蒸馏：只蒸馏指定会话，本批只处理它产出的草稿
 *   [8] 工具 / 路由经注册层可用；路由只认 loopback；extractor 经 onCandidates 不走旧的直接写库 / 直接合并
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-distill-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
delete process.env.DSH_STUDIO_HISTORY_DIR;
delete process.env.DSH_AGENTS_HOME;
process.env.DSH_STUDIO_TELEMETRY_DIR = join(fakeHome, "telemetry");

const { createDistill, locateKeyTurns, draftTextOf } = await import(modUrl("lib/distill.js"));
const { DISTILL_DEFAULTS } = await import(modUrl("lib/distill-config.js"));
const { buildDistillTools, buildDistillRoutes, DISTILL_API } = await import(modUrl("lib/distill-tools.js"));
const { createGovernance } = await import(modUrl("lib/governance.js"));
const { runExtraction, defaults: extractorDefaults } = await import(modUrl("lib/extractor.js"));
const { readVersionRecords } = await import(modUrl("lib/versions.js"));

const quiet = { info() {}, warn() {}, error() {} };
const dshSkills = join(fakeHome, ".dsh", "skills");
const agentSkills = join(fakeHome, ".agents", "skills");
const sessionsRoot = join(fakeHome, ".dsh", "sessions");

test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

// ── 合成会话 ─────────────────────────────────────────────────────────────
const NOW = Date.now();
const header = (id, createdAt) => JSON.stringify({ type: "session", version: 4, id, createdAt: new Date(createdAt).toISOString(), cwd: "/work/" + id });
const say = (seq, role, text) => JSON.stringify({ type: "agent/inbox/spliced", seq, time: NOW, data: { target: "next-turn", start: 0, inserted: [{ role, content: [{ type: "text", text }] }] } });
function writeSession(id, msgs) {
	const dir = join(sessionsRoot, id);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "session.v4.jsonl");
	writeFileSync(file, [header(id, NOW - 60_000), ...msgs.map(([role, text], i) => say(i + 1, role, text))].join("\n") + "\n");
	return file;
}

const CSV = { name: "csv-dedupe", description: "按指定列给 CSV 文件去重", group: "数据检索", rationale: "用户反复要求按列去重", body: "1. 读取 CSV 文件\n2. 用 pandas `drop_duplicates` 按指定列去重，保留第一条\n3. 保存去重结果并报告删掉了几行" };
const COMMIT = { name: "commit-message-writer", description: "帮用户写规范的 git commit message 并提交改动", group: "代码工程", rationale: "提交流程", body: "1. 运行 `git status` 查看改动\n2. 运行 `git diff` 查看改动内容\n3. 写约定式提交的 commit message\n4. 调用 `git_commit` 完成提交" };
const LEAKY = { name: "leaky-deploy", description: "部署脚本", group: "环境运维", rationale: "x", body: "1. 设置 api_key = abcdefghijklmnopqrstuvwx 然后部署" };

const GIT_HELPER = [
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
const MERGED = GIT_HELPER.replace("4. 执行 `git_commit` 提交", "4. 执行 `git_commit` 提交（提交信息用约定式提交格式）");

let caseNo = 0;
function fresh({ library = [], sessions = {} } = {}) {
	caseNo += 1;
	for (const d of [dshSkills, agentSkills, sessionsRoot, join(fakeHome, ".dsh", "dsh-studio")]) rmSync(d, { recursive: true, force: true });
	mkdirSync(dshSkills, { recursive: true });
	mkdirSync(agentSkills, { recursive: true });
	process.env.DSH_STUDIO_DISTILL_DIR = join(fakeHome, "distill-" + caseNo);
	process.env.DSH_STUDIO_GOVERNANCE_DIR = join(fakeHome, "gov-" + caseNo);
	process.env.DSH_STUDIO_OPTIMIZER_DIR = join(fakeHome, "opt-" + caseNo);
	for (const [name, text] of library) {
		mkdirSync(join(agentSkills, name), { recursive: true });
		writeFileSync(join(agentSkills, name, "SKILL.md"), text);
	}
	const files = {};
	for (const [id, msgs] of Object.entries(sessions)) files[id] = writeSession(id, msgs);
	return files;
}

/** 提取用的假宿主 llm（流式接口，同 extract-fixes 的口径）。 */
const extractLlm = (cands) => ({
	listProviders: () => [{ id: "fixture" }],
	listModels: async () => ["fixture-model"],
	prepareCall: async (config) => ({
		config,
		stream: async function* () {
			yield { type: "text-delta", text: JSON.stringify({ candidates: cands }) };
			yield { type: "finish", reason: { kind: "ok" } };
		}
	})
});
/** 评估 / 合并用的假模型（purpose = cases | judge | merge）。 */
function fakeModel({ judge = () => 8, merged = MERGED } = {}) {
	const calls = [];
	return {
		calls,
		async complete(req) {
			calls.push({ purpose: req.purpose, label: req.meta?.label ?? null, name: req.meta?.name ?? null });
			if (req.purpose === "cases") return { text: JSON.stringify({ cases: [{ id: "c1", scenario: "按 email 列给 data.csv 去重", expect: "用 drop_duplicates 按列去重", critical: true }, { id: "c2", scenario: "去重后告诉我删了几行", expect: "报告删除行数", critical: false }] }) };
			if (req.purpose === "judge") return { text: JSON.stringify({ scores: req.meta.cases.map((c) => ({ id: c.id, score: judge(req.meta.label, c), reason: "fake" })) }) };
			if (req.purpose === "merge") return { text: `<summary>并入</summary>\n<skill>\n${merged}</skill>` };
			return { text: "" };
		}
	};
}
const extractCfg = () => ({ ...extractorDefaults(), enabled: true, windowDays: 7, agentSkillDir: agentSkills, mirrorDir: "", llmBaseUrl: "", llmApiKey: "", llmModel: "" });

function setup({ model = fakeModel(), cands = [CSV], pluginConfig = {}, now } = {}) {
	const governance = createGovernance({ pluginConfig: {}, model, logger: quiet });
	let distill;
	const extract = (opts = {}) => runExtraction(extractCfg(), sessionsRoot, { now: NOW, llm: extractLlm(cands), onCandidates: (c, info) => distill.ingest(c, info), ...opts });
	distill = createDistill({ pluginConfig, governance, extractConfig: async () => extractCfg(), extract, model, logger: quiet, ...(now ? { now } : {}) });
	return { governance, distill, extract, model };
}
const CSV_SESSION = [
	["user", "帮我把 data.csv 按 email 列去重，保留第一条"],
	["assistant", "好的，用 pandas 的 drop_duplicates 按 email 列去重，保留第一条"],
	["user", "今天天气怎么样"],
	["assistant", "我查不到天气"]
];

// ── [1] ──────────────────────────────────────────────────────────────────
test("[1] 候选 → 草稿（不写库、不调评估模型）；出处带会话 / 时间 / 关键轮次；守门命中淘汰留记录", async () => {
	const files = fresh({ sessions: { "sess-csv": CSV_SESSION } });
	const { distill, extract, model } = setup({ cands: [CSV, LEAKY] });
	const r = await extract();
	assert.equal(r.ok, true, r.message);
	assert.match(r.message, /新草稿 2 个/);
	assert.deepEqual(r.accepted, []);
	assert.deepEqual(r.merged, []);
	assert.equal(readdirSync(agentSkills).length, 0, "草稿不进技能根");
	assert.equal(model.calls.length, 0, "成草稿不调评估模型");
	const drafts = await distill.listDrafts();
	const csv = drafts.find((d) => d.name === "csv-dedupe");
	assert.equal(csv.status, "queued");
	assert.equal(csv.text, draftTextOf(CSV));
	assert.deepEqual(csv.provenance.sessionIds, ["sess-csv"]);
	assert.equal(csv.provenance.trigger, "extract");
	assert.ok(Date.parse(csv.provenance.extractedAt) > 0);
	const s = csv.provenance.sessions[0];
	assert.equal(s.id, "sess-csv");
	assert.equal(s.file, files["sess-csv"]);
	assert.deepEqual(s.turns.map((t) => t.turn), [1, 2], "关键轮次 = 第 1、2 条消息");
	assert.ok(!s.turns.some((t) => t.turn === 3), "无关消息（天气）不算关键轮次");
	assert.match(s.turns[0].excerpt, /data\.csv/);
	const leaky = drafts.find((d) => d.name === "leaky-deploy");
	assert.equal(leaky.status, "failed");
	assert.equal(leaky.failure.kind, "guard");
	const discards = readFileSync(join(process.env.DSH_STUDIO_DISTILL_DIR, "discards.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(discards[0].kind, "guard");
	assert.equal(discards[0].draftId, leaky.id);
	// 再跑一次同样的候选：不重复建草稿
	const again = await extract();
	assert.match(again.message, /新草稿 0 个/);
	assert.equal((await distill.listDrafts()).length, 2);
	// 纯函数：没有任何重叠时仍保留会话 id
	const none = locateKeyTurns({ name: "zzz", description: "", body: "qqq" }, [{ file: "/f", log: { session: { id: "s9" }, msgs: [{ role: "user", text: "hello" }] } }]);
	assert.deepEqual(none.map((x) => [x.id, x.turns.length]), [["s9", 0]]);
});

// ── [2] ──────────────────────────────────────────────────────────────────
test("[2] 过门 → 版本化入库（actor / distill 出处 / 评估）；评估集冻结；报告过门率", async () => {
	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	const { distill, extract, model } = setup();
	await extract();
	const report = await distill.runBatch({ trigger: "manual" });
	assert.equal(report.status, "completed", report.markdown);
	assert.equal(report.counts.published, 1);
	assert.equal(report.passRate, 1);
	assert.match(report.markdown, /过门率：100%/);
	assert.deepEqual(model.calls.map((c) => c.purpose), ["cases", "judge"]);
	const file = join(agentSkills, "csv-dedupe", "SKILL.md");
	assert.equal(readFileSync(file, "utf8"), draftTextOf(CSV), "写进库的就是过门的那份文本");
	const rec = (await readVersionRecords()).find((r) => r.name === "csv-dedupe" && r.action === "create");
	assert.ok(rec, "有 #1 版本记录");
	assert.equal(rec.actor, "distill:gate-pass");
	assert.deepEqual(rec.sessionIds, ["sess-csv"]);
	assert.equal(rec.distill.sessions[0].id, "sess-csv");
	assert.deepEqual(rec.distill.sessions[0].turns, [1, 2]);
	assert.equal(rec.distill.eval.verdict, "pass");
	const d = (await distill.listDrafts())[0];
	assert.equal(d.status, "published");
	assert.equal(d.published.versionId, rec.id);
	assert.equal(rec.distill.draftId, d.id);
	const evalSet = JSON.parse(readFileSync(join(process.env.DSH_STUDIO_OPTIMIZER_DIR, "evals", "csv-dedupe.json"), "utf8"));
	assert.equal(evalSet.origin, "distill");
	assert.equal(evalSet.draftId, d.id);
	// 状态 / 报告可查
	const s = await distill.status({});
	assert.equal(s.counts.published, 1);
	assert.equal(s.reports[0].passRate, 1);
});

// ── [3] ──────────────────────────────────────────────────────────────────
test("[3] 不过门 → 淘汰、丢弃记录同 #3 口径、不写库；没有直接放行；requeue / discard", async () => {
	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	const { distill, extract } = setup({ model: fakeModel({ judge: (_l, c) => (c.critical ? 4 : 9) }) });
	await extract();
	const report = await distill.runBatch({});
	assert.equal(report.counts.gateFailed, 1);
	assert.equal(report.passRate, 0);
	assert.equal(existsSync(join(agentSkills, "csv-dedupe")), false, "不过门不写库");
	const d = (await distill.listDrafts())[0];
	assert.equal(d.status, "failed");
	assert.equal(d.failure.kind, "gate");
	assert.ok(d.failure.reasons.some((x) => /关键场景 c1/.test(x)), d.failure.reasons.join("；"));
	const rec = readFileSync(join(process.env.DSH_STUDIO_DISTILL_DIR, "discards.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
	assert.equal(rec.kind, "gate");
	assert.equal(rec.skill, "csv-dedupe");
	assert.ok(Array.isArray(rec.reasons) && rec.reasons.length > 0);
	assert.ok(rec.eval && typeof rec.eval.mean === "number");
	await assert.rejects(distill.decide({ id: d.id, decision: "approve" }), /没有直接放行/);
	const rq = await distill.decide({ id: d.id, decision: "requeue", reason: "改了评估集再试" });
	assert.equal(rq.draft.status, "queued");
	const dc = await distill.decide({ id: d.id, decision: "discard", reason: "不要了" });
	assert.equal(dc.draft.status, "discarded");
	assert.equal((await distill.runBatch({})).status, "empty");
});

// ── [4] ──────────────────────────────────────────────────────────────────
test("[4] 与库里高度相似 → 合并提案（草稿作来源）；批准溯源到草稿、不进回收站；拒绝后 requeue 跳过查重", async () => {
	fresh({ library: [["git-commit-helper", GIT_HELPER]], sessions: { "sess-git": [["user", "帮我写 commit message 然后提交，先看 git status 和 git diff"], ["assistant", "好的，按约定式提交写 commit message 再 git_commit"]] } });
	const { distill, extract, governance, model } = setup({ cands: [COMMIT] });
	await extract();
	const report = await distill.runBatch({});
	assert.equal(report.counts.mergeProposed, 1, report.markdown);
	assert.equal(report.merges[0].into, "git-commit-helper");
	assert.match(report.markdown, /合并去向/);
	assert.equal(existsSync(join(agentSkills, "commit-message-writer")), false, "相似的不新建");
	assert.ok(model.calls.some((c) => c.purpose === "merge"));
	const d = (await distill.listDrafts())[0];
	assert.equal(d.status, "merge-proposed");
	const pending = await governance.listProposals({ status: "pending" });
	assert.equal(pending.length, 1);
	const p = pending[0];
	assert.equal(p.drop.draft, true);
	assert.equal(p.drop.draftId, d.id);
	assert.equal(p.eval.verdict, "pass", "合并稿过门预演");
	const r = await governance.decide({ id: p.id, decision: "approve" });
	assert.equal(r.proposal.status, "approved");
	assert.equal(readFileSync(join(agentSkills, "git-commit-helper", "SKILL.md"), "utf8"), MERGED);
	const rec = (await readVersionRecords()).find((x) => x.action === "governance-merge");
	assert.equal(rec.merge.sources[1].role, "draft");
	assert.equal(rec.merge.sources[1].draftId, d.id);
	assert.deepEqual(rec.merge.sources[1].provenance.sessionIds, ["sess-git"]);
	const after = (await distill.listDrafts())[0];
	assert.equal(after.status, "merged");
	assert.equal(after.merge.versionId, rec.id);
	assert.equal(existsSync(join(fakeHome, ".dsh", "dsh-studio", "trash")) && readdirSync(join(fakeHome, ".dsh", "dsh-studio", "trash")).length > 0, false, "草稿不进回收站");

	// 拒绝路径
	fresh({ library: [["git-commit-helper", GIT_HELPER]], sessions: { "sess-git": [["user", "帮我写 commit message 然后提交"]] } });
	const s2 = setup({ cands: [COMMIT] });
	await s2.extract();
	await s2.distill.runBatch({});
	const p2 = (await s2.governance.listProposals({ status: "pending" }))[0];
	await s2.governance.decide({ id: p2.id, decision: "reject", reason: "这是另一个技能" });
	const d2 = (await s2.distill.listDrafts())[0];
	assert.equal(d2.status, "merge-rejected");
	const rq = await s2.distill.decide({ id: d2.id, decision: "requeue" });
	assert.equal(rq.draft.status, "queued");
	const r2 = await s2.distill.runBatch({});
	assert.equal(r2.counts.published, 1, "跳过查重直接过门");
	assert.ok(existsSync(join(agentSkills, "commit-message-writer", "SKILL.md")));
});

// ── [5] ──────────────────────────────────────────────────────────────────
test("[5] 节奏与上限：默认关；每批上限；预算到顶停批、不写库", async () => {
	assert.equal(DISTILL_DEFAULTS.enabled, false);
	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	const other = { ...CSV, name: "tsv-dedupe", description: "按列给 TSV 文件去重", body: "1. 读取 TSV\n2. 按列去重\n3. 保存" };
	const { distill, extract } = setup({ cands: [CSV, other], pluginConfig: { limits: { maxDrafts: 1 } } });
	await extract();
	assert.equal((await distill.tick()).reason, "disabled");
	const r1 = await distill.runBatch({});
	assert.equal(r1.counts.processed, 1);
	assert.equal(r1.counts.deferred, 1);
	assert.equal((await distill.listDrafts({ status: "queued" })).length, 1, "超上限的留在队列");

	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	const s2 = setup({ pluginConfig: { limits: { maxModelCalls: 1 } } });
	await s2.extract();
	const r2 = await s2.distill.runBatch({});
	assert.equal(r2.status, "budget-stop");
	assert.equal(existsSync(join(agentSkills, "csv-dedupe")), false);
	assert.equal((await s2.distill.listDrafts({ status: "queued" })).length, 1, "停批的草稿仍在队列");

	// 打开后也只在闲时窗口跑
	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	const noon = new Date(NOW);
	noon.setHours(12, 0, 0, 0);
	const s3 = setup({ pluginConfig: { enabled: true }, now: () => noon.getTime() });
	await s3.extract();
	assert.equal((await s3.distill.tick()).reason, "outside-window");
});

// ── [6] ──────────────────────────────────────────────────────────────────
test("[6] 来源跳转：关键轮次前后的消息", async () => {
	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	const { distill, extract } = setup();
	await extract();
	const d = (await distill.listDrafts())[0];
	const src = await distill.source(d.id);
	assert.equal(src.sessions[0].id, "sess-csv");
	assert.equal(src.sessions[0].readable, true);
	const keys = src.sessions[0].context.filter((m) => m.key).map((m) => m.turn);
	assert.deepEqual(keys, [1, 2]);
	assert.ok(src.sessions[0].context.some((m) => m.turn === 3 && !m.key), "带上下文");
	await assert.rejects(distill.source("draft-nope"), /找不到草稿/);
});

// ── [7] ──────────────────────────────────────────────────────────────────
test("[7] 点名蒸馏：只读指定会话，本批只处理它的草稿", async () => {
	fresh({ sessions: { "sess-csv": CSV_SESSION, "sess-other": [["user", "随便聊聊"]] } });
	const { distill } = setup();
	const r = await distill.runManual({ sessionId: "sess-csv" });
	assert.equal(r.counts.published, 1, r.markdown);
	assert.match(r.markdown, /扫描 1 个会话/);
	const d = (await distill.listDrafts())[0];
	assert.equal(d.provenance.trigger, "named");
	assert.deepEqual(d.provenance.sessionIds, ["sess-csv"]);
	const miss = await distill.runManual({ sessionId: "sess-missing" });
	assert.equal(miss.counts.queuedBefore, 0);
	assert.match(miss.extract.message, /点名的会话没找到/);
});

// ── [8] ──────────────────────────────────────────────────────────────────
test("[8] 工具 / 路由经注册层可用；路由只认 loopback", async () => {
	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	const { distill, extract } = setup();
	await extract();
	const tools = Object.fromEntries(buildDistillTools({ distill }).map((t) => [t.name, t]));
	assert.deepEqual(Object.keys(tools), ["skillmgr_distill_status", "skillmgr_distill_run", "skillmgr_distill_decide"]);
	const st = await tools.skillmgr_distill_status.execute({}, {});
	assert.equal(st.ok, true, st.message);
	assert.match(st.message, /队列（1）/);
	const id = st.queue[0].id;
	const one = await tools.skillmgr_distill_status.execute({ id }, {});
	assert.match(one.message, /关键轮次 #1/);
	const run = await tools.skillmgr_distill_run.execute({}, {});
	assert.equal(run.ok, true, run.message);
	assert.match(run.message, /过门入库 1/);
	const bad = await tools.skillmgr_distill_decide.execute({ id, decision: "approve" }, {});
	assert.equal(bad.ok, false);

	const routes = buildDistillRoutes({ logger: quiet }, { distill });
	assert.deepEqual(routes.map((r) => r.path), Object.values(DISTILL_API));
	const call = async (path, method, body, remote = "127.0.0.1", query = "") => {
		const route = routes.find((r) => r.path === path);
		const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
		const req = { method, url: path + query, headers: { host: "127.0.0.1" }, socket: { remoteAddress: remote }, [Symbol.asyncIterator]: async function* () { yield* chunks; }, on(ev, fn) { if (ev === "data") for (const c of chunks) fn(c); if (ev === "end") fn(); return this; } };
		let status = 0;
		let out = "";
		const res = { statusCode: 200, setHeader() {}, writeHead(c) { status = c; return this; }, end(d) { out = String(d ?? ""); if (!status) status = this.statusCode; } };
		await route.handler(req, res);
		return { status: status || res.statusCode, body: out ? JSON.parse(out) : null };
	};
	assert.equal((await call(DISTILL_API.status, "GET", undefined, "10.0.0.2")).status, 403);
	const s = await call(DISTILL_API.status, "GET");
	assert.equal(s.status, 200);
	assert.equal(s.body.counts.published, 1);
	const src = await call(DISTILL_API.source, "GET", undefined, "127.0.0.1", "?id=" + id);
	assert.equal(src.status, 200);
	assert.equal(src.body.sessions[0].id, "sess-csv");
});

// ── · A6 ─────────────────────────────────────────────────────────
test("[A6] 批次收尾写报告失败也放锁；批次进行中所有者淘汰的草稿不被批次覆盖", async () => {
	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	let distill;
	let onCases = null;
	const base = fakeModel();
	const model = {
		calls: base.calls,
		async complete(req) {
			if (req.purpose === "cases" && onCases !== null) await onCases();
			return base.complete(req);
		}
	};
	({ distill } = setup({ model }));
	const { extract } = { extract: (opts = {}) => runExtraction(extractCfg(), sessionsRoot, { now: NOW, llm: extractLlm([CSV]), onCandidates: (c, info) => distill.ingest(c, info), ...opts }) };
	await extract();
	const [draft] = await distill.listDrafts({ status: "queued" });

	// 批次处理这份草稿（评估门要调模型）的过程中，所有者把它淘汰了
	onCases = async () => {
		onCases = null;
		await distill.decide({ id: draft.id, decision: "discard", reason: "不要了" });
	};
	const report = await distill.runBatch({});
	const after = (await distill.listDrafts()).find((d) => d.id === draft.id);
	assert.equal(after.status, "discarded", "所有者的决定不被批次覆盖");
	assert.ok(after.history.some((h) => h.change === "batch-result-not-applied"), "本批结果记进历史");
	assert.match(report.drafts.find((d) => d.id === draft.id).note, /以那次决定为准/);

	// 写报告失败：reports 目录位置被一个文件占住
	await distill.decide({ id: draft.id, decision: "requeue" });
	const reportsDir = join(process.env.DSH_STUDIO_DISTILL_DIR, "reports");
	rmSync(reportsDir, { recursive: true, force: true });
	writeFileSync(reportsDir, "not a dir");
	await assert.rejects(distill.runBatch({}), /ENOTDIR|EEXIST|not a directory/i);
	assert.equal(existsSync(join(process.env.DSH_STUDIO_DISTILL_DIR, "batch.lock")), false, "锁已放");
	rmSync(reportsDir, { force: true });
	const again = await distill.runBatch({});
	assert.notEqual(again.status, undefined, "紧接着能再起一批（旧码这里 409：另一批蒸馏正在进行）");
});

test("[A6] 治理轮次收尾写报告失败也放锁", async () => {
	fresh({});
	const governance = createGovernance({ pluginConfig: {}, model: fakeModel(), logger: quiet });
	const reportsDir = join(process.env.DSH_STUDIO_GOVERNANCE_DIR, "reports");
	mkdirSync(process.env.DSH_STUDIO_GOVERNANCE_DIR, { recursive: true });
	writeFileSync(reportsDir, "not a dir");
	await assert.rejects(governance.runRound({ only: ["unused"] }), /ENOTDIR|EEXIST|not a directory/i);
	assert.equal(existsSync(join(process.env.DSH_STUDIO_GOVERNANCE_DIR, "round.lock")), false, "锁已放");
	rmSync(reportsDir, { force: true });
	const r = await governance.runRound({ only: ["unused"] });
	assert.equal(typeof r.roundId, "string", "紧接着能再起一轮（旧码这里 409：已有一轮治理在进行）");
});

// ── · A7 ─────────────────────────────────────────────────────────
test("[A7] 一份坏会话日志不拖垮整轮提取：createdAt 读不懂退回 mtime；非字符串 type 的行跳过", async () => {
	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	// 坏日志一：createdAt 是读不懂的串（旧码 buildDigest → RangeError，整轮失败）
	const badDate = join(sessionsRoot, "sess-bad-date");
	mkdirSync(badDate, { recursive: true });
	writeFileSync(
		join(badDate, "session.v4.jsonl"),
		[JSON.stringify({ type: "session", version: 4, id: "sess-bad-date", createdAt: "昨天下午", cwd: "/work/bad-date" }), say(1, "user", "按列去重 CSV"), say(2, "assistant", "好的")].join("\n") + "\n"
	);
	// 坏日志二：中间夹一行 type 不是字符串（旧码 startsWith 抛错，整份日志被丢）
	const badType = join(sessionsRoot, "sess-bad-type");
	mkdirSync(badType, { recursive: true });
	writeFileSync(
		join(badType, "session.v4.jsonl"),
		[header("sess-bad-type", NOW - 30_000), JSON.stringify({ type: 42, data: {} }), say(1, "user", "这份日志后面还有正常消息"), say(2, "assistant", "收到")].join("\n") + "\n"
	);
	const { buildDigest, readSessionLogFile } = await import(modUrl("lib/extractor.js"));
	const log = await readSessionLogFile(join(badType, "session.v4.jsonl"));
	assert.ok(log !== null, "非字符串 type 的一行不让整份日志作废");
	assert.equal(log.msgs.length, 2);
	const bad = await readSessionLogFile(join(badDate, "session.v4.jsonl"));
	const mtime = Date.UTC(2026, 10, 17, 1, 2, 3);
	assert.doesNotThrow(() => buildDigest(bad, 20, 200, mtime));
	assert.match(buildDigest(bad, 20, 200, mtime), /2026-11-17T01:02:03/, "退回文件 mtime");

	const { distill, extract } = setup();
	const r = await extract();
	assert.equal(r.ok, true, r.message);
	assert.equal(r.digests, 3, "三份会话都进了摘要");
	assert.ok((await distill.listDrafts()).length > 0);
});


test("[review B4] 模型超量输出不能让截断后的冻结集失去关键门", async () => {
	fresh({ sessions: { "sess-csv": CSV_SESSION } });
	const base = fakeModel({ judge: (_label, c) => c.id === "c1" ? 5 : 8 });
	const model = { complete: async (req) => req.purpose === "cases"
		? { text: JSON.stringify({ cases: Array.from({ length: 5 }, (_, i) => ({ id: "c" + (i + 1), scenario: "按列去重 " + i, expect: "保存并报告", critical: i === 4 })) }) }
		: base.complete(req) };
	const { distill, extract } = setup({ model });
	await extract();
	const report = await distill.runBatch({});
	assert.equal(report.counts.gateFailed, 1, report.markdown);
	assert.equal(report.counts.published, 0);
	const d = (await distill.listDrafts())[0];
	const { loadEvalSet } = await import(modUrl("lib/optimizer-eval.js"));
	const frozen = await loadEvalSet(d.name);
	assert.equal(frozen.cases.length, 4);
	assert.equal(frozen.cases[0].critical, true);
});
