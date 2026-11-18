/**
 * 目录评测巡检：闲时拿**真实注册表**的目录条目跑 G5 场景集，结果归档；
 * 总命中率比上一次归档掉了超过阈值就出一份回退报告。**只报告**：不改注册表、不改目录条目。
 *
 *   场景集：默认随包的 lib/catalog-scenarios.json（与 scripts/catalog-eval.mjs / [E] 测试同一份），
 *           mcp.catalogEval.scenariosFile 可指到所有者自己的场景文件（只读它的 scenarios）。
 *   候选：  注册表里非 disabled 的 server，目录条目取 catalogOf(entry)（catalog / notes）+ 缓存的工具名，
 *           与 `catalog-eval.mjs --registry` 口径一致（registryCandidates 两边共用）。
 *   评测器：lib/catalog-select.js 的词面代理，衡量「目录条目写得够不够区分」，不是模型准确率；不调模型。
 *
 * 数据目录（刻意在 .dsh 之外）：~/.dsh-studio/catalog-eval/（环境变量 DSH_STUDIO_CATALOG_EVAL_DIR 可改）
 *   runs/<runId>.json     每次评测一份归档（逐条结果 + 场景集 / 目录指纹），按 keep 保留最近 N 份
 *   alerts/<runId>.md     回退报告（只在「同一场景集下总命中率掉了 > dropThreshold」时写）
 *   state.json            lastRunAt（自动轮次的间隔节流）
 *
 *   config.json           可选配置层：与优化 / 治理 / 蒸馏 / 备份包四处同构的三层合并——
 *                         默认值 → 插件配置 mcp.catalogEval → 本文件（后者逐字段覆盖前者，类型不对的值忽略）；
 *                         status 注明 enabled / idleWindow 各自生效于哪一层
 *
 * 自动轮次默认关（enabled=false）；开了也只在闲时窗口 + 空闲 ≥ idleMinutes + 两次间隔 ≥ minIntervalHours 时跑。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateScenarios } from "./catalog-select.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { catalogOf } from "./mcp-policy.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isLocalRequest } from "./guard.js";
import { inIdleWindow } from "./optimizer-config.js";
import { ErrorMsg, handle, text, writeJson } from "./route-util.js";

export const BUNDLED_SCENARIOS = resolve(dirname(fileURLToPath(import.meta.url)), "catalog-scenarios.json");

export const CATALOG_EVAL_DEFAULTS = Object.freeze({
	/** 自动巡检总开关。默认关：只有手动 mcp_catalog_eval {action:"run"} / 面板「立即评测」。 */
	enabled: false,
	/** 闲时窗口（本机本地时间 HH:MM，可跨午夜） */
	idleWindow: Object.freeze({ start: "02:00", end: "06:00" }),
	/** 距最近一次会话活动至少多少分钟才算闲 */
	idleMinutes: 30,
	/** 两次自动评测至少隔多少小时（默认一周一次） */
	minIntervalHours: 168,
	/** 定时器多久看一次「该不该跑」（分钟） */
	checkEveryMinutes: 30,
	/** 总命中率比上一份可比归档低多少（绝对值，0–1）就出回退报告 */
	dropThreshold: 0.05,
	/** 归档保留份数（回退报告同口径修剪） */
	keep: 30,
	/** 可选：所有者自己的场景文件（JSON，读其中 scenarios）；空 = 随包场景集 */
	scenariosFile: ""
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 一层配置叠到 base 上（默认 base = 默认值）：只收同类型、有限、非负的值。
 * 插件配置 mcp.catalogEval 与 config.json 都走这一个函数，口径一致。
 */
export function resolveCatalogEvalConfig(input, base = CATALOG_EVAL_DEFAULTS) {
	const c = { ...base, idleWindow: { ...base.idleWindow } };
	if (!isObj(input)) return c;
	if (typeof input.enabled === "boolean") c.enabled = input.enabled;
	if (isObj(input.idleWindow)) {
		if (HHMM.test(String(input.idleWindow.start))) c.idleWindow.start = input.idleWindow.start;
		if (HHMM.test(String(input.idleWindow.end))) c.idleWindow.end = input.idleWindow.end;
	}
	for (const key of ["idleMinutes", "minIntervalHours", "checkEveryMinutes", "dropThreshold", "keep"]) {
		const v = input[key];
		if (typeof v === "number" && Number.isFinite(v) && v >= 0) c[key] = v;
	}
	c.dropThreshold = Math.min(1, c.dropThreshold);
	c.keep = Math.max(1, Math.floor(c.keep));
	if (typeof input.scenariosFile === "string") c.scenariosFile = input.scenariosFile.trim();
	return c;
}

