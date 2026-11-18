/**
 * dsh-studio — filesystem skill scanner.
 *
 * The host skill registry (`ctx.skills`) only sees providers registered in
 * the viewing layer: on the web host plane the filesystem provider is disabled
 * by design (per-agent presets own local discovery), so a host-side panel
 * would see only runtime/bundled skills. This scanner re-implements the
 * standard discovery contract directly on the filesystem so the panel can
 * visualize (and edit/toggle) every skill the user actually keeps on disk:
 *
 *   - project roots: <projectRoot>/.dsh/skills, <projectRoot>/.agents/skills
 *   - user roots:    <dshHome>/skills,        <agentsHome>/skills
 *   - one level of nesting: a directory without its own SKILL.md whose child
 *     directories carry SKILL.md files (e.g. ~/.agents/skills/superpowers/…)
 *     is expanded so nested skills are still visible and manageable. Nested
 *     skills are flagged `nested: true` — DSH itself only auto-discovers the
 *     top level, so the panel marks them accordingly.
 *
 * Frontmatter is parsed with a small line-level YAML reader (scalar + block
 * values + one level of nested objects) for the fields the manager needs:
 * name, description, whenToUse, the two invocation keys, and `metadata` —
 * which carries the optional `group` / `tags` grouping label. No third-party
 * dependency.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { configuredExtraSkillDirs } from "./extractor.js";
import { isInside } from "./paths.js";

/**
 * Extra custom skill dirs to scan on top of the standard roots (env, PATH-style list).
 * 分隔符用平台的 path.delimiter：Windows 上按 ":" 切会把 `C:\\Users\\me\\skills` 切成 `C` 和 `\\Users\\me\\skills` 两个错根。
 */
export function customSkillDirs(raw = process.env.DSH_SKILL_MANAGER_SKILL_DIRS, sepChar = delimiter) {
	return typeof raw === "string" && raw !== "" ? raw.split(sepChar).filter((s) => s !== "") : [];
}

/** Frontmatter block matcher (leading fence pair). */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** kebab-case skill-name grammar (mirrors @deepseek-ai/dsh-skill). */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_RE = SKILL_NAME_RE;

/**
 * 去掉 UTF-8 BOM（WO-FIX-2）。带 BOM 的 SKILL.md 会让 `^---` 匹配失败，
 * 整个 frontmatter 被当成正文，skill 在面板里直接消失。
 */
export function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 按需读一个技能文件的全文（去 BOM）。列表扫描不再携带 content。 */
export async function readSkillText(path) {
	return stripBom(await readFile(path, "utf8"));
}

/**
 * 其它 Agent 的技能根，只读扫描。目录存在才加入列表。
 * env 有值时用它的值当主根（`<env>/skills`），否则用 ~/<dir>/skills。
 * DSH 与公共 Agent 由 skillRoots 单独处理（它们还带项目级目录）。
 */
