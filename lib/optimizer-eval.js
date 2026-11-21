/**
 * G1 评估门：每个技能一份回归评估集（典型触发场景 + 期望行为），
 * 改前（基线）与改后（候选）在同一轮、同一模型下各打一次分；候选须
 *   - 平均分 ≥ 基线平均分 + gate.minDelta，且
 *   - 每条关键场景（critical）分数 ≥ 基线该条分数 − gate.criticalTolerance（零回退），且
 *   - 每条场景都拿到了分（缺分 = 不过）。
 * 不过即丢弃，原因逐条记进 discards.jsonl；没有旁路开关。
 *
 * 评估集存 `~/.dsh-studio/optimizer/evals/<技能名>.json`：第一次优化某技能时让模型依据**基线版本**
 * 出一份，落盘后冻结（后续轮次直接复用，所有者可以手工编辑 / 增删场景、改 critical 标记）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFile } from "./fs-atomic.js";
import { optimizerRoot } from "./optimizer-config.js";
import { callWithBudget, parseJsonObject } from "./optimizer-model.js";

export const EVAL_SCHEMA = 1;

export function sha256(text) {
	return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * 评估集文件名。纯 ASCII 安全名（`[\w.-]`）原样用——与既有文件一一对应；其余一律「可读前缀 + 名字的哈希」。
 * 旧写法把每一串非 `[\w.-]` 字符折成一个 `_`：「数据分析」和「周报生成」都落到 `evals/_.json`，
 * `a/b` 和 `a b` 都落到 `a_b.json`，后来的技能拿着别人的场景过门。
 */
function safeName(name) {
	const text = String(name);
	if (/^[\w.-]{1,120}$/.test(text) && !/^\.+$/.test(text)) return text;
	const prefix = text.replace(/[^\w.-]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 60);
	return (prefix === "" ? "skill" : prefix) + "-" + sha256(text).slice(0, 12);
}

export function evalFile(name) {
	return join(optimizerRoot(), "evals", safeName(name) + ".json");
}

function normalizeCases(list) {
	if (!Array.isArray(list)) return [];
	const out = [];
	const seen = new Set();
	for (const [i, c] of list.entries()) {
		if (!c || typeof c !== "object") continue;
		const scenario = String(c.scenario ?? c.prompt ?? "").trim();
		const expect = String(c.expect ?? c.expected ?? "").trim();
		if (scenario === "" || expect === "") continue;
		let id = String(c.id ?? `c${i + 1}`).trim().replace(/[^\w-]+/g, "_") || `c${i + 1}`;
		while (seen.has(id)) id += "_";
		seen.add(id);
		out.push({ id, scenario: scenario.slice(0, 600), expect: expect.slice(0, 600), critical: c.critical === true });
	}
	return out;
}

export async function loadEvalSet(name) {
	try {
		const parsed = JSON.parse(await readFile(evalFile(name), "utf8"));
		// 文件里记的技能名对不上 = 这份评估集是别的技能的（历史上的文件名碰撞）：当没有，重新生成
		if (typeof parsed?.skill === "string" && parsed.skill !== "" && parsed.skill !== String(name)) return null;
		const cases = normalizeCases(parsed?.cases);
		if (cases.length === 0) return null;
		return { ...parsed, cases };
	} catch {
		return null;
	}
}

/**
 * 用模型依据基线版本生成评估集并落盘冻结。至少保留 1 条 critical（没标就把第一条标上）。
 * persist=false：只在内存里用、不落盘（同名的另一份技能已经占着 evals/<名字>.json 时，· A3）。
 */
export async function generateEvalSet({ model, budget, name, key, baseline, count, maxOutputTokens, persist = true }) {
	const system = "你是技能（SKILL.md）回归测试设计者。只输出 JSON。";
	const prompt = [
		`下面是技能「${name}」的当前版本。请为它设计 ${count} 条回归评估场景：每条是一个会触发这个技能的典型用户请求（scenario），`,
		"以及按这个技能执行时**应当出现的行为**（expect，可检查、具体）。把最核心、绝不能退化的场景标 critical:true（至少 1 条）。",
		'输出格式：{"cases":[{"id":"c1","scenario":"…","expect":"…","critical":true}]}',
		"",
		"<skill>",
		baseline,
		"</skill>"
	].join("\n");
	const text = await callWithBudget(model, budget, { purpose: "cases", system, prompt, maxTokens: maxOutputTokens, meta: { name, skillText: baseline, count } });
	const cases = normalizeCases(parseJsonObject(text)?.cases).slice(0, Math.max(1, count));
	if (cases.length === 0) throw new Error("模型没有给出可用的评估场景");
	if (!cases.some((c) => c.critical)) cases[0].critical = true;
	const set = { v: EVAL_SCHEMA, skill: name, key, createdAt: new Date().toISOString(), createdFrom: sha256(baseline), generatedBy: "model", cases };
	if (persist === false) return { ...set, transient: true };
	await mkdir(join(optimizerRoot(), "evals"), { recursive: true });
	await atomicWriteFile(evalFile(name), JSON.stringify(set, null, 2) + "\n", "utf8");
	return set;
}