export function catalogEvalRoot() {
	const override = typeof process.env.DSH_STUDIO_CATALOG_EVAL_DIR === "string" ? process.env.DSH_STUDIO_CATALOG_EVAL_DIR.trim() : "";
	return override !== "" ? resolve(override) : resolve(homedir(), ".dsh-studio", "catalog-eval");
}

export function catalogEvalConfigFile() {
	return join(catalogEvalRoot(), "config.json");
}

/** 读 config.json：不存在 = 无此层；解析失败 / 不是对象 = 忽略并给出原因（与 governance / optimizer 同口径）。 */
export async function readCatalogEvalConfigFile() {
	let text;
	try {
		text = await readFile(catalogEvalConfigFile(), "utf8");
	} catch {
		return { value: null, error: null };
	}
	try {
		const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
		return isObj(parsed) ? { value: parsed, error: null } : { value: null, error: "config.json 不是 JSON 对象，已忽略" };
	} catch (error) {
		return { value: null, error: "config.json 解析失败，已忽略：" + (error instanceof Error ? error.message : String(error)) };
	}
}

const validBool = (layer, key) => isObj(layer) && typeof layer[key] === "boolean";
const validHHMM = (layer, key) => isObj(layer) && isObj(layer.idleWindow) && HHMM.test(String(layer.idleWindow[key]));

/**
 * 三层合并：默认值 → 插件配置 → config.json。返回生效配置 + 各层是否在 + 开关 / 窗口各自来自哪一层。
 * @returns {{config: object, sources: {defaults: true, plugin: boolean, file: boolean}, from: {enabled: string, idleWindow: string}}}
 */
export function resolveCatalogEvalLayers(pluginConfig, fileConfig) {
	const config = resolveCatalogEvalConfig(fileConfig, resolveCatalogEvalConfig(pluginConfig));
	const layerOf = (test) => (test(fileConfig) ? "file" : test(pluginConfig) ? "plugin" : "default");
	const startFrom = layerOf((l) => validHHMM(l, "start"));
	const endFrom = layerOf((l) => validHHMM(l, "end"));
	return {
		config,
		sources: { defaults: true, plugin: isObj(pluginConfig), file: isObj(fileConfig) },
		from: { enabled: layerOf((l) => validBool(l, "enabled")), idleWindow: startFrom === endFrom ? startFrom : `start:${startFrom}/end:${endFrom}` }
	};
}

const LAYER_LABEL = { file: "config.json", plugin: "插件配置 mcp.catalogEval", default: "默认值" };
const layerLabel = (from) => String(from).replace(/file|plugin|default/g, (m) => LAYER_LABEL[m]);

/** 注册表 servers → 评测候选（与 catalog-eval.mjs --registry 同口径）。 */
export function registryCandidates(servers) {
	return (Array.isArray(servers) ? servers : [])
		.filter((s) => s && typeof s.name === "string" && s.tier !== "disabled")
		.map((s) => {
			const c = catalogOf(s);
			return { name: s.name, summary: c.summary, useWhen: c.useWhen, avoidWhen: c.avoidWhen, tools: (s.tools ?? []).map((t) => t?.name).filter((n) => typeof n === "string") };
		});
}

const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const pct = (x) => (x * 100).toFixed(1) + "%";

async function readJson(file, fallback) {
	try {
		return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
	} catch {
		return fallback;
	}
}

/**
 * @param {{
 *   pluginConfig?: object,                         插件配置的 mcp.catalogEval
 *   loadRegistry: () => Promise<{servers: object[]}>, 读真实注册表（index 里传 McpStore.load）
 *   now?: () => number,
 *   logger?: object
 * }} options
 */
