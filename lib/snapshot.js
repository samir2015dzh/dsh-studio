/**
 * 配置快照：把 `~/.dsh` 里该备份的配置文件收集起来，打成 tar.gz；
 * 恢复时先给当前状态打一份、再逐文件覆盖，SHA 不符的跳过并报告。
 *
 * 设计取舍：
 *   - tar.gz 而不是 zip：Node 只有 zlib，手写 tar 头 512 字节比写 ZIP 中央目录简单得多，
 *     解压也不依赖外部命令。
 *   - 白名单而不是黑名单：`~/.dsh` 里有 sessions（几百 MB）、node_modules、asar 缓存，
 *     按黑名单迟早漏；白名单列不全时最多是少备份，不会把会话日志塞进备份包。
 *   - 密钥永远不进去：`.credentials.yaml` 与它所在目录一律跳过，不看调用方参数；
 *     白名单目录里含密钥的 JSON（extractor.json 的 llmApiKey、mcp.json 的
 *     Authorization / env 密钥）在打包时按字段换成占位符，恢复时不覆盖目标机现值。
 */
import { createHash } from "node:crypto";
import { createGunzip, createGzip, gzipSync, gunzipSync } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ATOMIC_TMP_RE, atomicWriteFile } from "./fs-atomic.js";
import { CREDENTIAL_FILE_MODE, hardenPermissions } from "./fs-perms.js";
import { removeDirForcibly } from "./command.js";
import { assertSnapshotId, isSafeEntryPath, splitSourceUrl } from "./paths.js";
import { REDACTED, isSensitiveField, looksLikeSecretValue, rewriteArgSecrets, rewriteUrlSecrets } from "./redact.js";
import { withFileLock } from "./state-lock.js";
import { UserError, notFound } from "./errors.js";
import { invalidateScanCache } from "./scanner.js";
import { HISTORY_LOG, historyRoot, mergeVersionLogText } from "./history-paths.js";

/** DSH 根目录。 */
const dshHome = () => resolve(homedir(), ".dsh");
/** 快照仓库。 */
export const snapshotsDir = () => resolve(dshHome(), "dsh-studio", "snapshots");

/**
 * 永远不进快照：密钥、会话日志、依赖、asar，以及版本控制内部数据。
 *
 * `.git` / `.svn` / `.hg` 是 VCS 的元数据目录，不是用户内容：真机 `~/.agents/skills`
 * 里就有带 `.git` 的 skill（huashu-design 的 pack 单文件 36.9 MB）。这类条目直接过滤，
 * 既不进包也不记进 SKIPPED.json —— SKIPPED 只记「太大了所以跳过」的用户文件（C-7）。
 * 只匹配整段目录名，`.gitignore` / `.github` 这类用户可见文件照常保留。
 */
const ALWAYS_SKIP = [
	/\.credentials\.yaml$/i,
	/(^|[\\/])node_modules([\\/]|$)/,
	/(^|[\\/])sessions([\\/]|$)/,
	/\.asar(\.unpacked)?$/i,
	/(^|[\\/])\.(git|svn|hg)([\\/]|$)/i,
	// 审计 1/2：损坏留档（mcp.json / sync.json / 凭据暂存的 *.corrupt-*）与损坏闸文件——
	// 坏 JSON 无法脱敏，里面可能是明文凭据，一律不进快照、不出机
	/\.corrupt-[^\\/]*$/
];

/** 脱敏占位符：包内看到它就知道「这里原本有值，但不在这里」。定义在 redact.js（版本史 / 备份包 / 快照共用）。 */
export { REDACTED };

/**
 * 含内嵌占位符（参数 / URL 里只换掉凭据那一段，）的凭据文件在包里挂到这个前缀下。
 * 旧版 dsh-studio 不认识内嵌占位符，会把它原样当凭据写回目标机；挂到白名单之外的前缀下，旧版恢复时
 * 这一条落进 skippedPaths（路径本身说明「要新版才能恢复」），整份不写，而不是写进一份带占位符的配置。
 * 只有整字段占位符的凭据文件照旧放在原路径——旧版本来就能正确处理它们。
 */
export const NEEDS_NEWER_PREFIX = "needs-newer-dsh-studio/";

/** createSnapshot 在白名单里一个文件都没有时抛的错误码（全新机器；恢复侧据此判断「没东西可保护」）。 */
export const SNAPSHOT_EMPTY = "SNAPSHOT_EMPTY";

/** 会被字段级脱敏的配置文件（相对 `~/.dsh`）。 */
export const CREDENTIAL_FILES = new Set(["dsh-studio/extractor.json", "dsh-studio/mcp.json"]);

// 凭据键名与 mcp.js / index.js 共用 lib/redact.js 那一份（C-5），不再各写一遍

/** 包内脱敏说明文件；恢复时不写回 `~/.dsh`。 */
export const REDACTED_NOTE = "REDACTED.json";

/** 包内「被跳过的大文件」说明（C-2）；同样不写回 `~/.dsh`。 */
export const SKIPPED_NOTE = "SKIPPED.json";

/**
 * 包内「只记链接、不打包内容」的 skill 清单（WO-LINK-1）。
 * 大 skill 的来源能确定时，包里只留 repo/ref/sha，恢复端自己拉。
 */
export const EXTERNAL_SKILLS_NOTE = "EXTERNAL_SKILLS.json";

/** 恢复端待拉取清单：写在目标 skill 根，字段与 skill-lock.json 对齐（WO-LINK-2）。 */
export const PENDING_PULLS_FILE = "PENDING_PULLS.json";

/** WO-LINK-1 阈值：skill 目录总大小超过 5 MB 且来源可确定，才改成只记链接。 */
const EXTERNAL_SKILL_MIN_BYTES = 5 * 1024 * 1024;

const execFileAsync = promisify(execFile);

/**
 * 一个字符串（URL 规则）或一组命令行参数（`args`，参数规则）里内嵌的凭据换成占位符。
 * 识别与展示侧的 maskUrlSecrets / maskArgs 是 redact.js 里同一份实现；返回的路径形如
 * `servers[0].url{query:exaApiKey}`、`servers[1].args{flag:--api-key}`，花括号里是恢复时按它补回的键。
 */
function redactEmbedded(value, path) {
	const hits = [];
	const replace = (key, original) => {
		if (original === "" || original === REDACTED) return original;
		hits.push(`${path}{${key}}`);
		return REDACTED;
	};
	const out = Array.isArray(value) ? rewriteArgSecrets(value, replace) : rewriteUrlSecrets(value, replace);
	return { value: out, hits };
}

const isStringArray = (value) => Array.isArray(value) && value.every((v) => typeof v === "string");

/**
 * 把一份配置 JSON 里的凭据就地换成占位符，返回被脱敏的字段路径。
 * - 整个字段是凭据：按键名判定，外加值本身一眼就是凭据的形态（厂商 token 前缀、`Bearer …`、带口令的 URL）——整值换掉；
 * - 字段里内嵌了凭据：`args` 里的 `--api-key xxx` / `--token=xxx` / 裸 token，任意字符串里 URL 的
 *   userinfo 与像凭据的查询参数——只换掉那一段，其余原样保留，恢复时按键补回。
 * 原本为空的值不算命中。
 */
export function redactCredentials(node, path = "") {
	const hits = [];
	if (Array.isArray(node)) {
		node.forEach((v, i) => {
			const here = `${path}[${i}]`;
			if (typeof v !== "string") {
				hits.push(...redactCredentials(v, here));
				return;
			}
			const r = redactEmbedded(v, here);
			if (r.hits.length > 0) {
				node[i] = r.value;
				hits.push(...r.hits);
			}
		});
		return hits;
	}
	if (node === null || typeof node !== "object") return hits;
	for (const [key, value] of Object.entries(node)) {
		const here = path === "" ? key : `${path}.${key}`;
		if (isSensitiveField(key, value)) {
			node[key] = REDACTED;
			hits.push(here);
		} else if (typeof value === "string" || (key === "args" && isStringArray(value))) {
			const r = redactEmbedded(value, here);
			if (r.hits.length > 0) {
				node[key] = r.value;
				hits.push(...r.hits);
			}
		} else hits.push(...redactCredentials(value, here));
	}
	return hits;
}

/** 这份（已脱敏的）JSON 里有没有内嵌占位符——即占位符只是某个字符串的一段，或在 `args` 里。 */
export function hasEmbeddedPlaceholder(node, key = "") {
	if (typeof node === "string") return node !== REDACTED && node.includes(REDACTED);
	if (Array.isArray(node)) return (key === "args" && node.includes(REDACTED)) || node.some((v) => hasEmbeddedPlaceholder(v));
	if (node === null || typeof node !== "object") return false;
	return Object.entries(node).some(([k, v]) => hasEmbeddedPlaceholder(v, k));
}

/**
 * 内嵌占位符按键补回：对目标机现值跑同一套识别取出各键的原值，模板里是占位符的那一段换成同键现值。
 * 现值里没有这个键的，占位符原样留着并记进 missing（不静默留空，也不拿别的键的值顶）。
 */
function fillEmbedded(template, current, missing, path, isArgs) {
	const known = new Map();
	const learn = (key, value) => {
		if (value !== "" && value !== REDACTED) known.set(key, value);
		return value;
	};
	if (isArgs) {
		if (isStringArray(current)) rewriteArgSecrets(current, learn);
	} else if (typeof current === "string") rewriteUrlSecrets(current, learn);
	let reported = 0;
	const fill = (key, value) => {
		if (value !== REDACTED) return value;
		if (known.has(key)) return known.get(key);
		missing?.push(`${path}{${key}}`);
		reported += 1;
		return value;
	};
	const out = isArgs
		? rewriteArgSecrets(template, fill, (v) => v === REDACTED || looksLikeSecretValue(v))
		: rewriteUrlSecrets(template, fill);
	// 识别规则认不出位置的占位符（手改过的包）补不回，也得报出来
	if (reported === 0 && (isArgs ? out.some((v) => v.includes(REDACTED)) : out.includes(REDACTED))) missing?.push(path);
	return out;
}

