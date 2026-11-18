/**
 * 目录选择的离线评测器。
 *
 * 真正做选择的是模型：它读系统提示里的 MCP 目录，决定调哪个 server（或一个都不调）。
 * 这里没有模型，只有一个**确定性的词面代理**：拿目录条目里的文字（是什么 / 何时用 / 工具名）
 * 和场景描述做词面重合打分，「何时别用」命中则扣分，最高分低于阈值判「不该用任何 MCP」。
 *
 * 它回答的问题是「目录条目写得够不够区分」：如果连词面重合都分不开两个 server、或者反例
 * 写了也拦不住，模型大概率也会选错。它**不是**模型选择准确率——PR 里明说，真实命中率要等
 * 真机遥测（catalog.outcome 的 shown/used）攒够了再看。
 *
 * 分词：ASCII 按词（≥2 字符），中日韩按相邻二字（bigram）。权重：IDF（在候选集合内算）。
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 文本 → 词元集合。 */
export function tokenize(text) {
	const out = new Set();
	const s = String(text ?? "").toLowerCase();
	for (const word of s.match(/[a-z0-9]{2,}/g) ?? []) out.add(word);
	let run = "";
	const flush = () => {
		for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
		run = "";
	};
	for (const ch of s) {
		if (CJK.test(ch)) run += ch;
		else flush();
	}
	flush();
	return out;
}

/**
 * @typedef {{name: string, summary?: string, useWhen?: string[], avoidWhen?: string[], tools?: string[]}} CatalogCandidate
 */

function docsOf(candidate) {
	const toolWords = (candidate.tools ?? []).map((t) => String(t).replace(/[_\-.]+/g, " ")).join(" ");
	return {
		pos: tokenize([candidate.name, candidate.summary ?? "", ...(candidate.useWhen ?? []), toolWords].join(" ")),
		// 「（用 xxx）」只是指路到别的 server，不是这个 server 的反例特征
		neg: tokenize((candidate.avoidWhen ?? []).map((a) => String(a).replace(/[（(]\s*用[^）)]*[）)]/g, " ")).join(" "))
	};
}

/**
 * 给一个场景挑 server。
 * @param {string} query 场景描述（用户这一轮要干什么）
 * @param {CatalogCandidate[]} candidates
 * @param {{threshold?: number, avoidWeight?: number}} [options]
 * @returns {{pick: string|null, scores: {name: string, score: number}[]}}
 */
export function selectServer(query, candidates, options = {}) {
	const threshold = options.threshold ?? 2.2;
	const avoidWeight = options.avoidWeight ?? 1.5;
	const docs = candidates.map((c) => ({ name: c.name, ...docsOf(c) }));
	const n = docs.length;
	const df = new Map();
	for (const d of docs) for (const t of d.pos) df.set(t, (df.get(t) ?? 0) + 1);
	const idf = (t) => Math.log(1 + n / (df.get(t) ?? n));
	const q = tokenize(query);
	const scores = docs.map((d) => {
		let score = 0;
		let avoidHits = 0;
		for (const t of q) {
			if (d.pos.has(t)) score += idf(t);
			if (d.neg.has(t)) avoidHits += 1;
		}
		// 反例要至少命中两个词元才算（单个二字词元碰巧重合太常见，如「成一」）
		if (avoidHits >= 2) score -= avoidWeight * avoidHits * Math.log(1 + n);
		return { name: d.name, score: Math.round(score * 1000) / 1000 };
	});
	scores.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
	const best = scores[0];
	return { pick: best !== undefined && best.score >= threshold ? best.name : null, scores };
}

/**
 * 跑一组场景，算命中率。
 * @param {{id: string, query: string, expect: string|null}[]} scenarios expect = null 表示「不该用任何 MCP」（反例）
 * @param {CatalogCandidate[]} candidates
 */
export function evaluateScenarios(scenarios, candidates, options = {}) {
	const results = scenarios.map((s) => {
		const { pick, scores } = selectServer(s.query, candidates, options);
		return { id: s.id, query: s.query, expect: s.expect ?? null, pick, hit: pick === (s.expect ?? null), top: scores.slice(0, 3) };
	});
	const positives = results.filter((r) => r.expect !== null);
	const negatives = results.filter((r) => r.expect === null);
	const rate = (list) => (list.length === 0 ? 1 : Math.round((list.filter((r) => r.hit).length / list.length) * 1000) / 1000);
	return {
		total: results.length,
		hits: results.filter((r) => r.hit).length,
		hitRate: rate(results),
		positive: { total: positives.length, hitRate: rate(positives) },
		negative: { total: negatives.length, hitRate: rate(negatives) },
		results
	};
}

/** 注册表条目 → 评测候选（与目录渲染同一份口径：catalogOf + 可见工具名）。 */
export function candidateFromEntry(entry, catalog, toolNames) {
	return { name: entry.name, summary: catalog.summary, useWhen: catalog.useWhen, avoidWhen: catalog.avoidWhen, tools: toolNames };
}
