/**
 * 技能的读写核心：frontmatter 行级改写、文件系统与 registry 两份目录的合并、
 * 详情读取、带 mtime 冲突检测的保存与启停策略。
 * （从 index.js 拆出，逻辑未改。）
 */
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { withFileLock } from "./state-lock.js";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { diffLines } from "./diff-lines.js";
import { UserError } from "./errors.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { versionedSkillWrite } from "./versions.js";
import { findSkillByName, invalidateScanCache, parseSkillFile, readSkillText, scanSkills, SKILL_NAME_RE, stripBom } from "./scanner.js";

/** Frontmatter block matcher: leading `---` fence pair. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** The two invocation keys this plugin toggles. */
const KEY_MODEL = "disable-model-invocation";
const KEY_USER = "user-invocable";
/** scanner 的 KEY_ALIASES 也认这个写法；开关只改规范键的话，别名行留在原地，技能照样是禁用的。 */
const KEY_MODEL_ALIASES = ["disable-model-invocable"];
/**
 * Split a skill file into { frontmatter, body }. `frontmatter` is the raw
 * YAML text between the fences (no fences), or null when there is no block.
 */
function splitFrontmatter(fileText) {
	const match = FRONTMATTER_RE.exec(fileText);
	if (!match) return { frontmatter: null, body: fileText };
	return { frontmatter: match[1], body: fileText.slice(match[0].length) };
}
/** Index of the first line whose key is `key:` (top-level YAML key), else -1. */
function findKeyLine(lines, key) {
	const re = new RegExp("^" + key + "\\s*:");
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) return i;
	}
	return -1;
}
/**
 * Apply invocation-policy changes to a frontmatter text (line-level surgery):
 * set → upsert the key line, unset → delete the key line. `changes` carries
 * only the keys that should change; everything else is preserved verbatim.
 * Returns the new frontmatter text (may be "" when all lines were removed).
 */
function applyPolicy(frontmatter, changes) {
	const lines = frontmatter === null ? [] : frontmatter.split("\n");
	const setKey = (key, value) => {
		const idx = findKeyLine(lines, key);
		if (idx >= 0) lines[idx] = key + ": " + value;
		else lines.push(key + ": " + value);
	};
	const unsetKey = (key) => {
		for (let idx = findKeyLine(lines, key); idx >= 0; idx = findKeyLine(lines, key)) lines.splice(idx, 1);
	};
	if (changes.modelInvocable === true || changes.modelInvocable === false) {
		// 别名行一律先清掉，再按规范键写；否则「启用」只删规范键、别名还在，返回成功但技能仍是禁用的
		for (const alias of KEY_MODEL_ALIASES) unsetKey(alias);
	}
	if (changes.modelInvocable === true) unsetKey(KEY_MODEL);
	else if (changes.modelInvocable === false) setKey(KEY_MODEL, "true");
	if (changes.userInvocable === true) unsetKey(KEY_USER);
	else if (changes.userInvocable === false) setKey(KEY_USER, "false");
	return lines.join("\n");
}
/**
 * Rebuild a skill file from its original text and an (optional) new frontmatter
 * text. Creates a frontmatter block only when the file had none and the new
 * frontmatter is non-empty; keeps the block when it already existed.
 */