const AGENT_ROOTS = [
	{ source: "claude", env: "DSH_CLAUDE_HOME", dirs: [".claude"] },
	{ source: "codex", env: "DSH_CODEX_HOME", dirs: [".codex"] },
	{ source: "cursor", env: "DSH_CURSOR_HOME", dirs: [".cursor"] },
	{ source: "gemini", env: "DSH_GEMINI_HOME", dirs: [".gemini"] },
	{ source: "windsurf", env: "DSH_WINDSURF_HOME", dirs: [".codeium/windsurf", ".windsurf"] },
	{ source: "trae", env: "DSH_TRAE_HOME", dirs: [".trae", ".trae-cn"] },
	{ source: "qoder", env: "DSH_QODER_HOME", dirs: [".qoder", ".qoder-cn"] },
	{ source: "lingma", env: "DSH_LINGMA_HOME", dirs: [".lingma"] },
	{ source: "opencode", env: "DSH_OPENCODE_HOME", dirs: [".config/opencode"] },
	{ source: "copilot", env: "DSH_COPILOT_HOME", dirs: [".copilot"] },
	{ source: "roo", env: "DSH_ROO_HOME", dirs: [".roo"] },
	{ source: "codebuddy", env: "DSH_CODEBUDDY_HOME", dirs: [".codebuddy"] },
	{ source: "workbuddy", env: "DSH_WORKBUDDY_HOME", dirs: [".workbuddy"] },
	{ source: "openclaw", env: "DSH_OPENCLAW_HOME", dirs: [".openclaw", ".clawdbot"] },
	{ source: "cc-switch", env: "", dirs: [".cc-switch"] }
];
/** Invocation key aliases (frontmatter → canonical). */
const KEY_ALIASES = {
	"disable-model-invocation": "disableModelInvocation",
	"disable-model-invocable": "disableModelInvocation",
	"user-invocable": "userInvocable"
};
/** 带引号标量的收尾引号位置（双引号认反斜杠转义，单引号认 '' 连写）；没有闭合返回 -1。 */
function closingQuote(value) {
	const quote = value[0];
	for (let i = 1; i < value.length; i++) {
		if (quote === '"' && value[i] === "\\") i += 1;
		else if (value[i] === quote) {
			if (quote === "'" && value[i + 1] === "'") i += 1;
			else return i;
		}
	}
	return -1;
}
/** Scalar value parse: quoted strings, booleans, numbers, plain text. */
function parseScalar(raw) {
	const value = raw.trim();
	if (value === "") return "";
	let text;
	const end = value[0] === '"' || value[0] === "'" ? closingQuote(value) : -1;
	if (end > 0 && /^\s*(?:#.*)?$/.test(value.slice(end + 1))) {
		// 带引号的值：引号里的 ` #` 是内容不是注释。此前先按 ` #` 截断再看引号，
		// `description: "Use when fixing issue #123"` 读出来是 `"Use when fixing issue`（连开头的引号都留着）。
		const quoted = value.slice(0, end + 1);
		text = quoted.slice(1, -1);
		if (value[0] === '"') {
			// 写入方用 JSON.stringify 产出双引号值，`\"` / `\\` 要解回来；不是合法 JSON 转义（Windows 路径之类）就保持原样
			try {
				const decoded = JSON.parse(quoted);
				if (typeof decoded === "string") text = decoded;
			} catch {
				/* 原样 */
			}
		} else text = text.replace(/''/g, "'");
		text = text.trim();
	} else {
		// strip trailing comment (" # …") only when preceded by whitespace
		const hash = value.indexOf(" #");
		const clean = hash >= 0 ? value.slice(0, hash).trimEnd() : value;
		text = clean;
		if (
			(clean.startsWith('"') && clean.endsWith('"') && clean.length >= 2) ||
			(clean.startsWith("'") && clean.endsWith("'") && clean.length >= 2)
		) {
			text = clean.slice(1, -1).trim();
		}
	}
	// WO-FIX-2：剥完引号再判一次布尔/数字。`disable-model-invocation: "true"` 是
	// 合法 YAML，旧实现剥完就原样返回字符串，下游 `!== true` 判断直接失效。
	const low = text.toLowerCase();
	if (low === "true" || low === "yes" || low === "on" || low === "1") return true;
	if (low === "false" || low === "no" || low === "off" || low === "0") return false;
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return Number(text);
	return text;
}
/** Parse an inline YAML array value ("[a, b]") into a string array, else null. */
function parseInlineArray(rawText) {
	const text = rawText.trim();
	if (!text.startsWith("[") || !text.endsWith("]")) return null;
	const inner = text.slice(1, -1).trim();
	if (inner === "") return [];
	return inner.split(",").map((part) => parseScalar(part));
}
/**
 * Parse one level of indented `key: value` children into a plain object.
 * Supports scalar values, inline arrays ("[a, b]") and `- item` block lists.
 * Returns { value, end } where `end` is the index of the last line consumed.
 */
function parseNestedBlock(lines, start) {
	const out = {};
	let lastKey = null;
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i += 1;
			continue;
		}
		if (!/^[ \t]/.test(line)) break; // dedent → the nested block ends
		const trimmed = line.trim();
		const item = /^-\s+(.*)$/.exec(trimmed);
		if (item) {
			if (lastKey !== null) {
				if (!Array.isArray(out[lastKey])) out[lastKey] = [];
				out[lastKey].push(parseScalar(item[1]));
			}
			i += 1;
			continue;
		}
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
		if (!match) {
			i += 1;
			continue;
		}
		const inline = parseInlineArray(match[2]);
		out[match[1]] = inline !== null ? inline : parseScalar(match[2]);
		lastKey = match[1];
		i += 1;
	}
	return { value: out, end: i - 1 };
}
/**
 * Parse frontmatter text into the fields the manager consumes.
 * Returns { fields, raw } where fields is the canonical view and raw keeps
 * every parsed key→value for display.
 */
