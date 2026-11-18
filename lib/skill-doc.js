/**
 * SKILL.md 的结构化切分（：红线检查与 G3 分级共用）。
 * 只做只读解析：frontmatter 原始键值、标题、步骤、代码围栏、正文行、工具引用。
 */
import { parseSkillFile, stripBom } from "./scanner.js";

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const STEP_RE = /^\s*(?:\d+[.)、]|(?:步骤|第[一二三四五六七八九十\d]+步|step)\s*\d*[:：.、)]?)\s+\S/i;
/** 工具引用：MCP 工具、本插件工具、反引号里的 snake_case 标识符，以及 shell 围栏里每行的命令名。 */
const TOOL_INLINE_RE = /\b(mcp__[A-Za-z0-9_-]+|skillmgr_[a-z0-9_]+|mcp_[a-z0-9_]+)\b/g;
const TOOL_TICK_RE = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
export const SHELL_LANG = /^(?:bash|sh|shell|zsh|console|powershell|pwsh|ps1|cmd|bat)$/i;

export function normalizeNewlines(text) {
	return stripBom(String(text ?? "")).replace(/\r\n?/g, "\n");
}

/**
 * @returns {{fmText: string|null, raw: Record<string, unknown>, body: string, lines: Array<{text:string, inFence:boolean, fenceLang:string, section:number}>,
 *   headings: Array<{level:number, text:string, line:number}>, fences: string[], steps: string[], tools: string[]}}
 */
export function parseSkillDoc(text) {
	const normalized = normalizeNewlines(text);
	const parsed = parseSkillFile(normalized);
	const body = parsed.body ?? "";
	const rawLines = body.split("\n");
	const lines = [];
	const headings = [];
	const fences = [];
	const steps = [];
	const tools = new Set();
	let inFence = false;
	let fenceLang = "";
	let fenceBuf = [];
	let section = -1;
	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i];
		if (FENCE_RE.test(line)) {
			if (!inFence) {
				inFence = true;
				fenceLang = line.trim().replace(/^(```|~~~)/, "").trim().split(/\s+/)[0] ?? "";
				fenceBuf = [];
			} else {
				inFence = false;
				fences.push(fenceBuf.join("\n"));
				fenceLang = "";
			}
			lines.push({ text: line, inFence: true, fenceLang, section, fenceMarker: true });
			continue;
		}
		if (inFence) {
			fenceBuf.push(line);
			if (SHELL_LANG.test(fenceLang)) {
				const cmd = line.trim().replace(/^[$>#]\s*/, "").split(/\s+/)[0] ?? "";
				if (/^[A-Za-z][\w.-]*$/.test(cmd) && !line.trim().startsWith("#")) tools.add("cmd:" + cmd.toLowerCase());
			}
		} else {
			const h = HEADING_RE.exec(line);
			if (h) {
				section = headings.length;
				headings.push({ level: h[1].length, text: h[2].trim(), line: i });
			} else if (STEP_RE.test(line)) steps.push(line.trim());
		}
		for (const m of line.matchAll(TOOL_INLINE_RE)) tools.add(m[1]);
		if (!inFence) for (const m of line.matchAll(TOOL_TICK_RE)) tools.add(m[1]);
		lines.push({ text: line, inFence, fenceLang, section });
	}
	if (inFence && fenceBuf.length > 0) fences.push(fenceBuf.join("\n"));
	return { fmText: parsed.fmText, raw: parsed.raw ?? {}, fields: parsed.fields, body, lines, headings, fences, steps, tools: [...tools].sort() };
}

/** 两个字符串数组按多重集合比较是否相等。 */
export function sameMultiset(a, b) {
	if (a.length !== b.length) return false;
	const count = new Map();
	for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
	for (const x of b) {
		const n = count.get(x);
		if (!n) return false;
		count.set(x, n - 1);
	}
	return true;
}

export function sameSequence(a, b) {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 字符二元组 Jaccard 相似度（中英文都适用）。 */
const GRAM_CACHE = new Map();
const GRAM_CACHE_MAX = 4000;
/**
 * 一段文本的二元组集合，按原文记忆。治理扫描对同一批触发语 / 步骤 / 指令两两比几千上万次，
 * 旧写法每次比较都把两边的集合重建一遍（约 200 个技能的全量扫描因此要阻塞事件循环好几秒）。
 */
function gramsOf(s) {
	const raw = String(s ?? "");
	const hit = GRAM_CACHE.get(raw);
	if (hit !== undefined) return hit;
	const t = raw.toLowerCase().replace(/\s+/g, " ").trim();
	const out = new Set();
	for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
	if (t.length === 1) out.add(t);
	if (GRAM_CACHE.size >= GRAM_CACHE_MAX) GRAM_CACHE.clear();
	GRAM_CACHE.set(raw, out);
	return out;
}

/** a 的二元组有多大比例还留在 b 里（0–1）。「在原句上补充细节」保留率高，「换成另一句话」保留率低。 */
export function bigramContainment(a, b) {
	const ga = gramsOf(a);
	const gb = gramsOf(b);
	if (ga.size === 0) return 1;
	let inter = 0;
	for (const g of ga) if (gb.has(g)) inter++;
	return inter / ga.size;
}

export function bigramSimilarity(a, b) {
	const ga = gramsOf(a);
	const gb = gramsOf(b);
	if (ga.size === 0 && gb.size === 0) return 1;
	let inter = 0;
	for (const g of ga) if (gb.has(g)) inter++;
	return inter / (ga.size + gb.size - inter);
}

export function stableJson(value) {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
	return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}