export function createCatalogWatch({ pluginConfig, loadRegistry, now = Date.now, logger } = {}) {
	/** 生效配置（每次现读 config.json：所有者 / Muse 改了文件不用重启 DSH）。 */
	async function effective() {
		const file = await readCatalogEvalConfigFile();
		const layers = resolveCatalogEvalLayers(pluginConfig, file.value);
		return { ...layers, configFile: catalogEvalConfigFile(), configError: file.error };
	}
	const config = async () => (await effective()).config;
	const dirs = { root: catalogEvalRoot, runs: () => join(catalogEvalRoot(), "runs"), alerts: () => join(catalogEvalRoot(), "alerts"), state: () => join(catalogEvalRoot(), "state.json") };
	let lastActivityAt = now();
	let lastCheckAt = 0;
	let lastCheckEveryMs = 0;
	let running = null;
	let seq = 0;

	async function loadScenarios(cfg) {
		const file = cfg.scenariosFile !== "" ? resolve(cfg.scenariosFile) : BUNDLED_SCENARIOS;
		const data = await readJson(file, null);
		if (!data || !Array.isArray(data.scenarios) || data.scenarios.length === 0) throw new Error("场景文件读不到或没有 scenarios：" + file);
		return { file, scenarios: data.scenarios };
	}

	async function listRuns() {
		let names = [];
		try {
			names = (await readdir(dirs.runs())).filter((n) => /^ce-[\w-]+\.json$/.test(n));
		} catch {
			return [];
		}
		return names.sort().reverse();
	}

	async function prune(keep) {
		const runs = await listRuns();
		for (const name of runs.slice(keep)) {
			await rm(join(dirs.runs(), name), { force: true });
			await rm(join(dirs.alerts(), name.replace(/\.json$/, ".md")), { force: true });
		}
	}

	function regressionReport(run, prev, regressed, threshold) {
		return [
			`# MCP 目录评测回退：${run.runId}`,
			"",
			`- 本次：总命中 ${run.hits}/${run.total} = ${pct(run.hitRate)}（正例 ${pct(run.positive.hitRate)}，反例 ${pct(run.negative.hitRate)}）`,
			`- 上次（${prev.runId}，${prev.at}）：${prev.hits}/${prev.total} = ${pct(prev.hitRate)}`,
			`- 下降 ${pct(prev.hitRate - run.hitRate)}，超过阈值 ${pct(threshold)}（mcp.catalogEval.dropThreshold）`,
			`- 目录指纹 ${prev.catalogSha} → ${run.catalogSha}；场景集 ${run.scenariosSha}（同一份）`,
			"",
			"由好变坏的场景：",
			...(regressed.length > 0 ? regressed.map((r) => `- ${r.id}：期望 ${r.expect ?? "（不用 MCP）"}，现在选 ${r.pick ?? "（不用 MCP）"}（${r.top.map((t) => t.name + " " + t.score).join("，")}）`) : ["- （逐条没有新增失败，是场景数变化导致的比例下降）"]),
			"",
			"只是报告：没有改注册表或目录条目。要调整目录条目走 mcp_register / 面板（写入出版本记录，可回滚）。"
		].join("\n");
	}

	async function doRun(trigger) {
		const cfg = await config();
		const t = now();
		const at = new Date(t).toISOString();
		const runId = "ce-" + at.replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + String(++seq).padStart(2, "0");
		const registry = await loadRegistry();
		const candidates = registryCandidates(registry?.servers);
		const { file, scenarios } = await loadScenarios(cfg);
		const report = evaluateScenarios(scenarios, candidates);
		const run = {
			v: 1,
			runId,
			at,
			trigger,
			scenariosFile: file,
			scenariosSha: sha(scenarios),
			catalogSha: sha(candidates),
			servers: candidates.map((c) => c.name),
			hits: report.hits,
			total: report.total,
			hitRate: report.hitRate,
			positive: report.positive,
			negative: report.negative,
			results: report.results
		};
		const runs = await listRuns();
		let prev = null;
		for (const name of runs) {
			const r = await readJson(join(dirs.runs(), name), null);
			if (r && r.scenariosSha === run.scenariosSha) {
				prev = r;
				break;
			}
		}
		let comparison;
		if (prev === null) comparison = { status: runs.length === 0 ? "first" : "scenarios-changed", note: runs.length === 0 ? "第一次归档，没有可比的上一次" : "场景集与以往归档不同，不做比较（避免把换场景当成回退）" };
		else {
			const drop = prev.hitRate - run.hitRate;
			comparison = { status: drop > cfg.dropThreshold ? "regressed" : "ok", previous: prev.runId, previousHitRate: prev.hitRate, drop: Number(drop.toFixed(4)), threshold: cfg.dropThreshold };
		}
		run.comparison = comparison;
		await mkdir(dirs.runs(), { recursive: true });
		await atomicWriteFile(join(dirs.runs(), runId + ".json"), JSON.stringify(run, null, 2) + "\n", "utf8");
		if (comparison.status === "regressed") {
			const before = new Map((prev.results ?? []).map((r) => [r.id, r.hit]));
			const regressed = run.results.filter((r) => !r.hit && before.get(r.id) === true);
			comparison.regressed = regressed.map((r) => r.id);
			comparison.alert = join(dirs.alerts(), runId + ".md");
			await mkdir(dirs.alerts(), { recursive: true });
			await atomicWriteFile(comparison.alert, regressionReport(run, prev, regressed, cfg.dropThreshold) + "\n", "utf8");
			await atomicWriteFile(join(dirs.runs(), runId + ".json"), JSON.stringify(run, null, 2) + "\n", "utf8");
			logger?.warn?.(`[dsh-studio] MCP 目录评测回退：${pct(prev.hitRate)} → ${pct(run.hitRate)}（报告 ${comparison.alert}）`);
		}
		await atomicWriteFile(dirs.state(), JSON.stringify({ lastRunAt: t, lastRunId: runId }, null, 2) + "\n", "utf8");
		await prune(cfg.keep);
		return run;
	}

	/** 跑一次（手动或自动）。同一时间只跑一个。 */
	async function run({ trigger = "manual" } = {}) {
		if (running !== null) return running;
		running = doRun(trigger).finally(() => {
			running = null;
		});
		return running;
	}

	/** 定时器每分钟调一次；自己按 checkEveryMinutes 节流，任何条件不满足直接返回（默认 enabled=false）。 */
	async function tick() {
		const t = now();
		// 审计 10：节流判断提到读配置（含 config.json）之前；读到新配置后按新值再判一次
		if (t - lastCheckAt < lastCheckEveryMs) return { ran: false, reason: "throttled" };
		const cfg = await config();
		lastCheckEveryMs = cfg.checkEveryMinutes * 60_000;
		if (t - lastCheckAt < lastCheckEveryMs) return { ran: false, reason: "throttled" };
		lastCheckAt = t;
		if (cfg.enabled !== true) return { ran: false, reason: "disabled" };
		if (!inIdleWindow(cfg.idleWindow, t)) return { ran: false, reason: "outside-window" };
		if (t - lastActivityAt < cfg.idleMinutes * 60_000) return { ran: false, reason: "busy" };
		const state = await readJson(dirs.state(), {});
		if (t - Number(state.lastRunAt || 0) < cfg.minIntervalHours * 3_600_000) return { ran: false, reason: "too-soon" };
		if (running !== null) return { ran: false, reason: "running" };
		const r = await run({ trigger: "auto" });
		return { ran: true, reason: "ok", runId: r.runId, status: r.comparison.status };
	}

	async function status({ limit = 10 } = {}) {
		const eff = await effective();
		const cfg = eff.config;
		const runs = [];
		for (const name of (await listRuns()).slice(0, limit)) {
			const r = await readJson(join(dirs.runs(), name), null);
			if (r) runs.push({ runId: r.runId, at: r.at, trigger: r.trigger, hits: r.hits, total: r.total, hitRate: r.hitRate, comparison: r.comparison, failed: (r.results ?? []).filter((x) => !x.hit).map((x) => x.id) });
		}
		const alerts = runs.filter((r) => r.comparison?.status === "regressed").map((r) => ({ runId: r.runId, file: r.comparison.alert, drop: r.comparison.drop }));
		return { dir: dirs.root(), config: cfg, configFile: eff.configFile, configError: eff.configError, sources: eff.sources, from: eff.from, inWindowNow: inIdleWindow(cfg.idleWindow, now()), runs, alerts };
	}

	return { run, tick, status, noteActivity: () => (lastActivityAt = now()), config, effective };
}