function parseFrontmatterText(fmText) {
	const fields = { name: null, description: null, whenToUse: null, disableModelInvocation: null, userInvocable: null, metadata: null };
	const raw = {};
	const lines = fmText.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
		if (!match) continue;
		const key = match[1];
		const rest = match[2].trim();
		// literal / folded block value
		if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-" || rest === "|+" || rest === ">+") {
			const block = [];
			i += 1;
			while (i < lines.length) {
				const line = lines[i];
				if (line.trim() === "") {
					block.push("");
					i += 1;
					continue;
				}
				if (line.startsWith(" ") || line.startsWith("\t")) {
					block.push(line.replace(/^[ \t]+/, ""));
					i += 1;
					continue;
				}
				break;
			}
			i -= 1;
			const value = block.join("\n").trimEnd();
			raw[key] = value;
			const canonical = KEY_ALIASES[key] ?? key;
			if (canonical in fields) fields[canonical] = value;
			continue;
		}
		// nested object block (one level): a bare `key:` followed by indented
		// children. This is how `metadata:` — the official carrier for a
		// skill's custom fields (e.g. a grouping label) — is written.
		if (rest === "") {
			const next = lines[i + 1];
			if (next !== undefined && /^[ \t]/.test(next) && next.trim() !== "") {
				const nested = parseNestedBlock(lines, i + 1);
				raw[key] = nested.value;
				const canonicalNested = KEY_ALIASES[key] ?? key;
				if (canonicalNested in fields) fields[canonicalNested] = nested.value;
				i = nested.end;
				continue;
			}
		}
		const value = parseScalar(rest);
		raw[key] = value;
		const canonical = KEY_ALIASES[key] ?? key;
		if (canonical in fields) fields[canonical] = value;
	}
	return { fields, raw };
}
/** Split a skill file into { fmText, body, fields } (fmText null when absent). */
export function parseSkillFile(fileText) {
	const text = stripBom(fileText);
	const match = FRONTMATTER_RE.exec(text);
	if (!match) {
		return {
			fmText: null,
			body: text,
			fields: { name: null, description: null, whenToUse: null, disableModelInvocation: null, userInvocable: null, metadata: null }
		};
	}
	const fmText = match[1];
	const parsed = parseFrontmatterText(fmText);
	return { fmText, body: text.slice(match[0].length), fields: parsed.fields, raw: parsed.raw };
}
/** Resolve project root: nearest ancestor containing a .git entry, else cwd. */
export async function findProjectRoot(cwd) {
	let current = resolve(cwd ?? process.cwd());
	for (;;) {
		try {
			await stat(join(current, ".git"));
			return current;
		} catch {
			// continue walking up
		}
		const parent = dirname(current);
		if (parent === current) return resolve(cwd ?? process.cwd());
		current = parent;
	}
}
/** Ordered skill roots for a workspace: project first, then user roots. */
export async function skillRoots(cwd) {
	const projectRoot = await findProjectRoot(cwd);
	const userRoots = [
		{ path: join(homedir(), ".dsh", "skills"), source: "user-dsh", projectRoot },
		{ path: join(homedir(), ".agents", "skills"), source: "user-agents", projectRoot }
	];
	// When the project root IS the home directory (no .git ancestor), the
	// project's `<root>/.agents/skills` is the same directory as the user's —
	// scan it once under its user-root identity.
	const userPaths = new Set(userRoots.map((root) => root.path));
	const roots = [];
	for (const rel of [".dsh/skills", ".agents/skills"]) {
		const rootPath = join(projectRoot, rel);
		if (userPaths.has(rootPath)) continue;
		roots.push({ path: rootPath, source: rel.startsWith(".dsh") ? "project-dsh" : "project-agents", projectRoot });
	}
	roots.push(...userRoots);
	// 其它 Agent 的只读来源（默认不开）：
	// - 显式设置了对应 DSH_*_HOME → 扫
	// - 或 DSH_STUDIO_SCAN_ALL_AGENTS=1 → 扫所有「目录存在」的 Agent 根
	// 出厂只扫 DSH + ~/.agents（+ 项目级），减少家目录/网络盘上的无谓 stat。
	const scanAllAgents = /^(1|true|yes)$/i.test(String(process.env.DSH_STUDIO_SCAN_ALL_AGENTS ?? ""));
	for (const agent of AGENT_ROOTS) {
		const envSet = agent.env !== "" && process.env[agent.env] !== undefined && process.env[agent.env] !== "";
		if (!envSet && !scanAllAgents) continue;
		const bases = envSet ? [process.env[agent.env]] : agent.dirs.map((dir) => join(homedir(), dir));
		for (const base of bases) {
			const rootPath = join(base, "skills");
			if (userPaths.has(rootPath)) continue;
			if (await dirExists(rootPath)) roots.push({ path: rootPath, source: agent.source, projectRoot });
		}
	}
	// Extra custom dirs (env) + the per-user configured mirror dir (e.g. the
	// Obsidian skill library), so the panel also sees/edits those skills.
	for (const dir of customSkillDirs()) {
		roots.push({ path: dir, source: "custom", projectRoot });
	}
	for (const dir of await configuredExtraSkillDirs()) {
		roots.push({ path: dir, source: "custom", projectRoot });
	}
	return roots;
}
/**
 * 路径是否落在当前工作区的某个技能根内（含根目录本身）。
 * 回收站用它来禁止把根目录整棵扔掉，也用来校验恢复目标。
 * @returns {Promise<string | null>} 命中的根路径；不在任何根内则 null。
 */
