/**
 * 技能红线：自动优化**永远不许改**的权限 / 安全段落。
 *
 * 这份清单就是 Muse 要核对的「红线清单」——写成代码而不是散在提示词里，
 * 任何候选版本在进评估之前先过 checkRedlines()；违反即丢弃（discard 记录 reason=redline），
 * 不出提案、不许所有者点名放行（放行入口会拒绝 redline 类丢弃）。
 *
 * 三类受保护内容（内置项不可删减；配置 optimizer.redlines.extra* 只能追加）：
 *   1. frontmatter 键：name（身份）、调用策略、工具 / 权限声明。值或写法有任何变化 = 违反。
 *   2. 标题命中安全类关键字的整段（标题行到下一个同级或更高级标题之前），逐字不变。
 *   3. 段外命中危险操作 / 凭据 / 禁令关键字的单行（含代码围栏里的行），逐字不变；
 *      候选**新增**这类行同样算违反——红线内容只能由人来改。
 */
import { normalizeNewlines, parseSkillDoc, sameMultiset } from "./skill-doc.js";

export const BUILTIN_REDLINES = Object.freeze({
	frontmatterKeys: Object.freeze([
		"name",
		"allowed-tools",
		"allowedTools",
		"allowed_tools",
		"tools",
		"permissions",
		"permission",
		"disable-model-invocation",
		"disable-model-invocable",
		"user-invocable",
		"model-invocable",
		"security",
		"sandbox"
	]),
	headingPatterns: Object.freeze([
		"权限",
		"安全",
		"红线",
		"禁止",
		"禁忌",
		"严禁",
		"凭据",
		"凭证",
		"密钥",
		"密码",
		"隐私",
		"合规",
		"警告",
		"permission",
		"security",
		"safety",
		"credential",
		"secret",
		"auth",
		"privacy",
		"guardrail",
		"red ?line",
		"forbidden",
		"prohibited",
		"danger",
		"warning",
		"caution",
		"restriction",
		"compliance"
	]),
	linePatterns: Object.freeze([
		"\\bsudo\\b",
		"rm\\s+-[a-z]*r[a-z]*f|rm\\s+-[a-z]*f[a-z]*r",
		"\\bchmod\\b|\\bchown\\b",
		"password|passwd|密码",
		"\\btoken\\b|api[\\s_-]?key|\\bsecret\\b|credential",
		"凭据|凭证|密钥|口令",
		"权限|permission",
		"不得|禁止|严禁|绝不|绝对不|永远不要|切勿|不准|不许",
		"\\bnever\\b|must not|do not|don't|forbidden|prohibited"
	])
});

/** 内置 + 追加后的有效红线（正则已编译）。 */
export function effectiveRedlines(extra = {}) {
	const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim() !== "") : []);
	const keys = [...new Set([...BUILTIN_REDLINES.frontmatterKeys, ...strs(extra.extraFrontmatterKeys)])];
	const headingSources = [...BUILTIN_REDLINES.headingPatterns, ...strs(extra.extraHeadingPatterns)];
	const lineSources = [...BUILTIN_REDLINES.linePatterns, ...strs(extra.extraLinePatterns)];
	const compile = (sources) => {
		const ok = [];
		const bad = [];
		for (const src of sources) {
			try {
				new RegExp(src, "i");
				ok.push(src);
			} catch {
				bad.push(src);
			}
		}
		return { re: new RegExp(ok.map((s) => "(?:" + s + ")").join("|"), "i"), bad };
	};
	const heading = compile(headingSources);
	const line = compile(lineSources);
	return {
		frontmatterKeys: keys,
		headingPatterns: headingSources,
		linePatterns: lineSources,
		headingRe: heading.re,
		lineRe: line.re,
		invalidPatterns: [...heading.bad, ...line.bad]
	};
}