/** 状态的文本渲染（mcp_catalog_eval 用）。 */
export function renderCatalogEvalStatus(s) {
	const c = s.config;
	const lines = [
		`MCP 目录评测巡检：自动${c.enabled ? "已开启" : "未开启（默认关；只有手动 run）"}；闲时窗口 ${c.idleWindow.start}–${c.idleWindow.end}（现在${s.inWindowNow ? "在" : "不在"}窗口内），空闲 ≥ ${c.idleMinutes} 分钟、两次间隔 ≥ ${c.minIntervalHours} 小时；回退阈值 ${pct(c.dropThreshold)}，保留 ${c.keep} 份`,
		...(s.from ? [`生效来源：开关 ← ${layerLabel(s.from.enabled)}；闲时窗口 ← ${layerLabel(s.from.idleWindow)}（合并次序：默认值 → 插件配置 → config.json）`] : []),
		...(s.configFile ? [`配置文件：${s.configFile}${s.configError ? "（" + s.configError + "）" : s.sources?.file ? "" : "（不存在；写入 {\"enabled\": true, \"idleWindow\": {\"start\": \"19:00\", \"end\": \"07:00\"}} 即可开启，无需重启）"}`] : []),
		`归档目录：${s.dir}`
	];
	if (s.runs.length === 0) lines.push("还没有归档。");
	for (const r of s.runs) {
		const cmp = r.comparison?.status === "regressed" ? `↓ 回退 ${pct(r.comparison.drop)}（报告 ${r.comparison.alert}）` : r.comparison?.status === "ok" ? `比上次 ${r.comparison.drop > 0 ? "−" : "+"}${pct(Math.abs(r.comparison.drop))}` : r.comparison?.note ?? "";
		lines.push(`- ${r.runId} · ${r.trigger} · ${r.hits}/${r.total} = ${pct(r.hitRate)} · ${cmp}${r.failed.length > 0 ? " · 未命中：" + r.failed.join("、") : ""}`);
	}
	return lines.join("\n");
}

