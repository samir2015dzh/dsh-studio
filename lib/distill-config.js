/**
 * 对话蒸馏硬化的配置：默认值、落盘位置。
 *
 * 三层合并（后者逐字段覆盖前者，类型不对的值忽略）：
 *   1. DISTILL_DEFAULTS（保守：闲时批量关闭、上限很低）；
 *   2. 插件配置行 `distill: {...}`；
 *   3. `~/.dsh-studio/distill/config.json`（可选）。
 *
 * 蒸馏产物**一律先成草稿**（存在本目录，不在任何技能根里，模型调不到）；只有过了 #3 评估门才写进技能库，
 * 与库里高度相似的不新建，走的合并提案（所有者批准）。评估门没有旁路开关。
 *
 * 数据目录：~/.dsh-studio/distill/（环境变量 DSH_STUDIO_DISTILL_DIR 可改）。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mergeInto } from "./optimizer-config.js";

export const DISTILL_DEFAULTS = Object.freeze({
	/** 闲时批量过门的总开关（默认关：草稿只排队，等手动 skillmgr_distill_run / 面板） */
	enabled: false,
	idleWindow: Object.freeze({ start: "02:00", end: "06:00" }),
	idleMinutes: 30,
	/** 两次闲时批量至少隔多少小时 */
	minIntervalHours: 24,
	checkEveryMinutes: 10,
	/** 每批上限：任何一项到顶即停批，剩下的草稿留在队列里 */
	limits: Object.freeze({
		/** 每批最多处理几份草稿（过门约 2 次模型调用；走合并提案约 5–7 次） */
		maxDrafts: 3,
		maxModelCalls: 12,
		maxTokens: 40000,
		maxDurationMs: 5 * 60_000,
		maxOutputTokens: 4000
	}),
	/** 评估门（与 #3 同一个 gateVerdict）：新技能没有基线，用绝对线当基线 */
	gate: Object.freeze({
		/** 平均分（0–10）不得低于此值 */
		minMean: 7,
		/** 关键场景单项不得低于此值 */
		minCritical: 6,
		/** 评估场景条数（由来源会话的真实请求 + 草稿生成，冻结在 #3 的评估集目录里） */
		cases: 4
	}),
	/** 先查重：与库里某份技能的相似度（#4 findSimilar 口径）≥ 此值 → 不新建，出合并提案 */
	dedupe: Object.freeze({ minScore: 0.55 }),
	/** 队列里最多排多少份草稿（超了新草稿不收，记一条淘汰记录） */
	maxQueued: 50
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function distillRoot() {
	const override = typeof process.env.DSH_STUDIO_DISTILL_DIR === "string" ? process.env.DSH_STUDIO_DISTILL_DIR.trim() : "";
	return override !== "" ? resolve(override) : resolve(homedir(), ".dsh-studio", "distill");
}

export function distillConfigFile() {
	return join(distillRoot(), "config.json");
}

export function resolveDistillConfig(pluginConfig, fileConfig) {
	let config = mergeInto(JSON.parse(JSON.stringify(DISTILL_DEFAULTS)), pluginConfig);
	config = mergeInto(config, fileConfig);
	if (!HHMM.test(config.idleWindow.start)) config.idleWindow.start = DISTILL_DEFAULTS.idleWindow.start;
	if (!HHMM.test(config.idleWindow.end)) config.idleWindow.end = DISTILL_DEFAULTS.idleWindow.end;
	for (const k of ["maxDrafts", "maxModelCalls"]) config.limits[k] = Math.max(0, Math.floor(config.limits[k]));
	config.gate.cases = Math.min(10, Math.max(1, Math.floor(config.gate.cases)));
	config.gate.minMean = Math.min(10, Math.max(0, config.gate.minMean));
	config.gate.minCritical = Math.min(10, Math.max(0, config.gate.minCritical));
	config.dedupe.minScore = Math.min(1, Math.max(0.05, config.dedupe.minScore));
	config.maxQueued = Math.max(1, Math.floor(config.maxQueued));
	return { config, sources: { defaults: true, plugin: isObj(pluginConfig), file: isObj(fileConfig) } };
}

export async function readDistillConfigFile() {
	let text;
	try {
		text = await readFile(distillConfigFile(), "utf8");
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
