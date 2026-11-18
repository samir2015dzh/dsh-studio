/**
 * ：MCP 接管——唯一注册表 + 按需加载 + 工具目录。
 *
 * 全在伪 HOME 里跑：注册表、版本史、遥测、凭据暂存都落临时目录；MCP 对端是
 * tests/fixtures/mock-mcp-server.mjs（stdio，本机子进程），不联网、不碰真机。
 *
 *   [A] 7 个现存 server 的迁移逐项等价 + 迁移记录 + 幂等；内建 MCP 管理写路径拦截；原生行自动接管
 *   [B] register → edit → unregister → rollback 全链（版本记录 + 遥测 + 凭据补回不串号）
 *   [C] 未验证可登记：失败照样入册、带失败原因；verify:false 跳过；手动重验
 *   [D] 按需加载：未选中的 server 零连接；加载 / 卸载进遥测；周统计出加载次数与闲置项
 *   [E] 目录条目（是什么 / 何时用 / 何时别用 / 读写 / 验证状态）随版本走；G5 场景集基线
 *   [F] 熔断（阈值 / 摘除 / 恢复时间 / 半开 / 手动复位 / 遥测）；试运行只放只读；健康 ping
 *   [G] 尾巴①：注册表整份消失 / 损坏留显式记录，缺口记录不可当回滚目标
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-mcp-takeover-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
delete process.env.DSH_STUDIO_HISTORY_DIR;
const telemetryDir = join(fakeHome, "telemetry");
process.env.DSH_STUDIO_TELEMETRY_DIR = telemetryDir;

const mcp = await import(modUrl("lib/mcp.js"));
const { McpStore, McpRuntime, buildMcpTools, buildMcpCatalog, catalogCandidateServers, storePath } = mcp;
const versions = await import(modUrl("lib/versions.js"));
const { readVersionRecords, REGISTRY_KEY, getObject, auditRegistryPresence, rollbackRegistry } = versions;
const { configureTelemetry } = await import(modUrl("lib/telemetry.js"));
const { migrateRegistry, compareMigration } = await import(modUrl("lib/mcp-migrate.js"));
const { installBuiltinMcpGuard, judgeManagerWrite } = await import(modUrl("lib/builtin-mcp-guard.js"));
const { reconcileProfileMcp } = await import(modUrl("lib/profile-mcp.js"));
const { buildEvolutionTools } = await import(modUrl("lib/evolution-tools.js"));
const { evaluateScenarios } = await import(modUrl("lib/catalog-select.js"));
const { classifyTool, CircuitBreaker } = await import(modUrl("lib/mcp-policy.js"));
const { stashPath } = await import(modUrl("lib/mcp-credential-stash.js"));
const { isWhitelistedEntry } = await import(modUrl("lib/snapshot.js"));

const telemetry = configureTelemetry({ dir: telemetryDir });
const mockServer = join(pluginRoot, "tests", "fixtures", "mock-mcp-server.mjs");
const quiet = { info() {}, warn() {}, error() {} };

const regRecords = async () => (await readVersionRecords()).filter((r) => r.key === REGISTRY_KEY);
const events = async (type) => {
	await telemetry.flush();
	if (!existsSync(telemetryDir)) return [];
	const out = [];
	for (const name of readdirSync(telemetryDir)) {
		for (const line of readFileSync(join(telemetryDir, name), "utf8").split("\n")) {
			if (line.trim() === "") continue;
			const ev = JSON.parse(line);
			if (type === undefined || ev.type === type) out.push(ev);
		}
	}
	return out;
};
const resetRegistry = () => {
	rmSync(join(fakeHome, ".dsh", "dsh-studio"), { recursive: true, force: true });
	rmSync(join(fakeHome, ".dsh-studio"), { recursive: true, force: true });
	rmSync(telemetryDir, { recursive: true, force: true });
};
const mockEntry = (name, extra = {}) => ({ name, command: process.execPath, args: [mockServer], tier: "on-demand", ...extra });
const harness = () => {
	const store = new McpStore();
	const runtime = new McpRuntime(quiet, { breaker: { threshold: 2, cooldownMs: 80 } });
	const tools = Object.fromEntries(buildMcpTools(store, runtime, {}).map((t) => [t.name, t]));
	const evo = Object.fromEntries(buildEvolutionTools({ registryPath: () => storePath() }).map((t) => [t.name, t]));
	return { store, runtime, tools, evo };
};

test.after(async () => {
	await telemetry.flush();
	await new Promise((r) => setTimeout(r, 50));
	await telemetry.flush();
	rmSync(fakeHome, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────── A
test("[A] 7 个现存 server 迁移：逐项等价、出 registry-migrate 记录、幂等", async () => {
	resetRegistry();
	const fixture = JSON.parse(readFileSync(join(pluginRoot, "tests/fixtures/mcp-registry-v1.json"), "utf8"));
	mkdirSync(dirname(storePath()), { recursive: true });
	writeFileSync(storePath(), JSON.stringify(fixture, null, 2) + "\n");
	const store = new McpStore();
	// 版本史里此前没有这份注册表的记录：迁移这次写入会先补一条 baseline（迁移前的现状），再记 registry-migrate
	const migrated = await store.migrate(migrateRegistry);
	assert.equal(migrated.version, 2);
	const after = JSON.parse(readFileSync(storePath(), "utf8"));
	const { equivalent, rows } = compareMigration(fixture, after);
	assert.equal(equivalent, true, "原有字段逐项相同：" + rows.filter((r) => r.verdict === "changed").map((r) => r.server + "." + r.field).join(","));
	assert.equal(after.servers.length, 7);
	for (const name of ["rea", "metis-reverse", "memory-bank", "craft-anything", "docbase", "baimiao", "web-research"]) {
		const before = fixture.servers.find((s) => s.name === name);
		const now = after.servers.find((s) => s.name === name);
		for (const key of Object.keys(before)) assert.deepEqual(now[key], before[key], `${name}.${key} 迁移前后相同`);
		assert.equal(now.trial, false, `${name} 迁移进来不进试运行`);
	}
	// 凭据原值仍在 mcp.json（引用不变），认不出的键原样保留
	assert.equal(after.servers.find((s) => s.name === "web-research").env.TAVILY_API_KEY, "tvly-fake-0005");
	assert.equal(after.servers.find((s) => s.name === "docbase")["x-local-tag"], "未知键也要原样保留");
	// 版本记录：baseline（迁移前的现状）+ registry-migrate
	const recs = await regRecords();
	const migrateRec = recs.find((r) => r.action === "registry-migrate");
	assert.ok(migrateRec, "迁移出一条 registry-migrate 记录");
	assert.equal(migrateRec.diff.changed.length, 7, "7 个 server 都列在 diff 里");
	assert.ok(recs.find((r) => r.id === migrateRec.parent)?.action === "baseline", "parent 是迁移前现状的 baseline");
	const objText = (await getObject(migrateRec.state.sha)).toString("utf8");
	assert.ok(!objText.includes("tvly-fake-0005") && !objText.includes("fake-memory-bank-token-0002"), "版本对象里凭据已脱敏");
	assert.equal((await events("mcp.registry")).filter((e) => e.action === "migrate").length, 7, "遥测 mcp.registry action=migrate ×7");
	// 幂等
	assert.equal(await new McpStore().migrate(migrateRegistry), null, "已是 v2：不再迁移");
	assert.equal((await regRecords()).length, recs.length, "第二次不出记录");
	// load 不丢未知键
	const loaded = await new McpStore().load();
	assert.equal(loaded.servers.find((s) => s.name === "docbase")["x-local-tag"], "未知键也要原样保留");
});

test("[A] 迁移对照表脚本：干跑 + 从版本史取迁移那一刻，凭据打码", () => {
	const dry = spawnSync(process.execPath, [join(pluginRoot, "scripts/mcp-migration-table.mjs"), join(pluginRoot, "tests/fixtures/mcp-registry-v1.json")], { encoding: "utf8" });
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /逐项等价：是/);
	for (const secret of ["fake-rea-key-0001", "tvly-fake-0005", "fake-memory-bank-token-0002", "sk-fake-docbase-0003"]) assert.ok(!dry.stdout.includes(secret), "表里不出凭据原值：" + secret);
	const hist = spawnSync(process.execPath, [join(pluginRoot, "scripts/mcp-migration-table.mjs"), "--history"], { encoding: "utf8", env: { ...process.env } });
	assert.equal(hist.status, 0, hist.stderr);
	assert.match(hist.stdout, /registry-migrate|版本史：/);
	assert.match(hist.stdout, /逐项等价：是/);
});

test("[A] 内建 MCP 管理让位：新增 / 修改 / 启用被拦，删除 / 停用放行，非 manager 不管", () => {
	assert.deepEqual(judgeManagerWrite({ a: { url: "x", enabled: true } }, { a: { url: "x", enabled: true } }), { block: false });
	assert.equal(judgeManagerWrite({ a: { url: "x" } }, {}).block, false, "删除放行");
	assert.equal(judgeManagerWrite({ a: { url: "x", enabled: true } }, { a: { url: "x", enabled: false } }).block, false, "停用放行");
	assert.deepEqual(judgeManagerWrite({}, { b: { url: "y", enabled: true } }), { block: true, names: ["b"] });
	assert.deepEqual(judgeManagerWrite({ a: { url: "x" } }, { a: { url: "z" } }), { block: true, names: ["a"] });

	const listeners = new Map();
	const managerFiber = { name: "McpServerManager" };
	const ctx = { on: (name, fn) => (listeners.set(name, fn), () => listeners.delete(name)), get: () => null };
	const guard = installBuiltinMcpGuard(ctx, { logger: quiet });
	const hook = listeners.get("internal/config");
	assert.equal(typeof hook, "function", "挂上了 internal/config");
	const cfg = (servers) => ({ servers });
	assert.deepEqual(hook(managerFiber, () => cfg({ old: { url: "u", enabled: true } })), cfg({ old: { url: "u", enabled: true } }), "第一次见：当基线放行");
	assert.throws(() => hook(managerFiber, () => cfg({ old: { url: "u", enabled: true }, fresh: { url: "v", enabled: true } })), /dsh-studio 统一管理/);
	assert.doesNotThrow(() => hook(managerFiber, () => cfg({})), "删光放行");
	assert.doesNotThrow(() => hook({ name: "SomethingElse" }, () => cfg({ any: { url: "v" } })), "别的插件的配置不管");
	assert.doesNotThrow(() => hook(managerFiber, () => ({ unrelated: 1 })), "认不出形态 fail-open");
	listeners.get("mcp-manager/status")?.("old", { state: "ready" });
	guard.setStudioNames(["old"]);
	const st = guard.status();
	assert.equal(st.guard, "armed");
	assert.equal(st.rejected, 1);
	assert.deepEqual(st.conflicts, ["old"], "镜像报出与注册表同名的内建 server");

	// 拿得到 manager 实例：按 owner fiber 认，基线取 manager 的现配置
	const owner = {};
	const listeners2 = new Map();
	const live = { known: { url: "k", enabled: true } };
	const ctx2 = {
		on: (name, fn) => (listeners2.set(name, fn), () => {}),
		get: (n) => (n === "mcpManager" ? { ctx: { fiber: owner }, config: { servers: { get: () => live } }, list: () => [{ name: "known", configured: true, status: { state: "ready" } }] } : null)
	};
	const g2 = installBuiltinMcpGuard(ctx2, { logger: quiet });
	assert.throws(() => listeners2.get("internal/config")(owner, () => cfg({ ...live, extra: { url: "e" } })), /mcp_register/);
	assert.doesNotThrow(() => listeners2.get("internal/config")({ name: "McpServerManager" }, () => cfg({ extra: { url: "e" } })), "有实例时只认 owner fiber");
	assert.equal(g2.status().servers[0].name, "known");
	assert.equal(g2.status().baseline, "manager");
	const off = installBuiltinMcpGuard({ on: (n, fn) => (listeners2.set("off:" + n, fn), () => {}) }, { lock: false, logger: quiet });
	assert.equal(off.status().guard, "off");
});

test("[A] 原生 dsh-mcp-client 新行自动接管；未接管的旧行只报告", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-takeover-row-"));
	const patch = join(dir, "cordis.patch.yml");
	writeFileSync(patch, `- insert:\n    - id: mcp-newone\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: newone\n        transport: stdio\n        command: "node"\n    - id: mcp-legacy\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: legacy\n        transport: stdio\n        command: "node"\n`);
	const state = { version: 2, idleTimeoutMinutes: 5, toolDescriptionMaxLength: 150, servers: [{ name: "legacy", tier: "disabled", transport: "stdio", command: "node", args: [], env: {}, cwd: "", source: { kind: "profile", rowId: "mcp-legacy", patchPath: patch } }] };
	const store = { async load() { return state; }, async save() {} };
	const result = await reconcileProfileMcp(store, [patch], { overridePath: patch, autoTakeover: true, logger: quiet });
	assert.deepEqual(result.takenOver.map((t) => t.name), ["newone"]);
	const fresh = state.servers.find((s) => s.name === "newone");
	assert.equal(fresh.tier, "on-demand");
	assert.equal(fresh.desiredNative, "disabled");
	assert.match(readFileSync(patch, "utf8"), /- id: mcp-newone\n\s+disabled: true/, "原生行原地写 disabled");
	assert.deepEqual(result.nativeOwned.map((n) => n.name), ["legacy"], "停用档 + 原生活行 = 双来源，只报不动");
	assert.doesNotMatch(readFileSync(patch, "utf8"), /- id: mcp-legacy\n\s+disabled: true/);
	// 函数层默认不接管（既有对账语义不变）
	const state2 = { version: 2, servers: [] };
	writeFileSync(patch, `- insert:\n    - id: mcp-x\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: xx\n        transport: stdio\n        command: "node"\n`);
	const r2 = await reconcileProfileMcp({ async load() { return state2; }, async save() {} }, [patch], { logger: quiet });
	assert.equal(state2.servers[0].tier, "disabled");
	assert.deepEqual(r2.takenOver, []);
	rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────── B
test("[B] register → edit → unregister → rollback：逐笔版本记录 + 遥测，凭据从暂存补回", async () => {
	resetRegistry();
	const { store, runtime, tools, evo } = harness();
	await tools.mcp_register.execute(mockEntry("bystander", { env: { API_TOKEN: "bystander-secret" }, verify: false }));
	const reg = await tools.mcp_register.execute(mockEntry("prm-probe", { env: { API_TOKEN: "probe-secret-xyz" }, notes: "探针" }));
	assert.equal(reg.ok, true);
	assert.equal(reg.verify.status, "verified", "真实握手 + 工具列表 → verified");
	assert.equal(reg.trial, true, "新 server 默认试运行");
	const edit = await tools.mcp_register.execute({ name: "prm-probe", notes: "探针 v2", catalog: { summary: "探针用的 mock", useWhen: ["验收"], avoidWhen: ["生产"] } });
	assert.equal(edit.ok, true);
	const un = await tools.mcp_unregister.execute({ name: "prm-probe", reason: "验收注销" });
	assert.ok(un.versionId && un.restoreVersionId, "注销返回版本号与恢复目标");
	assert.equal((await store.load()).servers.some((s) => s.name === "prm-probe"), false);
	assert.equal(runtime.connected("prm-probe"), false);
	// 暂存里有凭据原值（只在本机，0600，不进快照）
	assert.match(readFileSync(stashPath(), "utf8"), /probe-secret-xyz/);
	assert.equal(isWhitelistedEntry("dsh-studio/mcp-credential-stash.json"), false, "凭据暂存不进快照");
	const rb = await evo.skillmgr_rollback.execute({ target: "mcp-registry", versionId: un.restoreVersionId, reason: "验收回滚" });
	assert.equal(rb.ok, true);
	const back = (await store.load()).servers.find((s) => s.name === "prm-probe");
	assert.ok(back, "回滚后条目回来了");
	assert.equal(back.env.API_TOKEN, "probe-secret-xyz", "凭据按名字从暂存补回（不是占位符、不是别人的）");
	assert.equal((await store.load()).servers.find((s) => s.name === "bystander").env.API_TOKEN, "bystander-secret");
	assert.equal(back.notes, "探针 v2");
	assert.equal(back.catalog.summary, "探针用的 mock", "目录条目随版本回来");

	const recs = await regRecords();
	const actions = recs.map((r) => r.action);
	for (const a of ["registry-add", "registry-edit", "registry-remove", "rollback"]) assert.ok(actions.includes(a), "有 " + a + " 记录：" + actions.join(","));
	const removeRec = recs.find((r) => r.action === "registry-remove");
	assert.equal(removeRec.reason, "验收注销", "注销原因写进版本记录");
	assert.deepEqual(removeRec.diff.removed, ["prm-probe"]);
	const editRec = recs.filter((r) => r.action === "registry-edit").find((r) => r.diff.changed.some((c) => c.name === "prm-probe"));
	assert.ok(editRec.diff.changed[0].fields.includes("catalog"), "目录条目的修改出版本记录");
	const regEvents = (await events("mcp.registry")).filter((e) => e.server === "prm-probe").map((e) => e.action);
	for (const a of ["add", "edit", "remove", "rollback"]) assert.ok(regEvents.includes(a), "遥测 mcp.registry 有 " + a + "：" + regEvents.join(","));
	await runtime.closeAll();
});

test("[B] 回滚补凭据按名字配对：被注销的 server 不会拿到同位置别人的凭据", async () => {
	resetRegistry();
	const { store, tools } = harness();
	await tools.mcp_register.execute(mockEntry("first", { env: { API_TOKEN: "first-secret" }, verify: false }));
	await tools.mcp_register.execute(mockEntry("second", { env: { API_TOKEN: "second-secret" }, verify: false }));
	const un = await tools.mcp_unregister.execute({ name: "first" });
	// 暂存被清掉（例如手工删了），也只会缺键，不会串号
	rmSync(stashPath(), { force: true });
	await rollbackRegistry({ versionId: un.restoreVersionId, file: storePath() });
	const state = await store.load();
	assert.notEqual(state.servers.find((s) => s.name === "first").env.API_TOKEN, "second-secret", "不串号");
	assert.equal(state.servers.find((s) => s.name === "second").env.API_TOKEN, "second-secret");
});

// ─────────────────────────────────────────────────────────────── C
test("[C] 未验证可登记：握手失败照样入册（failed + 原因）；verify:false 只登记；mcp_verify 重试", async () => {
	resetRegistry();
	const { store, tools } = harness();
	const bad = await tools.mcp_register.execute({ name: "broken", command: process.execPath, args: ["-e", "process.exit(3)"] });
	assert.equal(bad.ok, true, "不再以握手为前提");
	assert.equal(bad.verify.status, "failed");
	assert.ok(typeof bad.verify.error === "string" && bad.verify.error !== "", "带失败原因");
	const saved = (await store.load()).servers.find((s) => s.name === "broken");
	assert.equal(saved.verify.status, "failed", "失败结论写进注册表");
	assert.ok((await regRecords()).some((r) => r.action === "registry-add" && r.diff.added.includes("broken")), "登记出版本记录");
	const skipped = await tools.mcp_register.execute(mockEntry("later", { verify: false }));
	assert.equal(skipped.verify.status, "unverified");
	const retry = await tools.mcp_verify.execute({ name: "later" });
	assert.equal(retry.ok, true);
	assert.equal(retry.verify.status, "verified");
	assert.equal((await store.load()).servers.find((s) => s.name === "later").verify.status, "verified");
	const verifyEvents = await events("mcp.verify");
	assert.ok(verifyEvents.some((e) => e.server === "broken" && e.state === "failed" && e.ok === false));
	assert.ok(verifyEvents.some((e) => e.server === "later" && e.state === "verified" && e.via === "manual"));
	// 只刷新验证状态不出版本记录
	const before = (await regRecords()).length;
	await tools.mcp_verify.execute({ name: "later" });
	assert.equal((await regRecords()).length, before, "verify 属运行时观测，不出记录");
});

// ─────────────────────────────────────────────────────────────── D
test("[D] 按需加载：只连被调用的那个；加载 / 卸载进遥测；周统计出加载次数与闲置项", async () => {
	resetRegistry();
	const { store, runtime, tools } = harness();
	const spawnLog = join(fakeHome, "spawn.log");
	rmSync(spawnLog, { force: true });
	for (const tag of ["alpha", "beta", "gamma"]) {
		await tools.mcp_register.execute(mockEntry(tag, { env: { MOCK_MCP_SPAWN_LOG: spawnLog, MOCK_MCP_TAG: tag }, verify: false }));
	}
	const catalog = await buildMcpCatalog(store, runtime);
	assert.match(catalog, /alpha/);
	assert.equal(existsSync(spawnLog), false, "登记 + 出目录：一个进程都不起");
	const out = await tools.mcp_call.execute({ name: "alpha", tool: "echo", args: { text: "hi" } });
	assert.match(JSON.stringify(out), /echo:hi/);
	const spawned = readFileSync(spawnLog, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
	assert.deepEqual(spawned, ["alpha"], "只有被选中的 alpha 起了进程");
	assert.equal(runtime.connected("alpha"), true);
	assert.equal(runtime.connected("beta"), false);
	assert.equal(runtime.connected("gamma"), false);
	await runtime.reclaim("alpha", "idle");
	const loads = await events("mcp.load");
	assert.deepEqual(loads.map((e) => e.server), ["alpha"]);
	assert.equal(loads[0].ok, true);
	assert.ok((await events("mcp.unload")).some((e) => e.server === "alpha" && e.cause === "idle"));
	// 周统计：加载次数 + 闲置（目录里出现过、一次没加载）
	await telemetry.record("catalog.outcome", { sid: "s1", shown: ["alpha", "beta", "gamma"], used: ["alpha"], unused: ["beta", "gamma"] });
	const stats = await telemetry.stats({ weeks: 1 });
	const week = stats.weeks[0];
	assert.equal(week.loads.find((l) => l.server === "alpha").loads, 1);
	assert.deepEqual(week.idle.map((i) => i.server).sort(), ["beta", "gamma"]);
	// 既有口径不变：mcp.call 仍按 server 计
	assert.equal(week.mcp.find((m) => m.server === "alpha").calls, 1);
	await runtime.closeAll();
});

// ─────────────────────────────────────────────────────────────── E
test("[E] 目录条目：是什么 / 何时用 / 何时别用 / 读写 / 验证状态；注册表 catalog 字段随版本走", async () => {
	resetRegistry();
	const { store, runtime, tools } = harness();
	await tools.mcp_register.execute(mockEntry("notes-box", {
		env: { MOCK_MCP_EXTRA: "1" },
		catalog: { summary: "笔记盒子", useWhen: ["要记笔记"], avoidWhen: ["只是聊天"], tools: { write_note: { use: "写一条", avoid: "批量导入" } } }
	}));
	const text = await buildMcpCatalog(store, runtime);
	assert.match(text, /^## MCP 服务器（按需加载）/);
	assert.match(text, /是什么：笔记盒子/);
	assert.match(text, /何时用：要记笔记/);
	assert.match(text, /何时别用：只是聊天/);
	assert.match(text, /只读 2 \/ 可写 2/, "echo/zap 只读，write_note/danger 可写");
	assert.match(text, /已验证/);
	assert.match(text, /试运行：只放只读/);
	assert.match(text, /write_note（写一条；别用：批量导入）/, "逐工具的用 / 别用");
	assert.match(text, /其中可写：write_note、danger/);
	await runtime.closeAll();
});

test("[E] G5 目录选择场景集（含反例）：命中率不低于基线", () => {
	const fixture = JSON.parse(readFileSync(join(pluginRoot, "lib/catalog-scenarios.json"), "utf8"));
	const report = evaluateScenarios(fixture.scenarios, fixture.candidates);
	assert.ok(fixture.scenarios.length >= 30, "场景不少于 30 条");
	assert.ok(report.negative.total >= 8, "反例不少于 8 条");
	// 基线（2026-11-15，词面代理）：总 33/35 = 0.943，正例 25/27 = 0.926，反例 8/8 = 1.0
	// 修正 mind-* 期望后（2026-11-16）：总 38/40 = 0.950，正例 27/29 = 0.931，反例 11/11 = 1.0（门槛仍用原基线）
	assert.ok(report.hitRate >= 0.943, "总命中率 " + report.hitRate);
	assert.ok(report.positive.hitRate >= 0.926, "正例命中率 " + report.positive.hitRate);
	assert.equal(report.negative.hitRate, 1, "反例全部判「不用 MCP」");
	const script = spawnSync(process.execPath, [join(pluginRoot, "scripts/catalog-eval.mjs")], { encoding: "utf8" });
	assert.equal(script.status, 0, script.stderr);
	assert.match(script.stdout, /总命中 38\/40/);
});

// ─────────────────────────────────────────────────────────────── F
test("[F] 熔断：连续失败到阈值摘除（原因 + 恢复时间），冷却后半开，mcp_verify 手动复位", async () => {
	resetRegistry();
	const { store, runtime, tools } = harness();
	await tools.mcp_register.execute({ name: "flaky", command: process.execPath, args: ["-e", "process.exit(4)"], verify: false });
	await tools.mcp_register.execute(mockEntry("healthy", { verify: false }));
	for (let i = 0; i < 2; i += 1) {
		const r = await tools.mcp_call.execute({ name: "flaky", tool: "echo", args: {} });
		assert.match(JSON.stringify(r), /失败/);
	}
	assert.equal(runtime.breaker.state("flaky"), "open");
	const blocked = await tools.mcp_call.execute({ name: "flaky", tool: "echo", args: {} });
	assert.match(JSON.stringify(blocked), /已熔断/);
	const state = await store.load();
	const { candidates, tripped } = catalogCandidateServers(state, runtime);
	assert.deepEqual(tripped.map((e) => e.name), ["flaky"], "熔断的从候选里摘除");
	assert.ok(!candidates.some((e) => e.name === "flaky"));
	const text = await buildMcpCatalog(store, runtime);
	assert.match(text, /暂时摘除[\s\S]*flaky[\s\S]*预计 .* 恢复/);
	const listed = (await tools.mcp_list.execute({})).servers.find((s) => s.name === "flaky");
	assert.equal(listed.health.breaker.state, "open");
	assert.ok(listed.health.breaker.until);
	const calls = (await events("mcp.call")).filter((e) => e.server === "flaky");
	assert.equal(calls.at(-1).err, "breaker-open", "被熔断拦下的调用记 err=breaker-open");
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(runtime.breaker.state("flaky"), "half-open", "冷却到点半开");
	const reset = await tools.mcp_verify.execute({ name: "flaky", reset: true });
	assert.equal(reset.verify.status, "failed");
	assert.equal(reset.breaker.state, "closed", "reset:true 无论成败都复位");
	const breakerEvents = (await events("mcp.breaker")).filter((e) => e.server === "flaky").map((e) => e.state);
	assert.deepEqual(breakerEvents.slice(0, 2), ["open", "half-open"]);
	assert.equal(breakerEvents.at(-1), "closed", "手动复位出 closed 迁移");
	// 单元：阈值 / 半开失败重新熔断
	let now = 0;
	const b = new CircuitBreaker({ threshold: 2, cooldownMs: 10, now: () => now });
	b.failure("x", "timeout");
	assert.equal(b.state("x"), "closed");
	b.failure("x", "timeout");
	assert.equal(b.allow("x").ok, false);
	now = 11;
	assert.equal(b.allow("x").ok, true);
	b.failure("x", "timeout");
	assert.equal(b.state("x"), "open", "半开试探失败重新熔断");
	await runtime.closeAll();
});

test("[F] 读写分级 + 试运行：只放只读工具，转正后放开；健康检查只 ping 已连接的", async () => {
	resetRegistry();
	const { runtime, tools } = harness();
	assert.equal(classifyTool({}, { name: "zap", annotations: { readOnlyHint: true } }).access, "read");
	assert.equal(classifyTool({}, { name: "get_x", annotations: { destructiveHint: true } }).access, "write", "注解优先于名字");
	assert.equal(classifyTool({ toolAccess: { danger: "read" } }, { name: "danger", annotations: { destructiveHint: true } }).access, "read", "手工覆盖最优先");
	assert.equal(classifyTool({}, "frobnicate").access, "write", "拿不准按可写");
	const reg = await tools.mcp_register.execute(mockEntry("gated", { env: { MOCK_MCP_EXTRA: "1" } }));
	assert.equal(reg.trial, true);
	const read = await tools.mcp_call.execute({ name: "gated", tool: "zap", args: {} });
	assert.match(JSON.stringify(read), /echo:/, "注解只读的工具放行");
	const echo = await tools.mcp_call.execute({ name: "gated", tool: "echo", args: { text: "a" } });
	assert.match(JSON.stringify(echo), /echo:a/);
	for (const tool of ["write_note", "danger"]) {
		const r = await tools.mcp_call.execute({ name: "gated", tool, args: {} });
		assert.match(JSON.stringify(r), /试运行/, tool + " 在试运行中被拦");
	}
	assert.ok((await events("mcp.call")).some((e) => e.server === "gated" && e.err === "trial-readonly"));
	const promoted = await tools.mcp_verify.execute({ name: "gated", promote: true });
	assert.equal(promoted.promoted, true);
	assert.equal(promoted.trial, false);
	const write = await tools.mcp_call.execute({ name: "gated", tool: "write_note", args: { text: "n" } });
	assert.match(JSON.stringify(write), /echo:n/, "转正后可写工具放行");
	const pings = await runtime.pingConnected();
	assert.deepEqual(pings, [{ name: "gated", ok: true }], "只 ping 已连接的 server");
	await runtime.closeAll();
});

// ─────────────────────────────────────────────────────────────── G
test("[G] 尾巴①：注册表整份消失 / 损坏留显式记录，缺口不可当回滚目标", async () => {
	resetRegistry();
	const { store, tools } = harness();
	await tools.mcp_register.execute(mockEntry("keep", { verify: false }));
	unlinkSync(storePath());
	const gap = await auditRegistryPresence(storePath());
	assert.equal(gap.action, "registry-missing");
	assert.deepEqual(gap.diff.removed, ["keep"]);
	assert.equal(await auditRegistryPresence(storePath()), null, "同一个缺口只记一次");
	await assert.rejects(() => rollbackRegistry({ versionId: gap.id, file: storePath() }), /缺口记录/);
	// 回滚到缺口之前的版本可以恢复
	await rollbackRegistry({ versionId: gap.parent, file: storePath() });
	assert.ok((await store.load()).servers.some((s) => s.name === "keep"));
	// 损坏：只记指纹，不存内容
	writeFileSync(storePath(), '{"servers": [ {"name": "keep", "env": {"API_TOKEN": "leak-me"} ');
	const corrupt = await auditRegistryPresence(storePath());
	assert.equal(corrupt.action, "registry-corrupt");
	assert.ok(corrupt.state.fingerprint && corrupt.state.size > 0);
	assert.ok(!JSON.stringify(await readVersionRecords()).includes("leak-me"), "损坏原文不进版本史");
	// 审计 1：损坏后写入被闸住；所有者确认后才放行
	await assert.rejects(() => tools.mcp_register.execute(mockEntry("after-gap", { verify: false })), (e) => e.code === "MCP_REGISTRY_CORRUPT");
	assert.ok((await store.acknowledgeCorrupt()).cleared);
	// 缺口之后的写入：从「空」起算，不把整份消失记在这次写入头上
	await tools.mcp_register.execute(mockEntry("after-gap", { verify: false }));
	const last = (await regRecords()).at(-1);
	assert.equal(last.action, "registry-add");
	assert.deepEqual(last.diff.removed, [], "不会冒出一条「删了 keep」的假 diff");
});

test("[#8 审计 1] 截断 JSON 启动：坏文件改名留档、不静默覆盖、写入闸住，回滚后自动解闸", async () => {
	resetRegistry();
	const { tools } = harness();
	await tools.mcp_register.execute(mockEntry("alpha", { verify: false }));
	await tools.mcp_register.execute(mockEntry("beta", { verify: false }));
	const goodId = (await regRecords()).at(-1).id;
	const full = readFileSync(storePath(), "utf8");
	writeFileSync(storePath(), full.slice(0, Math.floor(full.length / 2))); // 写到一半断电
	const errors = [];
	const store = new McpStore({ logger: { info() {}, warn() {}, error: (m) => errors.push(m) } }); // 模拟重启后的新实例
	const loaded = await store.load();
	assert.deepEqual(loaded.servers, [], "读不出就当空、不臆造");
	assert.equal(existsSync(storePath()), false, "坏文件已改名");
	const dir = dirname(storePath());
	const archived = readdirSync(dir).filter((n) => n.startsWith("mcp.json.corrupt-") && !n.endsWith("hold.json"));
	assert.equal(archived.length, 1, "留档一份");
	assert.equal(readFileSync(join(dir, archived[0]), "utf8"), full.slice(0, Math.floor(full.length / 2)), "留档内容原样");
	assert.ok(errors.some((m) => m.includes("无法解析")), "大声记日志");
	const hold = await store.corruptStatus();
	assert.ok(hold && hold.archivedTo.endsWith(archived[0]));
	assert.equal((await regRecords()).at(-1).action, "registry-corrupt", "版本史记的是损坏，不是消失");
	// 重启后（新实例、文件已不在）仍然闸住
	const again = new McpStore({ logger: quiet });
	const t2 = Object.fromEntries(buildMcpTools(again, new McpRuntime(quiet), {}).map((t) => [t.name, t]));
	await assert.rejects(() => t2.mcp_register.execute(mockEntry("gamma", { verify: false })), (e) => e.code === "MCP_REGISTRY_CORRUPT" && e.statusCode === 409);
	assert.equal(existsSync(storePath()), false, "save 没有覆盖出一份空注册表");
	const listed = await t2.mcp_list.execute({});
	assert.ok(listed.registryCorrupt, "mcp_list 报出损坏闸");
	// 恢复：回滚到损坏前那一版 → 下次 load 自动解闸
	await rollbackRegistry({ versionId: goodId, file: storePath() });
	const back = await again.load();
	assert.deepEqual(back.servers.map((s) => s.name).sort(), ["alpha", "beta"]);
	assert.equal(await again.corruptStatus(), null, "自动解闸");
	await t2.mcp_register.execute(mockEntry("gamma", { verify: false }));
	assert.ok((await again.load()).servers.some((s) => s.name === "gamma"));
});
