/**
 * 技能库治理的只读分析：载入技能库、两两相似度、合并候选（R6）、冲突检测（G7）、合并稿红线检查。
 * 本文件不写任何东西，也不调模型；#5 的蒸馏查重复用 loadLibrary / pairSimilarity / findSimilar。
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { bigramSimilarity, normalizeNewlines, parseSkillDoc } from "./skill-doc.js";
import { protectedContent } from "./skill-redlines.js";
import { skillKeyOf, skillTargetOf } from "./versions.js";

const TRIGGER_KEYS = ["when_to_use", "whenToUse", "when-to-use", "triggers", "trigger", "keywords"];
const NEG_RE = /(不要|不能|别再|禁止|不得|严禁|绝不|切勿|不准|不许|避免|\bnever\b|\bdon'?t\b|\bdo not\b|\bmust not\b|\bavoid\b)/i;
const POS_RE = /(必须|务必|一定要|总是|始终|优先用|\balways\b|\bmust\b|\bshould\b)/i;
const MARKERS_RE = new RegExp(`${NEG_RE.source}|${POS_RE.source}|[-*>#\`'"“”‘’，。,.;；:：!！?？()（）\\[\\]]`, "gi");

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const excerpt = (s, n = 160) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? t.slice(0, n) + "…" : t;
};
const round = (x) => Math.round(x * 1000) / 1000;

function rawValue(raw, key) {
	const v = raw?.[key];
	if (v === undefined || v === null) return "";
	return Array.isArray(v) ? v.join(" ") : String(v);
}

/** 一份技能文本 → 治理要用的结构化视图。 */
export function describeSkill(text, meta = {}) {
	const normalized = normalizeNewlines(text);
	const doc = parseSkillDoc(normalized);
	const name = String(doc.fields?.name ?? "").trim() || meta.dirName || "";
	const description = String(doc.fields?.description ?? rawValue(doc.raw, "description"));
	const trigger = [description, ...TRIGGER_KEYS.map((k) => rawValue(doc.raw, k))].filter((s) => s !== "").join(" ");
	const steps = doc.steps.map((s) => s.replace(/^\s*(?:\d+[.)、]|(?:步骤|第[一二三四五六七八九十\d]+步|step)\s*\d*[:：.、)]?)\s*/i, "").trim()).filter(Boolean);
	const tools = doc.tools.filter((t) => !t.startsWith("cmd:") || t.length > 6);
	const directives = [];
	doc.lines.forEach((l, i) => {
		if (l.inFence) return;
		const t = l.text.trim();
		if (t === "" || /^#/.test(t)) return;
		const polarity = NEG_RE.test(t) ? "neg" : POS_RE.test(t) ? "pos" : null;
		if (polarity) directives.push({ polarity, text: t, object: t.replace(MARKERS_RE, " ").replace(/\s+/g, " ").trim(), line: i + 1 });
	});
	return { ...meta, name, description, trigger, steps, tools, directives, text: normalized, sha: sha(normalized) };
}

/**
 * 载入用户技能根里的全部技能（<root>/<dir>/SKILL.md 与根上的 <name>.md）。
 * @returns {Promise<Array<ReturnType<typeof describeSkill> & {file:string, root:string, key:string, dirName:string}>>}
 */
// B6：describeSkill 的结果按 (文件, mtimeMs, size) 缓存。每次增量冲突检查、每轮治理 / 蒸馏、每次草稿合并、
// 每次优化的相邻技能查询以前都把整个技能库逐个顺序 stat + 读 + 解析一遍。stat 与读取改成有界并行；
// 返回深拷贝，调用方改了不会串到缓存里。本轮没见到的文件从缓存里删掉。
const libraryCache = new Map();
const LIBRARY_CONCURRENCY = 16;
export const libraryCounters = { parsed: 0, reused: 0 };

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			const i = cursor;
			cursor += 1;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

