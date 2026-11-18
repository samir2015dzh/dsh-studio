/**
 * 技能自动优化回路的配置：默认值、合并规则、落盘位置。
 *
 * 三层合并（后者覆盖前者，逐字段）：
 *   1. 本文件的 OPTIMIZER_DEFAULTS（保守：自动轮次关闭、只在闲时、上限很低）；
 *   2. 插件配置行里的 `optimizer: {...}`（cordis composition row，与 telemetry / mcp 同级）；
 *   3. `~/.dsh-studio/optimizer/config.json`（可选；所有者可直接编辑，或走面板路由 POST /optimizer/config）。
 *
 * 红线（权限 / 安全段落）**不在这里**：内置清单在 lib/skill-redlines.js 的 BUILTIN_REDLINES，
 * 配置只能往上追加（redlines.extra*），不能删减内置项。
 *
 * 数据目录刻意放在 `.dsh` 之外（与版本史同理：.dsh 整个被清空过），
 * 默认 `~/.dsh-studio/optimizer/`，可用环境变量 DSH_STUDIO_OPTIMIZER_DIR 改位置。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const OPTIMIZER_DEFAULTS = Object.freeze({
	/** 自动轮次总开关。默认关：不开就只有所有者手动 skillmgr_optimize_run / 面板「立即跑一轮」。 */
	enabled: false,
	/** 闲时窗口（本机本地时间，HH:MM，可跨午夜）。自动轮次只在窗口内启动。 */
	idleWindow: { start: "02:00", end: "06:00" },
	/** 距最近一次会话活动（回合开始 / 结束）至少多少分钟才算「闲」。 */
	idleMinutes: 30,
	/** 两轮自动优化之间至少隔多少小时。 */
	minIntervalHours: 20,
	/** 定时器多久看一次「该不该跑」（分钟）。 */
	checkEveryMinutes: 10,
	/** 每轮的成本 / 时长上限：任何一项超了立即停轮并在报告里写明。 */
	limits: Object.freeze({
		/** 每轮最多优化几个技能 */
		maxSkills: 1,
		/** 达尔文迭代代数（每代在当前最优上再变异） */
		generations: 2,
		/** 每代变异几个（第 1 个只许改措辞 / 示例 / 顺序，第 2 个起允许结构改动） */
		population: 2,
		/** 每轮最多调几次模型（出评估集 + 基线打分 + 每个变异 2 次） */
		maxModelCalls: 12,
		/** 每轮 token 上限（输入 + 输出；宿主没报 usage 时按字符数 / 4 估算） */
		maxTokens: 40000,
		/** 每轮时长上限（毫秒）；进行中的模型调用到点直接放弃 */
		maxDurationMs: 5 * 60_000,
		/** 单次模型调用的输出上限 */
		maxOutputTokens: 4000
	}),
	/** 候选挑选：只看遥测里有数据的技能。 */
	selection: Object.freeze({
		/** 看最近几周的遥测（1–13） */
		weeks: 2,
		/** 触发 + 注入至少几次才进候选 */
		minUses: 3,
		/** 失败率加权：分数 = 使用次数 × (1 + failureWeight × 失败率) */
		failureWeight: 10,
		/** 永不进自动优化的技能名 */
		exclude: Object.freeze(["darwin-skill"])
	}),
	/** G1 评估门。 */
	gate: Object.freeze({
		/** 候选平均分须 ≥ 基线平均分 + minDelta（默认 0 = 不低于基线） */
		minDelta: 0,
		/** 关键场景（critical）每一条的分数都不许低于基线 − criticalTolerance（默认 0 = 零回退） */
		criticalTolerance: 0,
		/** 只有比基线严格更好（> minGain）才真正改动；持平记 no-gain 丢弃，避免无意义改写 */
		minGain: 0,
		/** 长度护栏：候选正文长度 / 基线长度须落在 [min, max]（挡掉「整段删光」「灌水」型劣化） */
		minLengthRatio: 0.5,
		maxLengthRatio: 2.0,
		/** 新建评估集时让模型出几条场景 */
		casesPerSkill: 4
	}),
	/** G3 自治分级。kind → 分级；没列出的 kind 一律按结构性处理（保守）。 */
	autonomy: Object.freeze({
		/** 低风险改动过门后是否自动应用（关掉 = 一切都只出提案） */
		autoApplyLowRisk: true,
		lowRisk: Object.freeze(["wording", "example", "order", "format"]),
		structural: Object.freeze(["steps", "trigger", "tools", "sections", "frontmatter"]),
		/** 这些 frontmatter 键的任何变化都算「改触发条件」 */
		triggerKeys: Object.freeze(["when_to_use", "whenToUse", "when-to-use", "triggers", "trigger", "keywords", "paths", "globs", "arguments", "argument-hint"]),
		/** description 改动的字符二元组相似度 ≥ 此值算「措辞润色」，低于算「改触发条件」 */
		descriptionSimilarity: 0.5
	}),
	/**
	 * ：自动应用之后的回归监测。自动应用落地时记下应用前的评估结果与版本指针，之后每轮优化开头复评；
	 * 复评按 G1 评估门同一口径（gate）跟应用前比，不过门 = 退化 → 自动回滚到应用前版本，该技能此后不再自动应用。
	 */
	regression: Object.freeze({
		/** 关掉 = 自动应用后不复评（不推荐） */
		enabled: true,
		/** 连续这么多轮复评都没退化就结束观察 */
		checks: 2
	}),
	/** 红线追加项（内置项见 lib/skill-redlines.js，不可删减）。 */
	redlines: Object.freeze({ extraFrontmatterKeys: Object.freeze([]), extraHeadingPatterns: Object.freeze([]), extraLinePatterns: Object.freeze([]) }),
	/** 模型路由：留空 = 跟随提取器配置 / 当前会话 / DSH 默认（与提取器同一套口径） */
	provider: "",
	model: "",
	/** 只在这些根下找技能文件；留空 = ~/.dsh/skills 与 ~/.agents/skills（DSH_AGENTS_HOME 生效） */
	roots: Object.freeze([])
});

