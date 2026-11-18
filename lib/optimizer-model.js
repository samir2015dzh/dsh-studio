/**
 * 优化回路的模型接口与预算。
 *
 * 模型接口只有一个方法：
 *   model.complete({purpose, system, prompt, maxTokens, timeoutMs, meta}) → Promise<{text, usage?}>
 * 生产实现 createHostModel() 接宿主 `ctx.llm`（cordis 注入的 llm 服务：prepareCall → stream），
 * 路由口径与提取器完全一致（lib/extractor.js callLLMDetailed）；拿不到 ctx.llm 时回落到提取器的 HTTP 配置。
 * 测试一律注入假模型（purpose / meta 就是给假模型看的：mutate | judge | cases），离线、确定。
 *
 * 预算：每轮一个 budget；每次调模型前查「次数 / token / 时长」三项，任何一项到顶抛 BudgetStop，
 * 整轮停下并在报告里写明是哪一项、用了多少。进行中的调用到时长上限直接放弃（Promise.race）。
 */
import { callLLMDetailed } from "./extractor.js";

export class BudgetStop extends Error {
	constructor(cause, detail) {
		super(`本轮已到上限（${cause}）：${detail}`);
		this.name = "BudgetStop";
		this.limit = cause;
		this.detail = detail;
	}
}

/** usage → 计费 token（输入 + 缓存读写 + 输出；reasoningTokens 已含在 output 里，不重复加）。 */
export function usageTokens(usage) {
	if (!usage || typeof usage !== "object") return null;
	const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
	const total = n(usage.inputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens) + n(usage.outputTokens);
	return total > 0 ? total : null;
}

/**
 * @param {{maxModelCalls:number, maxTokens:number, maxDurationMs:number}} limits
 * @param {() => number} [now]
 */
export function createBudget(limits, now = () => Date.now()) {
	const startedAt = now();
	const used = { calls: 0, tokens: 0, estimatedTokens: 0 };
	const elapsed = () => now() - startedAt;
	const remainingMs = () => Math.max(0, limits.maxDurationMs - elapsed());
	function check() {
		if (elapsed() >= limits.maxDurationMs) throw new BudgetStop("duration", `已用 ${elapsed()} ms ≥ 上限 ${limits.maxDurationMs} ms`);
		if (used.tokens >= limits.maxTokens) throw new BudgetStop("tokens", `已用 ${used.tokens} token ≥ 上限 ${limits.maxTokens}`);
		if (used.calls >= limits.maxModelCalls) throw new BudgetStop("calls", `已调 ${used.calls} 次模型 ≥ 上限 ${limits.maxModelCalls}`);
	}
	return {
		limits,
		check,
		remainingMs,
		elapsed,
		charge(usage, fallbackChars) {
			used.calls += 1;
			const exact = usageTokens(usage);
			if (exact !== null) used.tokens += exact;
			else {
				const est = Math.ceil(Math.max(0, fallbackChars) / 4);
				used.tokens += est;
				used.estimatedTokens += est;
			}
		},
		snapshot() {
			return { calls: used.calls, tokens: used.tokens, estimatedTokens: used.estimatedTokens, ms: elapsed(), limits: { ...limits } };
		}
	};
}

/**
 * 在预算内调一次模型。调用前查预算；调用本身与「剩余时长」赛跑，超时抛 BudgetStop("duration")。
 * @returns {Promise<string>} 模型文本
 */
export async function callWithBudget(model, budget, request) {
	budget.check();
	const remaining = budget.remainingMs();
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new BudgetStop("duration", `模型调用进行中触到时长上限 ${budget.limits.maxDurationMs} ms，已放弃这次调用`)), remaining);
		timer.unref?.();
	});
	let result;
	try {
		result = await Promise.race([Promise.resolve(model.complete({ ...request, timeoutMs: remaining })), timeout]);
	} catch (error) {
		if (error instanceof BudgetStop) budget.charge(null, String(request.prompt ?? "").length);
		throw error;
	} finally {
		clearTimeout(timer);
	}
	const text = typeof result === "string" ? result : String(result?.text ?? "");
	budget.charge(typeof result === "object" ? result?.usage : null, String(request.prompt ?? "").length + String(request.system ?? "").length + text.length);
	return text;
}

/**
 * 宿主模型：ctx.llm（prepareCall + stream）优先，没有就走提取器配置里的 HTTP 端点。
 * @param {{llm?: object|null, agent?: () => object|null, routeConfig: () => Promise<object>}} deps
 */
export function createHostModel(deps) {
	return {
		kind: deps.llm ? "dsh-llm" : "http",
		async complete({ system, prompt, maxTokens = 4000, timeoutMs = 120000 }) {
			const cfg = await deps.routeConfig();
			const res = await callLLMDetailed(cfg, prompt, { llm: deps.llm ?? null, agent: deps.agent?.() ?? null, system, maxTokens, timeoutMs: Math.max(1000, Math.min(timeoutMs, 180000)) });
			return { text: res.text, usage: res.usage, route: { provider: res.provider, model: res.model } };
		}
	};
}

/** 从模型输出里取第一个括号配平的 JSON 对象（容忍 ```json 围栏与前后废话）。 */
export function parseJsonObject(text) {
	const s = String(text ?? "");
	const start = s.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(s.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/** 取 <tag>…</tag> 之间的内容（变异输出用标签而不是 JSON：整份 SKILL.md 塞进 JSON 字符串太容易转义出错）。 */
export function extractTag(text, tag) {
	const m = new RegExp("<" + tag + ">\\n?([\\s\\S]*?)\\n?</" + tag + ">", "i").exec(String(text ?? ""));
	return m ? m[1] : null;
}
