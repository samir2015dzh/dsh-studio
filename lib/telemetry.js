/**
 * 遥测地基：skill / MCP 的调用与「目录给模型看了没用」的本地统计。
 *
 * 存储：`~/.dsh/dsh-studio/telemetry/events-YYYY-MM-DD.jsonl`（本地日期按日滚动，一行一个事件），
 * 留 RETENTION_DAYS（默认 90）天，写入时每天顺手清一次过期文件。可用环境变量
 * `DSH_STUDIO_TELEMETRY_DIR` 改位置。遥测是运行时统计，不进快照（快照白名单已排除 telemetry/）。
 *
 * 隐私：只落 id、名称、计数、耗时、错误类——**不落对话正文、不落工具参数、不落错误原文**。
 * 事件字段走白名单（EVENT_FIELDS），键名像凭据的值一律走既有 maskSecret（redact.js）。
 *
 * 旁路：record() 永不抛、永不拖慢调用方（写入排在内部队列里，调用方不必 await）；
 * 写失败只把 dropped 计数 +1 并在日志里留痕（限频），统计缺了就是缺了，主流程照常。
 */
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { atomicWriteFile } from "./fs-atomic.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SENSITIVE_KEY, maskSecret } from "./redact.js";

export const TELEMETRY_SCHEMA = 1;
export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const FILE_RE = /^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/**
 * 事件类型：
 *   skill.trigger   模型调用 skill 工具加载某个 skill（via=skill-tool）
 *   skill.inject    skill 正文被注入会话（via=user-invocation：用户显式 /skill 调用）
 *   mcp.call        一次 MCP 工具调用（via=mcp_call | eager | studio：经本插件，studio = 插件内部调用；native：DSH 自带 mcp-client 的 mcp__*）
 *   catalog.inject  本轮开始时模型看得到的 MCP 目录候选（server 名单）
 *   catalog.outcome 本轮结束：看到了哪些、实际用了哪些、看了没用的是哪些
 * （MCP 线）追加，既有五类的字段与口径不变：
 *   mcp.load        真正建立一条上游连接（按需加载的那一下；via=call | load | eager | verify | register | panel | boot | studio，
 *                   studio = 不属于前几类的插件内部调用，见 lib/mcp.js viaOfContext）
 *   mcp.unload      断开一条上游连接（cause=idle 空闲回收 | reload 默认值：切档 / 重挂 / 面板重连 | config 改配置 |
 *                   unregister 注销 | shutdown 插件停用 | closed 对端或传输层自己断开）。熔断**不断开**连接，所以没有 breaker 这个 cause
 *   mcp.verify      一次验证（真实握手 + 工具列表）：state=verified | failed
 *   mcp.breaker     熔断状态迁移：state=open（cause=错误类）| half-open（cause=cooldown-elapsed，冷却到点）|
 *                   closed（cause=recovered 试探成功 | manual 手动复位）；until=预计恢复时间（只有 open 带）
 *   mcp.registry    注册表的一次语义写入（与版本记录一一对应）：action=add | edit | remove | setting | rollback | migrate
 */
export const EVENT_TYPES = new Set(["skill.trigger", "skill.inject", "mcp.call", "catalog.inject", "catalog.outcome", "mcp.load", "mcp.unload", "mcp.verify", "mcp.breaker", "mcp.registry"]);

/** 落盘字段白名单（除 v / ts / type 之外）。只在末尾追加 action / state / cause / until。 */
export const EVENT_FIELDS = ["sid", "turn", "skill", "via", "server", "tool", "ok", "ms", "err", "candidates", "shown", "used", "unused", "toolCount", "action", "state", "cause", "until"];

export function telemetryDir() {
	const override = typeof process.env.DSH_STUDIO_TELEMETRY_DIR === "string" ? process.env.DSH_STUDIO_TELEMETRY_DIR.trim() : "";
	if (override !== "") return resolve(override);
	return resolve(homedir(), ".dsh", "dsh-studio", "telemetry");
}