export async function isUnderSkillRoot(target, cwd) {
	if (typeof target !== "string" || target === "") return null;
	const full = resolve(target);
	for (const root of await skillRoots(cwd)) {
		if (isInside(root.path, full)) return root.path;
	}
	return null;
}

/** Whether `path` is an existing directory. */
async function dirExists(path) {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}
/** `path` 指向的文件存在时返回它的 stat（跟随符号链接），否则 null。 */
async function statFile(path) {
	try {
		const info = await stat(path);
		return info.isFile() ? info : null;
	} catch {
		return null;
	}
}
/** List one directory's direct child names (resilient). */
async function listDir(path) {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries;
	} catch {
		return [];
	}
}
/**
 * Scan one root for skills: top-level <name>/SKILL.md or <name>.md, plus one
 * level of nesting for directories that have no SKILL.md themselves.
 * Pushes raw candidates (name/path/mtimeMs/size/source/nested/parent) into
 * `out`. mtimeMs + size 是解析缓存的校验值（见 parseCache 头注）。
 */
async function scanRoot(rootPath, source, out) {
	const entries = await listDir(rootPath);
	for (const entry of entries) {
		const entryPath = join(rootPath, entry.name);
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const ownSkill = join(entryPath, "SKILL.md");
			const ownStat = await statFile(ownSkill);
			if (ownStat !== null) {
				out.push({ name: entry.name, path: ownSkill, mtimeMs: ownStat.mtimeMs, size: ownStat.size, dir: entryPath, source, nested: false, parent: null });
				continue;
			}
			// nested expansion (one level)
			const subs = await listDir(entryPath);
			for (const sub of subs) {
				if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
				const subSkill = join(entryPath, sub.name, "SKILL.md");
				const subStat = await statFile(subSkill);
				if (subStat !== null) {
					out.push({ name: sub.name, path: subSkill, mtimeMs: subStat.mtimeMs, size: subStat.size, dir: join(entryPath, sub.name), source, nested: true, parent: entry.name });
				}
			}
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			const ownStat = await statFile(entryPath);
			if (ownStat === null) continue;
			out.push({ name: entry.name.slice(0, -3), path: entryPath, mtimeMs: ownStat.mtimeMs, size: ownStat.size, dir: rootPath, source, nested: false, parent: null });
		}
	}
}
/**
 * 扫描器解析缓存（OPT-01 / OPT-02 → N-11 条目级缓存）。
 *
 * 面板的 list / get / policy 每次都走 scanSkills，而它会把每棵 roots 全量 walk 一遍，
 * 再逐个候选文件读全文 + 解析 frontmatter。目录枚举（scanRoot 的 readdir/stat）保留，
 * 「读全文 + 解析」按文件缓存：
 *
 *   键：候选文件身份的规范路径 —— realpath(路径) 成功就用它的返回值，失败退化 resolve()。
 *       与 upstream.js 的 realpath 归一去重同源；同一文件经软链或从不同根进来共用一条缓存。
 *       规范化结果按 resolve(路径) 存一份映射（canonicalPaths），命中校验时不必再 realpath。
 *   校验：(mtimeMs, size)。复扫时每次枚举都 stat，两项与缓存一致 → 不打开文件，直接复用
 *       上次 parseSkillFile 的 fields 组装条目；任一不同 / 无缓存 → 重新 realpath 确认身份、
 *       读全文重新解析并覆盖缓存（缓存只留 fields，不留正文）。
 *   正文：列表路径不附带 content。打开/编辑时用 readSkillText(path) 按需读盘。
 *       借鉴 hermes-agent 的 skills_list（只回 name/description）与 skill_view（再读全文），
 *       以及 dexter 的 metadata cache + getSkill 再加载。
 *       来源：https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py
 *            https://github.com/virattt/dexter/blob/7419deb7/src/skills/registry.ts
 *   淘汰：每次扫描结束把本轮枚举到的路径与规范路径记成 live 集，映射表与解析缓存里不在
 *       live 集的条目立即删除——文件被删、不再属于任何 root、或读不出来（readFile 失败，
 *       旧行为就是跳过）都会连缓存一起消失。缓存规模因此不超过一次扫描可见的候选文件数，
 *       不会无界增长。
 *
 * 失效语义：内容改动在**下一次扫描**就可见。旧实现是「roots 目录 mtime 指纹 + 2 秒 TTL」，
 * 改文件内容不动目录 mtime，只能靠 TTL 兜住，最多 2 秒陈旧；这里把陈旧窗口收成 0。
 * 已知边界：mtime 与 size 都不变的改写看不出来（例如等长原地改字节、再把时间戳回拨）。
 * 同一个边界也让「路径的软链目标被换成另一个 mtime/size 完全相同的文件」看不出来——两种情况
 * 都要 stat 值不变才会漏，旧实现在这两点上都同样看不见（目录 mtime 也不变），不是回退。
 */