function assembleFile(fileText, nextFrontmatter) {
	const parsed = splitFrontmatter(fileText);
	const fm = nextFrontmatter === null ? null : nextFrontmatter.trim();
	if (parsed.frontmatter === null) {
		if (fm) return "---\n" + fm + "\n---\n" + parsed.body;
		return parsed.body;
	}
	return "---\n" + (fm ?? "") + "\n---\n" + parsed.body;
}
/** Normalize a cwd query value (empty/undefined → undefined = process cwd). */
function resolveCwd(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return void 0;
	return resolve(raw);
}
/** Read `metadata.group` from a skill's metadata object ("" when absent). */
function metadataGroup(metadata) {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return "";
	return typeof metadata.group === "string" ? metadata.group.trim() : "";
}
/** Read `metadata.tags` from a skill's metadata object ([] when absent). */
function metadataTags(metadata) {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return [];
	if (!Array.isArray(metadata.tags)) return [];
	return metadata.tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter((tag) => tag !== "");
}
/** Project a filesystem-scanned skill to the plain summary shape. */
function fsToSummary(skill) {
	return {
		name: skill.name,
		description: skill.description,
		whenToUse: skill.whenToUse ?? "",
		source: skill.source,
		provider: skill.provider,
		modelInvocable: skill.modelInvocable === true,
		userInvocable: skill.userInvocable === true,
		editable: true,
		nested: skill.nested === true,
		parent: skill.parent ?? "",
		group: typeof skill.group === "string" ? skill.group : "",
		tags: Array.isArray(skill.tags) ? skill.tags : [],
		declaredName: skill.declaredName ?? "",
		nameValid: skill.nameValid !== false,
		dirName: skill.dirName ?? "",
		dir: skill.dir ?? "",
		shadowedBy: skill.shadowedBy ?? "",
		shadows: Array.isArray(skill.shadows) ? skill.shadows : []
	};
}
/** Project a registry summary to the plain summary shape (read-only here). */
function registryToSummary(skill) {
	return {
		name: skill.name,
		description: skill.description,
		whenToUse: typeof skill.whenToUse === "string" ? skill.whenToUse : "",
		source: skill.source,
		provider: skill.provider,
		modelInvocable: skill.invocation.modelInvocable === true,
		userInvocable: skill.invocation.userInvocable === true,
		editable: false,
		nested: false,
		parent: "",
		group: metadataGroup(skill.metadata),
		tags: metadataTags(skill.metadata)
	};
}
/**
 * List every visible skill for a workspace: filesystem scan (authoritative
 * for disk skills) merged with registry skills that are not the filesystem
 * provider (runtime / bundled / other providers).
 */
/**
 * registry 技能的摘要缓存。
 *
 * `ctx.skills.list()` 每次要几秒（它要问所有 provider），而 bundled/runtime
 * 那批技能几乎不变。所以：
 *   - 首次用磁盘缓存里的摘要立刻返回
 *   - 后台刷新，下次请求生效
 * 这样面板不再等那几秒。
 */