/**
 * 把包内 JSON 的占位符换回目标机现值。
 * - 整字段占位符：目标机有现值就用现值，没有就不留这个键；
 * - 内嵌占位符：按键补回同键现值，没有的占位符原样留着（配置一眼看得出缺什么，运行时也会拒绝带占位符连接）。
 * 两种补不回的都记进 `missing`（字段路径，内嵌的带 `{键}`），由调用方写进恢复报告。
 * 数组里带 `name` 的对象只按名字对齐（mcp.json 的 servers 顺序可能不同；名字对不上就是没有现值，
 * 不退回按下标配对——那会让一个 server 拿到排在同一位置的别的 server 的凭据），其余按索引。
 * @param {string[] | null} [missing]
 */
export function mergeRedacted(incoming, current, missing = null, path = "", fieldKey = "") {
	if (incoming === REDACTED) {
		if (typeof current === "string" && current !== "" && current !== REDACTED) return current;
		missing?.push(path);
		return undefined;
	}
	if (typeof incoming === "string") return incoming.includes(REDACTED) ? fillEmbedded(incoming, current, missing, path, false) : incoming;
	if (Array.isArray(incoming)) {
		if (fieldKey === "args" && isStringArray(incoming) && incoming.some((v) => v.includes(REDACTED))) {
			return fillEmbedded(incoming, current, missing, path, true);
		}
		const base = Array.isArray(current) ? current : [];
		const byName = new Map(
			base.filter((x) => x !== null && typeof x === "object" && typeof x.name === "string").map((x) => [x.name, x])
		);
		const out = [];
		incoming.forEach((value, i) => {
			const named = value !== null && typeof value === "object" && typeof value.name === "string";
			const peer = named ? byName.get(value.name) : base[i];
			const merged = mergeRedacted(value, peer, missing, `${path}[${i}]`);
			if (merged !== undefined) out.push(merged);
		});
		return out;
	}
	if (incoming !== null && typeof incoming === "object") {
		const base = current !== null && typeof current === "object" && !Array.isArray(current) ? current : {};
		const out = {};
		for (const [key, value] of Object.entries(incoming)) {
			const merged = mergeRedacted(value, base[key], missing, path === "" ? key : `${path}.${key}`, key);
			if (merged !== undefined) out[key] = merged;
		}
		return out;
	}
	return incoming;
}

/**
 * 恢复时把包内凭据文件与目标机现值合并：整字段占位符绝不写回，内嵌占位符按键补回。
 * 补不回的字段路径追加进 `missing`。
 * @param {string[] | null} [missing]
 */