/**
 * 让模型按评估集给一份技能文本打分（一次调用评全部场景）。
 * @returns {Promise<{mean:number, cases:Array<{id:string, score:number|null, critical:boolean, reason:string}>}>}
 */
export async function scoreSkill({ model, budget, name, text, evalSet, maxOutputTokens, label }) {
	const system = "你是严格的技能评审。只依据给出的 SKILL.md 判断：一个照它办事的助手在每个场景里能否做出期望行为。只输出 JSON。";
	const prompt = [
		`技能「${name}」的一个版本如下。对每个场景打 0–10 分（10 = 照这份技能一定能做到期望行为；0 = 做不到或会做错），附一句理由。`,
		'输出格式：{"scores":[{"id":"c1","score":7,"reason":"…"}]}',
		"",
		"<skill>",
		text,
		"</skill>",
		"",
		"<cases>",
		...evalSet.cases.map((c) => `- id=${c.id}${c.critical ? "（关键）" : ""}\n  场景：${c.scenario}\n  期望：${c.expect}`),
		"</cases>"
	].join("\n");
	const raw = await callWithBudget(model, budget, { purpose: "judge", system, prompt, maxTokens: maxOutputTokens, meta: { name, skillText: text, cases: evalSet.cases, label } });
	const parsed = parseJsonObject(raw);
	const byId = new Map();
	for (const s of Array.isArray(parsed?.scores) ? parsed.scores : []) {
		const value = s?.score;
		// 兼容非空数字字符串，但 null / 布尔值 / 空白不是模型评分。
		if (typeof value !== "number" && !(typeof value === "string" && value.trim() !== "")) continue;
		const score = Number(value);
		if (s && typeof s.id === "string" && Number.isFinite(score)) byId.set(s.id, { score: Math.min(10, Math.max(0, score)), reason: String(s.reason ?? "").slice(0, 200) });
	}
	const cases = evalSet.cases.map((c) => ({ id: c.id, critical: c.critical, score: byId.get(c.id)?.score ?? null, reason: byId.get(c.id)?.reason ?? "" }));
	const scored = cases.filter((c) => c.score !== null);
	const mean = scored.length === 0 ? 0 : Math.round((scored.reduce((n, c) => n + c.score, 0) / cases.length) * 1000) / 1000;
	return { mean, cases };
}

/**
 * 硬门判定。
 *
 * 基线也必须是完整的：基线评分被截断 / 解析不了时 scoreSkill 给的是「均分 0、各场景 null」，
 * 旧写法只查候选缺分、关键场景遇到基线 null 直接跳过——于是每个场景只得 1 分的候选也能「高于基线」过门并被自动应用。
 * options.absoluteLine：基线不是打出来的分而是一条绝对线（蒸馏新技能没有基线，非关键场景故意留 null），这时不查基线缺分。
 * @param {{absoluteLine?: boolean}} [options]
 * @returns {{pass:boolean, reasons:string[]}}
 */
export function gateVerdict(baseline, candidate, gate, options = {}) {
	const reasons = [];
	const missing = candidate.cases.filter((c) => c.score === null).map((c) => c.id);
	if (missing.length > 0) reasons.push(`场景缺分：${missing.join("、")}`);
	if (options.absoluteLine !== true) {
		const ids = new Set(baseline.cases.map((c) => c.id));
		const baseMissing = [...baseline.cases.filter((c) => c.score === null).map((c) => c.id), ...candidate.cases.filter((c) => !ids.has(c.id)).map((c) => c.id)];
		if (baseMissing.length > 0) reasons.push(`基线缺分（基线评分不完整，无从比较）：${[...new Set(baseMissing)].join("、")}`);
	}
	if (candidate.mean < baseline.mean + gate.minDelta) reasons.push(`平均分 ${candidate.mean} < 基线 ${baseline.mean}${gate.minDelta ? ` + ${gate.minDelta}` : ""}`);
	const base = new Map(baseline.cases.map((c) => [c.id, c]));
	for (const c of candidate.cases) {
		if (!c.critical) continue;
		const b = base.get(c.id);
		if (b === undefined || b.score === null || c.score === null) continue;
		if (c.score < b.score - gate.criticalTolerance) reasons.push(`关键场景 ${c.id} 回退：${b.score} → ${c.score}`);
	}
	return { pass: reasons.length === 0, reasons };
}