export async function loadLibrary(roots) {
	const candidates = [];
	const seen = new Set();
	for (const root of roots) {
		let entries = [];
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			let file = null;
			let needCheck = false;
			if (entry.isDirectory() && !entry.name.startsWith(".")) {
				file = join(root, entry.name, "SKILL.md");
				needCheck = true;
			} else if (entry.isFile() && /\.md$/i.test(entry.name) && !/^readme\.md$/i.test(entry.name)) file = join(root, entry.name);
			if (file === null || seen.has(file)) continue;
			seen.add(file);
			candidates.push({ file, root, needCheck, dirName: entry.isDirectory() ? entry.name : basename(entry.name, ".md") });
		}
	}
	const described = await mapLimit(candidates, LIBRARY_CONCURRENCY, async (c) => {
		let st;
		try {
			st = await stat(c.file);
		} catch {
			return null;
		}
		if (c.needCheck && !st.isFile()) return null;
		const hit = libraryCache.get(c.file);
		if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.root === c.root && hit.dirName === c.dirName) {
			libraryCounters.reused += 1;
			return hit.value;
		}
		try {
			const text = await readFile(c.file, "utf8");
			const value = describeSkill(text, { file: c.file, root: c.root, dirName: c.dirName, key: skillKeyOf(skillTargetOf(c.file)) });
			libraryCounters.parsed += 1;
			libraryCache.set(c.file, { mtimeMs: st.mtimeMs, size: st.size, root: c.root, dirName: c.dirName, value });
			return value;
		} catch {
			/* 读不了的跳过 */
			return null;
		}
	});
	const scanned = new Set(candidates.map((c) => c.file));
	for (const file of libraryCache.keys()) if (!scanned.has(file) && roots.some((r) => file.startsWith(r))) libraryCache.delete(file);
	return described.filter((x) => x !== null).map((x) => structuredClone(x));
}

/** 步骤骨架相似度：双向「每步取最像的一步」再平均；任一侧没有步骤 = 0（不拿空对空当相似）。 */
function stepSimilarity(a, b) {
	if (a.length === 0 || b.length === 0) return { sim: 0, pairs: [] };
	const best = (xs, ys) => xs.map((x) => ys.reduce((m, y) => { const s = bigramSimilarity(x, y); return s > m.s ? { s, y } : m; }, { s: 0, y: "" }));
	const ab = best(a, b);
	const ba = best(b, a);
	const sim = (ab.reduce((n, r) => n + r.s, 0) / a.length + ba.reduce((n, r) => n + r.s, 0) / b.length) / 2;
	const pairs = ab.map((r, i) => ({ a: a[i], b: r.y, sim: round(r.s) })).sort((x, y) => y.sim - x.sim).slice(0, 3);
	return { sim, pairs };
}

function toolSimilarity(a, b) {
	const A = new Set(a);
	const B = new Set(b);
	if (A.size === 0 || B.size === 0) return { sim: 0, shared: [], onlyA: [...A], onlyB: [...B] };
	const shared = [...A].filter((t) => B.has(t));
	return { sim: shared.length / new Set([...A, ...B]).size, shared, onlyA: [...A].filter((t) => !B.has(t)), onlyB: [...B].filter((t) => !A.has(t)) };
}

/** 两份技能的内容相似度（触发 / 步骤骨架 / 工具集），带证据。 */
export function pairSimilarity(a, b) {
	const trigger = bigramSimilarity(a.trigger, b.trigger);
	const steps = stepSimilarity(a.steps, b.steps);
	const tools = toolSimilarity(a.tools, b.tools);
	return {
		trigger: { sim: round(trigger), a: excerpt(a.trigger), b: excerpt(b.trigger) },
		steps: { sim: round(steps.sim), pairs: steps.pairs },
		tools: { sim: round(tools.sim), shared: tools.shared, onlyA: tools.onlyA, onlyB: tools.onlyB }
	};
}

/**
 * 遥测 → 每个技能的使用量与会话集合（同会话共触发用）。
 * @param {Array<{type:string, skill?:string, sid?:string}>} events
 */