const parseCache = new Map();
/** resolve(路径) → 规范路径（realpath 结果，失败退化 resolve 本身）：热路径靠它免掉 realpath。 */
const canonicalPaths = new Map();

/**
 * 写路径显式失效（save / policy / trash / restore）。
 * 借鉴：agent-skill-manager 在 mutation 后重扫；hermes-agent skills_tool 用签名缓存，写后需失效。
 * 来源：https://github.com/dees91/agent-skill-manager 、https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py
 */
export function invalidateScanCache(path) {
	lastScan = null;
	// B6：知道写的是哪个文件时只作废那一条（以前每次保存都清空整个解析缓存，面板随后重拉列表时
	// 全部技能重新 realpath + 读 + 解析一遍）。不知道（回收站批量、快照恢复、外部回调）就仍整个清空。
	if (typeof path === "string" && path !== "") {
		const key = resolve(path);
		const canonical = canonicalPaths.get(key);
		canonicalPaths.delete(key);
		parseCache.delete(canonical ?? key);
		return;
	}
	parseCache.clear();
	canonicalPaths.clear();
}

/**
 * B6：按名查找的短时记忆。findSkillByName 以前每次都完整扫一遍所有根（面板打开一个技能、
 * 每次保存 / 改策略前都要找一次）。上一轮扫描结果在 FIND_MEMO_MS 内、且期间没有任何写入作废时复用它定位，
 * 命中后再 stat 一次确认文件还在原处；找不到 / 过期 / 文件不在了就退回完整扫描。正文与 mtime 由调用方现读，
 * 复用的只是「名字 → 路径」这层映射。
 */