export const CATALOG_EVAL_API = {
	status: "/api/dsh-studio/mcp/catalog-eval",
	run: "/api/dsh-studio/mcp/catalog-eval/run"
};

const looseObject = { type: "object", additionalProperties: true };
const clean = (value) => JSON.parse(JSON.stringify(value ?? null));

/** 模型工具（1）：mcp_catalog_eval。只读注册表，只写自己的归档目录。 */
export function buildCatalogEvalTools({ watch }) {
	return [
		defineTool({
			name: "mcp_catalog_eval",
			description:
				"MCP 目录评测巡检（只报告）：action=status（默认）看最近几次归档与回退报告；action=run 立即用真实注册表的目录条目跑一遍 G5 场景集并归档，总命中率比上一份可比归档掉超过阈值时写回退报告。不改注册表、不改目录条目、不调模型。",
			parameters: {
				action: { type: "string", description: "status（默认）或 run" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						run: looseObject,
						status: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const action = typeof args?.action === "string" && args.action.trim() !== "" ? args.action.trim() : "status";
					if (action !== "status" && action !== "run") return { ok: false, message: "action 只能是 status 或 run" };
					let head = "";
					let run;
					if (action === "run") {
						const r = await watch.run({ trigger: "manual" });
						run = { runId: r.runId, hits: r.hits, total: r.total, hitRate: r.hitRate, comparison: r.comparison };
						head = `已评测并归档 ${r.runId}：${r.hits}/${r.total} = ${(r.hitRate * 100).toFixed(1)}%` + (r.comparison.status === "regressed" ? `；⚠ 比上次掉了 ${(r.comparison.drop * 100).toFixed(1)}%，回退报告 ${r.comparison.alert}` : "") + "\n\n";
					}
					const s = await watch.status();
					return clean({ ok: true, message: head + renderCatalogEvalStatus(s), ...(run ? { run } : {}), status: s });
				} catch (error) {
					return { ok: false, message: "目录评测失败：" + ErrorMsg(error) };
				}
			}
		})
	];
}

/** 面板路由（2）：GET 状态 / POST 立即评测。只认 loopback。 */
export function buildCatalogEvalRoutes(ctx, { watch }) {
	const guard = (req, res, method) => {
		if (!isLocalRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: "method not allowed: " + req.method });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: CATALOG_EVAL_API.status,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, clean(await watch.status()));
			})
		},
		{
			kind: "exact",
			path: CATALOG_EVAL_API.run,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				writeJson(res, 200, clean(await watch.run({ trigger: "manual" })));
			})
		}
	];
}