export function usageFromEvents(events) {
	const uses = new Map();
	const sessions = new Map();
	for (const ev of events) {
		if ((ev.type !== "skill.trigger" && ev.type !== "skill.inject") || typeof ev.skill !== "string") continue;
		uses.set(ev.skill, (uses.get(ev.skill) ?? 0) + 1);
		if (typeof ev.sid === "string" && ev.sid !== "") {
			if (!sessions.has(ev.skill)) sessions.set(ev.skill, new Set());
			sessions.get(ev.skill).add(ev.sid);
		}
	}
	return { uses, sessions };
}

/** n 个技能两两配对的总数。 */
export const pairTotal = (n) => (n * (n - 1)) / 2;
const pairKeyOf = (a, b) => [a, b].sort().join("|");

/**
 * 枚举要比较的技能对。
 *
 * focus（增量检查）：只出与它相关的 n-1 对，不吃上限。旧写法先按库顺序数满 limit 再过滤 focus，
 * 库一过 64 个技能，排在后面的技能做增量检查时一对相关的都轮不到。
 * 全量：总对数超过 limit 时只比一个窗口 [offset, offset+limit)（按对的线性编号、到头回卷）；
 * 调用方每轮把 offset 往前推，若干轮覆盖全库，而不是永远只比库顺序最靠前的那几个技能。
 * stats（可选）会被填上 { total, compared, truncated, pairKeys }：pairKeys 只在截断时给，供调用方判断「哪些对这轮真的比过」。
 */
function* pairsOf(library, limit, { focus = null, offset = 0, stats = null } = {}) {
	const n = library.length;
	const total = pairTotal(n);
	const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : total;
	const note = (compared, truncated, keys) => {
		if (stats !== null) Object.assign(stats, { total, compared, truncated, pairKeys: truncated ? keys : null });
	};
	if (focus !== null) {
		let compared = 0;
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				if (library[i].key !== focus && library[j].key !== focus) continue;
				compared += 1;
				yield [library[i], library[j]];
			}
		}
		note(compared, false, null);
		return;
	}
	const truncated = total > cap;
	const take = truncated ? cap : total;
	const start = truncated ? ((Math.floor(Number(offset) || 0) % total) + total) % total : 0;
	const keys = truncated ? new Set() : null;
	let k = 0;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const index = k++;
			const inWindow = index >= start ? index < start + take : index < start + take - total;
			if (!inWindow) continue;
			if (keys !== null) keys.add(pairKeyOf(library[i].key, library[j].key));
			yield [library[i], library[j]];
		}
	}
	note(take, truncated, keys);
}
export { pairKeyOf };

/**
 * R6 合并候选：同名多处 / 内容相似 + 同会话共触发，综合分 ≥ minScore。保留方 = 用得多的一方（持平取名字靠前的）。
 * @returns {Array<{id:string, score:number, keep:object, drop:object, reasons:string[], evidence:object}>}
 */
