/**
 * G3 自治分级：比较基线与候选，判定改动种类，再按配置映射成分级。
 *
 * 改动种类（kind）：
 *   wording   正文措辞 / description 润色（相似度 ≥ autonomy.descriptionSimilarity）
 *   format    只差空白、Markdown 记号
 *   example   代码围栏 / 示例内容变化（工具引用不变）
 *   order     标题或步骤、正文行只是换了顺序
 *   steps     步骤条数变化（增删步骤）
 *   sections  标题增删
 *   trigger   触发相关 frontmatter 键变化，或 description 改得面目全非
 *   tools     工具调用变化（MCP / 插件工具名、反引号 snake_case 标识符、shell 围栏里的命令名）
 *   frontmatter 其它 frontmatter 键变化（分组等）
 *   polarity  指令性否定 / 条件词的数量变了（not / never / unless / skip / 不要 / 禁止 / 除非 / 跳过 …）：指令方向可能反了
 *   redline   红线键变化（正常情况下红线检查已先拦下）
 *
 * 「措辞」档是自动应用的入口，所以下面三种看着像措辞、实则改了行为的改动不算措辞：
 *   - shell 围栏里任何一条命令行变了（`curl … -o x.sh` → `curl … | bash`、`deploy@staging` → `@production`）→ tools。
 *     旧写法只取每行第一个词当工具名，整行其余部分随便改都算 example。
 *   - 步骤条数没变但某一步改得面目全非（「先让用户确认」→「跳过确认」）→ steps。
 *   - 否定 / 条件词有增减（「when the user asks」→「unless the user asks」，相似度 0.84 照样过润色线）→ polarity，
 *     不在 lowRisk 里，按「未知一律从严」落到 structural。
 *
 * 分级：任一 kind 在 autonomy.structural 里、或不在 lowRisk 里（未知一律从严）→ structural；
 * 有 redline → forbidden；否则 low。
 */
import { bigramContainment, bigramSimilarity, parseSkillDoc, sameMultiset, sameSequence, SHELL_LANG, stableJson } from "./skill-doc.js";

