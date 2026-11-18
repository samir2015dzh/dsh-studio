/**
 * ：四条跟进项。
 *
 *   [1] G5 场景集按真实能力修正：docbase 是电气维修资料库（位号 / 图纸 / 程序包），不是头脑风暴工具；
 *       原 doc-1/2/3 改判为反例，新写的真实用途场景命中
 *   [2] telemetry.js 头注释与实现一致：mcp.unload 不再列从不发出的 breaker，列全实际发出的 cause
 *   [3] mcp_list 文本恒有一行内建 MCP 管理状态（守卫没装 / 关掉 / 有冲突都看得见）
 *   [4] 目录评测巡检：真实注册表 × 场景集 → 归档；同场景集下总命中率掉超过阈值才写回退报告；
 *       场景集换了不比较；保留份数；自动巡检默认关、只在闲时窗口跑
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-followups7-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(fakeHome, "telemetry");
delete process.env.DSH_STUDIO_CATALOG_EVAL_DIR;

const { evaluateScenarios } = await import(modUrl("lib/catalog-select.js"));
const { builtinStatusLine, buildMcpTools, McpRuntime, McpStore } = await import(modUrl("lib/mcp.js"));
const { CATALOG_EVAL_DEFAULTS, catalogEvalRoot, createCatalogWatch, registryCandidates, resolveCatalogEvalConfig } = await import(modUrl("lib/catalog-watch.js"));

const scenarioFile = join(pluginRoot, "lib/catalog-scenarios.json");
const fixture = JSON.parse(readFileSync(scenarioFile, "utf8"));

test("[1] 场景集：docbase 按真实能力（电气维修资料库），头脑风暴类改判反例", () => {
	const ms = fixture.candidates.find((c) => c.name === "docbase");
	assert.ok(ms.summary.includes("位号") && ms.summary.includes("图纸"), ms.summary);
	for (const tool of ["tag_search", "page_image", "log_search"]) assert.ok(ms.tools.includes(tool), "docbase 真实工具 " + tool);
	for (const fake of ["brainstorm", "mindmap", "six_hats", "idea_rank"]) assert.ok(!ms.tools.includes(fake), "不再有虚构工具 " + fake);
	const pr = fixture.candidates.find((c) => c.name === "web-research");
	assert.ok(pr.tools.includes("read_url") && pr.tools.some((t) => t.startsWith("github_")), "web-research 带 read_url 与 github_*");
	const byId = new Map(fixture.scenarios.map((s) => [s.id, s]));
	for (const id of ["neg-9", "neg-10", "neg-11"]) assert.equal(byId.get(id)?.expect, null, id + " 是反例");
	assert.ok(!fixture.scenarios.some((s) => s.expect === "docbase" && /头脑风暴|思维导图|点子|灵感/.test(s.query)), "没有「把 docbase 当头脑风暴」的正例");
	const report = evaluateScenarios(fixture.scenarios, fixture.candidates);
	const hit = new Map(report.results.map((r) => [r.id, r.hit]));
	for (const id of ["doc-1", "doc-2", "doc-3", "neg-9", "neg-10", "neg-11", "web-5", "web-6"]) assert.equal(hit.get(id), true, id + " 命中");
});

test("[2] telemetry.js 头注释：mcp.unload 的 cause 与实现一致（没有 breaker）", () => {
	const src = readFileSync(join(pluginRoot, "lib/telemetry.js"), "utf8");
	const header = src.slice(0, src.indexOf("export const EVENT_TYPES"));
	const unload = header.slice(header.indexOf("mcp.unload"), header.indexOf("mcp.verify"));
	assert.ok(!/cause=[^）]*\bbreaker\b/.test(unload.split("。")[0]), "unload 的 cause 列表里没有 breaker：" + unload);
	const mcpSrc = readFileSync(join(pluginRoot, "lib/mcp.js"), "utf8");
	// 实现里出现的 cause：record("mcp.unload", {cause:"…"})、reclaim(…, "…")、reclaim / forget 的默认值
	const emitted = new Set([
		...[...mcpSrc.matchAll(/record\("mcp\.unload", \{[^}]*cause: "(\w+)"/g)].map((m) => m[1]),
		...[...mcpSrc.matchAll(/reclaim\([^,()]+, "(\w+)"\)/g)].map((m) => m[1]),
		...[...mcpSrc.matchAll(/async (?:reclaim|forget)\(name, cause = "(\w+)"\)/g)].map((m) => m[1])
	]);
	assert.ok(emitted.size >= 5, "从实现里抓到的 cause：" + [...emitted].join(","));
	for (const cause of emitted) assert.ok(unload.includes(cause), "头注释列了实际发出的 cause " + cause);
	assert.ok(!emitted.has("breaker"), "实现确实不发 breaker");
});

test("[3] mcp_list 文本恒有内建 MCP 管理状态行", async () => {
	assert.match(builtinStatusLine(undefined), /^内建 MCP 管理：未接入/);
	const armed = builtinStatusLine({ available: true, guard: "armed", servers: [{ name: "a", state: "running" }, { name: "b", state: "disabled" }], conflicts: [], rejected: 0 });
	assert.match(armed, /守卫已拦截/);
	assert.match(armed, /内建条目 2 个（未停用 1 个）/);
	assert.match(armed, /无同名冲突/);
	const conflict = builtinStatusLine({ available: true, guard: "off", servers: [{ name: "memory-bank", state: "running" }], conflicts: ["memory-bank"], rejected: 2 });
	assert.match(conflict, /未开启/);
	assert.match(conflict, /已拒绝 2 次/);
	assert.match(conflict, /同名条目：memory-bank/);
	assert.match(builtinStatusLine({ available: false, guard: "unavailable", servers: [], conflicts: [] }), /未挂上.*读不到内建管理器/);

	const list = buildMcpTools(new McpStore(), new McpRuntime(undefined), {}).find((t) => t.name === "mcp_list");
	const value = await list.execute({}, {});
	const textOut = list.output.render({}, value)[0].text;
	assert.match(textOut, /\n内建 MCP 管理：未接入/, "没有守卫时也有状态行：" + textOut);
	const withGuard = buildMcpTools(new McpStore(), new McpRuntime(undefined), { builtinStatus: () => ({ available: true, guard: "armed", servers: [], conflicts: [], rejected: 0 }) }).find((t) => t.name === "mcp_list");
	const v2 = await withGuard.execute({}, {});
	assert.match(withGuard.output.render({}, v2)[0].text, /内建 MCP 管理：守卫已拦截.*内建条目 0 个.*无同名冲突/);
});

// ── [4] 目录评测巡检 ─────────────────────────────────────────────────────
const server = (c) => ({ name: c.name, tier: "on-demand", catalog: { summary: c.summary, useWhen: c.useWhen, avoidWhen: c.avoidWhen }, tools: c.tools.map((name) => ({ name })) });
const goodRegistry = () => ({ servers: fixture.candidates.map(server) });

function setup(extra = {}) {
	const dir = mkdtempSync(join(fakeHome, "ce-"));
	process.env.DSH_STUDIO_CATALOG_EVAL_DIR = dir;
	let registry = goodRegistry();
	let t = new Date(2026, 10, 16, 3, 0, 0).getTime();
	const warnings = [];
	const watch = createCatalogWatch({ pluginConfig: extra, loadRegistry: async () => registry, now: () => t, logger: { warn: (m) => warnings.push(m) } });
	return { dir, watch, warnings, setRegistry: (r) => (registry = r), advance: (ms) => (t += ms), at: () => t };
}

test("[4a] 默认配置保守：自动关、闲时窗口、阈值 5%、保留 30 份；非法值忽略", () => {
	assert.equal(CATALOG_EVAL_DEFAULTS.enabled, false);
	const c = resolveCatalogEvalConfig({ enabled: "yes", dropThreshold: -1, keep: 0.4, idleWindow: { start: "25:00", end: "05:30" } });
	assert.equal(c.enabled, false);
	assert.equal(c.dropThreshold, 0.05);
	assert.equal(c.keep, 1);
	assert.deepEqual(c.idleWindow, { start: "02:00", end: "05:30" });
	delete process.env.DSH_STUDIO_CATALOG_EVAL_DIR;
	assert.equal(catalogEvalRoot(), join(fakeHome, ".dsh-studio", "catalog-eval"));
	assert.deepEqual(registryCandidates([{ name: "off", tier: "disabled" }, { name: "x", notes: "备注当摘要", tools: [{ name: "t" }] }]).map((c) => [c.name, c.summary, c.tools.join()]), [["x", "备注当摘要", "t"]]);
});

test("[4b] 归档 → 同场景集比较 → 掉超过阈值写回退报告（列出由好变坏的场景）；只报告不改注册表", async () => {
	const { dir, watch, warnings, setRegistry, advance } = setup();
	const first = await watch.run();
	assert.equal(first.comparison.status, "first");
	assert.equal(first.hits, 38);
	assert.equal(first.total, 40);
	advance(60_000);
	const second = await watch.run();
	assert.equal(second.comparison.status, "ok");
	assert.equal(second.comparison.drop, 0);
	// 把 docbase 的目录条目写坏（退回成头脑风暴草案）：真实用途场景全掉
	const broken = goodRegistry();
	const ms = broken.servers.find((s) => s.name === "docbase");
	ms.catalog = { summary: "创意发散助手：头脑风暴、点子生成、思维导图", useWhen: ["头脑风暴"], avoidWhen: [] };
	ms.tools = [{ name: "brainstorm" }];
	const frozen = JSON.stringify(broken);
	setRegistry(broken);
	advance(60_000);
	const third = await watch.run();
	assert.equal(JSON.stringify(broken), frozen, "注册表对象没被改");
	assert.equal(third.comparison.status, "regressed", JSON.stringify(third.comparison));
	assert.ok(third.comparison.drop > 0.05);
	assert.ok(["doc-1", "doc-2", "doc-3"].every((id) => third.comparison.regressed.includes(id)), third.comparison.regressed.join(","));
	assert.ok(existsSync(third.comparison.alert));
	const alert = readFileSync(third.comparison.alert, "utf8");
	assert.match(alert, /由好变坏的场景/);
	assert.match(alert, /doc-1/);
	assert.match(alert, /只是报告/);
	assert.equal(warnings.length, 1);
	assert.equal(readdirSync(join(dir, "runs")).length, 3);
	const status = await watch.status();
	assert.equal(status.runs[0].runId, third.runId);
	assert.equal(status.alerts.length, 1);
	// 小幅波动不报：阈值调大后同样的退化只记 ok
	const lenient = setup({ dropThreshold: 0.5 });
	await lenient.watch.run();
	lenient.setRegistry(broken);
	lenient.advance(60_000);
	assert.equal((await lenient.watch.run()).comparison.status, "ok");
});

test("[4c] 场景集换了不比较；保留份数修剪归档与报告", async () => {
	const { dir, watch, advance } = setup({ keep: 2 });
	await watch.run();
	const custom = join(dir, "my-scenarios.json");
	writeFileSync(custom, JSON.stringify({ scenarios: fixture.scenarios.slice(0, 5) }));
	const swapped = createCatalogWatch({ pluginConfig: { keep: 2, scenariosFile: custom }, loadRegistry: async () => ({ servers: [] }), now: () => new Date(2026, 10, 16, 3, 0, 30).getTime() });
	const r = await swapped.run();
	assert.equal(r.comparison.status, "scenarios-changed");
	assert.equal(r.total, 5);
	advance(120_000);
	await watch.run();
	await watch.run();
	assert.equal(readdirSync(join(dir, "runs")).length, 2, "只留最近 2 份");
	await assert.rejects(createCatalogWatch({ pluginConfig: { scenariosFile: join(dir, "missing.json") }, loadRegistry: async () => ({ servers: [] }) }).run(), /场景文件读不到/);
});

test("[4d] 自动巡检：默认关；开了也只在闲时窗口 + 够闲 + 间隔够时跑", async () => {
	const off = setup();
	off.advance(31 * 60_000);
	assert.equal((await off.watch.tick()).reason, "disabled");
	assert.equal(existsSync(join(off.dir, "runs")), false, "默认关：一份归档都没有");

	const on = setup({ enabled: true, idleMinutes: 30, checkEveryMinutes: 1 });
	assert.equal((await on.watch.tick()).reason, "busy", "刚启动（活动时间 = 现在）不算闲");
	on.advance(31 * 60_000);
	const ran = await on.watch.tick();
	assert.equal(ran.ran, true);
	assert.equal(ran.status, "first");
	on.advance(2 * 60_000);
	assert.equal((await on.watch.tick()).reason, "too-soon");
	on.advance(30_000);
	assert.equal((await on.watch.tick()).reason, "throttled");
	on.watch.noteActivity();
	on.advance(2 * 60_000);
	assert.equal((await on.watch.tick()).reason, "busy");

	const outside = setup({ enabled: true, idleWindow: { start: "12:00", end: "13:00" }, checkEveryMinutes: 1 });
	outside.advance(31 * 60_000);
	assert.equal((await outside.watch.tick()).reason, "outside-window");
});