const REGISTRY_CACHE_FILE = () => resolve(homedir(), ".dsh", "dsh-studio", "registry-cache.json");
let registrySummaries = null;
let registryLoading = false;
async function loadRegistrySummaries() {
	if (registrySummaries !== null) return registrySummaries;
	try {
		const parsed = JSON.parse(await readFile(REGISTRY_CACHE_FILE(), "utf8"));
		if (Array.isArray(parsed?.summaries)) registrySummaries = parsed.summaries;
	} catch {
		/* 没有缓存，第一次为空 */
	}
	return registrySummaries ?? [];
}
// B6：registry 摘要（运行时 / 内置技能，几乎不变）的后台刷新加 TTL——以前每次列表请求都触发一次完整的
// ctx.skills.list() 并重写缓存文件。TTL 内同一 cwd 不再刷新；内容没变就不重写缓存文件。
const REGISTRY_TTL_MS = 60_000;
let registryRefreshedAt = 0;
let registryRefreshedCwd = null;
let registryCacheText = null;
function warmRegistry(ctx, cwd) {
	if (registryLoading) return;
	if (registryRefreshedCwd === cwd && Date.now() - registryRefreshedAt < REGISTRY_TTL_MS) return;
	registryLoading = true;
	ctx.skills
		.list({ cwd })
		.then(async (list) => {
			const summaries = list.filter((skill) => skill.provider !== "filesystem").map(registryToSummary);
			registrySummaries = summaries;
			registryRefreshedAt = Date.now();
			registryRefreshedCwd = cwd;
			const text = JSON.stringify(summaries);
			if (text === registryCacheText) return;
			try {
				await mkdir(dirname(REGISTRY_CACHE_FILE()), { recursive: true });
				await writeFile(REGISTRY_CACHE_FILE(), JSON.stringify({ at: Date.now(), summaries }), "utf8");
				registryCacheText = text;
			} catch {
				/* 缓存写不进去不影响本次结果 */
			}
		})
		.catch((error) => {
			ctx.logger?.warn?.(`[dsh-studio] registry 摘要刷新失败：${error instanceof Error ? error.message : String(error)}`);
		})
		.finally(() => {
			registryLoading = false;
		});
}
async function listSkills(ctx, cwd) {
	const fsSkills = await scanSkills(cwd);
	const summaries = new Map();
	for (const skill of fsSkills) {
		const summary = fsToSummary(skill);
		summaries.set(summary.name, summary);
	}
	for (const summary of await loadRegistrySummaries()) {
		if (!summaries.has(summary.name)) summaries.set(summary.name, summary);
	}
	warmRegistry(ctx, cwd); // 后台刷新，不阻塞这次请求
	return [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** Load one skill's full detail (body + path), or null. */
/** 读文件的 mtimeMs；文件不存在时返回 0。 */
async function stampOf(path) {
	try {
		const info = await stat(path);
		return { mtimeMs: info.mtimeMs, size: info.size };
	} catch {
		return { mtimeMs: 0, size: 0 };
	}
}

function stampsMatch(expected, actual) {
	return Math.round(Number(expected)) === Math.round(Number(actual));
}

/**
 * 保存前核对磁盘 mtime。调用方没给 expectedMtime 时不拦（旧客户端 / 工具兼容）。
 * overwrite=true 时强制覆盖。mtime 变了但正文与要写入的相同，视为无需改写。
 * 借鉴 HTTP If-Match / 409 Conflict（RFC 9110）。
 */
async function assertUnchanged(path, incoming, expectedMtime, overwrite) {
	if (overwrite === true) return;
	if (expectedMtime === undefined || expectedMtime === null || expectedMtime === "") return;
	const expected = Number(expectedMtime);
	if (!Number.isFinite(expected)) return;
	let info;
	try {
		info = await stat(path);
	} catch {
		throw new UserError("磁盘上已经找不到这个文件，没有保存。请重新加载列表。", 409, { code: "SKILL_CHANGED" });
	}
	if (stampsMatch(expected, info.mtimeMs)) return;
	let current = "";
	try {
		current = await readSkillText(path);
	} catch {
		current = "";
	}
	if (typeof incoming === "string" && incoming === current) return;
	const diff = typeof incoming === "string" ? diffLines(current, incoming) : [];
	throw new UserError("磁盘上的文件已经改过，没有保存。你可以重新加载后再改，或选择覆盖。", 409, {
		code: "SKILL_CHANGED",
		payload: { current, mtimeMs: info.mtimeMs, size: info.size, diff }
	});
}

async function getSkillDetail(ctx, skillName, cwd) {
	// filesystem first (has real content + path)
	const fsSkill = await findSkillByName(skillName, cwd);
	if (fsSkill) {
		let content = "";
		try {
			content = await readSkillText(fsSkill.path);
		} catch {
			content = "";
		}
		const stamp = await stampOf(fsSkill.path);
		return {
			...fsToSummary(fsSkill),
			path: fsSkill.path,
			dir: fsSkill.dir ?? "",
			content,
			metadata: fsSkill.metadata ?? {},
			mtimeMs: stamp.mtimeMs,
			size: stamp.size
		};
	}
	// registry fallback (runtime / bundled / other providers)
	const skill = await ctx.skills.get(skillName, { cwd });
	if (!skill) return null;
	const path = typeof skill.path === "string" ? skill.path : "";
	const stamp = path ? await stampOf(path) : { mtimeMs: 0, size: 0 };
	return {
		...registryToSummary(skill),
		path,
		dir: "",
		editable: path.length > 0,
		content: typeof skill.content === "string" ? skill.content : "",
		metadata: skill.metadata ?? {},
		mtimeMs: stamp.mtimeMs,
		size: stamp.size
	};
}
/** Registry/scanner-backed, path-safe write guard: resolve the file for `name`. */
async function editableFile(ctx, skillName, cwd, action) {
	const fsSkill = await findSkillByName(skillName, cwd);
	if (fsSkill) return fsSkill;
	const skill = await ctx.skills.get(skillName, { cwd });
	if (!skill) throw new UserError("找不到这个技能：" + skillName, 404);
	if (typeof skill.path !== "string" || !skill.path) {
		throw new UserError("skill \"" + skillName + "\"（" + skill.source + "/" + skill.provider + "）没有可写文件，不能" + action + "。这是内置技能，只能查看。");
	}
	return { name: skill.name, path: skill.path, source: skill.source, provider: skill.provider };
}
/** 保存前检查 frontmatter 的 name，避免写完后技能在列表里消失或改名。 */
function assertSavableContent(skill, content) {
	const parsed = parseSkillFile(content);
	const fmName = parsed.fields.name === null || parsed.fields.name === undefined ? "" : String(parsed.fields.name).trim();
	if (fmName === "") throw new UserError("开头的 --- 里要写 name，这次没有保存。");
	if (!SKILL_NAME_RE.test(fmName)) throw new UserError("name 只能用小写字母、数字和连字符，这次没有保存。");
	const declared = typeof skill.declaredName === "string" ? skill.declaredName.trim() : "";
	const listName = typeof skill.name === "string" ? skill.name : "";
	if (declared !== "" && SKILL_NAME_RE.test(declared) && fmName !== declared) {
		throw new UserError("frontmatter 里的 name 要和技能名「" + declared + "」一致，这次没有保存。");
	}
	if (declared === "" && listName !== "" && fmName !== listName && !listName.endsWith("/" + fmName)) {
		throw new UserError("frontmatter 里的 name 要和技能名「" + listName + "」一致，这次没有保存。");
	}
}

// 文件别名共用锁；锁留在插件数据目录，不能混进技能正文/版本对象。
// 锁顺序：技能编辑锁 → versionedSkillWrite 内部历史锁。其他写入口不在此处重入。
async function withSkillEditLock(path, fn) {
	let canonical;
	try {
		canonical = await realpath(path);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		// 保留旧 provider 可写但尚未存在的文件路径。
		canonical = resolve(path);
	}
	if (process.platform === "win32") canonical = canonical.toLowerCase();
	const key = createHash("sha256").update(canonical).digest("hex");
	return withFileLock(resolve(homedir(), ".dsh", "dsh-studio", "skill-writes", key), fn);
}

async function saveSkill(ctx, args, cwd) {
	const skill = await editableFile(ctx, args.name, cwd, "编辑");
	if (typeof args.content !== "string" || args.content.length === 0) {
		throw new UserError("内容不能为空。");
	}
	assertSavableContent(skill, args.content);
	return withSkillEditLock(skill.path, async () => {
		await assertUnchanged(skill.path, args.content, args.expectedMtime, args.overwrite === true);
		// · G2：全文保存记一条版本（只改分组 / 只改调用策略时自动细化成 group-change / policy）
		await versionedSkillWrite(skill.path, { action: "edit" }, () => atomicWriteFile(skill.path, args.content, "utf8"));
		invalidateScanCache(skill.path);
		const stamp = await stampOf(skill.path);
		return {
			ok: true,
			message: "已保存 " + skill.name + "（" + skill.path + "）",
			path: skill.path,
			bytes: Buffer.byteLength(args.content, "utf8"),
			mtimeMs: stamp.mtimeMs
		};
	});
}
/**
 * Apply an invocation-policy change to a skill's frontmatter.
 * `enabled: true/false` is the convenience master switch (both interfaces);
 * `modelInvocable` / `userInvocable` override one side independently.
 */
async function savePolicy(ctx, args, cwd) {
	const skill = await editableFile(ctx, args.name, cwd, "设置启用状态");
	const changes = {};
	if (args.enabled === true) {
		changes.modelInvocable = true;
		changes.userInvocable = true;
	} else if (args.enabled === false) {
		changes.modelInvocable = false;
		changes.userInvocable = false;
	}
	if (typeof args.modelInvocable === "boolean") changes.modelInvocable = args.modelInvocable;
	if (typeof args.userInvocable === "boolean") changes.userInvocable = args.userInvocable;
	if (Object.keys(changes).length === 0) {
		throw new UserError("没有可应用的策略变更（请提供 enabled / modelInvocable / userInvocable 之一）");
	}
	return withSkillEditLock(skill.path, async () => {
		// 先剥 BOM 再做 frontmatter 手术：带 BOM 的文件 FRONTMATTER_RE 匹配不上，旧写法会在 BOM 前面再塞一段
		// frontmatter，原来那段（含 name）沦为正文，技能直接从列表里消失。扫描器本来就容忍 BOM（readSkillText）。
		const raw = stripBom(await readFile(skill.path, "utf8"));
		const parsed = splitFrontmatter(raw);
		const next = assembleFile(raw, applyPolicy(parsed.frontmatter, changes));
		await assertUnchanged(skill.path, next, args.expectedMtime, args.overwrite === true);
		await versionedSkillWrite(skill.path, { action: "policy" }, () => atomicWriteFile(skill.path, next, "utf8"));
		invalidateScanCache(skill.path);
		const current = parseSkillFile(raw);
		const stamp = await stampOf(skill.path);
		return {
			ok: true,
			message: "已更新 " + skill.name + " 的调用策略",
			path: skill.path,
			modelInvocable: changes.modelInvocable ?? current.fields.disableModelInvocation !== true,
			userInvocable: changes.userInvocable ?? current.fields.userInvocable !== false,
			mtimeMs: stamp.mtimeMs
		};
	});
}

export { applyPolicy, assembleFile, getSkillDetail, listSkills, resolveCwd, savePolicy, saveSkill, splitFrontmatter, warmRegistry };