async function mergeCredentialFile(target, incoming, missing = null) {
	let parsed;
	try {
		parsed = JSON.parse(incoming.toString("utf8").replace(/^\uFEFF/, ""));
	} catch {
		return incoming; // 坏 JSON 原样写回：解析不了就没法判断哪些是占位符
	}
	// 本机现值：不存在 → null（全新机器，包里的占位符直接丢掉）。存在但读不出 / 解析不了 → 拒绝：
	// 旧写法把它也当 null，包里的占位符没有现值可换，写回去的注册表凭据字段全空，本机原来那份明文凭据就此丢失。
	let current = null;
	let text = null;
	try {
		text = await readFile(target, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (text !== null) {
		try {
			current = JSON.parse(text.replace(/^\uFEFF/, ""));
		} catch (error) {
			throw new UserError(`本机 ${target} 存在但无法解析（${error instanceof Error ? error.message : String(error)}），为免冲掉里面的凭据，拒绝用快照覆盖它；修好或移走后再恢复`, 409);
		}
	}
	return Buffer.from(JSON.stringify(mergeRedacted(parsed, current, missing), null, 2) + "\n", "utf8");
}

/** 白名单：相对 `~/.dsh` 的路径。dir 表示整目录，profiles 表示只取两个文件。 */
const WHITELIST = [
	{ rel: "cordis.patch.yml", kind: "file" },
	{ rel: "AGENTS.md", kind: "file" },
	{ rel: "skills", kind: "dir" },
	{
		rel: "dsh-studio",
		kind: "dir",
		// snapshots 是快照自己（递归）、sync-work 是 git 工作副本（含 .git）、
		// sync.json 存 gist token / s3 secretKey 明文 —— 三者都不能进快照。
		// telemetry 是 90 天滚动的运行时统计，体积随使用增长，不进快照。
		// mcp-credential-stash.json 是被注销 server 的凭据原值，只留本机、不出机。
		// B5：skill-tmp 是更新时的组装区（崩溃残留）、exports 是导出的 .tar.gz（可随时重导）、
		// skill-backups 是上游更新前的整目录备份（同一次更新前后的状态版本史里已有，且只增不减）——都不进快照。
		skip: ["snapshots", "sync-work", "sync.json", "telemetry", "mcp-credential-stash.json", "skill-tmp", "exports", "skill-backups"]
	},
	{ rel: "profiles", kind: "profiles" }
];

/** profiles 白名单下允许的两个文件（收集与恢复共用，不许各抄一份）。 */
const PROFILE_FILES = ["package.json", "cordis.patch.yml"];

function shouldSkip(relPath) {
	const normalized = relPath.split(sep).join("/");
	if (ALWAYS_SKIP.some((re) => re.test(normalized))) return true;
	// 原子写的残留临时文件（崩在 writeFile 与 rename 之间留下的 `.mcp.json.<pid>.<ms>.tmp`）：
	// 它是凭据文件的整份明文副本，文件名又不在 CREDENTIAL_FILES 里，照常打包就把密钥推到远端了
	if (ATOMIC_TMP_RE.test(normalized.slice(normalized.lastIndexOf("/") + 1))) return true;
	// 插件自己的数据目录里，任何 *.tmp / *.lock 都是运行时中间产物（skill 根不套这条：yarn.lock / uv.lock 是正经内容）
	return /^dsh-studio\/(?:.*\/)?[^/]+\.(?:tmp|lock)$/i.test(normalized);
}

/**
 * 单条相对路径（POSIX 写法）是否落在白名单形态内，且不命中 skip 集 —— 收集与恢复的唯一判定（N-04）。
 *
 * 收集侧（collectFiles / countFiles）按 WHITELIST 枚举文件系统，恢复侧只能拿到包里的路径字符串；
 * 两侧共用这一份定义，才不会出现「收集时不打这个路径、恢复时照写」的缺口。
 * S-05：`dsh-studio/sync.json` 存 gist token / s3 secretKey 明文，它不在 CREDENTIAL_FILES 里，
 * 恢复侧漏判就等于把手搓包里的同步凭据整份写到本机。
 *
 * `agents-skills/` 前缀是外部 skill 根（WO-FIX-8）：整树可恢复，仍受 ALWAYS_SKIP 约束。
 */
/**
 * 一段路径在 Windows 上实际落到的名字：不区分大小写、末尾的点与空格被丢掉。
 * 用于「排除」类判定（skip 集、凭据文件），不用于「放行」——放行仍要求原样匹配。
 */
function windowsSegment(segment) {
	return String(segment).replace(/[. ]+$/, "").toLowerCase();
}

export function isWhitelistedEntry(relPath) {
	const rel = String(relPath ?? "").split(sep).join("/").replace(/^\/+/, "");
	if (rel === "") return false;
	// · A10：比较前按 Windows 规则归一。旧写法区分大小写：包里的 `dsh-studio/SYNC.JSON`、
	// `dsh-studio/sync.json.`（尾点）能绕过「sync.json 不可写」，`dsh-studio/MCP.JSON` 绕过凭据合并原样落盘，
	// 而 Windows 文件系统会把它们写到同一个文件上。`name:stream`（备用数据流，含 `::$DATA`）一律不收；
	// 归一后成了空、`.`、`..` 的段（如 `.. `）在 Windows 上是越级路径，也不收。
	const raw = rel.split("/");
	if (raw.some((part) => part.includes(":"))) return false;
	const folded = raw.map(windowsSegment);
	if (folded.some((part) => part === "" || part === "." || part === "..")) return false;
	const norm = folded.join("/");
	if (norm !== rel.toLowerCase() || rel !== rel.toLowerCase()) {
		// 有大小写 / 尾点差异：归一后命中凭据文件或任何 skip，都按那个文件处理——不收
		if (CREDENTIAL_FILES.has(norm) || shouldSkip(norm)) return false;
		const top = WHITELIST.find((item) => item.rel === folded[0]);
		if (top?.kind === "dir" && folded.length > 1 && (top.skip ?? []).includes(folded[1])) return false;
	}
	if (shouldSkip(rel)) return false;
	// 外部 skill 根：前缀之下整树都算白名单内（落点由 restoreTarget 决定）
	if (rel.startsWith(EXTERNAL_SKILL_PREFIX)) return rel.length > EXTERNAL_SKILL_PREFIX.length;
	// 版本史：只认日志文件与内容寻址对象两种形态，锁与临时文件不算
	if (rel.startsWith(HISTORY_PREFIX)) return isHistoryRel(rel.slice(HISTORY_PREFIX.length));
	const parts = rel.split("/");
	const entry = WHITELIST.find((item) => item.rel === parts[0]);
	if (entry === undefined) return false;
	if (entry.kind === "file") return parts.length === 1;
	if (entry.kind === "profiles") return parts.length === 3 && parts[1] !== "" && PROFILE_FILES.includes(parts[2]);
	// dir：整目录，但目录内第一段命中 skip 集的路径不算
	const skip = new Set(entry.skip ?? []);
	return parts.length > 1 && !skip.has(parts[1]);
}

/**
 * 主 skill 库（extractor.json 的 agentSkillDir）可能落在 `~/.dsh` 之外 ——
 * 真机就是 `~/.agents/skills`。这类目录在快照里统一挂到 `agents-skills/` 前缀下，
 * 恢复时再落回原处，避免把 `..` 塞进 tar 让 isSafeEntryPath 拒收（WO-FIX-8）。
 */
const EXTERNAL_SKILL_PREFIX = "agents-skills/";
/** 外部 skill 库在用户 home 下的落点。 */
const externalSkillTarget = () => resolve(homedir(), ".agents", "skills");

/**
 * 版本史在快照里的前缀。版本史本体在 `~/.dsh` 之外（history-paths.js），
 * 但必须随每日备份 / WebDAV 一起出机，所以和外部 skill 根一样挂在一个前缀下，恢复时落回原处。
 */
export const HISTORY_PREFIX = "dsh-studio-history/";
/** 版本史目录里允许进出快照的两种文件：versions.jsonl 与 objects/xx/<sha>.gz。 */
function isHistoryRel(rel) {
	if (rel === HISTORY_LOG) return true;
	return /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\.gz$/.test(rel);
}

/** 快照内路径 → 恢复目标绝对路径。外部前缀的落点由调用方传入（C-1）。 */
function restoreTarget(rel, dshRoot, externalRoot = externalSkillTarget()) {
	if (rel.startsWith(EXTERNAL_SKILL_PREFIX)) return join(externalRoot, rel.slice(EXTERNAL_SKILL_PREFIX.length));
	if (rel.startsWith(HISTORY_PREFIX)) return join(historyRoot(), rel.slice(HISTORY_PREFIX.length));
	return join(dshRoot, rel);
}

/**
 * 恢复时外部 skill 库该落到哪（C-1）：跟着 extractor.json 的 agentSkillDir 走，
 * 不再写死 `~/.agents/skills`。配置缺失或指向 `~/.dsh` 内部时退回默认值。
 */
async function externalSkillTargetFromConfig(home) {
	let cfg;
	try {
		cfg = JSON.parse(await readFile(join(home, "dsh-studio", "extractor.json"), "utf8"));
	} catch {
		return null;
	}
	const dir = typeof cfg?.agentSkillDir === "string" ? cfg.agentSkillDir.trim() : "";
	if (dir === "") return null;
	const abs = resolve(dir);
	const rel = relative(home, abs);
	if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return null;
	return abs;
}

/**
 * 外部 skill 根的唯一口径（C-1）：恢复落点、PENDING_PULLS.json 的读写位置都从这里取，
 * 恢复端与拉取端不各写一遍「配置优先、否则 `~/.agents/skills`」（PULL-1）。
 */
export async function externalSkillRoot(home = dshHome()) {
	return (await externalSkillTargetFromConfig(home)) ?? externalSkillTarget();
}

/**
 * 读 extractor.json 的 agentSkillDir，返回落在 `~/.dsh` 之外、且真实存在的目录。
 * 路径跟随配置值，不写死；`~/.dsh` 内的目录已由 `skills` 白名单覆盖，不重复打包。
 */
async function externalSkillDir(home) {
	let cfg;
	try {
		cfg = JSON.parse(await readFile(join(home, "dsh-studio", "extractor.json"), "utf8"));
	} catch {
		return null;
	}
	const dir = typeof cfg?.agentSkillDir === "string" ? cfg.agentSkillDir.trim() : "";
	if (dir === "") return null;
	const abs = resolve(dir);
	const rel = relative(home, abs);
	if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return null;
	return (await pathExists(abs)) ? abs : null;
}

async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
async function isDir(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** 递归收集一个目录下的普通文件，返回相对传入根的 POSIX 路径。 */
async function walkDir(root, base = root, out = []) {
	let entries;
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(base, entry.name);
		const rel = relative(root, full);
		if (shouldSkip(join(root, rel))) continue;
		if (entry.isDirectory()) await walkDir(root, full, out);
		else if (entry.isFile()) out.push(rel.split(sep).join("/"));
	}
	return out;
}

/** 流式读写分块大小：打包/哈希的常驻内存只与它挂钩，不随文件数或总体积叠加。 */
const STREAM_CHUNK_BYTES = 1024 * 1024;

/** 「这个相对路径落在 skill 根里」——collectFiles 与 countFiles 共用同一口径（W-6）。 */
// B5：回收站里放的是被删掉的整个技能目录，同样套单文件上限（以前一个几十 MB 的素材删进回收站，每份快照都带着它）
const isSkillRel = (rel) => rel === "skills" || rel.startsWith("skills/") || rel.startsWith(EXTERNAL_SKILL_PREFIX) || rel.startsWith("dsh-studio/trash/");

/** 流式算文件 sha：分块读，超大文件也不整份进内存。 */
async function sha256OfFile(absPath) {
	const hash = createHash("sha256");
	const handle = await open(absPath, "r");
	try {
		const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
		for (;;) {
			const { bytesRead } = await handle.read(buf, 0, STREAM_CHUNK_BYTES, null);
			if (bytesRead === 0) break;
			hash.update(buf.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

/**
 * 按白名单收集要备份的文件。
 *
 * N-12：这里只出元数据清单（rel / abs / 磁盘字节数），不读内容、不存 Buffer ——
 * 打包阶段对每个文件只读一次，manifest 的 sha 就是那次读出的字节算的（OPT-05）。
 * @returns {Promise<Array<{rel: string, abs: string, bytes: number}>>}
 */
export async function collectFiles(options = {}) {
	const home = dshHome();
	const found = [];
	// C-2：单文件上限只作用于两个 skill 根，配置/数据文件不受限；0 = 不过滤
	const maxSkillFileBytes = Number.isFinite(Number(options.maxSkillFileBytes)) ? Number(options.maxSkillFileBytes) : 0;
	const skipped = Array.isArray(options.skipped) ? options.skipped : null;
	const add = async (absPath, relPath) => {
		// N-04：与恢复侧同一份白名单判定 —— 收集端枚举范围之外没有东西可加，这里是双保险
		if (!isWhitelistedEntry(relPath)) return;
		if (!(await pathExists(absPath))) return;
		const info = await stat(absPath);
		if (!info.isFile()) return;
		// C-2：超单文件上限的 skill 文件不进包；SKIPPED 里的 sha 用流式读算，
		// 否则一个 100 MB 的 GIF 光为了记 sha 就要整份进内存
		if (skipped !== null && maxSkillFileBytes > 0 && isSkillRel(relPath) && info.size > maxSkillFileBytes) {
			skipped.push({ path: relPath, size: info.size, sha: await sha256OfFile(absPath) });
			return;
		}
		found.push({ rel: relPath, abs: absPath, bytes: info.size });
	};
	for (const entry of WHITELIST) {
		const abs = join(home, entry.rel);
		if (entry.kind === "file") {
			await add(abs, entry.rel);
			continue;
		}
		if (entry.kind === "dir") {
			if (!(await isDir(abs))) continue;
			const skip = new Set(entry.skip ?? []);
			for (const rel of await walkDir(abs)) {
				const top = rel.split("/")[0];
				if (skip.has(top)) continue;
				await add(join(abs, rel), join(entry.rel, rel).split(sep).join("/"));
			}
			continue;
		}
		if (entry.kind === "profiles") {
			let names = [];
			try {
				names = (await readdir(abs, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
			} catch {
				continue;
			}
			for (const name of names) {
				for (const file of ["package.json", "cordis.patch.yml"]) {
					await add(join(abs, name, file), `${entry.rel}/${name}/${file}`);
				}
			}
		}
	}
	// WO-FIX-8：主 skill 库在 ~/.dsh 之外时（真机是 ~/.agents/skills），单独挂到
	// agents-skills/ 前缀下，恢复时由 restoreTarget 落回原处。
	const external = await externalSkillDir(home);
	if (external !== null) {
		for (const rel of await walkDir(external)) {
			await add(join(external, rel), EXTERNAL_SKILL_PREFIX + rel);
		}
	}
	// · G2：版本史随快照出机（isWhitelistedEntry 只放行日志与对象文件）
	const history = historyRoot();
	if (await isDir(history)) {
		for (const rel of await walkDir(history)) await add(join(history, rel), HISTORY_PREFIX + rel);
	}
	return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 只数「会被打进快照的文件有多少个」（OPT-03）。
 * 面板的 GET /snapshot 原来为了一个数字调 collectFiles：把所有文件读一遍、算 sha、
 * 还把 Buffer 留在内存里。真机 1830 个文件、129 MB，一次列表就顶一次全量读盘。
 */
export async function countFiles(options = {}) {
	const home = dshHome();
	// W-6：与 collectFiles 同口径 —— 超单文件上限的 skill 文件不计入「可入包」数
	const maxSkillFileBytes = Number.isFinite(Number(options.maxSkillFileBytes)) ? Number(options.maxSkillFileBytes) : 0;
	let count = 0;
	const hit = async (relPath, absPath) => {
		if (!isWhitelistedEntry(relPath)) return;
		if (maxSkillFileBytes > 0 && isSkillRel(relPath)) {
			try {
				if ((await stat(absPath)).size > maxSkillFileBytes) return;
			} catch {
				return;
			}
		}
		count += 1;
	};
	for (const entry of WHITELIST) {
		const abs = join(home, entry.rel);
		if (entry.kind === "file") {
			if (await pathExists(abs)) await hit(entry.rel, abs);
			continue;
		}
		if (entry.kind === "dir") {
			if (!(await isDir(abs))) continue;
			const skip = new Set(entry.skip ?? []);
			for (const rel of await walkDir(abs)) {
				if (skip.has(rel.split("/")[0])) continue;
				await hit(join(entry.rel, rel).split(sep).join("/"), join(abs, rel));
			}
			continue;
		}
		if (entry.kind === "profiles") {
			let names = [];
			try {
				names = (await readdir(abs, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
			} catch {
				continue;
			}
			for (const name of names) {
				for (const file of ["package.json", "cordis.patch.yml"]) {
					if (await pathExists(join(abs, name, file))) await hit(`${entry.rel}/${name}/${file}`, join(abs, name, file));
				}
			}
		}
	}
	const external = await externalSkillDir(home);
	if (external !== null) {
		for (const rel of await walkDir(external)) await hit(EXTERNAL_SKILL_PREFIX + rel, join(external, rel));
	}
	const history = historyRoot();
	if (await isDir(history)) {
		for (const rel of await walkDir(history)) await hit(HISTORY_PREFIX + rel, join(history, rel));
	}
	return count;
}

// ── 最小 tar 写入 / 读取（ustar + GNU longname，只处理普通文件） ────────────

/** GNU tar 的 longname 扩展头在 name 字段里的固定占位。 */
const GNU_LONGNAME = "././@LongLink";
/** 路径硬上限：超过就没法在 tar 里可靠表达，直接报错而不是写坏文件名。 */
const TAR_PATH_LIMIT = 4096;

/** 填 ustar 头的公共字段并算 checksum。 */
function sealHeader(header, size, mtimeSeconds, typeflag) {
	const octal = (value, width) => value.toString(8).padStart(width - 1, "0") + "\0";
	Buffer.from(octal(0o644, 8), "ascii").copy(header, 100); // mode
	Buffer.from(octal(0, 8), "ascii").copy(header, 108); // uid
	Buffer.from(octal(0, 8), "ascii").copy(header, 116); // gid
	Buffer.from(octal(size, 12), "ascii").copy(header, 124); // size
	Buffer.from(octal(mtimeSeconds, 12), "ascii").copy(header, 136); // mtime
	header.fill(32, 148, 156); // checksum 先填空格
	header[156] = typeflag;
	Buffer.from("ustar\0", "ascii").copy(header, 257);
	Buffer.from("00", "ascii").copy(header, 263);
	let sum = 0;
	for (let i = 0; i < 512; i += 1) sum += header[i];
	Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
	return header;
}

/**
 * ustar 头。装得下就返回头，装不下返回 null，由调用方补 GNU longname 扩展头。
 *
 * prefix(155) + name(100) 必须**双向**满足：从右往左找第一个既能塞进 prefix、
 * 又能让剩余段塞进 name 的斜杠。旧实现只取 lastIndexOf(47, 155)，剩余段超过
 * 100 字节时 copy() 会静默截断，还可能截在 UTF-8 多字节中间（BUG-08）。
 */
function tarHeader(name, size, mtimeSeconds) {
	const header = Buffer.alloc(512, 0);
	const nameBuf = Buffer.from(name, "utf8");
	if (nameBuf.length <= 100) {
		nameBuf.copy(header, 0);
	} else {
		let split = -1;
		for (let i = Math.min(nameBuf.length - 1, 155); i > 0; i -= 1) {
			if (nameBuf[i] !== 47) continue; // '/'
			if (nameBuf.length - i - 1 <= 100) {
				split = i;
				break;
			}
		}
		if (split <= 0) return null;
		nameBuf.subarray(0, split).copy(header, 345);
		nameBuf.subarray(split + 1).copy(header, 0);
	}
	return sealHeader(header, size, mtimeSeconds, 0x30);
}

/** 路径硬上限预检：超限直接抛，不写坏文件名。 */
function assertTarPath(rel) {
	if (Buffer.byteLength(rel, "utf8") > TAR_PATH_LIMIT) {
		throw new UserError(`路径超过 ${TAR_PATH_LIMIT} 字节，拒绝打包（写坏文件名比失败更糟）：${rel.slice(0, 80)}…`);
	}
}

/**
 * 一个条目的 tar 前导块：装得下就是 ustar 头，装不下补一条 GNU longname（'L'）扩展头。
 * 同步打包（packTarGz）与流式写盘（writeTarGzStream）共用这一份，格式不会两边漂移。
 * @returns {Buffer[]} 依次要写出的头块（长名时含扩展头、长名正文、填充、占位真头）
 */
function tarEntryPrelude(rel, size, nowSeconds) {
	assertTarPath(rel);
	let header = tarHeader(rel, size, nowSeconds);
	if (header !== null) return [header];
	// 先发一条 'L' 扩展头，正文是完整路径 + NUL；紧接着的真头里 name 只是占位
	const longName = Buffer.from(rel + "\0", "utf8");
	const ext = Buffer.alloc(512, 0);
	Buffer.from(GNU_LONGNAME, "ascii").copy(ext, 0);
	const placeholder = Buffer.alloc(512, 0);
	Buffer.from(rel.split("/").pop() ?? "", "utf8").subarray(0, 100).copy(placeholder, 0);
	const extPad = (512 - (longName.length % 512)) % 512;
	return [
		sealHeader(ext, longName.length, nowSeconds, 0x4c), // 'L'
		longName,
		...(extPad > 0 ? [Buffer.alloc(extPad, 0)] : []),
		sealHeader(placeholder, size, nowSeconds, 0x30)
	];
}

/** 条目正文之后的 512 对齐填充；不用补时返回 null。 */
function tarPad(size) {
	const pad = (512 - (size % 512)) % 512;
	return pad > 0 ? Buffer.alloc(pad, 0) : null;
}

/** 把 {rel, data} 列表打成 tar.gz（整包在内存里成形；只给小块调用方与对拍用）。 */
export function packTarGz(entries) {
	const chunks = [];
	const now = Math.floor(Date.now() / 1000);
	for (const entry of entries) {
		const data = entry.data;
		chunks.push(...tarEntryPrelude(entry.rel, data.length, now));
		chunks.push(data);
		const pad = tarPad(data.length);
		if (pad !== null) chunks.push(pad);
	}
	chunks.push(Buffer.alloc(1024, 0)); // 两个空块结束
	return gzipSync(Buffer.concat(chunks), { level: GZIP_LEVEL });
}

/**
 * B5：gzip 级别 9 → 6。包里大头是已压缩的素材与版本史对象（本身就是 .gz），9 级几乎压不动它们，
 * 却要多花一倍以上的 CPU；文本部分 6 级与 9 级的大小差在几个百分点内。
 */
export const GZIP_LEVEL = 6;

/**
 * 把条目逐条流式写进 target（gzip level GZIP_LEVEL）。条目两种形态：
 *   {rel, data: Buffer} —— 内容已在内存（三份说明文件、脱敏后的凭据文件）
 *   {rel, abs: string}  —— 源文件：打开一次、读一遍，内容边读边写、sha 边读边算
 *   {rel, build: (written) => Buffer} —— 写到这条时才生成（参数是此前已写条目的 rel/bytes/sha，清单用）
 * 整包 tar 与整包 gzip 都不在内存里成形。
 * @returns {Promise<Array<{rel: string, bytes: number, sha: string}>>} 按写出顺序
 */
export async function writeTarGzStream(target, entries) {
	const now = Math.floor(Date.now() / 1000);
	const gz = createGzip({ level: GZIP_LEVEL });
	const out = createWriteStream(target);
	// 流的 error 一律变成 await 上的异常：宁可整次失败，也不留半截包
	const closed = new Promise((resolve, reject) => {
		out.once("close", resolve);
		out.once("error", reject);
		gz.once("error", reject);
	});
	gz.pipe(out);
	// 回调在 chunk 被 zlib 完全接手后才触发：等它，就不必为每块留一份新拷贝
	const write = (chunk) =>
		new Promise((resolve, reject) => {
			gz.write(chunk, (error) => (error ? reject(error) : resolve()));
		});
	const written = [];
	// 整趟打包只有这一块读缓冲：上面每块都等到了消费完成，才能原地复用
	const scratch = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
	try {
		for (const entry of entries) {
			// ：{rel, build(written)} —— 走到这条时才生成内容（备份包的清单要带前面各条写出时算的 sha）
			const data = entry.data !== undefined ? entry.data : typeof entry.build === "function" ? await entry.build(written) : undefined;
			if (data !== undefined) {
				for (const head of tarEntryPrelude(entry.rel, data.length, now)) await write(head);
				await write(data);
				const pad = tarPad(data.length);
				if (pad !== null) await write(pad);
				written.push({ rel: entry.rel, bytes: data.length, sha: createHash("sha256").update(data).digest("hex") });
				continue;
			}
			const handle = await open(entry.abs, "r");
			try {
				const size = (await handle.stat()).size;
				for (const head of tarEntryPrelude(entry.rel, size, now)) await write(head);
				const hash = createHash("sha256");
				let offset = 0;
				while (offset < size) {
					const want = Math.min(STREAM_CHUNK_BYTES, size - offset);
					const { bytesRead } = await handle.read(scratch, 0, want, offset);
					if (bytesRead === 0) break;
					hash.update(scratch.subarray(0, bytesRead));
					await write(scratch.subarray(0, bytesRead));
					offset += bytesRead;
				}
				// 头里已经写死 size：读不够就是包要坏，宁可失败也不出坏包
				if (offset !== size) throw new Error(`源文件在打包过程中变短（头写 ${size} 字节，实读 ${offset}）：${entry.rel}`);
				const pad = tarPad(size);
				if (pad !== null) await write(pad);
				written.push({ rel: entry.rel, bytes: size, sha: hash.digest("hex") });
			} finally {
				await handle.close();
			}
		}
		await write(Buffer.alloc(1024, 0)); // 两个空块结束
		gz.end();
		await closed;
	} catch (error) {
		gz.destroy();
		out.destroy();
		await closed.catch(() => {});
		throw error;
	}
	return written;
}

/** 解开 tar.gz，返回 {rel, data} 列表。识别 GNU longname（'L'）扩展头。 */
export function unpackTarGz(buffer) {
	const raw = gunzipSync(buffer);
	const out = [];
	let offset = 0;
	let pendingLongName = null;
	while (offset + 512 <= raw.length) {
		const header = raw.subarray(offset, offset + 512);
		if (header.every((b) => b === 0)) break;
		const readStr = (start, len) => {
			const slice = header.subarray(start, start + len);
			const end = slice.indexOf(0);
			return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
		};
		const name = readStr(0, 100);
		const prefix = readStr(345, 155);
		const size = parseInt(readStr(124, 12).trim() || "0", 8);
		const type = String.fromCharCode(header[156] || 0x30);
		offset += 512;
		if (type === "L") {
			pendingLongName = raw.subarray(offset, offset + size).toString("utf8").replace(/\0+$/, "");
			offset += Math.ceil(size / 512) * 512;
			continue;
		}
		const rel = pendingLongName !== null ? pendingLongName : prefix === "" ? name : `${prefix}/${name}`;
		pendingLongName = null;
		if (type === "0" || type === "\0") {
			const data = raw.subarray(offset, offset + size);
			out.push({ rel, data: Buffer.from(data) });
		}
		offset += Math.ceil(size / 512) * 512;
	}
	return out;
}

/** 从一串 chunk 的异步迭代器里按字节数取数据（流式解包用；只缓存当前要的那一段）。 */
class ByteReader {
	constructor(iterable) {
		this.it = iterable[Symbol.asyncIterator]();
		this.chunks = [];
		this.have = 0;
		this.done = false;
	}
	async fill(n) {
		while (this.have < n && !this.done) {
			const { value, done } = await this.it.next();
			if (done) this.done = true;
			else if (value.length > 0) {
				this.chunks.push(value);
				this.have += value.length;
			}
		}
	}
	/** 读满 n 字节；不够（流提前结束）返回 null。 */
	async read(n) {
		if (n === 0) return Buffer.alloc(0);
		await this.fill(n);
		if (this.have < n) return null;
		const out = Buffer.allocUnsafe(n);
		let off = 0;
		while (off < n) {
			const head = this.chunks[0];
			const take = Math.min(head.length, n - off);
			head.copy(out, off, 0, take);
			off += take;
			if (take === head.length) this.chunks.shift();
			else this.chunks[0] = head.subarray(take);
		}
		this.have -= n;
		return out;
	}
	async skip(n) {
		let left = n;
		while (left > 0) {
			await this.fill(Math.min(left, STREAM_CHUNK_BYTES));
			if (this.have === 0) return false;
			const take = Math.min(left, this.have);
			await this.read(take);
			left -= take;
		}
		return true;
	}
}

/**
 * 流式解开 tar.gz（审计 7，与 writeTarGzStream 对齐）：createReadStream → createGunzip → 逐条回调，
 * 同一时刻内存里只有当前这一条的内容，整包 tar 不在内存里成形。条目口径与 unpackTarGz 逐条一致
 * （普通文件条目、GNU longname 'L'、ustar prefix）。onEntry 可返回 Promise（逐条落盘），返回 false 提前停止。
 * @param {string} file tar.gz 路径
 * @param {(entry: {rel: string, data: Buffer}) => unknown} onEntry
 * @returns {Promise<number>} 回调过的条目数
 */
export async function forEachTarGzEntry(file, onEntry) {
	const source = createReadStream(file);
	const gunzip = createGunzip();
	source.on("error", (error) => gunzip.destroy(error));
	const reader = new ByteReader(source.pipe(gunzip));
	let pendingLongName = null;
	let count = 0;
	try {
		for (;;) {
			const header = await reader.read(512);
			if (header === null || header.every((b) => b === 0)) break;
			const readStr = (start, len) => {
				const slice = header.subarray(start, start + len);
				const end = slice.indexOf(0);
				return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
			};
			const name = readStr(0, 100);
			const prefix = readStr(345, 155);
			const size = parseInt(readStr(124, 12).trim() || "0", 8);
			const type = String.fromCharCode(header[156] || 0x30);
			const padded = Math.ceil(size / 512) * 512;
			if (type === "L") {
				const body = await reader.read(padded);
				if (body === null) break;
				pendingLongName = body.subarray(0, size).toString("utf8").replace(/\0+$/, "");
				continue;
			}
			const rel = pendingLongName !== null ? pendingLongName : prefix === "" ? name : `${prefix}/${name}`;
			pendingLongName = null;
			if (type === "0" || type === "\0") {
				const data = await reader.read(size);
				if (data === null) break; // 截断在内容中间：不交出半截条目
				count += 1;
				if ((await onEntry({ rel, data })) === false) break;
				if (padded > size && !(await reader.skip(padded - size))) break;
			} else if (!(await reader.skip(padded))) break;
		}
	} finally {
		source.destroy();
		gunzip.destroy();
	}
	return count;
}

// ── 跨机路径重映射 ────────────────────────────────────────────────────────

/** 看起来是文本吗（有 NUL 或大量控制字符就当二进制，原样不动）。 */
export function isProbablyText(buf) {
	const sample = buf.subarray(0, Math.min(buf.length, 4096));
	if (sample.includes(0)) return false;
	let bad = 0;
	for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) bad += 1;
	return bad / Math.max(1, sample.length) < 0.05;
}

const escapeBackslashes = (s) => s.replace(/\\/g, "\\\\");

/**
 * 按 [{from, to}] 替换文本里的绝对路径前缀。
 * JSON 里的路径是双反斜杠（`C:\\Users\\a`），所以原样和转义两种写法都要替换。
 * @returns {{data: Buffer, changed: boolean}}
 */
export function remapText(buf, pathMap) {
	if (!Array.isArray(pathMap) || pathMap.length === 0) return { data: buf, changed: false };
	if (!isProbablyText(buf)) return { data: buf, changed: false };
	let text = buf.toString("utf8");
	let changed = false;
	for (const pair of pathMap) {
		const from = typeof pair?.from === "string" ? pair.from.trim() : "";
		// to 留空就当没填：替换成空串会把路径删掉，那是数据损坏，不是迁移
		const to = typeof pair?.to === "string" ? pair.to.trim() : "";
		if (from === "" || to === "") continue;
		for (const [source, target] of [
			[from, to],
			[escapeBackslashes(from), escapeBackslashes(to)]
		]) {
			if (!text.includes(source)) continue;
			text = text.split(source).join(target);
			changed = true;
		}
	}
	return { data: changed ? Buffer.from(text, "utf8") : buf, changed };
}

// ── 快照的建立 / 列举 / 恢复 / 清理 ────────────────────────────────────────
// id 与包内路径的闸门已抽到 lib/paths.js（WO-FIX-5），snapshot / trash / sync 共用一份。

function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	// 带毫秒：同一秒内连建两份不会撞 id（撞了就是后一份覆盖前一份）
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * 建一份快照。
 * @param {string} label 标签，会拼进目录名
 */
/** skill 名：rel 形如 `skills/<name>/…` 或 `agents-skills/<name>/…`，取第二段。 */
function skillNameOfRel(rel) {
	if (typeof rel !== "string") return null;
	const parts = rel.split("/");
	if (parts.length < 2) return null;
	if (parts[0] !== "skills" && parts[0] !== "agents-skills") return null;
	return parts[1] === "" ? null : parts[1];
}

/** 读安装锁（WO-BORROW-6 的 skill-lock.json）；读不到就当没有。 */
async function readSkillLock() {
	try {
		const parsed = JSON.parse(await readFile(join(dshHome(), "dsh-studio", "skill-lock.json"), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * 判定一个 skill 的来源（WO-LINK-1），两级：
 * (a) skill-lock.json 里的 source/ref/sha256；
 * (b) 目录内 .git 的 origin remote + HEAD sha（只读查询，不改仓库）。
 * 都拿不到就返回 null —— 调用方据此走「保底打包」。
 * URL 拆分用 lib/paths.js 的 splitSourceUrl（U-1/U-3 共用同一份归一）。
 */
async function resolveSkillSource(name, dir) {
	const lock = await readSkillLock();
	const rec = lock[name];
	if (rec && typeof rec.source === "string" && rec.source.trim() !== "") {
		// WO-LINK-3：subdir 全链结构化 —— 结构化 subPath 优先，其次看 source 是不是 tree URL
		const split = splitSourceUrl(rec.source);
		const lockedSub = typeof rec.subPath === "string" ? rec.subPath.trim().replace(/^\/+|\/+$/g, "") : "";
		const refFromLock = typeof rec.ref === "string" ? rec.ref.trim() : "";
		return {
			repo: split.repo,
			ref: refFromLock !== "" ? refFromLock : split.ref,
			sha: typeof rec.sha256 === "string" ? rec.sha256 : "",
			subdir: lockedSub !== "" ? lockedSub : split.subdir,
			via: "lock"
		};
	}
	if (!(await pathExists(join(dir, ".git")))) return null;
	const url = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"], { windowsHide: true })
		.then((r) => String(r.stdout).trim())
		.catch(() => "");
	if (url === "") return null;
	const sha = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"], { windowsHide: true })
		.then((r) => String(r.stdout).trim())
		.catch(() => "");
	// WO-LINK-3：git 定源是「整仓即 skill」，没有子目录
	return { repo: url, ref: "", sha, subdir: "", via: "git" };
}

/**
 * 找出「够大且来源可确定」的 skill（WO-LINK-1）。
 * 总大小按目录口径算：入包文件 + 被 C-2 跳过的文件一起累计。
 */
async function collectExternalSkills(files, skipped, home) {
	const groups = new Map();
	const add = (rel, bytes) => {
		const name = skillNameOfRel(rel);
		if (name === null) return;
		const root = rel.split("/")[0];
		const g = groups.get(name) ?? { name, root, bytes: 0, count: 0 };
		g.bytes += bytes;
		g.count += 1;
		groups.set(name, g);
	};
	for (const file of files) add(file.rel, file.bytes);
	for (const item of skipped) add(item.path, item.size);
	const external = await externalSkillDir(home);
	const out = [];
	for (const g of groups.values()) {
		if (g.bytes <= EXTERNAL_SKILL_MIN_BYTES) continue;
		const dir = g.root === "skills" ? join(home, "skills", g.name) : external === null ? null : join(external, g.name);
		if (dir === null) continue;
		const src = await resolveSkillSource(g.name, dir);
		// 来源不可确定 → 保底打包，不链接化（防丢）
		if (src === null) continue;
		// subdir 恒为字符串：无子目录时写空串（字段形态稳定，调用方不用判 undefined）
		out.push({ name: g.name, repo: src.repo, ref: src.ref, sha: src.sha, subdir: src.subdir ?? "", sizeBytes: g.bytes, fileCount: g.count });
	}
	return out;
}

export async function createSnapshot(label = "manual") {
	const schedule = await loadSchedule().catch(() => ({ ...DEFAULT_SCHEDULE }));
	// C-2：skill 根下的超大文件不进包，改记进 SKIPPED.json（否则 ~/.agents/skills 里的 GIF/PNG 会把包撑到 100 MB+）
	const home = dshHome();
	const skipped = [];
	let files = await collectFiles({ skipped, maxSkillFileBytes: schedule.maxSkillFileBytes });
	if (files.length === 0) throw new UserError("白名单里一个文件都没找到，检查 ~/.dsh 是否存在", 400, { code: SNAPSHOT_EMPTY });
	// WO-LINK-1：大 skill 来源可确定时只记链接 —— 内容不进包，也不进 SKIPPED（那是「太大」的语义）
	const externalSkills = schedule.linkExternalSkills === false ? [] : await collectExternalSkills(files, skipped, home);
	if (externalSkills.length > 0) {
		const linked = new Set(externalSkills.map((item) => item.name));
		files = files.filter((file) => !linked.has(skillNameOfRel(file.rel) ?? ""));
		for (let i = skipped.length - 1; i >= 0; i -= 1) {
			if (linked.has(skillNameOfRel(skipped[i].path) ?? "")) skipped.splice(i, 1);
		}
	}
	const entries = [];
	const redacted = [];
	const excluded = [];
	for (const file of files) {
		// 白名单目录里的凭据文件按字段脱敏（WO-SEC-4）：包会被推到 git / gist /
		// webdav / s3，带上活密钥就等于把密钥交出去。只记字段路径，不记原值。
		// 脱敏必须看内容，所以这两个小配置整份读；其余文件只留路径，打包时流式读一遍。
		if (!CREDENTIAL_FILES.has(file.rel)) {
			entries.push({ rel: file.rel, abs: file.abs });
			continue;
		}
		let data = await readFile(file.abs);
		try {
			// 带 BOM 的 mcp.json（PowerShell / 记事本存的）注册表侧照常能读，这里也得剥，否则每份快照都把它整份排除
			const parsed = JSON.parse(data.toString("utf8").replace(/^\uFEFF/, ""));
			const hits = redactCredentials(parsed);
			if (hits.length > 0) {
				data = Buffer.from(JSON.stringify(parsed, null, 2) + "\n", "utf8");
				// ：有内嵌占位符的挂到 NEEDS_NEWER_PREFIX 下，旧版恢复时跳过而不是把占位符当凭据写回
				const rel = hasEmbeddedPlaceholder(parsed) ? NEEDS_NEWER_PREFIX + file.rel : file.rel;
				redacted.push({ file: file.rel, fields: hits, ...(rel !== file.rel ? { storedAs: rel } : {}) });
				entries.push({ rel, data });
				continue;
			}
		} catch (error) {
			// C-3：读不懂就没法字段级脱敏 —— 整份排除，不能把可能含明文的原样打进可外推的包
			excluded.push({ file: file.rel, reason: "JSON 解析失败：" + (error instanceof Error ? error.message : String(error)) });
			continue;
		}
		entries.push({ rel: file.rel, data });
	}
	if (redacted.length > 0 || excluded.length > 0) {
		const note = {
			note: "本快照打包时对下列字段做了脱敏，值已替换为占位符；解析失败的文件整份排除。恢复时不会覆盖目标机已有凭据。",
			placeholder: REDACTED,
			redacted,
			excluded
		};
		// 没有内嵌占位符时说明文件逐字节与旧版一致；有才补这段
		if (redacted.some((r) => r.storedAs !== undefined)) {
			note.embedded =
				"字段路径带 {键} 的是参数 / URL 里内嵌的凭据，只换掉了那一段，恢复时从目标机同名 server 的同键现值补回，补不回的占位符原样留着并列在恢复报告的 missingCredentials 里。" +
				`带 storedAs 的文件在包里放在 ${NEEDS_NEWER_PREFIX} 下：旧版 dsh-studio 不认识内嵌占位符，恢复时会跳过它（报告的 skippedPaths 里能看到），先升级再恢复。`;
		}
		entries.push({ rel: REDACTED_NOTE, data: Buffer.from(JSON.stringify(note, null, 2) + "\n", "utf8") });
	}
	if (externalSkills.length > 0) {
		const note = {
			note: "下列 skill 体积超过阈值且来源可确定，本快照只记仓库链接、不打包内容。恢复端按 PENDING_PULLS.json 自行拉取。",
			thresholdBytes: EXTERNAL_SKILL_MIN_BYTES,
			skills: externalSkills
		};
		entries.push({ rel: EXTERNAL_SKILLS_NOTE, data: Buffer.from(JSON.stringify(note, null, 2) + "\n", "utf8") });
	}
	if (skipped.length > 0) {
		const note = {
			note: "下列 skill 文件超过单文件上限，未打进本快照（可用 snapshot.json 的 maxSkillFileBytes 调整或设 0 关闭）。",
			maxSkillFileBytes: schedule.maxSkillFileBytes,
			skipped
		};
		entries.push({ rel: SKIPPED_NOTE, data: Buffer.from(JSON.stringify(note, null, 2) + "\n", "utf8") });
	}
	// 路径硬上限在写任何字节、建任何目录之前先判：超限时连空快照目录都不留
	for (const entry of entries) assertTarPath(entry.rel);
	// label 只用来拼目录名：清掉非 \w.- 的字符，再截 60 字符（Windows 路径 260 上限）
	const safeLabel = String(label).replace(/[^\w.-]+/g, "_").slice(0, 60) || "manual";
	const id = `${stamp()}-${safeLabel}`;
	const dir = join(snapshotsDir(), id);
	let existed = true;
	try {
		await stat(dir);
	} catch {
		existed = false;
	}
	await mkdir(dir, { recursive: true });
	const archivePath = join(dir, "config.tar.gz");
	// 同目录临时文件 → rename：正式包要么完整存在，要么根本不出现
	const tmpPath = join(dir, `config.tar.gz.${process.pid}.tmp`);
	let written;
	try {
		written = await writeTarGzStream(tmpPath, entries);
		await rename(tmpPath, archivePath);
	} catch (error) {
		await rm(tmpPath, { force: true }).catch(() => {});
		// 本次新建的目录里只可能有这一个半成品，整个撤掉；已存在的目录不碰
		if (!existed) await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	const manifest = {
		id,
		label,
		at: Date.now(),
		archiveBytes: (await stat(archivePath)).size,
		// 顺序 = 写进包的顺序；bytes/sha 就是对写出去的那份字节算的（OPT-05）
		files: written,
		redacted,
		excluded,
		skipped
	};
	await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
	return manifest;
}

/** 列出所有快照（按时间倒序）。 */
export async function listSnapshots() {
	const root = snapshotsDir();
	let names = [];
	try {
		names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		try {
			const manifest = JSON.parse(await readFile(join(root, name, "manifest.json"), "utf8"));
			out.push({
				id: manifest.id ?? name,
				label: manifest.label ?? "",
				at: manifest.at ?? 0,
				archiveBytes: manifest.archiveBytes ?? 0,
				fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0
			});
		} catch {
			continue;
		}
	}
	return out.sort((a, b) => b.at - a.at);
}

/**
 * 恢复一份快照。
 * @param {string} id 快照 id
 * @param {{dryRun?: boolean, pathMap?: Array<{from: string, to: string}>, force?: boolean}} options
 *   dryRun 只算差异不写盘；pathMap 在写盘前把文本里的绝对路径前缀换掉（跨机迁移用）；
 *   force：恢复前保护快照打不成时仍然覆盖（默认中止）
 */
/** 清单针对原始 tar 字节；不能拿路径替换/凭据补回之后的内容验证。 */
async function snapshotIntegrity(dir) {
	let manifest;
	try {
		manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return null; // 旧的无清单包仍可恢复，报告明确未校验。
		throw error;
	}
	if (manifest.files === undefined) return null;
	if (!Array.isArray(manifest.files)) throw new UserError("快照清单 files 格式无效");
	const expected = new Map();
	for (const file of manifest.files) {
		if (!file || typeof file.rel !== "string" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/i.test(file.sha ?? "") || expected.has(file.rel)) {
			throw new UserError("快照清单包含无效或重复文件");
		}
		expected.set(file.rel, file);
	}
	return expected;
}

function verifySnapshotEntry(entry, expected, seen) {
	if (expected === null) return;
	const file = expected.get(entry.rel);
	const sha = createHash("sha256").update(entry.data).digest("hex");
	if (!file || seen.has(entry.rel) || file.bytes !== entry.data.length || file.sha.toLowerCase() !== sha) {
		throw new UserError(`快照内容校验失败：${entry.rel}`);
	}
	seen.add(entry.rel);
}

export async function restoreSnapshot(id, options = {}) {
	const safeId = assertSnapshotId(id);
	const dir = join(snapshotsDir(), safeId);
	const archiveFile = join(dir, "config.tar.gz");
	await stat(archiveFile); // 不存在就照旧抛 ENOENT
	const expected = await snapshotIntegrity(dir);
	const seen = new Set();
	const pathMap = Array.isArray(options.pathMap) ? options.pathMap : [];
	const home = dshHome();
	const plan = [];
	const remapped = [];
	const rejected = [];
	// N-04：白名单镜像拦下的条目（包里有、收集侧永远不会打进来）—— 与 rejected（不安全路径）分开计数
	const skipped = [];
	// C-1：外部 skill 库落点跟随 extractor.json 的 agentSkillDir（与拉取端同一口径）
	const externalRoot = await externalSkillRoot(home);
	// WO-LINK-2：包内若有大 skill 的链接清单，这些 skill 不从包里恢复，交给恢复端自己拉
	let externalSkills = [];
	// ：占位符补不回的凭据字段（目标机没有同名同键的现值），逐项进报告
	const missingCredentials = [];

	/**
	 * 一条包内条目 → 要落盘的内容（null = 不落盘）。dry-run 的计划与真恢复的写入共用这一个函数，
	 * 审计 7：两遍都是流式逐条过，整包条目不再一次性留在内存里。
	 * @param {boolean} collect 第一遍：顺手收集 rejected / skipped / remapped 计数
	 */
	const prepare = async (entry, collect) => {
		if (entry.rel.startsWith(NEEDS_NEWER_PREFIX)) {
			// 前缀只为挡旧版；新版只认凭据文件挂在它下面，别的一律当白名单外
			if (collect) skipped.push(entry.rel);
			return null;
		}
		// 脱敏说明只是给人看的，不落到 ~/.dsh
		if (entry.rel === REDACTED_NOTE) return null;
		if (entry.rel === SKIPPED_NOTE) return null;
		if (entry.rel === EXTERNAL_SKILLS_NOTE) {
			if (collect) {
				try {
					const parsed = JSON.parse(entry.data.toString("utf8"));
					externalSkills = Array.isArray(parsed?.skills) ? parsed.skills : [];
				} catch {
					externalSkills = [];
				}
			}
			return null;
		}
		// 包内路径越权（../ 或绝对路径）直接丢，不进 plan 也不写盘
		if (shouldSkip(entry.rel)) return null;
		if (!isSafeEntryPath(entry.rel)) {
			if (collect) rejected.push(entry.rel);
			return null;
		}
		// N-04：白名单镜像（S-05）—— 收集侧永远不会打进包的路径，恢复侧也不写。
		// 顺序放在 isSafeEntryPath 之后：不安全路径进 rejected，两者的语义不混。
		if (!isWhitelistedEntry(entry.rel)) {
			if (collect) skipped.push(entry.rel);
			return null;
		}
		const mapped = remapText(entry.data, pathMap);
		if (mapped.changed && collect) remapped.push(entry.rel);
		let data = mapped.data;
		if (CREDENTIAL_FILES.has(entry.rel)) {
			const missing = collect ? [] : null;
			data = await mergeCredentialFile(restoreTarget(entry.rel, home, externalRoot), mapped.data, missing);
			for (const field of missing ?? []) missingCredentials.push({ file: entry.rel, field });
		}
		// 版本日志按 id 取并集：快照里的旧日志不许冲掉本机更新的记录
		if (entry.rel === HISTORY_PREFIX + HISTORY_LOG) {
			let current = "";
			try {
				current = await readFile(restoreTarget(entry.rel, home, externalRoot), "utf8");
			} catch {
				current = "";
			}
			data = Buffer.from(mergeVersionLogText(mapped.data.toString("utf8"), current), "utf8");
		}
		return data;
	};

	// 第一遍：算计划（每条的 sha 与现状比）。B7：要写的内容在总量不超过 RESTORE_BUFFER_BYTES 时顺手留下，
	// 第二遍就不必再解压一次整包；超了就丢掉已留的、照旧第二遍流式读（内存上限不变）。
	const actions = new Map();
	let buffered = new Map();
	let bufferedBytes = 0;
	await forEachTarGzEntry(archiveFile, async (raw) => {
		verifySnapshotEntry(raw, expected, seen);
		const entry = unwrapNeedsNewer(raw);
		const data = await prepare(entry, true);
		if (data === null) return;
		const target = restoreTarget(entry.rel, home, externalRoot);
		const sha = createHash("sha256").update(data).digest("hex");
		let currentSha = null;
		try {
			currentSha = createHash("sha256").update(await readFile(target)).digest("hex");
		} catch {
			currentSha = null;
		}
		const action = currentSha === null ? "create" : currentSha === sha ? "same" : "overwrite";
		plan.push({ rel: entry.rel, action, sha });
		actions.set(entry.rel, action);
		if (action !== "same" && buffered !== null) {
			bufferedBytes += data.length;
			if (bufferedBytes > RESTORE_BUFFER_BYTES) buffered = null;
			else buffered.set(entry.rel, data);
		}
	});
	if (expected !== null && seen.size !== expected.size) throw new UserError("快照内容校验失败：清单中的文件缺失");
	const summary = {
		id: safeId,
		integrity: expected === null ? "legacy-unverified" : "verified",
		dryRun: options.dryRun === true,
		total: plan.length,
		create: plan.filter((p) => p.action === "create").length,
		overwrite: plan.filter((p) => p.action === "overwrite").length,
		same: plan.filter((p) => p.action === "same").length,
		remapped: remapped.length,
		rejected: rejected.length,
		// N-04：被白名单镜像拦下的条目数（dry-run 与真恢复都带）
		skipped: skipped.length,
		// ：占位符没补回的凭据字段 [{file, field}]——目标机没有同名同键的现值；内嵌的仍是占位符，整字段的不写
		missingCredentials,
		// WO-LINK-2：需自行拉取的 skill（包里没有它们的内容）
		pendingPulls: externalSkills.map((item) => ({
			name: item.name,
			repo: item.repo ?? "",
			ref: item.ref ?? "",
			sha: item.sha ?? "",
			subdir: item.subdir ?? ""
		}))
	};
	if (options.dryRun === true) return { ...summary, plan, rejectedPaths: rejected, skippedPaths: skipped };

	// 写盘前先给当前状态留一份，出问题能退回去；只留最近几份，不然每恢复一次就多 1.2 MB。
	// 修剪挪到写完之后：第二遍还要从包里流式读，恢复的若正是一份 pre-restore 快照，先修剪可能删掉它自己
	// 保护快照打不出来就不许覆盖：旧写法 `.catch(() => null)` 吞掉失败照写，一个被占用的文件就能让
	// 「恢复前先留一份」落空，随后整批覆盖没有退路。只有两种情况允许没有保护快照继续：
	// 本机白名单里本来就没东西可留（全新机器）；或本次计划一个现有文件都不覆盖（只新建）。
	// options.force === true 是所有者明确放弃保护的口子。
	let pre = null;
	try {
		pre = await createSnapshot("pre-restore");
	} catch (error) {
		const nothingToProtect = error?.code === SNAPSHOT_EMPTY || summary.overwrite === 0;
		if (!nothingToProtect && options.force !== true) {
			throw new UserError(
				`恢复前快照没打成（${error instanceof Error ? error.message : String(error)}），本次会覆盖 ${summary.overwrite} 个现有文件，已中止、一个字节都没写。排除原因后重试；确认不需要保护快照时带 force:true。`,
				409,
				{ code: "PRE_RESTORE_SNAPSHOT_FAILED" }
			);
		}
	}

	const written = [];
	const failed = [];
	let unchanged = 0;
	const writeEntry = async (rel, data) => {
		const entry = { rel };
		const target = restoreTarget(entry.rel, home, externalRoot);
		try {
			await mkdir(dirname(target), { recursive: true });
			// 恢复也是对同一批凭据文件落盘（WO-SEC-3 补遗）：新建时按 0600，
			// 已存在的写完再收紧一次；否则恢复到空机器上会按默认 0644 落盘。
			if (CREDENTIAL_FILES.has(entry.rel)) {
				await writeFile(target, data, { mode: CREDENTIAL_FILE_MODE });
				await hardenPermissions(target);
			} else {
				await writeFile(target, data);
			}
			written.push(entry.rel);
		} catch (error) {
			failed.push({ rel: entry.rel, error: error instanceof Error ? error.message : String(error) });
		}
	};
	// B7：第一遍判定与现状逐字节相同的条目不再重写（只计入 written / unchanged，不动文件、不改 mtime）
	for (const item of plan) {
		if (item.action !== "same") continue;
		unchanged += 1;
		written.push(item.rel);
	}
	if (buffered !== null) {
		for (const [rel, data] of buffered) await writeEntry(rel, data);
	} else {
		// 第二遍：逐条解、逐条落盘
		await forEachTarGzEntry(archiveFile, async (raw) => {
			const entry = unwrapNeedsNewer(raw);
			if (actions.get(entry.rel) === "same") return;
			const data = await prepare(entry, false);
			if (data === null) return;
			await writeEntry(entry.rel, data);
		});
	}
	await pruneByLabel("pre-restore", PRE_RESTORE_KEEP).catch(() => {});
	// WO-LINK-2：把待拉取清单落到目标 skill 根，供恢复端 DSH 用 skill-import / git 自己拉
	if (externalSkills.length > 0) {
		const pendingPath = join(externalRoot, PENDING_PULLS_FILE);
		const payload = {
			note: "下列 skill 未随快照打包（体积大且来源可确定）。用 skill-import 或 git 自行拉取。",
			at: new Date().toISOString(),
			pulls: externalSkills.map((item) => ({
				name: item.name,
				source: item.repo ?? "",
				ref: item.ref ?? "",
				sha: item.sha ?? "",
				subdir: item.subdir ?? ""
			}))
		};
		try {
			await mkdir(externalRoot, { recursive: true });
			await writeFile(pendingPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
		} catch (error) {
			failed.push({ rel: PENDING_PULLS_FILE, error: error instanceof Error ? error.message : String(error) });
		}
	}
	invalidateScanCache();
	return {
		...summary,
		dryRun: false,
		written: written.length,
		unchanged,
		failed,
		preSnapshot: pre?.id ?? null,
		skippedPaths: skipped
	};
}

/** 恢复时第一遍顺手留在内存里的待写内容上限（B7）；超过就退回第二遍流式读。 */
const RESTORE_BUFFER_BYTES = 64 * 1024 * 1024;

/** 包内挂在 NEEDS_NEWER_PREFIX 下的凭据文件还原成原路径；不是凭据文件的保持原样（随后按白名单外跳过）。 */
function unwrapNeedsNewer(entry) {
	if (!entry.rel.startsWith(NEEDS_NEWER_PREFIX)) return entry;
	const rel = entry.rel.slice(NEEDS_NEWER_PREFIX.length);
	return CREDENTIAL_FILES.has(rel) ? { ...entry, rel } : entry;
}

/** 删掉一份快照（连目录一起）。 */
export async function deleteSnapshot(id) {
	const target = join(snapshotsDir(), assertSnapshotId(id));
	if (!(await pathExists(target))) throw notFound(`快照不存在：${id}`);
	await removeDirForcibly(target);
	return { id, deleted: true };
}

/** 只保留最近 keep 份，其余连目录一起删。 */
export async function pruneSnapshots(keep = 10) {
	const safeKeep = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : 10;
	const list = await listSnapshots();
	const doomed = list.slice(Math.max(0, safeKeep));
	for (const item of doomed) {
		// manifest 里的 id 是外部数据（也可能被手改过），拼 rm 路径前必须过闸（BUG-14）
		await removeDirForcibly(join(snapshotsDir(), assertSnapshotId(item.id)));
	}
	return { kept: Math.min(list.length, safeKeep), removed: doomed.map((d) => d.id) };
}

// ── 定时备份 ──────────────────────────────────────────────────────────────

const SCHEDULE_FILE = () => resolve(dshHome(), "dsh-studio", "snapshot.json");
/** C-2：skill 根下单文件默认上限 5 MB，超过就不进包（0 = 关闭过滤）。 */
const DEFAULT_MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_SCHEDULE = {
	enabled: false,
	intervalHours: 24,
	keep: 10,
	maxSkillFileBytes: DEFAULT_MAX_SKILL_FILE_BYTES,
	/** WO-LINK-1：大 skill 来源可确定时只记链接（默认开，与 C-2 的单文件上限互相独立） */
	linkExternalSkills: true
};

/** 读定时备份配置（缺文件/坏 JSON 一律回默认：关、24 小时、留 10 份）。 */
export async function loadSchedule() {
	try {
		const parsed = JSON.parse(await readFile(SCHEDULE_FILE(), "utf8"));
		return {
			enabled: parsed?.enabled === true,
			intervalHours:
				Number.isFinite(parsed?.intervalHours) && parsed.intervalHours > 0
					? parsed.intervalHours
					: DEFAULT_SCHEDULE.intervalHours,
			keep: Number.isFinite(parsed?.keep) && parsed.keep >= 1 ? Math.floor(parsed.keep) : DEFAULT_SCHEDULE.keep,
			maxSkillFileBytes:
				Number.isFinite(Number(parsed?.maxSkillFileBytes)) && Number(parsed.maxSkillFileBytes) >= 0
					? Number(parsed.maxSkillFileBytes)
					: DEFAULT_SCHEDULE.maxSkillFileBytes,
			linkExternalSkills: parsed?.linkExternalSkills !== false,
			lastError: typeof parsed?.lastError === "string" ? parsed.lastError : "",
			lastErrorAt: Number.isFinite(Number(parsed?.lastErrorAt)) ? Number(parsed.lastErrorAt) : 0
		};
	} catch {
		return { ...DEFAULT_SCHEDULE, lastError: "", lastErrorAt: 0 };
	}
}

/** 改定时备份配置（只改传进来的字段）。 */
export async function saveSchedule(patch = {}) {
	// N-06：load → 合并 → 写整段在同一把文件锁里（两个面板请求并发写会互相覆盖）
	return withFileLock(SCHEDULE_FILE(), async () => {
		const current = await loadSchedule();
		const next = {
			enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
			intervalHours:
				Number.isFinite(patch.intervalHours) && patch.intervalHours > 0 ? patch.intervalHours : current.intervalHours,
			// keep 至少 1：0.5 这类值 floor 成 0 会把定时快照全修剪掉
			keep: Number.isFinite(patch.keep) && patch.keep >= 1 ? Math.floor(patch.keep) : current.keep,
			maxSkillFileBytes:
				Number.isFinite(Number(patch.maxSkillFileBytes)) && Number(patch.maxSkillFileBytes) >= 0
					? Number(patch.maxSkillFileBytes)
					: current.maxSkillFileBytes,
			linkExternalSkills: typeof patch.linkExternalSkills === "boolean" ? patch.linkExternalSkills : current.linkExternalSkills,
			lastError: typeof patch.lastError === "string" ? patch.lastError : (current.lastError ?? ""),
			lastErrorAt: Number.isFinite(Number(patch.lastErrorAt)) ? Number(patch.lastErrorAt) : (current.lastErrorAt ?? 0)
		};
		await mkdir(dirname(SCHEDULE_FILE()), { recursive: true });
		await writeFile(SCHEDULE_FILE(), JSON.stringify(next, null, 2), "utf8");
		return next;
	});
}

/** 上次定时备份的时间点（0 = 从没跑过）。 */
async function lastScheduledAt() {
	const list = await listSnapshots();
	const hit = list.find((s) => s.label === "scheduled");
	return hit?.at ?? 0;
}

/**
 * 只清理某个标签的旧快照。
 *
 * 定时备份与恢复前的保护快照都用它，不能调 pruneSnapshots —— 后者按时间排全部快照，
 * 把用户手动建的那几份一起算进「保留 N 份」里，实测会删掉 manual。
 */
async function pruneByLabel(label, keep) {
	const list = (await listSnapshots()).filter((item) => item.label === label);
	const doomed = list.slice(Math.max(0, keep));
	for (const item of doomed) {
		// manifest 里的 id 是外部数据（也可能被手改过），拼 rm 路径前必须过闸（BUG-14）
		await removeDirForcibly(join(snapshotsDir(), assertSnapshotId(item.id)));
	}
	return { kept: Math.min(list.length, keep), removed: doomed.map((item) => item.id) };
}

/** 恢复前的保护快照留这么多份，再多就删最旧的。 */
const PRE_RESTORE_KEEP = 3;

/**
 * 定时备份失败时打到 stderr 的前缀。必须出现在进程的 stdout/stderr 上。
 *
 * 真机第 9 项（ALEXWORK / 8124fc1）：快照目录写拒绝时 `runScheduledBackup()` 抛了
 * EPERM，但 apply() 里 `ctx.logger?.warn?.("[dsh-studio] 定时备份失败：…")` 从未出现
 * 在隔离实例的 stdout/stderr。原因：失败只在定时器回调里记 logger，直接调用没有
 * 这条路径；且 Cordis 默认 exporter 只写入内存 buffer（见 @deepseek-ai/cordis
 * `LoggerService` 构造函数），`ctx.logger.warn` 本身也不保证落到标准流。
 */
export const SCHEDULED_BACKUP_FAIL_PREFIX = "[dsh-studio] 定时备份失败：";

/** 把定时备份失败写到 stderr，并尽量通知宿主 logger（logger 坏了也不挡 stderr）。 */
export function warnScheduledBackupFailure(error, logger) {
	const message = error instanceof Error ? error.message : String(error);
	const line = `${SCHEDULED_BACKUP_FAIL_PREFIX}${message}`;
	try {
		if (typeof logger?.warn === "function") logger.warn(line);
	} catch {
		/* logger 抛错也不挡 stderr */
	}
	console.warn(line);
	return line;
}

/**
 * 到点就备份一次并清理旧快照。
 * 调用方（插件 apply 里的定时器）每半小时问一次，这里只判断「该不该跑」。
 * 失败时先记 lastError、再打 stderr，然后把原错误抛回给调用方。
 */
export async function runScheduledBackup(now = Date.now(), opts = {}) {
	const logger = opts?.logger;
	const cfg = await loadSchedule();
	if (!cfg.enabled) return { skipped: "disabled" };
	const last = await lastScheduledAt();
	const dueAt = last + cfg.intervalHours * 3600_000;
	if (now < dueAt) return { skipped: "not-due", dueAt };
	try {
		const snap = await createSnapshot("scheduled");
		const pruned = await pruneByLabel("scheduled", cfg.keep);
		if (cfg.lastError) await saveSchedule({ lastError: "", lastErrorAt: 0 });
		return { created: snap.id, fileCount: snap.files.length, pruned };
	} catch (error) {
		const lastError = error instanceof Error ? error.message : String(error);
		await saveSchedule({ lastError, lastErrorAt: Date.now() }).catch(() => {});
		warnScheduledBackupFailure(error, logger);
		throw error;
	}
}

/** 导出：把某份快照打成可携带的 .tar.gz 文件。 */
export async function exportSnapshot(id, targetPath) {
	const dir = join(snapshotsDir(), assertSnapshotId(id));
	const source = join(dir, "config.tar.gz");
	const bytes = (await stat(source)).size;
	await mkdir(dirname(resolve(targetPath)), { recursive: true });
	await copyFile(source, resolve(targetPath)); // 审计 7：不把整包读进内存
	const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
	return { path: resolve(targetPath), bytes, files: manifest.files?.length ?? 0 };
}

/**
 * 导入：把外部 .tar.gz 读成一份快照（不写配置）。
 *
 * 包可能来自别人，含 `../` 或绝对路径的条目在这里就报错，不留给后面的恢复去发现。
 */
export async function importSnapshot(sourcePath, label = "imported") {
	const source = resolve(sourcePath);
	const archiveBytes = (await stat(source)).size;
	// 审计 7：流式过一遍，只留每条的 rel / 字节数 / sha，不把整包条目留在内存里
	const files = [];
	try {
		await forEachTarGzEntry(source, (entry) => {
			files.push({ rel: entry.rel, bytes: entry.data.length, sha: createHash("sha256").update(entry.data).digest("hex") });
		});
	} catch (error) {
		throw new UserError("这个包解不开（不是有效的 tar.gz）：" + (error instanceof Error ? error.message : String(error)));
	}
	if (files.length === 0) throw new UserError("这个包里没有可读取的文件");
	const unsafe = files.filter((entry) => !isSafeEntryPath(entry.rel)).map((entry) => entry.rel);
	if (unsafe.length > 0) {
		throw new UserError(`包里有 ${unsafe.length} 条越权路径，已拒绝导入：${unsafe.slice(0, 3).join(", ")}`);
	}
	const id = `${stamp()}-${String(label).replace(/[^\w.-]+/g, "_") || "imported"}`;
	const dir = join(snapshotsDir(), id);
	await mkdir(dir, { recursive: true });
	await copyFile(source, join(dir, "config.tar.gz"));
	const manifest = { id, label, at: Date.now(), archiveBytes, files, imported: true };
	await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
	return manifest;
}