export function discoverMergeCandidates(library, usage, cfg, { exclude = [], maxPairs = 2000, offset = 0, stats = null } = {}) {
	const skip = new Set(exclude);
	const lib = library.filter((s) => !skip.has(s.name));
	const w = cfg.weights;
	const out = [];
	for (const [x, y] of pairsOf(lib, maxPairs, { offset, stats })) {
		const sim = pairSimilarity(x, y);
		const sx = usage.sessions.get(x.name) ?? new Set();
		const sy = usage.sessions.get(y.name) ?? new Set();
		const both = [...sx].filter((s) => sy.has(s)).length;
		const coRatio = Math.min(sx.size, sy.size) > 0 ? both / Math.min(sx.size, sy.size) : 0;
		const sameName = x.name === y.name;
		const score = sameName ? 1 : round(w.trigger * sim.trigger.sim + w.steps * sim.steps.sim + w.tools * sim.tools.sim + w.coTrigger * coRatio);
		if (score < cfg.minScore) continue;
		const ux = usage.uses.get(x.name) ?? 0;
		const uy = usage.uses.get(y.name) ?? 0;
		const [keep, drop] = ux > uy || (ux === uy && x.file.localeCompare(y.file) <= 0) ? [x, y] : [y, x];
		const reasons = [];
		if (sameName) reasons.push(`同名「${x.name}」出现在多个技能根`);
		if (sim.trigger.sim >= 0.3) reasons.push(`触发描述相似 ${sim.trigger.sim}`);
		if (sim.steps.sim >= 0.3) reasons.push(`步骤骨架相似 ${sim.steps.sim}`);
		if (sim.tools.sim >= 0.3) reasons.push(`工具集重合 ${sim.tools.sim}（共用 ${sim.tools.shared.join("、")}）`);
		if (both > 0) reasons.push(`最近遥测里 ${both} 个会话两者都触发过`);
		out.push({
			id: "mc-" + sha([keep.key, drop.key].join("|")).slice(0, 12),
			score,
			keep: { name: keep.name, key: keep.key, file: keep.file, uses: usage.uses.get(keep.name) ?? 0 },
			drop: { name: drop.name, key: drop.key, file: drop.file, uses: usage.uses.get(drop.name) ?? 0 },
			reasons,
			evidence: { ...sim, coTrigger: { sessions: both, ratio: round(coRatio) }, sameName }
		});
	}
	return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** 给一份草稿在库里找最像的技能（#5 蒸馏查重用）。 */
export function findSimilar(draft, library, cfg) {
	const w = cfg.weights;
	return library
		.map((s) => {
			const sim = pairSimilarity(draft, s);
			const sameName = draft.name !== "" && draft.name === s.name;
			const score = sameName ? 1 : round((w.trigger * sim.trigger.sim + w.steps * sim.steps.sim + w.tools * sim.tools.sim) / (w.trigger + w.steps + w.tools));
			return { name: s.name, key: s.key, file: s.file, score, sameName, evidence: sim };
		})
		.sort((a, b) => b.score - a.score);
}

const conflictId = (type, a, b, extra = "") => "conf-" + sha([type, ...[a, b].sort(), extra].join("|")).slice(0, 12);

/**
 * G7 冲突检测（只读）。focus 给了就只查与它相关的对（增量检查）。
 * 类型：duplicate-name（同名多根）/ trigger-overlap（触发重叠）/ contradiction（指令矛盾）/ tool-conflict（一方要求用的工具另一方禁用）。
 */
export function detectConflicts(library, cfg, { focus = null, exclude = [], maxPairs = 2000, offset = 0, stats = null } = {}) {
	const skip = new Set(exclude);
	const lib = library.filter((s) => !skip.has(s.name));
	const out = [];
	const ref = (s) => ({ name: s.name, key: s.key, file: s.file });
	for (const [a, b] of pairsOf(lib, maxPairs, { focus, offset, stats })) {
		if (a.name === b.name) {
			out.push({
				id: conflictId("duplicate-name", a.key, b.key),
				type: "duplicate-name",
				pair: [ref(a), ref(b)],
				evidence: [
					{ skill: a.name, file: a.file, quote: excerpt(a.description) },
					{ skill: b.name, file: b.file, quote: excerpt(b.description) }
				],
				suggestion: { action: "merge", note: "同名技能在两个根里各有一份：保留一份，另一份走合并提案（skillmgr_governance_run 会出合并提案）或改名" }
			});
		}
		const trig = bigramSimilarity(a.trigger, b.trigger);
		if (a.name !== b.name && trig >= cfg.triggerOverlap) {
			out.push({
				id: conflictId("trigger-overlap", a.key, b.key),
				type: "trigger-overlap",
				similarity: round(trig),
				pair: [ref(a), ref(b)],
				evidence: [
					{ skill: a.name, file: a.file, quote: excerpt(a.trigger) },
					{ skill: b.name, file: b.file, quote: excerpt(b.trigger) }
				],
				suggestion: { action: "narrow-trigger", note: `两者的触发描述相似度 ${round(trig)}，同一句话可能同时命中：收窄其中一个的 description / when_to_use，或评估是否合并` }
			});
		}
		for (const [x, y] of [[a, b], [b, a]]) {
			for (const p of x.directives.filter((d) => d.polarity === "pos")) {
				for (const n of y.directives.filter((d) => d.polarity === "neg")) {
					if (p.object.length < 2 || n.object.length < 2) continue;
					const s = bigramSimilarity(p.object, n.object);
					if (s < cfg.contradiction) continue;
					out.push({
						id: conflictId("contradiction", x.key, y.key, p.text + "|" + n.text),
						type: "contradiction",
						similarity: round(s),
						pair: [ref(x), ref(y)],
						evidence: [
							{ skill: x.name, file: x.file, line: p.line, quote: p.text },
							{ skill: y.name, file: y.file, line: n.line, quote: n.text }
						],
						suggestion: { action: "manual", note: "两份技能对同一件事给了相反的指令：请所有者裁决以哪份为准（裁决会进入教训来源），再改其中一份" }
					});
				}
			}
			for (const n of x.directives.filter((d) => d.polarity === "neg")) {
				for (const tool of y.tools) {
					const bare = tool.replace(/^cmd:/, "");
					if (bare.length < 3 || !n.text.includes(bare)) continue;
					const use = y.text.split("\n").map((t, i) => ({ t: t.trim(), i: i + 1 })).find((l) => l.t.includes(bare) && !NEG_RE.test(l.t));
					if (!use) continue;
					out.push({
						id: conflictId("tool-conflict", x.key, y.key, bare + "|" + n.text),
						type: "tool-conflict",
						tool: bare,
						pair: [ref(x), ref(y)],
						evidence: [
							{ skill: x.name, file: x.file, line: n.line, quote: n.text },
							{ skill: y.name, file: y.file, line: use.i, quote: use.t }
						],
						suggestion: { action: "manual", note: `「${x.name}」要求避开 ${bare}，「${y.name}」的步骤却在用：请所有者裁决，或给其中一份加适用范围` }
					});
				}
			}
		}
	}
	const seen = new Set();
	return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/**
 * 合并稿的红线检查：保留方（keep）的受保护 frontmatter 键原样不变；来源（drop）的受保护键和保留方不同 → 需人工合并；
 * 两个来源的受保护段 / 受保护行（去重后的并集）必须逐字出现在合并稿里，合并稿不得多出新的受保护内容。
 */
export function checkMergeRedlines(keepText, dropText, mergedText, rules) {
	const a = protectedContent(keepText, rules);
	const b = protectedContent(dropText, rules);
	const m = protectedContent(mergedText, rules);
	const violations = [];
	for (const key of rules.frontmatterKeys) {
		if (key === "name") {
			if (a.frontmatter.name !== m.frontmatter.name) violations.push({ kind: "frontmatter", change: "changed", what: "name（合并稿必须沿用保留方的 name）" });
			continue;
		}
		if (a.frontmatter[key] !== m.frontmatter[key]) violations.push({ kind: "frontmatter", change: "changed", what: key });
		if (b.frontmatter[key] !== null && b.frontmatter[key] !== a.frontmatter[key]) violations.push({ kind: "frontmatter", change: "conflict", what: `${key}（两个来源不同，需人工合并）` });
	}
	for (const kind of ["sections", "lines"]) {
		const want = new Set([...a[kind], ...b[kind]]);
		const got = new Set(m[kind]);
		for (const x of want) if (!got.has(x)) violations.push({ kind: kind === "sections" ? "section" : "line", change: "removed", what: x.split("\n")[0].slice(0, 120) });
		for (const y of got) if (!want.has(y)) violations.push({ kind: kind === "sections" ? "section" : "line", change: "added", what: y.split("\n")[0].slice(0, 120) });
	}
	return { ok: violations.length === 0, violations };
}