export function optimizerRoot() {
	const override = typeof process.env.DSH_STUDIO_OPTIMIZER_DIR === "string" ? process.env.DSH_STUDIO_OPTIMIZER_DIR.trim() : "";
	if (override !== "") return resolve(override);
	return resolve(homedir(), ".dsh-studio", "optimizer");
}

export function optimizerConfigFile() {
	return join(optimizerRoot(), "config.json");
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 逐字段深合并：只接受与默认值同类型的值（数字须有限、≥0），其它忽略。 */
export function mergeInto(base, patch) {
	if (!isObj(patch)) return base;
	const out = { ...base };
	for (const [key, def] of Object.entries(base)) {
		if (!Object.hasOwn(patch, key)) continue;
		const value = patch[key];
		if (isObj(def)) out[key] = mergeInto(def, value);
		else if (Array.isArray(def)) {
			if (Array.isArray(value)) out[key] = value.filter((x) => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
		} else if (typeof def === "number") {
			const n = Number(value);
			if (Number.isFinite(n) && n >= 0) out[key] = n;
		} else if (typeof def === "boolean") {
			if (typeof value === "boolean") out[key] = value;
		} else if (typeof def === "string") {
			if (typeof value === "string") out[key] = value.trim();
		}
	}
	return out;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** 合并三层配置。返回 {config, sources}，sources 说明每层是否生效（给 status 看）。 */
export function resolveOptimizerConfig(pluginConfig, fileConfig) {
	let config = mergeInto(structuredClone(plain(OPTIMIZER_DEFAULTS)), pluginConfig);
	config = mergeInto(config, fileConfig);
	if (!HHMM.test(config.idleWindow.start)) config.idleWindow.start = OPTIMIZER_DEFAULTS.idleWindow.start;
	if (!HHMM.test(config.idleWindow.end)) config.idleWindow.end = OPTIMIZER_DEFAULTS.idleWindow.end;
	config.limits.maxSkills = Math.max(1, Math.floor(config.limits.maxSkills));
	config.limits.generations = Math.max(1, Math.floor(config.limits.generations));
	config.limits.population = Math.max(1, Math.floor(config.limits.population));
	config.selection.weeks = Math.min(13, Math.max(1, Math.floor(config.selection.weeks)));
	config.gate.casesPerSkill = Math.min(12, Math.max(1, Math.floor(config.gate.casesPerSkill)));
	config.regression.checks = Math.min(20, Math.max(1, Math.floor(config.regression.checks)));
	return { config, sources: { defaults: true, plugin: isObj(pluginConfig), file: isObj(fileConfig) } };
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 读 ~/.dsh-studio/optimizer/config.json；不存在 / 坏文件返回 null（坏文件同时给出错误文案）。 */
export async function readOptimizerConfigFile() {
	let text;
	try {
		text = await readFile(optimizerConfigFile(), "utf8");
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

/** 现在是否落在闲时窗口里（本地时间；start > end 表示跨午夜）。 */
export function inIdleWindow(window, at = Date.now()) {
	const d = new Date(at);
	const minutes = d.getHours() * 60 + d.getMinutes();
	const parse = (s) => {
		const m = HHMM.exec(String(s));
		return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
	};
	const start = parse(window?.start);
	const end = parse(window?.end);
	if (start === end) return false;
	return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
