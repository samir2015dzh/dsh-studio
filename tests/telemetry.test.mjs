/**
 * · G4 遥测：落盘格式 / 脱敏 / 保留期 / 周统计 / 钩子归因，以及「遥测写不进去时主流程照常」。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;

const fakeHome = mkdtempSync(join(tmpdir(), "dsh-telemetry-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
delete process.env.DSH_STUDIO_TELEMETRY_DIR;
process.env.DSH_STUDIO_HISTORY_DIR = join(fakeHome, "history");

const { createTelemetry, configureTelemetry, sanitizeEvent, errorClassOf, telemetryDir, RETENTION_DAYS, EVENT_FIELDS } = await import(modUrl("lib/telemetry.js"));
const { McpRuntime } = await import(modUrl("lib/mcp.js"));
const { installEvolutionHooks, parseNativeMcpName } = await import(modUrl("lib/evolution-hooks.js"));
const { currentWriteContext } = await import(modUrl("lib/write-context.js"));

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, "0");
const dayOf = (t) => {
	const d = new Date(t);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const readEvents = (dir) =>
	readdirSync(dir)
		.filter((n) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
		.flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const tick = () => new Promise((r) => setTimeout(r, 20));

/** 假宿主：只实现 ctx.on 与 emit / waterfall 调度。 */
function fakeHost() {
	const listeners = new Map();
	return {
		on(event, fn) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(fn);
			return () => {};
		},
		emit(event, ...args) {
			for (const fn of listeners.get(event) ?? []) fn(...args);
		},
		/** tools/execute 是 waterfall：listener(exec, next) */
		execute(exec, inner) {
			const fns = listeners.get("tools/execute") ?? [];
			const run = (i) => (i >= fns.length ? inner() : fns[i](exec, () => run(i + 1)));
			return run(0);
		}
	};
}