function localDay(ts) {
	const d = new Date(ts);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clampString(value, max = 128) {
	const s = String(value);
	return s.length <= max ? s : s.slice(0, max);
}

function sanitizeValue(key, value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return SENSITIVE_KEY.test(key) ? maskSecret(value) : clampString(value);
	if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;
	if (typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.filter((x) => typeof x === "string").slice(0, 200).map((x) => clampString(x));
	return undefined;
}

/** 事件 → 可落盘对象：只留白名单字段、只留标量与字符串数组。 */
export function sanitizeEvent(type, fields, ts = Date.now()) {
	const out = { v: TELEMETRY_SCHEMA, ts: new Date(ts).toISOString(), type };
	for (const key of EVENT_FIELDS) {
		if (!fields || !Object.hasOwn(fields, key)) continue;
		const value = sanitizeValue(key, fields[key]);
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/**
 * 错误 → 错误类（短标识，不含原文）。优先用宿主 / Node 给的 code；其次按常见形态归类。
 * @returns {string}
 */
export function errorClassOf(error) {
	if (error === undefined || error === null) return "error";
	const code = error?.info?.code ?? error?.code;
	if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(code)) return code;
	const message = String(error?.message ?? error);
	if (/timed? ?out|超时/i.test(message)) return "timeout";
	if (/未连接|ECONNREFUSED|ECONNRESET|connect|连接/i.test(message)) return "connect";
	if (/未登记|not found|unknown tool/i.test(message)) return "not-found";
	if (/已禁用|disabled|denied|拒绝|过滤/i.test(message)) return "denied";
	const name = typeof error?.name === "string" && /^[A-Za-z]{1,48}$/.test(error.name) ? error.name : "";
	return name !== "" && name !== "Error" ? name : "error";
}

/**
 * @param {{dir?: () => string, logger?: object, enabled?: boolean, retentionDays?: number, now?: () => number}} [options]
 */
export function createTelemetry(options = {}) {
	const dirOf = typeof options.dir === "function" ? options.dir : typeof options.dir === "string" ? () => options.dir : telemetryDir;
	const now = typeof options.now === "function" ? options.now : () => Date.now();
	const retentionDays = Number.isFinite(Number(options.retentionDays)) && Number(options.retentionDays) > 0 ? Number(options.retentionDays) : RETENTION_DAYS;
	let enabled = options.enabled !== false;
	let logger = options.logger ?? null;
	let chain = Promise.resolve();
	let lastPruneDay = "";
	let lastWarnAt = 0;
	const state = { written: 0, dropped: 0, lastError: "" };
	/** sid → 当前轮次（来自 agent/inbox/claimed） */
	const turns = new Map();
	/** sid → {turn, shown:string[], used:Set<string>}：本轮 MCP 目录的「看了 / 用了」 */
	const turnUsage = new Map();

	const warn = (message) => {
		state.lastError = message;
		const t = now();
		if (t - lastWarnAt < 60_000) return;
		lastWarnAt = t;
		const text = "[dsh-studio] 遥测写入失败（只丢统计，不影响主流程）：" + message;
		try {
			if (logger?.warn) logger.warn(text);
			else process.stderr.write(text + "\n");
		} catch {
			/* 日志也坏了：放弃 */
		}
	};

	async function prune(at = now()) {
		const day = localDay(at);
		if (day === lastPruneDay) return 0;
		lastPruneDay = day;
		let removed = 0;
		let names = [];
		try {
			names = await readdir(dirOf());
		} catch {
			return 0;
		}
		const cutoff = at - retentionDays * DAY_MS;
		for (const name of names) {
			const m = FILE_RE.exec(name);
			if (!m) continue;
			// 文件日的 23:59:59 都早于截止点才删（按整天保留）
			const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime();
			if (end <= cutoff) {
				await rm(join(dirOf(), name), { force: true }).catch(() => {});
				removed += 1;
			}
		}
		return removed;
	}

	async function write(event, at) {
		const dir = dirOf();
		await mkdir(dir, { recursive: true });
		await appendFile(join(dir, `events-${localDay(at)}.jsonl`), JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
		state.written += 1;
		await prune(at).catch(() => {});
	}

	/**
	 * 记一个事件。永不抛；返回的 Promise 在落盘（或失败）后 resolve 为 true / false。
	 * 调用方通常不 await——测试或需要顺序的地方可以 await 它或 flush()。
	 */
	function record(type, fields = {}) {
		if (!enabled || !EVENT_TYPES.has(type)) return Promise.resolve(false);
		let event;
		const at = now();
		try {
			const sid = typeof fields.sid === "string" ? fields.sid : "";
			const withTurn = sid !== "" && fields.turn === undefined && turns.has(sid) ? { ...fields, turn: turns.get(sid) } : fields;
			event = sanitizeEvent(type, withTurn, at);
			if (type === "mcp.call" && sid !== "" && typeof fields.server === "string") {
				const usage = turnUsage.get(sid);
				if (usage !== undefined) usage.used.add(fields.server);
			}
		} catch (error) {
			state.dropped += 1;
			warn(error instanceof Error ? error.message : String(error));
			return Promise.resolve(false);
		}
		const job = chain.then(
			() => write(event, at).then(() => true),
			() => write(event, at).then(() => true)
		).catch((error) => {
			state.dropped += 1;
			warn(error instanceof Error ? error.message : String(error));
			return false;
		});
		chain = job.then(() => undefined, () => undefined);
		return job;
	}

	/** 等所有排队的写入落完（测试与关停时用）。 */
	function flush() {
		return chain.then(() => undefined, () => undefined);
	}

	/** 轮次开始：记下 sid 当前轮次；返回 true 表示这是该 (sid, turn) 第一次出现。 */
	function beginTurn(sid, turn) {
		if (typeof sid !== "string" || sid === "") return false;
		const t = Number(turn);
		const known = turns.get(sid);
		turns.set(sid, Number.isFinite(t) ? t : known ?? 0);
		if (turns.size > 2000) turns.delete(turns.keys().next().value);
		return known !== t;
	}

	/** 本轮给模型看的目录候选（catalog.inject）。同一 (sid, turn) 只记一次。 */
	function noteCatalogShown(sid, turn, candidates, toolCount) {
		if (typeof sid !== "string" || sid === "") return Promise.resolve(false);
		const prev = turnUsage.get(sid);
		if (prev !== undefined && prev.turn === turn) return Promise.resolve(false);
		turnUsage.set(sid, { turn, shown: [...candidates], used: new Set() });
		if (turnUsage.size > 2000) turnUsage.delete(turnUsage.keys().next().value);
		return record("catalog.inject", { sid, turn, candidates, toolCount });
	}

	/** 轮次结束：出一条 catalog.outcome（看了 / 用了 / 看了没用）。没有目录记录的轮次不出。 */
	function endTurn(sid, turn) {
		const usage = typeof sid === "string" ? turnUsage.get(sid) : undefined;
		if (usage === undefined) return Promise.resolve(false);
		turnUsage.delete(sid);
		const used = [...usage.used].sort();
		const unused = usage.shown.filter((s) => !usage.used.has(s));
		return record("catalog.outcome", { sid, turn: Number.isFinite(Number(turn)) ? Number(turn) : usage.turn, shown: usage.shown, used, unused });
	}

	return {
		record,
		flush,
		prune: (at) => prune(at ?? now()).catch(() => 0),
		beginTurn,
		turnOf: (sid) => turns.get(sid),
		noteCatalogShown,
		endTurn,
		stats: (opts = {}) => computeStats({ dir: dirOf(), now: now(), retentionDays, ...opts, health: { ...state, enabled } }),
		configure(next = {}) {
			if (next.logger !== undefined) logger = next.logger;
			if (next.enabled !== undefined) enabled = next.enabled !== false;
		},
		get health() {
			return { ...state, enabled, dir: dirOf(), retentionDays };
		}
	};
}

// ── 统计出口 ──────────────────────────────────────────────────────────────

async function readEvents(dir, fromTs, toTs) {
	let names = [];
	try {
		names = await readdir(dir);
	} catch {
		return { events: [], files: 0, badLines: 0 };
	}
	const fromDay = localDay(fromTs);
	const toDay = localDay(toTs);
	const events = [];
	let files = 0;
	let badLines = 0;
	for (const name of names.sort()) {
		const m = FILE_RE.exec(name);
		if (!m) continue;
		const day = `${m[1]}-${m[2]}-${m[3]}`;
		if (day < fromDay || day > toDay) continue;
		let text;
		try {
			text = await readFile(join(dir, name), "utf8");
		} catch {
			continue;
		}
		files += 1;
		for (const line of text.split(/\r?\n/)) {
			if (line.trim() === "") continue;
			try {
				const ev = JSON.parse(line);
				const t = Date.parse(ev?.ts);
				if (!Number.isFinite(t) || t < fromTs || t >= toTs) continue;
				events.push({ ...ev, t });
			} catch {
				badLines += 1;
			}
		}
	}
	return { events, files, badLines };
}

/**
 * 原始事件只读出口。不改任何统计口径。
 * @param {{dir?: string, fromTs: number, toTs: number}} opts
 * @returns {Promise<Array<object & {t:number, file:string}>>}
 */
export async function readTelemetryEvents(opts) {
	const dir = typeof opts?.dir === "string" && opts.dir !== "" ? opts.dir : getTelemetry().health.dir;
	const { events } = await readEvents(dir, Number(opts?.fromTs) || 0, Number(opts?.toTs) || Date.now() + 1);
	return events.map((ev) => ({ ...ev, file: "events-" + localDay(ev.t) + ".jsonl" }));
}

const rate = (fail, total) => (total > 0 ? Math.round((fail / total) * 10000) / 10000 : 0);
const iso = (t) => (Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null);

/** 可合并的聚合中间态（审计 4：按日预聚合缓存的就是它）。 */
function newAcc() {
	return { skills: new Map(), servers: new Map(), catalog: new Map(), lifecycle: new Map() };
}

const lifeRow = (acc, name) => {
	let row = acc.lifecycle.get(name);
	if (row === undefined) {
		row = { server: name, loads: 0, failedLoads: 0, unloads: 0, unloadCauses: {}, lastLoadedAt: 0, verifyOk: 0, verifyFailed: 0, breakerOpens: 0, breakerResets: 0, registryWrites: 0 };
		acc.lifecycle.set(name, row);
	}
	return row;
};
const skillRowOf = (acc, name) => {
	let row = acc.skills.get(name);
	if (row === undefined) {
		row = { skill: name, triggers: 0, injections: 0, failures: 0, lastTriggeredAt: 0, sessions: new Set() };
		acc.skills.set(name, row);
	}
	return row;
};
const serverRowOf = (acc, name) => {
	let srv = acc.servers.get(name);
	if (srv === undefined) {
		srv = { server: name, calls: 0, failures: 0, totalMs: 0, timed: 0, maxMs: 0, lastCalledAt: 0, errors: {}, via: {}, tools: new Map() };
		acc.servers.set(name, srv);
	}
	return srv;
};
const toolRowOf = (srv, toolName) => {
	let tool = srv.tools.get(toolName);
	if (tool === undefined) {
		tool = { tool: toolName, calls: 0, failures: 0, totalMs: 0, timed: 0, lastCalledAt: 0, errors: {} };
		srv.tools.set(toolName, tool);
	}
	return tool;
};
const catalogRowOf = (acc, name) => {
	let row = acc.catalog.get(name);
	if (row === undefined) {
		row = { server: name, shownTurns: 0, usedTurns: 0, unusedTurns: 0 };
		acc.catalog.set(name, row);
	}
	return row;
};
const addCounts = (into, from) => {
	for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

function accumulate(acc, events) {
	for (const ev of events) {
		if ((ev.type === "skill.trigger" || ev.type === "skill.inject") && typeof ev.skill === "string") {
			const row = skillRowOf(acc, ev.skill);
			if (ev.type === "skill.trigger") row.triggers += 1;
			else row.injections += 1;
			if (ev.ok === false) row.failures += 1;
			row.lastTriggeredAt = Math.max(row.lastTriggeredAt, ev.t);
			if (typeof ev.sid === "string") row.sessions.add(ev.sid);
		} else if (ev.type === "mcp.call" && typeof ev.server === "string") {
			const srv = serverRowOf(acc, ev.server);
			const tool = toolRowOf(srv, typeof ev.tool === "string" ? ev.tool : "(unknown)");
			for (const row of [srv, tool]) {
				row.calls += 1;
				if (ev.ok === false) {
					row.failures += 1;
					const cls = typeof ev.err === "string" ? ev.err : "error";
					row.errors[cls] = (row.errors[cls] ?? 0) + 1;
				}
				if (Number.isFinite(ev.ms)) {
					row.totalMs += ev.ms;
					row.timed += 1;
				}
				row.lastCalledAt = Math.max(row.lastCalledAt, ev.t);
			}
			if (Number.isFinite(ev.ms)) srv.maxMs = Math.max(srv.maxMs, ev.ms);
			const via = typeof ev.via === "string" ? ev.via : "unknown";
			srv.via[via] = (srv.via[via] ?? 0) + 1;
		} else if (ev.type === "mcp.load" && typeof ev.server === "string") {
			const row = lifeRow(acc, ev.server);
			if (ev.ok === false) row.failedLoads += 1;
			else {
				row.loads += 1;
				row.lastLoadedAt = Math.max(row.lastLoadedAt, ev.t);
			}
		} else if (ev.type === "mcp.unload" && typeof ev.server === "string") {
			const row = lifeRow(acc, ev.server);
			row.unloads += 1;
			const cause = typeof ev.cause === "string" ? ev.cause : "unknown";
			row.unloadCauses[cause] = (row.unloadCauses[cause] ?? 0) + 1;
		} else if (ev.type === "mcp.verify" && typeof ev.server === "string") {
			const row = lifeRow(acc, ev.server);
			if (ev.state === "verified") row.verifyOk += 1;
			else row.verifyFailed += 1;
		} else if (ev.type === "mcp.breaker" && typeof ev.server === "string") {
			const row = lifeRow(acc, ev.server);
			if (ev.state === "open") row.breakerOpens += 1;
			else if (ev.state === "closed") row.breakerResets += 1;
		} else if (ev.type === "mcp.registry" && typeof ev.server === "string") {
			lifeRow(acc, ev.server).registryWrites += 1;
		} else if (ev.type === "catalog.outcome") {
			const used = new Set(Array.isArray(ev.used) ? ev.used : []);
			for (const name of Array.isArray(ev.shown) ? ev.shown : []) {
				const row = catalogRowOf(acc, name);
				row.shownTurns += 1;
				if (used.has(name)) row.usedTurns += 1;
				else row.unusedTurns += 1;
			}
		}
	}
	return acc;
}

/** 把一份（已反序列化的）日聚合并进 acc；与把那一天的原始事件逐条 accumulate 等价。 */
function mergeAcc(acc, part) {
	for (const r of part.skills) {
		const row = skillRowOf(acc, r.skill);
		row.triggers += r.triggers;
		row.injections += r.injections;
		row.failures += r.failures;
		row.lastTriggeredAt = Math.max(row.lastTriggeredAt, r.lastTriggeredAt);
		for (const sid of r.sessions) row.sessions.add(sid);
	}
	for (const s of part.servers) {
		const srv = serverRowOf(acc, s.server);
		for (const k of ["calls", "failures", "totalMs", "timed"]) srv[k] += s[k];
		srv.maxMs = Math.max(srv.maxMs, s.maxMs);
		srv.lastCalledAt = Math.max(srv.lastCalledAt, s.lastCalledAt);
		addCounts(srv.errors, s.errors);
		addCounts(srv.via, s.via);
		for (const t of s.tools) {
			const tool = toolRowOf(srv, t.tool);
			for (const k of ["calls", "failures", "totalMs", "timed"]) tool[k] += t[k];
			tool.lastCalledAt = Math.max(tool.lastCalledAt, t.lastCalledAt);
			addCounts(tool.errors, t.errors);
		}
	}
	for (const l of part.lifecycle) {
		const row = lifeRow(acc, l.server);
		for (const k of ["loads", "failedLoads", "unloads", "verifyOk", "verifyFailed", "breakerOpens", "breakerResets", "registryWrites"]) row[k] += l[k];
		row.lastLoadedAt = Math.max(row.lastLoadedAt, l.lastLoadedAt);
		addCounts(row.unloadCauses, l.unloadCauses);
	}
	for (const c of part.catalog) {
		const row = catalogRowOf(acc, c.server);
		row.shownTurns += c.shownTurns;
		row.usedTurns += c.usedTurns;
		row.unusedTurns += c.unusedTurns;
	}
	return acc;
}

/** acc → 可落盘的纯 JSON（Map / Set 摊平成数组，保持插入顺序）。 */
function serializeAcc(acc) {
	return {
		skills: [...acc.skills.values()].map((r) => ({ ...r, sessions: [...r.sessions] })),
		servers: [...acc.servers.values()].map((s) => ({ ...s, errors: { ...s.errors }, via: { ...s.via }, tools: [...s.tools.values()].map((t) => ({ ...t, errors: { ...t.errors } })) })),
		lifecycle: [...acc.lifecycle.values()].map((l) => ({ ...l, unloadCauses: { ...l.unloadCauses } })),
		catalog: [...acc.catalog.values()].map((c) => ({ ...c }))
	};
}

function finalize(acc) {
	const { skills, servers, catalog, lifecycle } = acc;
	return {
		skills: [...skills.values()]
			.map((r) => ({ skill: r.skill, triggers: r.triggers, injections: r.injections, failures: r.failures, failureRate: rate(r.failures, r.triggers + r.injections), lastTriggeredAt: iso(r.lastTriggeredAt), sessions: r.sessions.size }))
			.sort((a, b) => b.triggers + b.injections - (a.triggers + a.injections) || a.skill.localeCompare(b.skill)),
		mcp: [...servers.values()]
			.map((s) => ({
				server: s.server,
				calls: s.calls,
				failures: s.failures,
				failureRate: rate(s.failures, s.calls),
				avgMs: s.timed > 0 ? Math.round(s.totalMs / s.timed) : null,
				maxMs: s.timed > 0 ? Math.round(s.maxMs) : null,
				lastCalledAt: iso(s.lastCalledAt),
				errors: s.errors,
				via: s.via,
				tools: [...s.tools.values()]
					.map((t) => ({ tool: t.tool, calls: t.calls, failures: t.failures, failureRate: rate(t.failures, t.calls), avgMs: t.timed > 0 ? Math.round(t.totalMs / t.timed) : null, lastCalledAt: iso(t.lastCalledAt), errors: t.errors }))
					.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
			}))
			.sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server)),
		catalog: [...catalog.values()].sort((a, b) => b.unusedTurns - a.unusedTurns || a.server.localeCompare(b.server)),
		// · D：每个 server 的加载次数，以及「目录里出现过、但窗口内一次都没被加载」的闲置项
		loads: [...lifecycle.values()]
			.map((r) => ({ ...r, lastLoadedAt: iso(r.lastLoadedAt) }))
			.sort((a, b) => b.loads - a.loads || a.server.localeCompare(b.server)),
		idle: [...catalog.values()]
			.filter((c) => (lifecycle.get(c.server)?.loads ?? 0) === 0)
			.map((c) => ({ server: c.server, shownTurns: c.shownTurns, loads: 0 }))
			.sort((a, b) => b.shownTurns - a.shownTurns || a.server.localeCompare(b.server))
	};
}

function aggregate(events) {
	return finalize(accumulate(newAcc(), events));
}

/**
 * 周统计：最近 weeks 个「滚动 7 天」窗口（第 0 个是截至 now 的最近 7 天），每个窗口一份
 * skill / MCP server+tool / 目录「看了没用」三张表。lastTriggeredAt / lastCalledAt 取整个保留期内的最近一次。
 * @param {{dir:string, now:number, weeks?:number, sid?:string, retentionDays?:number, health?:object}} opts
 */
export async function computeStats(opts) {
	const sid = typeof opts.sid === "string" && opts.sid.trim() !== "" ? opts.sid.trim() : "";
	// 按会话过滤的口径不走日缓存（缓存只存全量聚合）；结果与直读口径相同
	if (sid !== "" || opts.cache === false) return computeStatsDirect(opts);
	return computeStatsCached(opts);
}

/** 直读口径（前的实现原样保留）：读保留期内全部原始事件再聚合。对拍与按会话统计用。 */
export async function computeStatsDirect(opts) {
	const weeks = Math.min(Math.max(Math.floor(Number(opts.weeks) || 1), 1), 13);
	const end = Number(opts.now);
	const retention = Number(opts.retentionDays) || RETENTION_DAYS;
	const sid = typeof opts.sid === "string" && opts.sid.trim() !== "" ? opts.sid.trim() : "";
	const { events: all, files, badLines } = await readEvents(opts.dir, end - retention * DAY_MS, end + 1);
	const scoped = sid === "" ? all : all.filter((ev) => ev.sid === sid);
	const overall = aggregate(scoped);
	const lastSkill = new Map(overall.skills.map((r) => [r.skill, r.lastTriggeredAt]));
	const lastServer = new Map(overall.mcp.map((r) => [r.server, r.lastCalledAt]));
	const buckets = [];
	for (let i = 0; i < weeks; i += 1) {
		const to = end + 1 - i * 7 * DAY_MS;
		const from = to - 7 * DAY_MS;
		const agg = aggregate(scoped.filter((ev) => ev.t >= from && ev.t < to));
		for (const row of agg.skills) row.lastTriggeredAt = lastSkill.get(row.skill) ?? row.lastTriggeredAt;
		for (const row of agg.mcp) row.lastCalledAt = lastServer.get(row.server) ?? row.lastCalledAt;
		buckets.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...agg });
	}
	return {
		ok: true,
		sid: sid === "" ? null : sid,
		retentionDays: retention,
		dir: opts.dir,
		files,
		badLines,
		events: scoped.length,
		health: opts.health ?? null,
		weeks: buckets
	};
}

// ── 按日预聚合（审计 4）──────────────────────────────────────────────
//
// 每个日文件一份可合并的聚合中间态，键 = 文件名 + mtimeMs + size（变了就重算），进程内 Map + 磁盘
// `<telemetry>/.agg/<文件名>.json`（今天的文件还在长，不落盘）。中间态另记这一天事件的 min/max 时间戳：
// 统计窗口是「截至 now 的滚动 7 天」，不按自然日对齐——某一天整天落在窗口里才用缓存，跨窗口边界的那天
// 照旧读原始事件逐条过滤。于是每次统计只读：今天 + 每个窗口边界上的那天 + 缓存失效的日子。
const AGG_DIR = ".agg";
const AGG_SCHEMA = 1;
const memoryAgg = new Map();
/** 诊断计数：本进程里统计出口读了多少次原始日文件（测试对拍「只读增量日」用）。 */
export const statsCounters = { rawDayReads: 0, aggHits: 0, aggBuilds: 0 };

async function readDayRaw(file) {
	const text = await readFile(file, "utf8");
	statsCounters.rawDayReads += 1;
	const events = [];
	let badLines = 0;
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		try {
			const ev = JSON.parse(line);
			const t = Date.parse(ev?.ts);
			if (!Number.isFinite(t)) continue;
			events.push({ ...ev, t });
		} catch {
			badLines += 1;
		}
	}
	return { events, badLines };
}

