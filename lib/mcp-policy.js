/**
 * MCP 线的策略层：验证状态、读写分级、试运行、熔断。
 *
 * 这里只有纯数据与内存状态机，不碰文件、不连上游：
 *   - verifyOf / writeAllowed：登记口径（C）。条目带 `verify: {status, checkedAt, error, toolCount, via}`；
 *     `verified` 只来自真实握手 + 工具列表（McpRuntime.ensure 成功），写进注册表不等于验过。
 *     老条目没有 verify 字段 → 当作 `unverified`。
 *   - classifyTool：读写分级（F）。优先级：条目 `toolAccess` 手工覆盖 > MCP 工具注解
 *     （readOnlyHint / destructiveHint）> 工具名动词启发式 > 拿不准一律按「可写」（宁严勿松）。
 *   - 试运行：`trial: true` 或尚未 verified 的条目只放行只读工具；verified 且没钉 trial 才放开可写。
 *   - CircuitBreaker：连续失败达阈值熔断（从目录候选里摘除并标注原因与恢复时间），冷却到点后
 *     半开放一次试探，成功复位、失败再熔断；手动复位走 mcp_verify。状态迁移经 onTransition 出遥测。
 */

export const VERIFY_STATES = new Set(["unverified", "verified", "failed"]);
export const ACCESS_LEVELS = new Set(["read", "write"]);

/** 条目的验证状态（缺省 = unverified）。 */
export function verifyOf(entry) {
	const v = entry?.verify;
	const status = v && VERIFY_STATES.has(v.status) ? v.status : "unverified";
	return {
		status,
		checkedAt: typeof v?.checkedAt === "string" ? v.checkedAt : null,
		error: typeof v?.error === "string" && v.error !== "" ? v.error : null,
		toolCount: Number.isFinite(v?.toolCount) ? v.toolCount : null,
		via: typeof v?.via === "string" ? v.via : null
	};
}

/** 试运行（只许握手 + 工具列表 + 只读调用）：钉了 trial，或者还没 verified。 */
export function inTrial(entry) {
	return entry?.trial === true || verifyOf(entry).status !== "verified";
}

/** 可写工具是否放开。 */
export function writeAllowed(entry) {
	return !inTrial(entry);
}

// 动词表：按「词」匹配（名字按 _ - . 空格 与驼峰切开），只看第一个能判定的词。
const READ_VERBS = new Set([
	"get", "list", "search", "read", "fetch", "query", "find", "recall", "describe", "show", "view", "lookup", "look",
	"stat", "stats", "info", "peek", "check", "inspect", "count", "browse", "explore", "scan", "ls", "cat", "head",
	"tail", "grep", "diff", "status", "ping", "health", "echo", "preview", "analyze", "analyse", "summarize",
	"summarise", "extract", "parse", "detect", "compare", "resolve", "validate", "verify", "estimate", "reflect",
	"ocr", "recognize", "translate", "lint", "help", "version", "whoami", "download", "open", "load", "retrieve", "select"
]);
const WRITE_VERBS = new Set([
	"create", "write", "update", "delete", "remove", "rm", "set", "add", "put", "post", "send", "retain", "edit",
	"upload", "move", "mv", "rename", "kill", "run", "exec", "execute", "apply", "install", "uninstall", "save",
	"insert", "patch", "push", "commit", "publish", "modify", "start", "stop", "restart", "clear", "drop", "reset",
	"purge", "archive", "import", "merge", "approve", "reject", "close", "submit", "deploy", "trigger", "click",
	"type", "fill", "press", "navigate", "store", "remember", "forget", "mkdir", "copy", "cp", "convert", "generate",
	"render", "make", "build", "compile", "grow", "spawn", "launch", "schedule", "cancel", "transfer", "pay", "order",
	"book", "email", "message", "notify", "tweet", "reply", "comment", "like", "follow", "invite", "assign", "lock",
	"unlock", "enable", "disable", "toggle", "replace", "overwrite", "append", "truncate", "format", "encrypt", "sign"
]);