/** frontmatter 里某个键的原文块（键行 + 后续缩进行）；没有返回 null。 */
function frontmatterKeyBlock(fmText, key) {
	if (typeof fmText !== "string") return null;
	const lines = normalizeNewlines(fmText).split("\n");
	const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp("^" + esc + "\\s*:");
	for (let i = 0; i < lines.length; i++) {
		if (!re.test(lines[i])) continue;
		const block = [lines[i].trimEnd()];
		for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j]); j++) block.push(lines[j].trimEnd());
		return block.join("\n");
	}
	return null;
}

/**
 * 抽出一份技能文本里的全部受保护内容。
 * @returns {{frontmatter: Record<string, string|null>, sections: string[], lines: string[]}}
 */
export function protectedContent(text, rules) {
	const doc = parseSkillDoc(text);
	const frontmatter = {};
	for (const key of rules.frontmatterKeys) frontmatter[key] = frontmatterKeyBlock(doc.fmText, key);
	// 受保护的标题段：从命中标题起，到下一个同级或更高级标题前
	const protectedSection = new Set();
	const sections = [];
	for (let h = 0; h < doc.headings.length; h++) {
		const head = doc.headings[h];
		if (!rules.headingRe.test(head.text)) continue;
		let end = doc.lines.length;
		for (let k = h + 1; k < doc.headings.length; k++) {
			if (doc.headings[k].level <= head.level) {
				end = doc.headings[k].line;
				break;
			}
		}
		const chunk = [];
		for (let i = head.line; i < end; i++) {
			chunk.push(doc.lines[i].text.trimEnd());
			protectedSection.add(i);
		}
		while (chunk.length > 0 && chunk[chunk.length - 1] === "") chunk.pop();
		sections.push(chunk.join("\n"));
	}
	const lines = [];
	for (let i = 0; i < doc.lines.length; i++) {
		if (protectedSection.has(i)) continue;
		const t = doc.lines[i].text.trim();
		if (t !== "" && rules.lineRe.test(t)) lines.push(t);
	}
	return { frontmatter, sections, lines };
}

/**
 * 候选相对基线是否碰了红线。
 * @returns {{ok: boolean, violations: Array<{kind:"frontmatter"|"section"|"line", change:"removed"|"added"|"changed", what:string}>}}
 */
export function checkRedlines(beforeText, afterText, rules) {
	const a = protectedContent(beforeText, rules);
	const b = protectedContent(afterText, rules);
	const violations = [];
	for (const key of rules.frontmatterKeys) {
		if (a.frontmatter[key] === b.frontmatter[key]) continue;
		violations.push({ kind: "frontmatter", change: a.frontmatter[key] === null ? "added" : b.frontmatter[key] === null ? "removed" : "changed", what: key });
	}
	const diffList = (kind, xs, ys) => {
		if (sameMultiset(xs, ys)) return;
		const left = [...ys];
		for (const x of xs) {
			const idx = left.indexOf(x);
			if (idx >= 0) left.splice(idx, 1);
			else violations.push({ kind, change: "removed", what: x.split("\n")[0].slice(0, 120) });
		}
		for (const y of left) violations.push({ kind, change: "added", what: y.split("\n")[0].slice(0, 120) });
	};
	diffList("section", a.sections, b.sections);
	diffList("line", a.lines, b.lines);
	return { ok: violations.length === 0, violations };
}

/** 给 status / PR 看的纯数据视图（不含编译后的正则）。 */
export function describeRedlines(rules) {
	return {
		frontmatterKeys: rules.frontmatterKeys,
		headingPatterns: rules.headingPatterns,
		linePatterns: rules.linePatterns,
		invalidPatterns: rules.invalidPatterns,
		builtinCounts: { frontmatterKeys: BUILTIN_REDLINES.frontmatterKeys.length, headingPatterns: BUILTIN_REDLINES.headingPatterns.length, linePatterns: BUILTIN_REDLINES.linePatterns.length }
	};
}