async function dayPartial(dir, name, todayName) {
	const file = join(dir, name);
	let info;
	try {
		info = await stat(file);
	} catch {
		return null;
	}
	const key = `${resolve(dir)}|${name}`;
	const hit = memoryAgg.get(key);
	if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
		statsCounters.aggHits += 1;
		return { ...hit, raw: null };
	}
	const aggFile = join(dir, AGG_DIR, name + ".json");
	try {
		const disk = JSON.parse(await readFile(aggFile, "utf8"));
		if (disk?.schema === AGG_SCHEMA && disk.mtimeMs === info.mtimeMs && disk.size === info.size && disk.part) {
			memoryAgg.set(key, disk);
			statsCounters.aggHits += 1;
			return { ...disk, raw: null };
		}
	} catch {
		/* 没有缓存 / 缓存坏了：重算 */
	}
	let raw;
	try {
		raw = await readDayRaw(file);
	} catch {
		return null;
	}
	statsCounters.aggBuilds += 1;
	let minT = Infinity;
	let maxT = -Infinity;
	for (const ev of raw.events) {
		if (ev.t < minT) minT = ev.t;
		if (ev.t > maxT) maxT = ev.t;
	}
	const entry = { schema: AGG_SCHEMA, name, mtimeMs: info.mtimeMs, size: info.size, count: raw.events.length, badLines: raw.badLines, minT: raw.events.length ? minT : null, maxT: raw.events.length ? maxT : null, part: serializeAcc(accumulate(newAcc(), raw.events)) };
	memoryAgg.set(key, entry);
	if (name !== todayName) {
		await atomicWriteFile(aggFile, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 }).catch(() => {});
	}
	return { ...entry, raw: raw.events };
}