function wordsOf(name) {
	return String(name ?? "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w !== "");
}

/** 只按名字判断：返回 "read" / "write" / null（判不出来）。 */
export function accessFromName(name) {
	for (const word of wordsOf(name)) {
		if (WRITE_VERBS.has(word)) return "write";
		if (READ_VERBS.has(word)) return "read";
	}
	return null;
}

/**
 * 工具的读写分级。tool 可以是完整的 MCP 工具定义（带 annotations），也可以是注册表里的瘦缓存
 * （{name, description, readOnly?}）。
 * @returns {{access:"read"|"write", source:"override"|"annotation"|"name"|"default"}}
 */
export function classifyTool(entry, tool) {
	const name = typeof tool === "string" ? tool : tool?.name;
	const override = entry?.toolAccess && typeof entry.toolAccess === "object" ? entry.toolAccess[name] : undefined;
	if (ACCESS_LEVELS.has(override)) return { access: override, source: "override" };
	const ann = typeof tool === "object" && tool !== null ? tool.annotations : undefined;
	if (ann && typeof ann === "object") {
		if (ann.readOnlyHint === true) return { access: "read", source: "annotation" };
		if (ann.readOnlyHint === false || ann.destructiveHint === true) return { access: "write", source: "annotation" };
	}
	if (typeof tool === "object" && tool !== null && typeof tool.readOnly === "boolean") {
		return { access: tool.readOnly ? "read" : "write", source: "annotation" };
	}
	const byName = accessFromName(name);
	if (byName !== null) return { access: byName, source: "name" };
	return { access: "write", source: "default" };
}

/** 注册表里瘦缓存要留下的注解（只有布尔的 readOnly，别的不落盘）。 */
export function slimAnnotation(tool) {
	const ann = tool?.annotations;
	if (ann && typeof ann === "object") {
		if (ann.readOnlyHint === true) return { readOnly: true };
		if (ann.readOnlyHint === false || ann.destructiveHint === true) return { readOnly: false };
	}
	if (typeof tool?.readOnly === "boolean") return { readOnly: tool.readOnly };
	return {};
}

const clip = (s, n) => {
	const t = typeof s === "string" ? s.trim() : "";
	return t.length <= n ? t : t.slice(0, n - 1) + "…";
};
const listOf = (value, each = 120, max = 12) => {
	const arr = Array.isArray(value) ? value : typeof value === "string" && value.trim() !== "" ? value.split(/[;；\n]/) : [];
	return arr.map((x) => clip(String(x ?? ""), each)).filter((x) => x !== "").slice(0, max);
};

/**
 * 目录条目（E）：是什么 / 干什么、什么时候用、什么时候不要用（反例）、逐工具的补充说明。
 * 条目存在注册表的 `catalog` 字段里，随注册表走版本史。
 */
export function normalizeCatalog(input) {
	if (input === null || typeof input !== "object") return undefined;
	const out = {};
	const summary = clip(input.summary ?? input.what ?? "", 300);
	if (summary !== "") out.summary = summary;
	const useWhen = listOf(input.useWhen ?? input.whenToUse);
	if (useWhen.length > 0) out.useWhen = useWhen;
	const avoidWhen = listOf(input.avoidWhen ?? input.whenNotToUse);
	if (avoidWhen.length > 0) out.avoidWhen = avoidWhen;
	if (input.tools && typeof input.tools === "object") {
		const tools = {};
		for (const [name, spec] of Object.entries(input.tools).slice(0, 200)) {
			if (spec === null || typeof spec !== "object") continue;
			const use = clip(spec.use ?? spec.useWhen ?? "", 160);
			const avoid = clip(spec.avoid ?? spec.avoidWhen ?? "", 160);
			if (use !== "" || avoid !== "") tools[name] = { ...(use !== "" ? { use } : {}), ...(avoid !== "" ? { avoid } : {}) };
		}
		if (Object.keys(tools).length > 0) out.tools = tools;
	}
	return out;
}

/** 条目当前的目录内容（没写 catalog 时用 notes 兜底 summary）。 */
export function catalogOf(entry) {
	const c = normalizeCatalog(entry?.catalog) ?? {};
	const summary = c.summary ?? clip(entry?.notes ?? "", 300);
	return { summary, useWhen: c.useWhen ?? [], avoidWhen: c.avoidWhen ?? [], tools: c.tools ?? {}, authored: entry?.catalog !== undefined && entry?.catalog !== null };
}

/** 读写分级只认 read / write，别的值丢掉。 */
export function normalizeToolAccess(input) {
	if (input === null || typeof input !== "object") return undefined;
	const out = {};
	for (const [name, level] of Object.entries(input)) if (ACCESS_LEVELS.has(level)) out[name] = level;
	return out;
}

// ── 熔断 ─────────────────────────────────────────────────────────────────

export const DEFAULT_BREAKER_THRESHOLD = 3;
export const DEFAULT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * 每个 server 一份：closed（正常）→ 连续失败 threshold 次 → open（摘除，until 前直接拒绝）
 * → until 到点 → half-open（放一次试探）→ 成功 closed / 失败重新 open。
 * 只在内存里：DSH 重启即全部复位（重启本身就是一次「人工复位」）。
 */
export class CircuitBreaker {
	/** @param {{threshold?:number, cooldownMs?:number, now?:() => number, onTransition?:(name:string, info:object)=>void}} [options] */
	constructor(options = {}) {
		this.threshold = Number.isFinite(options.threshold) && options.threshold >= 1 ? Math.floor(options.threshold) : DEFAULT_BREAKER_THRESHOLD;
		this.cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs > 0 ? options.cooldownMs : DEFAULT_BREAKER_COOLDOWN_MS;
		this.now = typeof options.now === "function" ? options.now : () => Date.now();
		this.onTransition = options.onTransition;
		/** name → {state, failures, cause, openedAt, until, lastFailureAt, lastSuccessAt} */
		this.rows = new Map();
	}

	row(name) {
		let row = this.rows.get(name);
		if (row === undefined) {
			row = { state: "closed", failures: 0, cause: null, openedAt: null, until: null, lastFailureAt: null, lastSuccessAt: null };
			this.rows.set(name, row);
		}
		return row;
	}

	emit(name, row, cause) {
		try {
			this.onTransition?.(name, { state: row.state, cause, until: row.until === null ? null : new Date(row.until).toISOString(), failures: row.failures });
		} catch {
			/* 旁路 */
		}
	}

	/** 现在的状态；open 到点会就地转 half-open（并出一次迁移）。 */
	state(name) {
		const row = this.rows.get(name);
		if (row === undefined) return "closed";
		if (row.state === "open" && row.until !== null && this.now() >= row.until) {
			row.state = "half-open";
			this.emit(name, row, "cooldown-elapsed");
		}
		return row.state;
	}

	/** 这次调用放不放行。open → 拒绝；half-open / closed → 放行。 */
	allow(name) {
		const state = this.state(name);
		if (state !== "open") return { ok: true, state };
		const row = this.rows.get(name);
		return { ok: false, state, cause: row.cause, until: new Date(row.until).toISOString(), failures: row.failures };
	}

	success(name) {
		const row = this.rows.get(name);
		if (row === undefined) return;
		row.lastSuccessAt = this.now();
		const was = row.state;
		row.failures = 0;
		if (was !== "closed") {
			row.state = "closed";
			row.cause = null;
			row.openedAt = null;
			row.until = null;
			this.emit(name, row, "recovered");
		}
	}

	/** @param {string} cause 错误类（不含原文） */
	failure(name, cause = "error") {
		const row = this.row(name);
		row.lastFailureAt = this.now();
		row.failures += 1;
		row.cause = cause;
		const state = this.state(name);
		if (state === "half-open" || (state === "closed" && row.failures >= this.threshold)) {
			row.state = "open";
			row.openedAt = this.now();
			row.until = this.now() + this.cooldownMs;
			this.emit(name, row, cause);
		}
	}

	/** 手动复位（mcp_verify 成功 / 面板）。 */
	reset(name, cause = "manual") {
		const row = this.rows.get(name);
		if (row === undefined) return false;
		const was = row.state;
		row.failures = 0;
		row.state = "closed";
		row.cause = null;
		row.openedAt = null;
		row.until = null;
		if (was !== "closed") this.emit(name, row, cause);
		return was !== "closed";
	}

	forget(name) {
		this.rows.delete(name);
	}

	/** 可查询的快照（目录 / 路由 / mcp_list 用）。 */
	snapshot(name) {
		const state = this.state(name);
		const row = this.rows.get(name);
		const iso = (t) => (t === null || t === undefined ? null : new Date(t).toISOString());
		return {
			state,
			failures: row?.failures ?? 0,
			threshold: this.threshold,
			cause: row?.cause ?? null,
			openedAt: iso(row?.openedAt),
			until: iso(row?.until),
			lastFailureAt: iso(row?.lastFailureAt),
			lastSuccessAt: iso(row?.lastSuccessAt)
		};
	}
}