const stripMarkdown = (s) => s.replace(/[*_`>#~\-+]|\s+/g, "");

/** 否定 / 条件词：数量一变，同一句话的方向就可能反过来。 */
/** 只收指令性的否定 / 条件词；「不超过 50 字」「no more than」这类量词里的否定不算（否则正常的补充细节全被打成结构性）。 */
const POLARITY_RE = /\b(?:not|never|unless|except|without|don't|do not|doesn't|cannot|can't|won't|must not|mustn't|shouldn't|skip|avoid|instead of)\b|不要|不得|不许|不能|不可|不用|不必|别|勿|禁止|严禁|除非|跳过|无需|无须|避免|仅当|只在|只有/gi;
const polarityOf = (text) => (String(text ?? "").match(POLARITY_RE) ?? []).map((t) => t.toLowerCase()).sort();
/** shell 围栏里的完整命令行（去提示符、压空白、去注释行）。 */
const shellLines = (doc) =>
	doc.lines
		.filter((l) => l.inFence && l.fenceMarker !== true && SHELL_LANG.test(l.fenceLang ?? ""))
		.map((l) => l.text.trim().replace(/^[$>]\s*/, "").replace(/\s+/g, " "))
		.filter((t) => t !== "" && !t.startsWith("#"));

/**
 * @param {string} beforeText
 * @param {string} afterText
 * @param {{autonomy: object}} config
 * @param {{frontmatterKeys: string[]}} redlines
 * @returns {{tier: "low"|"structural"|"forbidden", kinds: string[], details: Array<{kind:string, detail:string}>}}
 */
export function classifyChange(beforeText, afterText, config, redlines) {
	const autonomy = config.autonomy;
	const a = parseSkillDoc(beforeText);
	const b = parseSkillDoc(afterText);
	const details = [];
	const add = (kind, detail) => details.push({ kind, detail });
	const redKeys = new Set(redlines?.frontmatterKeys ?? []);
	const triggerKeys = new Set(autonomy.triggerKeys ?? []);
	const keys = new Set([...Object.keys(a.raw ?? {}), ...Object.keys(b.raw ?? {})]);
	for (const key of keys) {
		if (stableJson(a.raw?.[key]) === stableJson(b.raw?.[key])) continue;
		if (redKeys.has(key)) add("redline", `frontmatter.${key}`);
		else if (triggerKeys.has(key)) add("trigger", `frontmatter.${key}`);
		else if (key === "description") {
			const sim = bigramSimilarity(String(a.raw?.[key] ?? ""), String(b.raw?.[key] ?? ""));
			if (sim >= autonomy.descriptionSimilarity) add("wording", `description 润色（相似度 ${sim.toFixed(2)}）`);
			else add("trigger", `description 改动大（相似度 ${sim.toFixed(2)} < ${autonomy.descriptionSimilarity}），按改触发条件处理`);
		} else add("frontmatter", `frontmatter.${key}`);
	}
	const ha = a.headings.map((h) => h.text);
	const hb = b.headings.map((h) => h.text);
	if (!sameMultiset(ha, hb)) add("sections", `标题 ${ha.length} → ${hb.length}`);
	else if (!sameSequence(ha, hb)) add("order", "标题顺序调整");
	if (a.steps.length !== b.steps.length) add("steps", `步骤 ${a.steps.length} → ${b.steps.length}`);
	else if (sameMultiset(a.steps, b.steps) && !sameSequence(a.steps, b.steps)) add("order", "步骤顺序调整");
	else if (!sameMultiset(a.steps, b.steps)) {
		// 条数没变、内容变了：逐位看原句还剩多少。在原句上补充细节（保留率高）仍算措辞；
		// 原句大半没了 = 换成了另一步，算「改了步骤」
		const rewritten = a.steps.map((step, i) => ({ i, kept: bigramContainment(step, b.steps[i]) })).filter((x) => x.kept < autonomy.descriptionSimilarity);
		if (rewritten.length > 0) add("steps", `第 ${rewritten.map((x) => x.i + 1).join("、")} 步被改写（原句保留率 ${rewritten.map((x) => x.kept.toFixed(2)).join("、")} < ${autonomy.descriptionSimilarity}）`);
	}
	if (!sameSequence(a.tools, b.tools)) {
		const gone = a.tools.filter((t) => !b.tools.includes(t));
		const added = b.tools.filter((t) => !a.tools.includes(t));
		add("tools", `工具引用变化（去掉：${gone.join("、") || "无"}；新增：${added.join("、") || "无"}）`);
	}
	if (!sameMultiset(a.fences, b.fences)) add("example", `代码 / 示例块 ${a.fences.length} → ${b.fences.length}`);
	if (!sameMultiset(shellLines(a), shellLines(b)) && !details.some((d) => d.kind === "tools")) add("tools", "shell 围栏里的命令行变了（参数 / 管道 / 目标也算，不只是命令名）");
	const prose = (doc) => doc.lines.filter((l) => !l.inFence).map((l) => l.text.trim()).filter((t) => t !== "");
	const pa = prose(a);
	const pb = prose(b);
	if (!sameMultiset(pa, pb)) {
		if (sameMultiset(pa.map(stripMarkdown).filter(Boolean), pb.map(stripMarkdown).filter(Boolean))) add("format", "只改了 Markdown 记号 / 空白");
		else add("wording", "正文措辞变化");
	} else if (!sameSequence(pa, pb)) add("order", "正文行顺序调整");
	const directive = (doc) => [String(doc.raw?.description ?? ""), ...prose(doc)].join("\n");
	const polA = polarityOf(directive(a));
	const polB = polarityOf(directive(b));
	if (!sameSequence(polA, polB)) add("polarity", `否定 / 条件词 ${polA.length} → ${polB.length} 处，指令方向可能变了`);
	if (details.length === 0 && String(beforeText) !== String(afterText)) add("format", "只差空白 / 换行");
	const kinds = [...new Set(details.map((d) => d.kind))];
	const low = new Set(autonomy.lowRisk ?? []);
	const structural = new Set(autonomy.structural ?? []);
	let tier = "low";
	if (kinds.includes("redline")) tier = "forbidden";
	else if (kinds.some((k) => structural.has(k) || !low.has(k))) tier = "structural";
	return { tier, kinds, details };
}