async function computeStatsCached(opts) {
	const weeks = Math.min(Math.max(Math.floor(Number(opts.weeks) || 1), 1), 13);
	const end = Number(opts.now);
	const retention = Number(opts.retentionDays) || RETENTION_DAYS;
	const fromTs = end - retention * DAY_MS;
	const toTs = end + 1;
	let names = [];
	try {
		names = await readdir(opts.dir);
	} catch {
		names = null;
	}
	const fromDay = localDay(fromTs);
	const toDay = localDay(toTs);
	const todayName = `events-${localDay(end)}.jsonl`;
	const days = [];
	let files = 0;
	let badLines = 0;
	for (const name of (names ?? []).slice().sort()) {
		const m = FILE_RE.exec(name);
		if (!m) continue;
		const day = `${m[1]}-${m[2]}-${m[3]}`;
		if (day < fromDay || day > toDay) continue;
		const part = await dayPartial(opts.dir, name, todayName);
		if (part === null) continue;
		files += 1;
		badLines += part.badLines;
		days.push(part);
	}
	// 缓存里已经没有对应日文件的聚合（被 prune 掉的日子）顺手清掉
	if (names !== null) void sweepAgg(opts.dir, new Set(names.filter((n) => FILE_RE.test(n)))).catch(() => {});

	/** 一个时间窗 [from, to) 的聚合：整天落在窗内的用缓存，其余读原始事件过滤。 */
	const windowAcc = async (from, to) => {
		const acc = newAcc();
		let count = 0;
		for (const d of days) {
			// 按这一天事件的真实时间范围判定（不按文件名的日子：日文件里可能混着别的日子的事件）
			if (d.count === 0 || d.maxT < from || d.minT >= to) continue;
			if (d.minT >= from && d.maxT < to) {
				mergeAcc(acc, d.part);
				count += d.count;
				continue;
			}
			if (d.raw === null) d.raw = (await readDayRaw(join(opts.dir, d.name)).catch(() => ({ events: [] }))).events;
			const inside = d.raw.filter((ev) => ev.t >= from && ev.t < to);
			accumulate(acc, inside);
			count += inside.length;
		}
		return { acc, count };
	};

	const overallRes = await windowAcc(fromTs, toTs);
	const overall = finalize(overallRes.acc);
	const lastSkill = new Map(overall.skills.map((r) => [r.skill, r.lastTriggeredAt]));
	const lastServer = new Map(overall.mcp.map((r) => [r.server, r.lastCalledAt]));
	const buckets = [];
	for (let i = 0; i < weeks; i += 1) {
		const to = end + 1 - i * 7 * DAY_MS;
		const from = to - 7 * DAY_MS;
		// 与直读口径一致：桶也只在保留期窗口里取事件
		const agg = finalize((await windowAcc(Math.max(from, fromTs), Math.min(to, toTs))).acc);
		for (const row of agg.skills) row.lastTriggeredAt = lastSkill.get(row.skill) ?? row.lastTriggeredAt;
		for (const row of agg.mcp) row.lastCalledAt = lastServer.get(row.server) ?? row.lastCalledAt;
		buckets.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...agg });
	}
	return {
		ok: true,
		sid: null,
		retentionDays: retention,
		dir: opts.dir,
		files,
		badLines,
		events: overallRes.count,
		health: opts.health ?? null,
		weeks: buckets
	};
}

async function sweepAgg(dir, live) {
	let names;
	try {
		names = await readdir(join(dir, AGG_DIR));
	} catch {
		return;
	}
	for (const n of names) {
		if (!n.endsWith(".json")) continue;
		if (!live.has(n.slice(0, -5))) await rm(join(dir, AGG_DIR, n), { force: true }).catch(() => {});
	}
}

// ── 进程级默认实例（mcp.js / 钩子共用；index.js 装配时注入 logger 与开关）──

let current = createTelemetry();

export function getTelemetry() {
	return current;
}

/** 替换默认实例（装配与测试用）。 */
export function configureTelemetry(options = {}) {
	current = createTelemetry(options);
	return current;
}
