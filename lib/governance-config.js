/**
 * 技能库治理的配置：默认值、合并规则、落盘位置。
 *
 * 三层合并（后者逐字段覆盖前者，类型不对的值忽略）：
 *   1. GOVERNANCE_DEFAULTS（保守：自动轮次关闭、只在闲时、上限很低、一切只出提案 / 报告）；
 *   2. 插件配置行 `governance: {...}`；
 *   3. `~/.dsh-studio/governance/config.json`（可选）。
 *
 * 治理**没有任何自动写技能的路径**：合并 / 教训补丁一律是提案，所有者批准后才按 #1 版本化写入；
 * 冲突只报告。红线沿用 #3 的清单（lib/skill-redlines.js + optimizer.redlines 追加项）。
 *
 * 数据目录：~/.dsh-studio/governance/（环境变量 DSH_STUDIO_GOVERNANCE_DIR 可改）。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mergeInto } from "./optimizer-config.js";

export const GOVERNANCE_DEFAULTS = Object.freeze({
	/** 闲时自动轮次总开关（默认关：只有手动 skillmgr_governance_run / 面板） */
	enabled: false,
	idleWindow: Object.freeze({ start: "02:00", end: "06:00" }),
	idleMinutes: 30,
	/** 两轮自动治理至少隔多少小时（默认一周） */
	minIntervalHours: 168,
	checkEveryMinutes: 10,
	/** 新增技能 / 新版本落地时做增量冲突检查（只读、不调模型；只写冲突报告） */
	incrementalConflicts: true,
	/** 每轮上限：任何一项到顶即停轮并在报告里写明 */
	limits: Object.freeze({
		/** 每轮最多出几份合并提案（每份要调模型出合并稿 + 评估预演） */
		maxMergeProposals: 1,
		/** 每轮最多出几份教训补丁提案 */
		maxLessonProposals: 2,
		/** 两两比较的技能对上限（库很大时只比前 N 对） */
		maxPairs: 2000,
		maxModelCalls: 8,
		maxTokens: 40000,
		maxDurationMs: 5 * 60_000,
		maxOutputTokens: 4000
	}),
	/** R6 合并候选 */
	merge: Object.freeze({
		/** 综合分 ≥ 此值才算候选 */
		minScore: 0.5,
		/** 内容相似度（触发 / 步骤骨架 / 工具集）与遥测（同会话共触发）的权重 */
		weights: Object.freeze({ trigger: 0.4, steps: 0.25, tools: 0.2, coTrigger: 0.15 }),
		/** 看最近几周遥测 */
		weeks: 4
	}),
	/** G7 冲突检测 */
	conflicts: Object.freeze({
		/** 触发描述相似度 ≥ 此值算「触发重叠」 */
		triggerOverlap: 0.45,
		/** 一正一反两条指令的对象相似度 ≥ 此值算「矛盾」 */
		contradiction: 0.5
	}),
	/** G8 教训 */
	lessons: Object.freeze({
		/** 遥测失败至少几次才成一条教训（#3 丢弃 / 放行记录、所有者裁决过的冲突 1 次即可） */
		minTelemetryFailures: 2,
		weeks: 4,
		/** 一条教训最多引用多少条来源事件（计数照常累加） */
		maxCitations: 20
	}),
	/** 展示未用报告：看最近几周 */
	unused: Object.freeze({ weeks: 4 }),
	/** 只看这些技能根（空 = $DSH_HOME/skills 与 ~/.agents/skills，与 #3 相同） */
	roots: Object.freeze([]),
	/** 永不进治理候选的技能名 */
	exclude: Object.freeze(["darwin-skill"])
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function governanceRoot() {
	const override = typeof process.env.DSH_STUDIO_GOVERNANCE_DIR === "string" ? process.env.DSH_STUDIO_GOVERNANCE_DIR.trim() : "";
	return override !== "" ? resolve(override) : resolve(homedir(), ".dsh-studio", "governance");
}

export function governanceConfigFile() {
	return join(governanceRoot(), "config.json");
}

export function resolveGovernanceConfig(pluginConfig, fileConfig) {
	let config = mergeInto(JSON.parse(JSON.stringify(GOVERNANCE_DEFAULTS)), pluginConfig);
	config = mergeInto(config, fileConfig);
	if (!HHMM.test(config.idleWindow.start)) config.idleWindow.start = GOVERNANCE_DEFAULTS.idleWindow.start;
	if (!HHMM.test(config.idleWindow.end)) config.idleWindow.end = GOVERNANCE_DEFAULTS.idleWindow.end;
	for (const k of ["maxMergeProposals", "maxLessonProposals", "maxPairs", "maxModelCalls"]) config.limits[k] = Math.max(0, Math.floor(config.limits[k]));
	config.merge.weeks = Math.min(13, Math.max(1, Math.floor(config.merge.weeks)));
	config.lessons.weeks = Math.min(13, Math.max(1, Math.floor(config.lessons.weeks)));
	config.unused.weeks = Math.min(13, Math.max(1, Math.floor(config.unused.weeks)));
	return { config, sources: { defaults: true, plugin: isObj(pluginConfig), file: isObj(fileConfig) } };
}

export async function readGovernanceConfigFile() {
	let text;
	try {
		text = await readFile(governanceConfigFile(), "utf8");
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