try {
	console.log("\n[1] 路径与字段白名单");
	{
		assert(telemetryDir() === join(fakeHome, ".dsh", "dsh-studio", "telemetry"), "默认目录在 ~/.dsh/dsh-studio/telemetry");
		assert(RETENTION_DAYS === 90, "保留期 90 天");
		const ev = sanitizeEvent("mcp.call", { sid: "s1", server: "gh", tool: "search", ok: true, ms: 12.3456, prompt: "用户原话：帮我查一下", content: "工具返回的正文", args: { token: "x" } }, Date.UTC(2026, 0, 1));
		assert(ev.prompt === undefined && ev.content === undefined && ev.args === undefined, "白名单外字段（对话正文 / 参数）一律不落");
		assert(ev.sid === "s1" && ev.server === "gh" && ev.ms === 12.346 && ev.v === 1 && ev.type === "mcp.call", "白名单字段保留，数字规整");
		assert(EVENT_FIELDS.every((f) => !/text|content|prompt|message|args/i.test(f)), "字段表里没有承载正文的字段");
		const long = sanitizeEvent("skill.trigger", { skill: "x".repeat(500) });
		assert(long.skill.length === 128, "字符串截到 128 字");
	}

	console.log("\n[2] 错误类");
	{
		assert(errorClassOf({ info: { code: "tool-timeout" } }) === "tool-timeout", "宿主 error.info.code 优先");
		assert(errorClassOf(Object.assign(new Error("x"), { code: "ECONNREFUSED" })) === "ECONNREFUSED", "Node code");
		assert(errorClassOf(new Error("request timed out after 30s")) === "timeout", "超时归类");
		assert(errorClassOf(new Error("MCP server gh 未登记")) === "not-found", "未登记归类");
		assert(errorClassOf(new TypeError("boom")) === "TypeError", "错误名兜底");
		assert(errorClassOf(new Error("secret sk-abc 泄露")) === "error", "原文不进错误类");
		assert(JSON.stringify(parseNativeMcpName("mcp__github__search_code")) === JSON.stringify({ server: "github", tool: "search_code" }), "原生 MCP 工具名解析");
		assert(parseNativeMcpName("read") === null, "非 MCP 工具名返回 null");
	}

	console.log("\n[3] 遥测目录不可写：record 返回 false、只告警一次、不抛");
	{
		const blocker = join(fakeHome, "blocked");
		writeFileSync(blocker, "我是文件，不是目录");
		const warns = [];
		const t = createTelemetry({ dir: join(blocker, "telemetry"), logger: { warn: (m) => warns.push(m) } });
		let threw = false;
		let r1;
		let r2;
		try {
			r1 = await t.record("mcp.call", { sid: "s", server: "a", tool: "b", ok: true });
			r2 = await t.record("skill.trigger", { sid: "s", skill: "x", ok: true });
		} catch {
			threw = true;
		}
		assert(!threw && r1 === false && r2 === false, "写失败 resolve 为 false，不抛");
		assert(t.health.dropped === 2 && t.health.written === 0, "health 计数 dropped=2");
		assert(warns.length === 1 && /遥测写入失败（只丢统计，不影响主流程）/.test(warns[0]), "告警限流：1 分钟内只打一次");
		assert((await t.record("not.a.type", {})) === false, "未知事件类型直接丢弃");
		const stats = await t.stats();
		assert(stats.ok === true && stats.events === 0, "目录坏了统计也照常返回（空）");
	}

	console.log("\n[4] 遥测坏了，McpRuntime.call 主流程照常");
	{
		const blocker = join(fakeHome, "blocked2");
		writeFileSync(blocker, "x");
		const warns = [];
		configureTelemetry({ dir: join(blocker, "t"), logger: { warn: (m) => warns.push(m) } });
		const runtime = new McpRuntime({ warn() {}, info() {}, error() {} });
		runtime.ensure = async () => ({ callTool: async (tool, args) => ({ content: [{ type: "text", text: "echo:" + args.text }] }) });
		const result = await runtime.call({ name: "fixture" }, "echo", { text: "hi" });
		assert(result?.content?.[0]?.text === "echo:hi", "调用结果原样返回");
		runtime.ensure = async () => {
			throw new Error("MCP server fixture 未连接");
		};
		let msg = "";
		try {
			await runtime.call({ name: "fixture" }, "echo", {});
		} catch (error) {
			msg = String(error?.message);
		}
		assert(msg === "MCP server fixture 未连接", "调用失败时抛出的仍是原错误，不被遥测吞掉或替换");
		await tick();
		assert(warns.length >= 1, "遥测失败只进日志");
	}

	console.log("\n[5] 遥测坏了，钩子包着的工具调用照常（含模型直接改 SKILL.md 的版本旁路）");
	{
		const blocker = join(fakeHome, "blocked3");
		writeFileSync(blocker, "x");
		const t = createTelemetry({ dir: join(blocker, "t"), logger: { warn() {} } });
		const host = fakeHost();
		installEvolutionHooks(host, { telemetry: t, studioToolNames: new Set(), catalogCandidates: async () => ({ servers: ["a"], toolCount: 1 }) });
		const agent = { id: "sess-broken" };
		let seen = null;
		const value = await host.execute({ name: "read", callId: "c1", agent, arguments: {} }, async () => {
			seen = currentWriteContext();
			return { content: "ok" };
		});
		assert(value?.content === "ok", "tools/execute 的 next() 结果原样透传");
		assert(seen?.actor === "model:read" && seen?.sessionId === "sess-broken", "写上下文带上 actor 与会话 id");
		const editValue = await host.execute({ name: "write", callId: "c2", agent, arguments: { file_path: join(fakeHome, "nowhere", "SKILL.md") } }, async () => ({ content: "written" }));
		assert(editValue?.content === "written", "skill 根外的 SKILL.md 写入：结果照常、不记版本");
		let threw = false;
		try {
			host.emit("tools/result", { name: "mcp__a__x", callId: "c3", agent }, { isError: false });
			host.emit("agent/inbox/claimed", { agent, turn: 1, message: { source: { kind: "skill-invocation", name: "foo" } } });
			host.emit("agent/turn-stopping", { agent, turn: 1 });
			host.emit("tools/result", null, null);
			host.emit("agent/inbox/claimed", null);
		} catch {
			threw = true;
		}
		await tick();
		await t.flush();
		assert(!threw, "坏 payload / 坏目录都不会把异常抛回宿主");
	}

	console.log("\n[6] 模拟一个真实会话：钩子 → 落盘 → 周统计（含注入了没用的候选）");
	{
		const dir = join(fakeHome, "tele-ok");
		const t = createTelemetry({ dir });
		const host = fakeHost();
		const studioToolNames = new Set(["mcp__studio__eager_tool"]);
		installEvolutionHooks(host, { telemetry: t, studioToolNames, catalogCandidates: async () => ({ servers: ["github", "notion", "fs"], toolCount: 9 }) });
		const agent = { id: "sess-A" };
		host.emit("agent/inbox/claimed", { agent, turn: 1, message: { source: { kind: "skill-invocation", name: "pdf" } } });
		await tick();
		// 同一轮再 claimed 一次（续消息）不重复记目录
		host.emit("agent/inbox/claimed", { agent, turn: 1, message: { source: { kind: "user" } } });
		await tick();
		const call = async (name, args, result) => {
			const exec = { name, callId: name + Math.random(), agent, arguments: args };
			const out = await host.execute(exec, async () => result);
			host.emit("tools/result", exec, out);
		};
		await call("skill", { name: "frontend-design" }, { content: "loaded" });
		await call("mcp__github__search_code", { q: "SECRET-QUERY-TEXT" }, { content: "x" });
		await call("mcp__github__get_file", {}, { isError: true, error: { info: { code: "tool-timeout" } } });
		await call("mcp__studio__eager_tool", {}, { content: "x" }); // 本插件 eager：McpRuntime 已记，这里跳过
		await call("mcp_call", { name: "fs" }, { content: "x" }); // 同上
		await call("read", { path: "/x" }, { content: "x" }); // 非 MCP 非 skill：不记
		host.emit("agent/turn-stopping", { agent, turn: 1 });
		await tick();
		await t.flush();

		const events = readEvents(dir);
		const types = events.map((e) => e.type).sort();
		assert(JSON.stringify(types) === JSON.stringify(["catalog.inject", "catalog.outcome", "mcp.call", "mcp.call", "skill.inject", "skill.trigger"]), "事件类型齐全且无重复：" + types.join(","));
		assert(readdirSync(dir).every((n) => n === `events-${dayOf(Date.now())}.jsonl`), "按本地日期落 events-YYYY-MM-DD.jsonl");
		assert(!readFileSync(join(dir, readdirSync(dir)[0]), "utf8").includes("SECRET-QUERY-TEXT"), "工具参数（对话内容）不落盘");
		const inject = events.find((e) => e.type === "catalog.inject");
		assert(inject.candidates.join(",") === "github,notion,fs" && inject.toolCount === 9 && inject.turn === 1 && inject.sid === "sess-A", "catalog.inject 记候选与工具数");
		const outcome = events.find((e) => e.type === "catalog.outcome");
		assert(outcome.used.join(",") === "github" && outcome.unused.join(",") === "notion,fs", "catalog.outcome：用了 github，没用 notion/fs");
		const fail = events.find((e) => e.type === "mcp.call" && e.tool === "get_file");
		assert(fail.ok === false && fail.err === "tool-timeout" && fail.via === "native" && Number.isFinite(fail.ms), "失败调用带错误类、via、耗时");
		assert(events.find((e) => e.type === "skill.trigger").turn === 1, "事件自动带上当前轮次");

		const stats = await t.stats({ weeks: 1 });
		const week = stats.weeks[0];
		const gh = week.mcp.find((m) => m.server === "github");
		assert(gh.calls === 2 && gh.failures === 1 && gh.failureRate === 0.5 && gh.errors["tool-timeout"] === 1, "per server：调用 2、失败 1、失败率 0.5");
		assert(gh.tools.length === 2 && gh.tools.every((x) => x.calls === 1), "per tool 分开统计");
		const fd = week.skills.find((s) => s.skill === "frontend-design");
		const pdf = week.skills.find((s) => s.skill === "pdf");
		assert(fd?.triggers === 1 && pdf?.injections === 1 && fd.lastTriggeredAt !== null, "per skill：触发 / 注入 / 最近触发时间");
		const notion = week.catalog.find((c) => c.server === "notion");
		const ghCat = week.catalog.find((c) => c.server === "github");
		assert(notion?.shownTurns === 1 && notion.unusedTurns === 1 && ghCat?.usedTurns === 1, "目录「看了没用」按轮计");
		const scoped = await t.stats({ sid: "sess-other" });
		assert(scoped.events === 0 && scoped.sid === "sess-other", "按会话过滤");
	}

	console.log("\n[7] 周桶与 90 天保留");
	{
		const dir = join(fakeHome, "tele-retention");
		mkdirSync(dir, { recursive: true });
		const now = Date.now();
		const old = now - 100 * DAY;
		const keep = now - 80 * DAY;
		writeFileSync(join(dir, `events-${dayOf(old)}.jsonl`), JSON.stringify({ v: 1, ts: new Date(old).toISOString(), type: "skill.trigger", skill: "ancient" }) + "\n");
		writeFileSync(join(dir, `events-${dayOf(keep)}.jsonl`), JSON.stringify({ v: 1, ts: new Date(keep).toISOString(), type: "skill.trigger", skill: "kept" }) + "\n");
		let clock = now - 9 * DAY;
		const t = createTelemetry({ dir, now: () => clock });
		await t.record("mcp.call", { sid: "s", server: "lastweek", tool: "t", ok: true, ms: 5 });
		clock = now;
		await t.record("mcp.call", { sid: "s", server: "thisweek", tool: "t", ok: true, ms: 7 });
		await t.flush();
		assert(!existsSync(join(dir, `events-${dayOf(old)}.jsonl`)), "超过 90 天的日文件被清掉");
		assert(existsSync(join(dir, `events-${dayOf(keep)}.jsonl`)), "90 天内的日文件保留");
		const stats = await t.stats({ weeks: 2 });
		assert(stats.weeks.length === 2, "weeks=2 给两个滚动 7 天桶");
		assert(stats.weeks[0].mcp.map((m) => m.server).join(",") === "thisweek", "第 0 桶 = 最近 7 天");
		assert(stats.weeks[1].mcp.map((m) => m.server).join(",") === "lastweek", "第 1 桶 = 再往前 7 天");
		assert(stats.weeks[0].mcp[0].avgMs === 7, "平均耗时");
		const off = createTelemetry({ dir: join(fakeHome, "tele-off"), enabled: false });
		assert((await off.record("mcp.call", { server: "x" })) === false && !existsSync(join(fakeHome, "tele-off")), "关闭开关后不建目录不写文件");
	}
} finally {
	rmSync(fakeHome, { recursive: true, force: true });
}

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (telemetry) ===");