const FIND_MEMO_MS = 2000;
let lastScan = null;


/** 规范路径（缓存键）：realpath 优先，失败退化 resolve。 */
async function canonicalPath(path) {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

/**
 * 冷路径的规范化预取：串行 realpath 比读一个 SKILL.md 还贵，476 个文件串行要 70ms+，
 * 限流 32 并发压到 15ms 量级。只处理映射表里没有的路径，热路径因此一次都不调。
 */
const CANONICAL_CONCURRENCY = 32;
async function prefetchCanonical(paths) {
	let cursor = 0;
	const worker = async () => {
		while (cursor < paths.length) {
			const path = paths[cursor];
			cursor += 1;
			canonicalPaths.set(path, await canonicalPath(path));
		}
	};
	await Promise.all(Array.from({ length: Math.min(CANONICAL_CONCURRENCY, paths.length) }, worker));
}

/** metadata 浅拷贝（值里只有一层数组），避免复用缓存时下游改写串到下一条。 */
function copyMetadata(meta) {
	const out = {};
	for (const [key, value] of Object.entries(meta)) out[key] = Array.isArray(value) ? value.slice() : value;
	return out;
}

/**
 * Scan every standard root for a workspace and return normalized skill
 * candidates (frontmatter name preferred; duplicates disambiguated with a
 * parent prefix; sorted by final name).
 */
export async function scanSkills(cwd, { includeContent = false } = {}) {
	const roots = await skillRoots(cwd);
	const raw = [];
	const seenRoots = new Set();
	for (const root of roots) {
		if (seenRoots.has(root.path)) continue;
		seenRoots.add(root.path);
		await scanRoot(root.path, root.source, raw);
	}
	const liveKeys = new Set();
	const livePaths = new Set();
	const usedNames = new Set();
	const firstByName = new Map();
	const skills = [];
	// 冷路径预取：本轮还没见过规范化结果的候选路径，一次性并发算出来
	const missing = new Set();
	for (const candidate of raw) {
		const pathKey = resolve(candidate.path);
		if (!canonicalPaths.has(pathKey)) missing.add(pathKey);
	}
	if (missing.size > 0) await prefetchCanonical([...missing]);
	for (const candidate of raw) {
		const pathKey = resolve(candidate.path);
		livePaths.add(pathKey);
		let text;
		let fields;
		const known = canonicalPaths.get(pathKey);
		const warm = known === undefined ? undefined : parseCache.get(known);
		if (warm !== undefined && warm.mtimeMs === candidate.mtimeMs && warm.size === candidate.size) {
			// 热路径：已知规范路径 + 校验值一致 → 不 realpath、不读文件（正文按需再读）
			fields = warm.fields;
			liveKeys.add(known);
			if (includeContent) {
				try {
					text = await readSkillText(candidate.path);
				} catch {
					continue;
				}
			}
		} else {
			// 冷路径 / 校验不符。校验不符时身份可能已变（软链替换），重新 realpath；
			// 只有映射缺省时才需要算，其余情况直接用预取/上一轮的结果。
			const canonical = warm !== undefined || known === undefined ? await canonicalPath(pathKey) : known;
			canonicalPaths.set(pathKey, canonical);
			liveKeys.add(canonical);
			const cached = parseCache.get(canonical);
			if (cached !== undefined && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) {
				fields = cached.fields;
				if (includeContent) {
					try {
						text = await readSkillText(candidate.path);
					} catch {
						continue;
					}
				}
			} else {
				try {
					text = stripBom(await readFile(candidate.path, "utf8"));
				} catch {
					parseCache.delete(canonical);
					continue; // unreadable → skip (mirrors provider behavior)
				}
				fields = parseSkillFile(text).fields;
				// 缓存只留 fields：列表不再把整份正文堆在内存里
				parseCache.set(canonical, { mtimeMs: candidate.mtimeMs, size: candidate.size, fields });
			}
		}
		// parseScalar 现在会把裸数字还原成 number（WO-FIX-2），文本字段一律 String 兜底
		const fmName = fields.name === null || fields.name === undefined ? "" : String(fields.name).trim();
		// A skill requires a frontmatter `name`; a top-level note like README.md
		// (or any Markdown without a name) is not a skill and is not shown/edited.
		if (!fmName) continue;
		// `metadata` is the official carrier for custom skill fields: a grouping
		// label rides `metadata.group`, optional extra labels ride
		// `metadata.tags`. Non-object values are ignored, mirroring the official
		// filesystem provider's contract.
		const rawMeta = fields.metadata;
		const metadata = typeof rawMeta === "object" && rawMeta !== null && !Array.isArray(rawMeta) ? copyMetadata(rawMeta) : null;
		const group = typeof metadata?.group === "string" ? metadata.group.trim() : "";
		const tags = Array.isArray(metadata?.tags) ? metadata.tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter((tag) => tag !== "") : [];
		let displayName = NAME_RE.test(fmName) ? fmName : candidate.name;
		const namedOk = NAME_RE.test(fmName);
		if (usedNames.has(displayName)) {
			// A custom/mirror entry duplicating a higher-priority (agent/project)
			// root is the same skill's mirror — drop it so it is listed once.
			if (candidate.source === "custom") continue;
			// other duplicate → qualify with parent (or full dir name) to stay unique
			const qualified = candidate.parent ? candidate.parent + "/" + displayName : basename(dirname(candidate.path)) + "/" + displayName;
			// · A8：同一个目录名出现在 3 个以上的根里时，上面那一步给出的都是 `foo/foo`，
			// 后面几份互相撞名、findSkillByName 只够得到第一个。还撞就带上根的来源标识，再撞（同来源多个根）追加序号。
			displayName = qualified;
			if (usedNames.has(displayName)) displayName = `${candidate.source}/${qualified}`;
			for (let n = 2; usedNames.has(displayName); n += 1) displayName = `${candidate.source}/${qualified}#${n}`;
		}
		usedNames.add(displayName);
		const entry = {
			name: displayName,
			description: fields.description === null || fields.description === undefined ? "" : String(fields.description),
			whenToUse: fields.whenToUse === null || fields.whenToUse === undefined ? null : String(fields.whenToUse),
			modelInvocable: fields.disableModelInvocation !== true,
			userInvocable: fields.userInvocable !== false,
			source: candidate.source,
			provider: "filesystem",
			path: candidate.path,
			dir: candidate.dir,
			nested: candidate.nested === true,
			parent: candidate.parent,
			group,
			tags,
			metadata,
			// 诊断用：宿主只认 kebab-case 的 frontmatter name
			declaredName: fmName,
			nameValid: namedOk,
			dirName: candidate.name
		};
		if (includeContent) entry.content = text;
		// 同名跨来源：先扫到的生效，后面的标出被谁盖住
		const prev = firstByName.get(fmName);
		if (prev === undefined) firstByName.set(fmName, entry);
		else if (prev.path !== candidate.path) {
			entry.shadowedBy = prev.name;
			prev.shadows = [...(prev.shadows ?? []), entry.name];
		}
		skills.push(entry);
	}
	// 淘汰：本轮没枚举到的路径与规范路径（文件删了 / 根不再包含它）连缓存一起丢弃
	for (const key of [...canonicalPaths.keys()]) if (!livePaths.has(key)) canonicalPaths.delete(key);
	for (const key of [...parseCache.keys()]) if (!liveKeys.has(key)) parseCache.delete(key);
	skills.sort((a, b) => a.name.localeCompare(b.name));
	if (!includeContent) lastScan = { cwd, at: Date.now(), skills };
	return skills.slice();
}
/** Find one filesystem skill by exact name (or parent/child path form). */
export async function findSkillByName(name, cwd) {
	const memo = lastScan;
	if (memo !== null && memo.cwd === cwd && Date.now() - memo.at < FIND_MEMO_MS) {
		const hit = memo.skills.find((skill) => skill.name === name);
		if (hit !== undefined) {
			try {
				if ((await stat(hit.path)).isFile()) return { ...hit, metadata: hit.metadata ? copyMetadata(hit.metadata) : hit.metadata, tags: hit.tags.slice() };
			} catch {
				/* 文件不在了：退回完整扫描 */
			}
		}
	}
	const skills = await scanSkills(cwd);
	return skills.find((skill) => skill.name === name) ?? null;
}
