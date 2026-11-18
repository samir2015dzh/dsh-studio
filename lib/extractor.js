/**
 * dsh-studio — skill extraction core (merged from dsh-skill-extractor).
 *
 * Pure, no DSH-runtime dependency. Handles: extractor config store, session-log
 * scanning/digesting, LLM candidate extraction, the candidate queue, dedup, and
 * writing SKILL.md into the Obsidian personal skill library (2️⃣ AI/Skill/).
 */
import { readdir, readFile, writeFile, appendFile, mkdir, stat, rename } from "node:fs/promises";
import { guardContent, guardTextOf } from "./guard-content.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { CorruptFileError, isObjectJson, readJsonState } from "./json-file.js";
import { versionedSkillWrite } from "./versions.js";
import { runWithWriteContext } from "./write-context.js";
import { withFileLock } from "./state-lock.js";
import { UserError } from "./errors.js";
import { scrubSecrets } from "./redact.js";
import { rememberKey } from "./remember.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, basename, dirname, delimiter, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_CONFIG_FILE = join(homedir(), ".dsh", "dsh-studio", "extractor.json");
export const DEFAULT_CANDIDATE_FILE = join(homedir(), ".dsh", "dsh-studio", "candidates.json");
export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".dsh", "sessions");

/**
 * The canonical session-log names DSH has written across generations:
 * `session.jsonl[.zstd]` (v0), `session.v3.jsonl.zstd`, `session.v4.jsonl.zstd`, …
 * Mirrors the core's `CANONICAL_LOG_FILENAME` (`/^session(?:\.v([1-9][0-9]*))?\.jsonl$/`)
 * plus the optional `.zstd` suffix, so a version bump never blinds the scanner again.
 */
export const SESSION_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/** Whether a directory entry names a session log of any generation. */
export function isSessionLogName(name) {
	return SESSION_LOG_NAME.test(name);
}

/**
 * Directories a Finder-launched desktop Host does not put on PATH (the Electron
 * app inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin`), so a bare `zstd`
 * spawn would ENOENT there and the scan would silently return nothing.
 */
function extraBinDirs() {
	return [
		process.env.DSH_EXTRA_BIN_DIRS ?? "",
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(homedir(), ".local", "bin"),
		"/usr/bin",
		"/bin"
	].filter((d) => d !== "");
}

/** Absolute path of `name` when it is findable, otherwise the bare name (fallback). */
export function resolveExecutable(name) {
	const suffixes = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	const seen = new Set();
	for (const dir of [...(process.env.PATH ?? "").split(delimiter), ...extraBinDirs()]) {
		if (dir === "" || seen.has(dir)) continue;
		seen.add(dir);
		for (const suffix of suffixes) {
			const candidate = join(dir, name + suffix);
			if (existsSync(candidate)) return candidate;
		}
	}
	return name;
}
/**
 * Resolve the per-user agent skill root that DSH's model-facing registry auto-loads.
 * Honours DSH_AGENTS_HOME (when configured); defaults to ~/.agents/skills.
 * Never baked to a single user's path — portability across machines/users.
 */
export function defaultAgentSkillDir() {
	const agentsHome = process.env.DSH_AGENTS_HOME;
	return agentsHome ? join(agentsHome, "skills") : join(homedir(), ".agents", "skills");
}

/**
 * Extra per-user skill directories the panel should also scan on top of the
 * standard roots — currently the user-configured mirror dir (e.g. Obsidian).
 * Resolved from the extractor config, never baked to one user's path.
 */
export async function configuredExtraSkillDirs() {
	try {
		const cfg = await new ExtractorStore().load();
		return cfg.mirrorDir ? [cfg.mirrorDir] : [];
	} catch {
		return [];
	}
}

function configPath() {
	const o = process.env.DSH_SKILL_EXTRACTOR_CONFIG;
	return o !== void 0 && o !== "" ? o : DEFAULT_CONFIG_FILE;
}
function candidatePath() {
	const o = process.env.DSH_SKILL_EXTRACTOR_CANDIDATES;
	return o !== void 0 && o !== "" ? o : DEFAULT_CANDIDATE_FILE;
}
/** 候选队列文件路径（尊重 DSH_SKILL_EXTRACTOR_CANDIDATES 覆盖）。 */
export function candidateFile() {
	return candidatePath();
}
function sessionsRoot() {
	const o = process.env.DSH_SKILL_EXTRACTOR_SESSIONS;
	return o !== void 0 && o !== "" ? o : DEFAULT_SESSIONS_ROOT;
}

export function defaults() {
	return {
		enabled: true,
		intervalMinutes: 1440,
		windowDays: 7,
		maxCandidatesPerRun: 3,
		skillLanguage: "zh",
		llmBaseUrl: "",
		llmApiKey: "",
		llmModel: "",
		agentSkillDir: defaultAgentSkillDir(),
		mirrorDir: "",
		/** 提取后直接写入正式库，不进待确认队列（入队仅当写入失败）。
		 *  默认 true（WO-EVO-7）：优化类改动直接生效，不需要人工确认。 */
		autoAccept: true,
		/** 与既存 skill 的 name+description 相似度超过此值才尝试语义合并 */
		mergeThreshold: 0.2,
		/** 手动指定模型；留空则跟随当前会话 / DSH 默认 */
		provider: "",
		model: "",
		/** 每轮对话结束时先做轻量判定，值得才提取 */
		autoPerTurn: true,
		/** WO-BORROW-1：多久没用标 stale / 多久没用归档（天，0 = 关闭） */
		staleAfterDays: 90,
		archiveAfterDays: 180,
		lastRunAt: "",
		lastRunSummary: "",
		/** B3：上一轮真正调用了提取模型的那份提示词指纹；摘要没变就不再调一次 */
		lastDigest: ""
	};
}

function clampInt(v, min, max) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	return Math.min(max, Math.max(min, Math.floor(v)));
}

export function parse(raw) {
	const r = typeof raw === "object" && raw !== null ? raw : {};
	const num = (v, f, min, max) => clampInt(v, min, max) ?? f;
	const str = (v, f = "") => typeof v === "string" ? v : f;
	const bool = (v, f) => typeof v === "boolean" ? v : f;
	const d = defaults();
	const lang = str(r.skillLanguage, d.skillLanguage).toLowerCase();
	return {
		enabled: bool(r.enabled, d.enabled),
		intervalMinutes: num(r.intervalMinutes, d.intervalMinutes, 0, 10080),
		windowDays: num(r.windowDays, d.windowDays, 1, 365),
		maxCandidatesPerRun: num(r.maxCandidatesPerRun, d.maxCandidatesPerRun, 1, 20),
		skillLanguage: lang === "en" ? "en" : lang === "auto" ? "auto" : "zh",
		llmBaseUrl: str(r.llmBaseUrl, d.llmBaseUrl),
		llmApiKey: str(r.llmApiKey, d.llmApiKey),
		llmModel: str(r.llmModel, d.llmModel),
		agentSkillDir: str(r.agentSkillDir, d.agentSkillDir),
		mirrorDir: str(r.mirrorDir, d.mirrorDir),
		autoAccept: bool(r.autoAccept, d.autoAccept),
		mergeThreshold: Math.min(1, Math.max(0, typeof r.mergeThreshold === "number" ? r.mergeThreshold : d.mergeThreshold)),
		provider: str(r.provider, d.provider),
		model: str(r.model, d.model),
		autoPerTurn: bool(r.autoPerTurn, d.autoPerTurn),
		// WO-BORROW-1：生命周期阈值（天）。0 = 关闭该档，负数按 0 处理
		staleAfterDays: num(r.staleAfterDays, d.staleAfterDays, 0, 3650),
		archiveAfterDays: num(r.archiveAfterDays, d.archiveAfterDays, 0, 3650),
		lastRunAt: str(r.lastRunAt, d.lastRunAt),
		lastRunSummary: str(r.lastRunSummary, d.lastRunSummary),
		lastDigest: str(r.lastDigest, d.lastDigest)
	};
}

/** File-backed extractor config store (mode 0600). */
export class ExtractorStore {
	/** 由 apply() 在挂载时写入：宿主是否提供 llm 服务（true 时面板显示「走 DSH 模型」）。 */
	dshAvailable = false;
	/** 读盘并区分「不存在 / 可解析 / 坏了 / 读不到」（BOM 由 readJsonState 剥掉）。 */
	async read() {
		try {
			return await readJsonState(configPath(), { validate: isObjectJson });
		} catch (error) {
			return { status: "unreadable", error };
		}
	}
	/**
	 * 只读视图，永不抛。文件不存在 → 默认值（全新安装）。
	 * 存在但坏了 / 一时读不到（BOM 之外的损坏、截断、Windows 上被占用）→ **关闭态**的默认值：
	 * 旧写法把这两种也当「没配置」，结果是 enabled 变回 true、定时器立刻自己跑一轮，
	 * 随后的 patch 再把默认值落盘，用户的模型 / 目录 / 关闭开关全被冲掉。写入侧的拒绝见 patch。
	 */
	async load() {
		const r = await this.read();
		if (r.status === "ok") return parse(r.value);
		if (r.status === "missing") return defaults();
		return { ...defaults(), enabled: false, autoPerTurn: false };
	}
	async save(cfg) {
		await mkdir(dirname(configPath()), { recursive: true });
		await atomicWriteFile(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
		return cfg;
	}
	async patch(args) {
		// N-06：load → 合并 → save 整个周期在同一把文件锁里（面板改配置与工具改配置并发时曾互相覆盖）
		return withFileLock(configPath(), async () => {
			// 坏文件 / 读不到时拒绝写：原文件原地保留（readJsonState 已留档），不许用默认值覆盖
			const r = await this.read();
			if (r.status === "corrupt") throw new CorruptFileError(configPath(), r);
			if (r.status === "unreadable") throw r.error;
			const cur = r.status === "ok" ? parse(r.value) : defaults();
			const merged = { ...cur };
			if (args !== void 0 && typeof args === "object") {
				for (const k of Object.keys(merged)) {
					if (k in args) merged[k] = args[k];
				}
			}
			const view = parse(merged);
			await this.save(view);
			return view;
		});
	}
	async view() {
		const v = await this.load();
		return {
			...v,
			llmKeyMasked: v.llmApiKey ? v.llmApiKey.slice(0, 2) + "…" + v.llmApiKey.slice(-2) : "",
			llmApiKey: "",
			configured: v.llmBaseUrl !== "" && v.llmApiKey !== "" && v.llmModel !== "",
			dshModel: this.dshAvailable === true,
			configPath: configPath(),
			candidatePath: candidatePath()
		};
	}
}

/**
 * B2：目录列表缓存。会话目录是「根/<会话>/session.*.jsonl[.zstd]」，新会话 = 根下新目录，
 * 日志换代 = 会话目录里新文件——两种情况父目录的 mtime 都会变。目录 mtime 没变就复用上次的列表，
 * 只 stat 不 readdir；另设一个兜底时限，过期强制重列（防个别文件系统不更新目录 mtime）。
 * 列表内容与顺序与直接 readdir 相同（缓存的就是那次 readdir 的结果）。
 */
const DIR_CACHE_TTL_MS = 10 * 60 * 1000;
const dirListCache = new Map();
export const sessionScanCounters = { readdirs: 0, dirReused: 0, parsed: 0, reused: 0 };

async function listDirCached(dir) {
	let st;
	try {
		st = await stat(dir);
	} catch {
		dirListCache.delete(dir);
		return null;
	}
	const hit = dirListCache.get(dir);
	if (hit !== undefined && hit.mtimeMs === st.mtimeMs && Date.now() - hit.at < DIR_CACHE_TTL_MS) {
		sessionScanCounters.dirReused += 1;
		return hit.entries;
	}
	let entries;
	try {
		entries = (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() }));
	} catch {
		dirListCache.delete(dir);
		return null;
	}
	sessionScanCounters.readdirs += 1;
	dirListCache.set(dir, { mtimeMs: st.mtimeMs, at: Date.now(), entries });
	return entries;
}

async function findSessionFiles(root) {
	const out = [];
	const seen = new Set();
	async function walk(dir) {
		seen.add(dir);
		const entries = await listDirCached(dir);
		if (entries === null) return;
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.dir) await walk(p);
			else if (isSessionLogName(e.name)) out.push(p);
		}
	}
	await walk(root);
	// 删掉的会话目录不再占缓存
	for (const dir of dirListCache.keys()) if ((dir === root || dir.startsWith(root + sep)) && !seen.has(dir)) dirListCache.delete(dir);
	return out;
}

/**
 * 技能加载事件（N-03）：日志里唯一的可观测形态是模型调用 `skill` 工具
 * （`tool/call` + `data.name === "skill"`），技能名在 `data.arguments.name`，
 * 事件时间取 envelope 的 `time`。消息正文提到技能名不构成加载事件。
 */
function skillLoadOf(row) {
	const data = row?.data;
	if (!data || data.name !== "skill") return null;
	let args = data.arguments;
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			return null;
		}
	}
	const name = args && typeof args === "object" ? args.name : void 0;
	if (typeof name !== "string" || name.trim() === "") return null;
	return { name: name.trim(), at: Number.isFinite(row.time) ? row.time : null };
}

async function readSessionLog(file) {
	try {
		// Compressed generations shell out to a resolved `zstd`: a Finder-launched
		// desktop Host runs with launchd's minimal PATH, where a bare spawn is ENOENT
		// and the whole scan would silently come back empty. Plain `.jsonl` is read directly.
		const stdout = file.endsWith(".zstd")
			? (await execFileAsync(resolveExecutable("zstd"), ["-d", "-c", file], { maxBuffer: 512 * 1024 * 1024 })).stdout
			: await readFile(file, "utf8");
		const session = {};
		const msgs = [];
		const skillLoads = [];
		let toolCalls = 0;
		let toolResults = 0;
		for (const l of stdout.split("\n")) {
			if (!l) continue;
			let o;
			try {
				o = JSON.parse(l);
			} catch {
				continue;
			}
			if (o === null || typeof o !== "object") continue;
			if (o.type === "session") {
				session.id = o.id;
				session.createdAt = o.createdAt;
				session.cwd = o.cwd;
			} else if (o.type === "agent/inbox/spliced") {
				const ins = o.data && o.data.inserted;
				if (Array.isArray(ins)) {
					for (const item of ins) {
						const role = item && item.role;
						const content = item && Array.isArray(item.content) ? item.content : [];
						const text = content.map((c) => (c && c.type === "text" ? c.text : "")).join(" ").trim();
						// 凭据形态的片段在入口就抹掉：msgs 之后会进摘要（发给模型）、每轮判定、草稿 provenance 摘录
						if (text) msgs.push({ role, text: scrubSecrets(text) });
					}
				}
			} else if (typeof o.type === "string" && o.type.startsWith("tool/")) {
				// · A7：先判是字符串——`type` 是数字 / 对象的一行此前让 startsWith 抛错，被外层 catch 吞掉，整份日志作废
				if (o.type === "tool/call") {
					toolCalls++;
					const load = skillLoadOf(o);
					if (load) skillLoads.push(load);
				} else if (o.type === "tool/result") toolResults++;
			}
		}
		return { session, msgs, toolCalls, toolResults, skillLoads };
	} catch {
		return null;
	}
}

/**
 * B2：会话解析缓存，按文件 (mtime, size) 指纹。每轮提取以前要把窗口内全部日志（所有者机器上约
 * 945 份）各起一个 zstd 子进程解压、逐行 JSON.parse，而真正变的通常只有正在进行的那一两份。
 * 每份只常驻轻量结果（会话头、技能加载事件、消息数）；完整消息只给「要进摘要」的最新几份留着（有上限）。
 * 解析失败的文件同样按指纹记住，不每轮重新解压。
 * 不换 Node 自带 zstd：DSH 日志是追加写的，可能是多帧拼接，而 zstdDecompressSync 对两帧拼接只解第一帧。
 */
const SESSION_FULL_KEEP = 24;
const sessionCache = new Map();
let sessionFullCount = 0;

const sessionFp = (entry) => `${entry.mtime}:${entry.size}`;

function lightLog(log) {
	return { session: log.session, skillLoads: log.skillLoads, toolCalls: log.toolCalls, toolResults: log.toolResults, msgCount: log.msgs.length };
}

function dropFull(hit) {
	if (hit?.full) {
		hit.full = null;
		sessionFullCount -= 1;
	}
}

/**
 * @param {{file:string, mtime:number, size:number}} entry
 * @param {boolean} needFull 要完整消息（摘要用）还是只要轻量结果
 * @returns {Promise<object|null>} 完整 log 或轻量 log；解析失败为 null
 */
async function readSessionCached(entry, needFull) {
	const fp = sessionFp(entry);
	const hit = sessionCache.get(entry.file);
	if (hit !== undefined && hit.fp === fp && (hit.bad || !needFull || hit.full)) {
		sessionScanCounters.reused += 1;
		if (hit.bad) return null;
		if (!needFull) return hit.light;
		// LRU：最近用到的完整结果挪到末尾
		sessionCache.delete(entry.file);
		sessionCache.set(entry.file, hit);
		return hit.full;
	}
	const log = await readSessionLog(entry.file);
	sessionScanCounters.parsed += 1;
	dropFull(hit);
	sessionCache.delete(entry.file);
	if (log === null) {
		sessionCache.set(entry.file, { fp, bad: true, light: null, full: null });
		return null;
	}
	const item = { fp, bad: false, light: lightLog(log), full: needFull ? log : null };
	if (needFull) sessionFullCount += 1;
	sessionCache.set(entry.file, item);
	if (sessionFullCount > SESSION_FULL_KEEP) {
		for (const other of sessionCache.values()) {
			if (sessionFullCount <= SESSION_FULL_KEEP) break;
			if (other !== item) dropFull(other);
		}
	}
	return needFull ? log : item.light;
}

/** 测试用：清空会话解析与目录列表缓存。 */
export function resetSessionScanCache() {
	sessionCache.clear();
	dirListCache.clear();
	sessionFullCount = 0;
}

function truncate(s, n) {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 折成单行（换行 → ` ⏎ `）。摘要里一条消息只占一行，见 buildDigest。 */
function oneLine(s) {
	return String(s ?? "").replace(/\s*\r?\n\s*/g, " ⏎ ");
}

/**
 * @param {number} [fallbackMs] session.createdAt 读不懂时用的时间（调用方传文件 mtime）
 */
export function buildDigest(log, maxMsgs = 20, maxMsgLen = 200, fallbackMs = Date.now()) {
	const { session, msgs, toolCalls, toolResults } = log;
	// · A7：createdAt 解析不了（坏字符串 / 越界数字）时 new Date(...).toISOString() 抛 RangeError，
	// 最近 12 个会话里有一份这样的日志，每一轮提取都整轮失败。读不懂就退回文件 mtime。
	let at = new Date(session.createdAt || fallbackMs);
	if (!Number.isFinite(at.getTime())) at = new Date(Number.isFinite(fallbackMs) ? fallbackMs : Date.now());
	const title = session.cwd ? basename(session.cwd) : session.id || "unknown";
	const lines = [];
	lines.push(`## 会话「${title}」（${at.toISOString()}）`);
	if (session.cwd) lines.push(`工作区：${session.cwd}`);
	lines.push(`工具调用 ${toolCalls} 次 / 工具结果 ${toolResults} 次`);
	for (const m of msgs.slice(-maxMsgs)) {
		const role = m.role === "user" ? "用户" : "助手";
		// 消息正文里的换行折成一行：摘要按「一条消息一行」给模型看，正文自带的换行能伪造出
		// 一行 `- 用户：…`（网页 / 工具内容里夹一句就行），下游与模型都会把它当成用户原话
		lines.push(`- ${role}：${truncate(oneLine(m.text), maxMsgLen)}`);
	}
	return lines.join("\n");
}

/**
 * 窗口内的会话日志文件清单，只做 stat（不解压、不解析）：mtime 与 size 来自同一次 stat。
 * 顺序 = findSessionFiles 的枚举序（readdir 深度优先），后续排序口径的并列次序就靠它。
 */
async function findWindowFiles(root, windowDays) {
	const files = await findSessionFiles(root);
	const cutoff = Date.now() - windowDays * 86400000;
	const out = [];
	for (const f of files) {
		let st;
		try {
			st = await stat(f);
		} catch {
			continue;
		}
		if (st.mtimeMs < cutoff) continue;
		out.push({ file: f, mtime: st.mtimeMs, size: st.size });
	}
	return out;
}

/**
 * 唯一的排序口径：mtime 降序。并列时不许换次级键 —— Array#sort 自 ES2019 起要求稳定，
 * 所以并列项保持输入序（即 findSessionFiles 枚举序）。全量日志与摘要两条路径共用本比较器。
 */
const byMtimeDesc = (a, b) => b.mtime - a.mtime;

/**
 * 枚举并解析窗口内的会话日志，最新的在前。
 * N-03：提取与「真实使用信号」采集共用这一次枚举/解析（采集不再单独扫目录、再解压一遍）；
 * 这里不截断、不丢空消息会话，两件事各自的取舍留给自己的消费端。
 */
export async function collectSessionLogs(root, windowDays) {
	const found = [];
	for (const entry of await findWindowFiles(root, windowDays)) {
		const log = await readSessionLog(entry.file);
		if (!log) continue;
		found.push({ ...entry, log });
	}
	found.sort(byMtimeDesc);
	return found;
}

/**
 * Collect recent session digests within `windowDays`, most recent first.
 * N-07：先排序截断、再解压 —— 旧实现把窗口内每个会话都解压一遍，才 filter/slice；
 * 这里只读「可能进结果」的那些：按与 collectSessionLogs 完全相同的口径排序后逐个读取，
 * 解压失败与空消息都不占名额（继续往后补位），凑满 maxSessions 即停。
 */
export async function collectSessionDigests(root, windowDays, maxSessions = 12) {
	// ponytail: 非正整数上限沿用旧的 filter→slice 语义（slice(0,-n) 会去尾、slice(0,NaN) 为空），
	// 这时结果依赖总数、只能读全量；只有正整数才走进度即停的快路径。
	if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
		const logs = await collectSessionLogs(root, windowDays);
		return logs.filter((e) => e.log.msgs.length > 0).slice(0, maxSessions);
	}
	const out = [];
	for (const entry of (await findWindowFiles(root, windowDays)).sort(byMtimeDesc)) {
		const log = await readSessionCached(entry, true);
		if (!log || log.msgs.length === 0) continue;
		out.push({ ...entry, log });
		if (out.length >= maxSessions) break;
	}
	return out;
}

/**
 * B2：一轮提取的会话收集。返回
 *   - logs：窗口内全部会话（最新在前），log 只有轻量字段（session / skillLoads / 计数），喂给使用信号采集；
 *   - digs：其中最新的 maxDigests 份有消息的会话，带完整 log，做摘要。
 * 与「collectSessionLogs 后 filter(msgs>0).slice(0,12)」同口径（同一排序、同一并列次序），
 * 但没变过的文件（指纹相同）不再解压解析。
 */
export async function scanSessionsForExtraction(root, windowDays, maxDigests = 12) {
	const files = (await findWindowFiles(root, windowDays)).sort(byMtimeDesc);
	const logs = [];
	const digs = [];
	const live = new Set();
	for (const entry of files) {
		live.add(entry.file);
		const wantFull = digs.length < maxDigests;
		let log = await readSessionCached(entry, wantFull);
		if (log === null) continue;
		if (wantFull && log.msgs.length > 0) digs.push({ ...entry, log });
		if (wantFull) log = lightLog(log);
		logs.push({ ...entry, log });
	}
	// 出了窗口 / 被删掉的文件不再占缓存
	for (const [file, hit] of sessionCache) {
		if ((file === root || file.startsWith(root + sep)) && !live.has(file)) {
			dropFull(hit);
			sessionCache.delete(file);
		}
	}
	return { logs, digs };
}

export function buildPrompt(digestTexts, cfg) {
	const body = digestTexts.length ? digestTexts.join("\n\n") : "（没有近期会话）";
	const keepAsIs = "代码块、命令、路径、API 名、报错原文一律保持原样，不要翻译、不要改写。";
	const langLine =
		cfg.skillLanguage === "en"
			? `- 正文（body）用英文叙述；${keepAsIs} description 也用英文 Use when... 开头。`
			: cfg.skillLanguage === "auto"
				? `- 正文（body）跟随这段会话的主要语言叙述（会话是中文就中文，是英文就英文）；${keepAsIs} description 用英文 Use when... 开头。`
				: `- 正文（body）用中文叙述，但正文里出现的代码、命令、日志按原样保留；${keepAsIs} description 用英文 Use when... 开头（这是 agent 判断何时加载的依据）。`;
	return [
		"以下是从 DSH 会话日志里提取的摘要。请从中找出可复用的技术、模式、工作流或参考，把它们写成个人 skill。",
		"",
		"**第一优先级：用户明确要求记住的内容**（原话里出现「记住」「以后都按这个」「下次也这样」等）。",
		"遇到这类内容，必须单独写成一条 skill，正文以它为核心，不要和别的主题混在一条里；即使它看起来不像「技术」也要写。",
		"",
		"准入五条（全部满足才写；缺一条就不写）：",
		"- Recurring：会反复出现，不是只发生过一次",
		"- Verified：结论经过实际验证（跑通了、报错对上了），不是推测",
		"- Non-obvious：不查不知道、容易踩坑或反直觉的部分",
		"- Broadly applicable：换项目、换目标仍然适用",
		"- User-flagged：用户明确要求记住，或说了「以后都这样」",
		"不考虑：一次性解决、项目专属约定、已被文档覆盖的标准做法、能用自动化替代的机械约束。",
		"",
		"每个 skill 给出：",
		"- name：kebab-case 英文名",
		"- description：一句话「何时使用」（用 Use when... 开头，不要概括流程）",
		"- rationale：为什么可复用（一句话）",
		"- group：用途分类。只能从这几个里原样选一个，不要自己造新词：逆向分析 / 安全测试 / 代码工程 / 文档写作 / 环境运维 / 数据检索 / 流程协作 / 其他",
		"- body：markdown 正文（概述、何时用、核心模式、示例、常见错误），控制在 600–800 字，只写真正可复用的部分；不要写成某次解决过程的叙事，不要贴大段源码",
		langLine,
		"",
		`最多 ${cfg.maxCandidatesPerRun} 个。只输出 JSON（不要任何额外文字），格式：`,
		'{"candidates":[{"name":"","description":"","rationale":"","group":"","body":""}]}',
		"",
		"会话摘要：",
		body
	].join("\n");
}

/**
 * 解析要用的 provider/model：优先 cfg，其次当前 agent 的 route，最后回落到
 * DSH 已配置的第一个可用供应商。这样插件不需要自己存 API key / model。
 */
function pickRoute(agent, cfg) {
	if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
	const a = agent ?? {};
	for (const c of [a.route, a.config, a.options, a.defaultModel, a.model]) {
		if (c && typeof c === "object" && c.provider && c.model) return { provider: c.provider, model: c.model };
	}
	if (a.provider && a.model) return { provider: a.provider, model: a.model };
	return null;
}

async function resolveProviderModel(llm, agent, cfg) {
	const route = pickRoute(agent, cfg);
	if (route) return route;
	const providers = typeof llm.listProviders === "function" ? llm.listProviders() : [];
	if (!Array.isArray(providers) || providers.length === 0) throw new Error("DSH 未配置任何模型供应商");
	for (const p of providers) {
		const id = p.id ?? p.provider;
		if (!id) continue;
		try {
			const models = typeof llm.listModels === "function" ? await llm.listModels(id) : [];
			if (Array.isArray(models) && models.length > 0) {
				const first = models[0];
				const model = typeof first === "string" ? first : first.id ?? first.model;
				if (model) return { provider: id, model };
			}
		} catch {
			/* 该供应商不可用，继续下一个 */
		}
	}
	throw new Error("无法从 DSH 配置解析出可用模型（请在 DSH 里配置供应商/模型）");
}

/** 模型原始输出的诊断文件名（都在配置目录下）：提取 / 归属裁决 / 合并各一份。 */
export const RAW_FILE_EXTRACT = "last-llm-raw.txt";
export const RAW_FILE_PLACEMENT = "last-llm-raw-placement.txt";
export const RAW_FILE_MERGE = "last-llm-raw-merge.txt";

/** 从一个 text 块流的 chunk 里取可见文本。 */
function chunkText(chunk) {
	if (!chunk || typeof chunk !== "object") return "";
	if (chunk.type === "text-delta") return typeof chunk.text === "string" ? chunk.text : typeof chunk.delta === "string" ? chunk.delta : "";
	if (chunk.type === "block-end" && chunk.block && chunk.block.type === "text" && typeof chunk.block.text === "string") return chunk.block.text;
	return "";
}

/**
 * 走 DSH 自己的 llm 服务（用户配置里的 provider/model，不额外存密钥）。
 * 返回纯文本；失败抛错由上层回退或报错。
 */
async function callViaDsh(llm, agent, cfg, prompt, opts = {}) {
	return (await streamViaDsh(llm, agent, cfg, prompt, opts)).text;
}

/** 走宿主 llm 服务，返回文本与 usage 分片（的成本上限要用 token 数）。 */
async function streamViaDsh(llm, agent, cfg, prompt, { maxTokens = 4000, system = null, rawFile = RAW_FILE_EXTRACT, timeoutMs = 120000 } = {}) {
	const { provider, model } = await resolveProviderModel(llm, agent, cfg);
	runtimeState.lastRoute = { provider, model };
	const signal = AbortSignal.timeout(timeoutMs);
	// 提取是「读摘要 → 写条目」的机械活，用低思考强度更快更省；模型不支持就退回默认。
	const base = { provider, model, maxTokens };
	let prepared;
	try {
		prepared = await llm.prepareCall({ ...base, reasoningEffort: "low" }, signal);
	} catch {
		prepared = await llm.prepareCall(base, signal);
	}
	const options = {
		...prepared.config,
		system: system ?? "你从会话日志摘要中提取可复用的个人 skill。只输出 JSON。",
		messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
		signal
	};
	let text = "";
	let terminal;
	let usage = null;
	for await (const chunk of prepared.stream(options)) {
		const piece = chunkText(chunk);
		if (piece) text += piece;
		if (chunk && chunk.type === "usage" && chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
		if (chunk.type === "finish") terminal = chunk.reason;
	}
	if (terminal && terminal.kind === "error") throw new Error("DSH 模型调用失败：" + (terminal.failure?.message ?? terminal.failure?.code ?? "unknown"));
	if (text.trim() === "") throw new Error("DSH 模型返回空内容");
	// 留一份原始输出，解析失败时不用猜模型到底返回了什么。
	// 按用途分文件：以前所有调用共写 last-llm-raw.txt，提取解析失败时看到的常常只是
	// 后一次 YES/NO 判定的「NO」。rawFile 为 null 的调用（每轮判定）不落盘。
	if (typeof rawFile === "string" && rawFile !== "") {
		try {
			// C-4：诊断文件里可能有会话摘要，按 0600 落盘
			await writeFile(join(dirname(configPath()), rawFile), text, { encoding: "utf8", mode: 0o600 });
		} catch {
			/* 诊断文件写不进去不影响主流程 */
		}
	}
	return { text, usage, provider, model };
}

async function callViaHttp(cfg, prompt, opts = {}) {
	return (await requestViaHttp(cfg, prompt, opts)).text;
}

async function requestViaHttp(cfg, prompt, { maxTokens = 4000, system = null, timeoutMs = 120000 } = {}) {
	const base = (cfg.llmBaseUrl || "").replace(/\/+$/, "");
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.llmApiKey}` },
		body: JSON.stringify({
			model: cfg.llmModel,
			messages: [
				{ role: "system", content: system ?? "你从会话日志摘要中提取可复用的个人 skill。只输出 JSON。" },
				{ role: "user", content: prompt }
			],
			temperature: 0.2,
			max_tokens: maxTokens,
			response_format: { type: "json_object" }
		}),
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) throw new Error("LLM API responded " + res.status);
	const data = await res.json();
	const text =
		data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
	if (!text) throw new Error("LLM API empty completion");
	const u = data.usage;
	const usage = u && typeof u === "object" ? { inputTokens: Number(u.prompt_tokens) || 0, outputTokens: Number(u.completion_tokens) || 0 } : null;
	return { text, usage, provider: "http", model: cfg.llmModel };
}

/**
 * 调模型。优先走 DSH 的 llm 服务（llm 由调用方从 ctx 传入），
 * 只有调用方没给 llm 或显式要求 HTTP 时才回退到自带的 baseUrl/apiKey。
 */
export async function callLLM(cfg, prompt, { maxTokens = 4000, llm = null, agent = null, system = null, rawFile = RAW_FILE_EXTRACT } = {}) {
	if (llm) return callViaDsh(llm, agent, cfg, prompt, { maxTokens, system, rawFile });
	return callViaHttp(cfg, prompt, { maxTokens, system });
}

/**
 * 同 callLLM，但返回 {text, usage, provider, model}（usage 是宿主 TokenUsage 或 null）。
 * 的技能优化回路用它统计每轮 token 花费；接口与 callLLM 同一条路由口径。
 */
export async function callLLMDetailed(cfg, prompt, { maxTokens = 4000, llm = null, agent = null, system = null, rawFile = null, timeoutMs = 120000 } = {}) {
	if (llm) return streamViaDsh(llm, agent, cfg, prompt, { maxTokens, system, rawFile, timeoutMs });
	return requestViaHttp(cfg, prompt, { maxTokens, system, timeoutMs });
}

export function normalizeName(n) {
	return String(n)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** 从任意文本里取出第一个括号配平的 JSON 对象（忽略字符串内的花括号与转义）。 */
function firstJsonObject(text) {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
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
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/** 去掉模型常带的 ```json 围栏。 */
function stripFence(text) {
	return String(text || "")
		.trim()
		.replace(/^```(?:json|JSON)?\s*\n?/, "")
		.replace(/\n?```\s*$/, "")
		.trim();
}

/** 模型输出被 maxTokens 截断时，逐个抢救 candidates 数组里已经完整的对象。 */
function salvageCandidates(text) {
	const key = text.indexOf('"candidates"');
	if (key < 0) return [];
	const arrStart = text.indexOf("[", key);
	if (arrStart < 0) return [];
	const out = [];
	let i = arrStart + 1;
	while (i < text.length) {
		const objStart = text.indexOf("{", i);
		if (objStart < 0) break;
		const obj = firstJsonObject(text.slice(objStart));
		if (obj === null) break;
		try {
			out.push(JSON.parse(obj));
		} catch {
			/* 这个对象本身就坏了，跳过继续 */
		}
		i = objStart + obj.length;
	}
	return out;
}

/** buildPrompt 里给模型的 8 个固定分类；候选的 group 只能落在这里面。 */
const SKILL_GROUPS = new Set(["逆向分析", "安全测试", "代码工程", "文档写作", "环境运维", "数据检索", "流程协作", "其他"]);

/** 模型自造的分类名（或干脆没给）统一归「其他」，别让面板多出野生分组。 */
function normalizeGroup(value) {
	const text = typeof value === "string" ? value.trim() : "";
	return SKILL_GROUPS.has(text) ? text : "其他";
}

export function parseLlmCandidates(rawText) {
	const text = stripFence(rawText);
	let obj;
	try {
		obj = JSON.parse(text);
	} catch {
		const candidate = firstJsonObject(text);
		let parsed = null;
		if (candidate !== null) {
			try {
				parsed = JSON.parse(candidate);
			} catch {
				parsed = null;
			}
		}
		if (parsed !== null) obj = parsed;
		else {
			// 截断抢救：拿得到几个完整候选就用几个，不整批丢弃
			const salvaged = salvageCandidates(text);
			if (salvaged.length === 0) throw new Error("LLM response is not JSON");
			obj = { candidates: salvaged };
		}
	}
	const arr = Array.isArray(obj)
		? obj
		: obj && Array.isArray(obj.candidates)
			? obj.candidates
			: [];
	return arr
		.map((c) => ({
			name: normalizeName(String((c && c.name) || "")),
			description: String((c && c.description) || "").trim(),
			rationale: String((c && c.rationale) || "").trim(),
			// WO-EVO-2：group 之前在这里被丢掉，自动提取的 skill 永远没有 metadata.group
			group: normalizeGroup(c && c.group),
			body: String((c && c.body) || "").trim()
		}))
		.filter((c) => c.name && c.description && c.body);
}

/**
 * 读候选队列。不存在 → 空；存在但解析失败 → 抛 CorruptFileError（原文件保留并留档）。
 * 旧写法把坏文件当空队列，下一次 saveCandidates 就把待确认的候选整份冲掉。
 */
export async function loadCandidates() {
	const r = await readJsonState(candidatePath(), { validate: (v) => (Array.isArray(v) ? undefined : "顶层不是数组") });
	if (r.status === "missing") return [];
	if (r.status === "corrupt") throw new CorruptFileError(candidatePath(), r);
	return r.value;
}

/** WO-BORROW-7：自动生成 skill 的来源证据链目录。 */
export function provenanceDir() {
	return join(homedir(), ".dsh", "dsh-studio", "provenance");
}

/** 裁决事件流水（M-5）：append-only，一行一条，历史裁决可复盘。 */
export function provenanceEventsFile() {
	return join(provenanceDir(), "provenance-events.jsonl");
}

/**
 * 记一条 provenance（设计参考 ECNU-ICALK/AutoSkill 的 provenance_store.py，MIT，只借设计未移植代码）：
 * 这个 skill 从哪次对话来、正文摘要、走的是 SAVE / FOLD_INTO / tombstone 哪条裁决路径。
 * 同名按名覆盖写（保留「最新裁决」），每次裁决另追加一行事件流水（M-5），供质量度量按事件计数。
 */
export async function writeProvenance(record) {
	const name = normalizeName(String(record?.name ?? ""));
	if (name === "") return null;
	const payload = {
		name,
		at: new Date(Number(record.at ?? Date.now())).toISOString(),
		action: typeof record.action === "string" ? record.action : "SAVE",
		into: typeof record.into === "string" ? record.into : null,
		source: typeof record.source === "string" ? record.source : "session-extract",
		sessions: Array.isArray(record.sessions) ? record.sessions.filter((x) => typeof x === "string" && x !== "") : [],
		digest: typeof record.digest === "string" ? record.digest : "",
		rationale: typeof record.rationale === "string" ? record.rationale : ""
	};
	await mkdir(provenanceDir(), { recursive: true });
	await writeFile(join(provenanceDir(), name + ".json"), JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	// 事件流水只记四个字段：at / name / action / rationale（into 等细节留在按名文件里）
	const event = { at: payload.at, name, action: payload.action, rationale: payload.rationale };
	await appendFile(provenanceEventsFile(), JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
	return payload;
}

/** 读一条 provenance；没有就返回 null。 */
export async function readProvenance(name) {
	const key = normalizeName(String(name ?? ""));
	if (key === "") return null;
	try {
		return JSON.parse(await readFile(join(provenanceDir(), key + ".json"), "utf8"));
	} catch {
		return null;
	}
}

export async function saveCandidates(arr) {
	await mkdir(dirname(candidatePath()), { recursive: true });
	// tmp + rename（OPT-07）：与 ExtractorStore.save 同一写法，写一半崩掉不会留下坏 JSON
	const tmp = candidatePath() + ".tmp";
	await writeFile(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
	await rename(tmp, candidatePath());
	return arr;
}

/** 候选归档的滚动上限（M-6）：只留最近 500 条终局，超出丢最旧。 */
export const CANDIDATE_ARCHIVE_LIMIT = 500;

/** 候选终局归档文件（与 candidates.json 同目录，尊重同一套路径覆盖）。 */
export function candidateArchiveFile() {
	return join(dirname(candidatePath()), "candidates-archive.json");
}

/** 读归档；文件不存在或坏掉都当空表（归档只用于度量，不参与任何决策）。 */
export async function loadCandidateArchive() {
	try {
		const arr = JSON.parse(await readFile(candidateArchiveFile(), "utf8"));
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

/**
 * 把已裁决（accepted / rejected）的候选追加进归档（M-6）：
 * 接受即删会让「接受率」永远不可复盘，所以终局留档，并只保留最近 CANDIDATE_ARCHIVE_LIMIT 条。
 * @returns {Promise<{archived:number, dropped:number, total:number}>}
 */
export async function archiveCandidates(decided, { decision, now = Date.now() } = {}) {
	const entries = (Array.isArray(decided) ? decided : []).filter((c) => c && typeof c.name === "string");
	if (entries.length === 0) return { archived: 0, dropped: 0, total: 0 };
	const decidedAt = new Date(now).toISOString();
	// N-06：load → 追加 → 截断 → save 整段在归档文件自己的锁里（与 candidates.json 是两把锁）
	return withFileLock(candidateArchiveFile(), async () => {
		const next = [
			...(await loadCandidateArchive()),
			...entries.map((c) => ({ ...c, decision: decision === "accepted" ? "accepted" : "rejected", decidedAt }))
		];
		const dropped = Math.max(0, next.length - CANDIDATE_ARCHIVE_LIMIT);
		const kept = dropped > 0 ? next.slice(dropped) : next;
		const file = candidateArchiveFile();
		await mkdir(dirname(file), { recursive: true });
		const tmp = file + ".tmp";
		await writeFile(tmp, JSON.stringify(kept, null, 2), { mode: 0o600 });
		await rename(tmp, file);
		return { archived: entries.length, dropped, total: kept.length };
	});
}

/**
 * Update one pending candidate's draft fields in the queue (by id). Accepts
 * `{ name, description, rationale, body }`; the name is re-normalized to
 * kebab-case. Returns the updated candidate or null when not found.
 */
export async function updateCandidate(id, patch) {
	// N-06：整段 load → 改字段 → save 在同一把候选队列锁里
	return withFileLock(candidatePath(), async () => {
		const queue = await loadCandidates();
		const target = queue.find((c) => c.id === id && c.status === "pending");
		if (!target) return null;
		if (patch && typeof patch.body === "string") target.body = patch.body.trim();
		if (patch && typeof patch.rationale === "string") target.rationale = patch.rationale.trim();
		if (patch && typeof patch.description === "string") target.description = patch.description.trim();
		if (patch && typeof patch.name === "string") {
			const norm = normalizeName(patch.name);
			if (norm) target.name = norm;
		}
		await saveCandidates(queue);
		return target;
	});
}

export async function existingSkillNames(targetDir) {
	try {
		const entries = await readdir(targetDir, { withFileTypes: true });
		const names = [];
		for (const e of entries) {
			if (e.isDirectory()) names.push(e.name);
			else if (e.name.endsWith(".md")) names.push(basename(e.name, ".md"));
		}
		return names;
	} catch {
		return [];
	}
}

/** 把既有 SKILL.md 拆成 frontmatter 原文与正文，保留原换行风格。block 不含首尾 `---`。 */
function splitSkillText(text) {
	const nl = text.includes("\r\n") ? "\r\n" : "\n";
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?/);
	if (!m) return { block: null, body: text, nl };
	return { block: m[1], body: text.slice(m[0].length), nl };
}

/**
 * 就地重写 frontmatter：只替换受管键（name / description / metadata.group），
 * 其余顶层键、metadata 下的其他子键、键顺序与空行全部原样保留。
 * 合并一条被用户 `disable-model-invocation: true` 关掉的 skill，不能顺手把它打开。
 */
function rewriteFrontmatterBlock(block, fields, nl) {
	const lines = block === null || block === "" ? [] : block.split(/\r?\n/);
	const isTopKey = (line) => /^[A-Za-z0-9_.-]+\s*:/.test(line);
	// 顶层键区间 [start, end)：缩进续行与紧邻空行都归该键，尾部空行不吞
	const spans = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (!isTopKey(lines[i])) continue;
		let end = i + 1;
		while (end < lines.length && !isTopKey(lines[end])) end += 1;
		while (end - 1 > i && lines[end - 1].trim() === "") end -= 1;
		spans.push({ key: lines[i].match(/^([A-Za-z0-9_.-]+)\s*:/)[1], start: i, end });
		i = end - 1;
	}
	const byKey = new Map(spans.map((s) => [s.key, s]));
	const out = [];
	let cursor = 0;
	for (const span of spans) {
		for (let i = cursor; i < span.start; i += 1) out.push(lines[i]);
		if (span.key === "name") out.push(`name: ${fields.name}`);
		else if (span.key === "description") out.push(`description: ${JSON.stringify(String(fields.description ?? ""))}`);
		else if (span.key === "metadata") {
			const inner = lines.slice(span.start + 1, span.end);
			const gi = inner.findIndex((l) => /^\s+group\s*:/.test(l));
			if (fields.group !== "") {
				if (gi >= 0) inner[gi] = `  group: ${fields.group}`;
				else inner.push(`  group: ${fields.group}`);
			}
			out.push(lines[span.start], ...inner);
		} else for (let i = span.start; i < span.end; i += 1) out.push(lines[i]);
		cursor = span.end;
	}
	for (let i = cursor; i < lines.length; i += 1) out.push(lines[i]);
	// 缺失的受管键补在最前/最后，不打断既有顺序
	if (!byKey.has("description")) out.unshift(`description: ${JSON.stringify(String(fields.description ?? ""))}`);
	if (!byKey.has("name")) out.unshift(`name: ${fields.name}`);
	if (fields.group !== "" && !byKey.has("metadata")) out.push("metadata:", `  group: ${fields.group}`);
	return out.join(nl);
}

export async function writeSkill(targetDir, cand, { force = false } = {}) {
	if (!cand || !cand.name) return { ok: false, message: "candidate 缺少 name" };
	const names = await existingSkillNames(targetDir);
	if (names.includes(cand.name) && !force) {
		return { ok: false, message: `已存在同名 skill ${cand.name}` };
	}
	const dir = join(targetDir, cand.name);
	const file = join(dir, "SKILL.md");
	// · G2：写前后各取一次状态记版本（覆盖已有文件 = 语义合并，否则 = 蒸馏新建）。
	// mkdir 也放进包装里，否则「写之前」就已经有了一个空目录。
	const existed = existsSync(file);
	return versionedSkillWrite(dir, { action: force && existed ? "merge" : "create" }, () => writeSkillUnversioned(dir, file, cand, force));
}

async function writeSkillUnversioned(dir, file, cand, force) {
	await mkdir(dir, { recursive: true });
	const body = cand.body.startsWith("#") ? cand.body : `# ${cand.name}\n\n${cand.body}`;
	let text;
	// 覆盖已有文件时以原 frontmatter 为基底就地改写（WO-EVO-1）：
	// 用户写的策略键、tags、自定义字段与键顺序必须活下来，只有正文和三个受管键可以变。
	if (force && existsSync(file)) {
		const { block, nl } = splitSkillText(await readFile(file, "utf8"));
		const nextBlock = rewriteFrontmatterBlock(
			block,
			{ name: cand.name, description: cand.description, group: typeof cand.group === "string" ? cand.group.trim() : "" },
			nl
		);
		const merged = cand.body.startsWith("#") ? cand.body : `# ${cand.name}${nl}${nl}${cand.body}`;
		text = `---${nl}${nextBlock}${nl}---${nl}${nl}${merged}${nl}`;
	} else {
		const groupLine = typeof cand.group === "string" && cand.group.trim() !== "" ? `metadata:\n  group: ${cand.group.trim()}\n` : "";
		const frontmatter = `---\nname: ${cand.name}\ndescription: ${JSON.stringify(String(cand.description ?? ""))}\n${groupLine}---\n`;
		text = frontmatter + "\n" + body + "\n";
	}
	await atomicWriteFile(file, text, { encoding: "utf8" });
	return { ok: true, message: `已写入 ${file}`, path: file };
}

/**
 * Write a candidate skill to the mandatory agent skill root (so DSH's
 * model-facing registry can load it) and, only when `mirrorDir` is set, to the
 * user-defined mirror dir. Each write dedups against its own dir; the result is
 * ok when at least one wrote.
 */
export async function writeSkillDual(agentDir, mirrorDir, cand, { force = false } = {}) {
	const results = [];
	if (agentDir) results.push({ dir: agentDir, ...(await writeSkill(agentDir, cand, { force })) });
	if (mirrorDir) results.push({ dir: mirrorDir, ...(await writeSkill(mirrorDir, cand, { force })) });
	const ok = results.some((r) => r.ok);
	return { ok, written: results.filter((r) => r.ok).map((r) => r.path), results };
}

export function shortenSummary(s) {
	return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

/** Build the full SKILL.md text (frontmatter + body) for a candidate. */
export function assembleCandidateFile(cand) {
	const groupLine = typeof cand.group === "string" && cand.group.trim() !== "" ? `metadata:\n  group: ${cand.group.trim()}\n` : "";
	const frontmatter = `---\nname: ${cand.name}\ndescription: ${JSON.stringify(String(cand.description ?? ""))}\n${groupLine}---\n`;
	const body = cand.body.startsWith("#") ? cand.body : `# ${cand.name}\n\n${cand.body}`;
	return frontmatter + "\n" + body + "\n";
}

/**
 * Run one extraction pass: scan recent logs, prompt the LLM, stage the fresh
 * candidates into the queue (dedup against existing skills and queued names).
 * Returns a result; caller persists lastRunAt/lastRunSummary.
 */
/** 类别别名：把同族前缀归到同一个类，供裁决与本地校验使用。 */
const CATEGORY_ALIASES = {
	desktop: "gui",
	gui: "gui",
	swing: "gui",
	electron: "gui",
	handoff: "handoff",
	session: "handoff",
	context: "handoff",
	cross: "handoff",
	project: "handoff",
	agent: "handoff",
	long: "handoff",
	decompiled: "decompile",
	decompile: "decompile",
	java: "java",
	"java-decompile": "decompile",
	"java-oom": "oom",
	"java-swing": "gui",
	"java-desktop": "portable",
	"java-legacy": "parity",
	jadx: "decompile",
	cfr: "decompile",
	portable: "portable",
	offline: "portable",
	remote: "portable",
	relocatable: "portable",
	windows: "portable",
	native: "parity",
	binary: "parity",
	apk: "android",
	android: "android",
	background: "bgjob",
	oom: "oom",
	heap: "oom",
	constrained: "oom",
	probe: "probe",
	isolated: "probe",
	readonly: "audit",
	asar: "audit",
	packaged: "audit",
	verify: "verify",
	skill: "skillmgmt",
	make: "skillmgmt",
	auto: "skillmgmt",
	overlapping: "skillmgmt",
	subagent: "subagent",
	delegated: "subagent",
	shared: "subagent",
	exclusive: "subagent",
	evidence: "subagent",
	acceptance: "subagent",
};

/** 从 skill 名字推导类别（前两段优先，其次首段）。 */
export function categoryOf(name) {
	const parts = String(name || "").toLowerCase().split("-").filter(Boolean);
	if (parts.length === 0) return "other";
	const two = parts.slice(0, 2).join("-");
	if (CATEGORY_ALIASES[two]) return CATEGORY_ALIASES[two];
	if (CATEGORY_ALIASES[parts[0]]) return CATEGORY_ALIASES[parts[0]];
	return parts[0];
}

/** 候选与某个既有 skill 的相似度（name + description 的 Jaccard）。 */
export function similarityOf(cand, skill) {
	const ta = tokensOf(`${cand.name ?? ""} ${cand.description ?? ""}`);
	const tb = tokensOf(`${skill.name ?? ""} ${skill.desc ?? skill.description ?? ""}`);
	return jaccard(ta, tb);
}

const STOP_WORDS = new Set(
	"a an the to of for and or in on with when you your it is are be as at by from this that use used using which what how not no i we they he she his her its our us also any all so if then than into over under out up down only just like such do does did will would can could should may might must have has had been being more most other some each both".split(" ")
);

/** 粗粒度 token 集合：英文词 + 中文 2-gram（中文整段当一个 token 会永不匹配）。 */
function tokensOf(text) {
	const s = String(text || "").toLowerCase();
	const out = new Set();
	for (const w of s.match(/[a-z][a-z0-9]{2,}/g) ?? []) if (!STOP_WORDS.has(w)) out.add(w);
	for (const seg of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
		if (seg.length <= 2) out.add(seg);
		else for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
	}
	return out;
}

function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

/**
 * 读目标目录下所有既有 skill 的 name/description/正文，建相似度索引。
 * 只统计目录版与单文件版两种布局（与 loader 一致）。
 */
export async function buildSkillIndex(dir) {
	const index = [];
	if (!dir) return index;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return index;
	}
	for (const e of entries) {
		const file = e.isDirectory() ? join(dir, e.name, "SKILL.md") : e.name.endsWith(".md") ? join(dir, e.name) : null;
		if (!file) continue;
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		// 去 BOM（WO-FIX-2）：带 BOM 的 SKILL.md 会让 ^--- 匹配失败，索引里整条消失
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const block = fm ? fm[1] : "";
		const name = (block.match(/^name:\s*(.+)$/m)?.[1] ?? e.name.replace(/\.md$/, "")).trim().replace(/^["']|["']$/g, "");
		const descRaw = block.match(/^description:\s*(.+)$/m)?.[1] ?? "";
		const desc = descRaw.trim().replace(/^["']|["']$/g, "");
		const body = fm ? text.slice(fm[0].length) : text;
		// metadata.group / metadata.tags（WO-EVO-1）：合并写回要沿用原分组，
		// 不解析就等于每次 merge 都把 group 丢掉、再回填成候选自带的分类。
		const group = (block.match(/^[ \t]*group[ \t]*:[ \t]*(.+)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
		const tagsRaw = (block.match(/^[ \t]*tags[ \t]*:[ \t]*(.+)$/m)?.[1] ?? "").trim();
		const tags = tagsRaw.startsWith("[")
			? tagsRaw
					.replace(/^\[|\]$/g, "")
					.split(",")
					.map((s) => s.trim().replace(/^["']|["']$/g, ""))
					.filter(Boolean)
			: [];
		// protected: 手工维护的 skill 不进合并池 —— frontmatter 里 `protected: true`，
		// 或 skill 目录下放一个 `.no-merge` 标记文件（后者不会被重写 frontmatter 时丢掉）。
		const isProtected =
			/^\s*protected:\s*true\s*$/m.test(block) || (e.isDirectory() && existsSync(join(dir, e.name, ".no-merge")));
		index.push({ name, desc, group, tags, body, path: file, protected: isProtected, category: categoryOf(name), tok: tokensOf(name + " " + desc) });
	}
	return index;
}

/** 取与候选最像的既存 skill（按 name+description 的 Jaccard 排序）。 */
export function bestMatches(index, cand, limit = 3) {
	const tok = tokensOf((cand.name ?? "") + " " + (cand.description ?? ""));
	return index
		.map((item) => ({ item, score: jaccard(tok, item.tok) }))
		.filter((x) => x.score > 0 && !x.item.protected)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

/** 最近一次实际使用的模型路由，供面板显示「实际用哪个」。 */
export const runtimeState = { lastRoute: null };

const PLACEMENT_SYSTEM = [
	"你在维护一个 agent skill 库。给你【已有 skill 清单】和【新候选 skill】。",
	"清单每行是 `- [类别] 名字: 描述`。**先看类别**：候选与某条类别相同、且描述说的是同一类工作流，才算覆盖。",
	"类别不同就不要合并 —— 例如 [decompile] 的候选不要塞进 [java] 或 [parity] 的 skill。",
	"有覆盖 → FOLD_INTO: <已有 skill 名>；确实是新主题 → SAVE。",
	"宁可 SAVE 也不要强行合并：把不相关的东西塞进已有 skill，比多一个 skill 更糟。",
	'只输出 JSON：{"decisions":[{"candidate":"<候选名>","action":"FOLD_INTO","into":"<已有名>"}]}；SAVE 时 action 写 SAVE，不带 into。'
].join("\n");

/** 低水位：本地相似度低于它就算「完全不像任何既有项」（WO-BORROW-4）。 */
const PLACEMENT_LOW_WATER = 0.15;

/**
 * 廉价预筛（WO-BORROW-4）：思路来自 SpaceMan consolidation 的 no-op 快路与水位回退。
 * 候选与既有库零类别交集、且本地相似度全部低于低水位 → 直接判 SAVE，不发模型。
 * 只有模糊带（类别撞上或有弱相似）才值得付整份清单的裁决成本。
 */
export function preScreenPlacement(index, candidates, lowWater = PLACEMENT_LOW_WATER) {
	const decided = [];
	const ambiguous = [];
	if (index.length === 0 || candidates.length === 0) {
		return { fastPath: true, decided: candidates.map((c) => c.name), ambiguous };
	}
	const cats = new Set(index.map((s) => s.category || categoryOf(s.name)));
	for (const cand of candidates) {
		const catHit = cats.has(categoryOf(cand.name));
		const best = bestMatches(index, cand, 1)[0];
		const sim = best?.score ?? 0;
		if (!catHit && sim < lowWater) decided.push(cand.name);
		else ambiguous.push(cand.name);
	}
	return { fastPath: ambiguous.length === 0, decided, ambiguous };
}

/**
 * 把「整份既有 skill 清单 + 新候选」交给模型裁决归属。
 * 本地的 token 相似度抓不住措辞差异（实测同类 skill 只有 0.07–0.24），所以这一步是必需的。
 */
export async function judgePlacement(cfg, llm, agent, index, candidates) {
	// 受保护的 skill 不出现在候选清单里，模型就无法把新候选塞进去
	const pool = index.filter((s) => !s.protected);
	if (pool.length === 0 || candidates.length === 0) return new Map();
	// WO-BORROW-4：先做廉价预筛，明显全新的候选不必进模型
	const screen = preScreenPlacement(pool, candidates);
	runtimeState.lastPlacement = { fastPath: screen.fastPath, decided: screen.decided.length, ambiguous: screen.ambiguous.length }; 
	if (screen.fastPath) return new Map();
	const toJudge = candidates.filter((c) => screen.ambiguous.includes(c.name));
	const catalog = pool.map((s) => `- [${s.category || categoryOf(s.name)}] ${s.name}: ${(s.desc || "").slice(0, 90)}`).join("\n");
	const list = toJudge.map((c) => `- ${c.name}: ${(c.description || "").slice(0, 120)}`).join("\n");
	const prompt = ["【已有 skill 清单】", catalog, "", "【新候选】", list].join("\n");
	const raw = await callLLM(cfg, prompt, { llm, agent, maxTokens: 2000, system: PLACEMENT_SYSTEM, rawFile: RAW_FILE_PLACEMENT });
	const json = firstJsonObject(stripFence(raw));
	if (!json) return new Map();
	const obj = JSON.parse(json);
	const out = new Map();
	for (const d of Array.isArray(obj?.decisions) ? obj.decisions : []) {
		if (d && typeof d.candidate === "string") out.set(d.candidate, d);
	}
	return out;
}

/** 最近改动过的 skill（按 mtime 倒序），供面板展示「最近添加」。 */
export async function recentSkills(dir, limit = 20) {
	if (!dir) return [];
	const index = await buildSkillIndex(dir);
	const withTime = [];
	for (const s of index) {
		try {
			const st = await stat(s.path);
			withTime.push({ name: s.name, description: s.desc, path: s.path, mtime: st.mtimeMs });
		} catch {
			/* 读不到跳过 */
		}
	}
	withTime.sort((a, b) => b.mtime - a.mtime);
	return withTime.slice(0, Math.max(1, limit)).map((s) => ({ ...s, added: new Date(s.mtime).toISOString() }));
}

/** 收集所有归档目录里出现过的 skill 名字 —— 这些名字以前被合并过，不许再新建。 */
export async function archivedNames() {
	const base = join(homedir(), ".dsh");
	const out = new Set();
	try {
		for (const e of await readdir(base, { withFileTypes: true })) {
			if (!e.isDirectory() || !e.name.startsWith("skill-archive")) continue;
			let names = [];
			try {
				names = await readdir(join(base, e.name));
			} catch {
				continue;
			}
			for (const n of names) out.add(n.replace(/-v\d+$/, "").replace(/\.orig$/, ""));
		}
	} catch {
		/* 读不到归档目录就当没有墓碑 */
	}
	return out;
}

/** 用户明确要求记住的说法 —— 命中就跳过判定，避免「说了记住却没记」 */
const REMEMBER_HINT = /(记住|记一下|记下来|以后都用|以后都按|下次也这|下次也按|按这个来|别忘了|不要忘)/;

const VERDICT_SYSTEM = "你判断一段 agent 会话是否值得沉淀成可复用的 skill。只回答 YES 或 NO。";
/** 每轮判定的输出上限（见 shouldExtract 里的说明）。 */
export const VERDICT_MAX_TOKENS = 512;

/**
 * 轻量判定：这一轮是否值得做完整提取。只发小 prompt、只要 YES/NO，
 * 让「每轮都判断」的成本可以接受。
 */
export async function shouldExtract(cfg, { llm = null, agent = null, handledRemember = null } = {}) {
	try {
		const digs = await collectSessionDigests(sessionsRoot(), 1, 1);
		if (digs.length === 0) return { worth: false, remember: false };
		const digest = buildDigest(digs[0].log, 20, 400, digs[0].mtime);
		// 「记住」只认 role === "user" 的消息本身。旧写法回头按行前缀 `- 用户：` 切渲染好的摘要，
		// 助手 / 工具消息正文里夹一行同样前缀的话就能冒充用户，下一轮被当成「直接落位、不要提问」的指令。
		// handledRemember：已经挂起 / 处理过的「记住」指纹。同一句话不再命中，这一轮照常走下面的模型判定
		const sessionId = digs[0].log.session?.id ?? digs[0].file ?? "";
		const rememberMsg = digs[0].log.msgs
			.slice(-20)
			.find((m) => m.role === "user" && REMEMBER_HINT.test(m.text) && !(handledRemember?.has(rememberKey(sessionId, truncate(oneLine(m.text), 400).trim())) === true));
		if (rememberMsg !== undefined) {
			const rememberText = truncate(oneLine(rememberMsg.text), 400).trim();
			// 指纹挂成不可枚举属性：返回体的可见形态保持 { worth, remember, rememberText }（有对拍测试钉着这个形态）
			return Object.defineProperty({ worth: true, remember: true, rememberText }, "rememberKey", { value: rememberKey(sessionId, rememberText), enumerable: false });
		}
		const prompt = [
			"判断下面这段最近的 agent 会话里，是否出现了【值得沉淀成 skill】的内容。",
			"满足下面【A】或【B】任意一组就答 YES，否则答 NO。",
			"【A】四条全部满足：",
			"1. Recurring：会反复出现，不是只发生过一次",
			"2. Verified：结论经过实际验证，不是推测",
			"3. Non-obvious：不查不知道、容易踩坑或反直觉",
			"4. Broadly applicable：换项目、换目标仍然适用",
			"【B】User-flagged：用户明确要求记住，或说了「以后都这样」（此时不必再看 A）。",
			"不算：一次性问答、纯查询、skill 库里已覆盖的常规做法、没有结论的中断。",
			"也不算：关于工具/插件本身如何配置或实现的元讨论（例如「这个 skill 插件怎么装」）。",
			"只回答 YES 或 NO。",
			"",
			digest
		].join("\n");
		// 输出上限留足：推理模型的思考内容会计入输出上限，16 个 token 可能在给出 YES/NO 之前
		// 就被用完、返回空内容。答案本身只有一个词，上限放宽不会增加实际消耗。
		const raw = await callLLM(cfg, prompt, { llm, agent, maxTokens: VERDICT_MAX_TOKENS, system: VERDICT_SYSTEM, rawFile: null });
		return { worth: /^\s*YES\b/i.test(stripFence(raw)), remember: false };
	} catch (error) {
		// 失败不等于「不值得」：返回形态保持一致，并把原因带出去由调用方记日志
		return { worth: false, remember: false, error: String(error?.message ?? error) };
	}
}

const MERGE_SYSTEM = [
	"你在维护一份 agent skill 库。给你一个【既存 skill】的完整正文，和一个【新候选 skill】（来自最近的会话经验）。",
	"判断它们是否属于同一类工作流。",
	"如果是：把新候选里真正新增的经验（尤其是踩坑与恢复路径）合并进既存正文，保持原有的章节结构（# Title / ## 概述 / ## 何时用 / ## 核心模式 / ## 常见错误），不要为了改写而改写。",
	"如果不是：只回答 KEEP。",
	"",
	"只输出两种情况之一，不要其他文字：",
	"KEEP",
	"或：",
	"MERGE: <完整的更新后 SKILL.md 正文（不含 frontmatter）>"
].join("\n");

const MERGE_SYSTEM_FORCE = [
	"你在维护一份 agent skill 库。给你一个【既存 skill】的完整正文，和一个【新候选 skill】。",
	"这个候选的名字在过去已经被合并过一次，说明它属于同类工作流 —— 不要再新建同名 skill。",
	"把新候选里真正新增的经验（尤其是踩坑与恢复路径）并入既存正文，保持原有章节结构（# Title / ## 概述 / ## 何时用 / ## 核心模式 / ## 常见错误）。",
	"如果确实没有任何新内容，就原样返回既存正文。",
	"",
	"只输出一种格式，不要其他文字：",
	"MERGE: <完整的更新后 SKILL.md 正文（不含 frontmatter）>"
].join("\n");

/** 合并时模型有时会把整篇原文再抄一遍 —— 第二个同名二级标题起视为重复输出，截断。 */
function dedupeBody(body) {
	// 正文可能以 "## 概述" 开头（没有前导换行），补一个以便统一按 "\n## " 查找
	const b = body.startsWith("\n") ? body : "\n" + body;
	const first = b.indexOf("\n## ");
	if (first < 0) return body;
	const eol = b.indexOf("\n", first + 1);
	const marker = eol < 0 ? b.slice(first + 1) : b.slice(first + 1, eol);
	if (marker === "" || marker.length > 40) return body;
	const second = b.indexOf("\n" + marker, first + 1);
	if (second < 0) return body;
	return b.slice(1, second).trimEnd();
}

/** 合并时模型有时会把协议标记一起吐进正文 —— MERGE: / KEEP 出现在末尾就切掉。 */
function stripResidue(body) {
	const i = body.lastIndexOf("MERGE:");
	if (i >= 0 && body.length - i < 300) return body.slice(0, i).trimEnd();
	const j = body.lastIndexOf("KEEP");
	if (j >= 0 && body.length - j < 80) return body.slice(0, j).trimEnd();
	return body;
}

async function tryMerge(cfg, llm, agent, hit, cand, { force = false } = {}) {
	// 受保护 skill 的正文由人维护：任何合并路径都不许改它
	if (hit?.protected) return null;
	const prompt = [
		"【既存 skill】",
		`name: ${hit.name}`,
		`description: ${hit.desc}`,
		"",
		hit.body.slice(0, 12000),
		"",
		"【新候选 skill】",
		`name: ${cand.name}`,
		`description: ${cand.description}`,
		"",
		cand.body.slice(0, 8000)
	].join("\n");
	const raw = await callLLM(cfg, prompt, { llm, agent, maxTokens: 6000, system: force ? MERGE_SYSTEM_FORCE : MERGE_SYSTEM, rawFile: RAW_FILE_MERGE });
	const text = stripFence(raw);
	if (!force && /^KEEP\b/i.test(text)) return null;
	const m = text.match(/^MERGE:\s*([\s\S]+)$/i);
	if (!m) return null;
	const body = stripResidue(dedupeBody(m[1].trim()));
	if (body.length < (force ? 10 : 40)) return null;
	// 合并结果比原文短太多 → 视为模型截断，保留原文不动
	if (body.length < (hit.body?.length ?? 0) * 0.6) return null;
	return { hit, body };
}

/**
 * Run one extraction pass: scan recent logs, ask the LLM for candidates,
 * merge near-duplicates into existing skills, then either auto-accept straight
 * into the skill root or stage them for review.
 *
 * 走 DSH 自己的模型：传入 llm（由插件把 ctx.llm 递进来）即可，不需要
 * baseUrl/apiKey/model；三者只在没有 llm 时作为 HTTP 回退。
 */
/**
 * N-03：把这一轮的会话解析结果交给真实使用信号采集。动态 import 是为了切断
 * extractor → usage-signals → lifecycle → extractor 的静态环；模块缓存后开销可忽略。
 */
async function collectUsageSignals(logs, now) {
	try {
		const { ingestUsageSignals } = await import("./usage-signals.js");
		return await ingestUsageSignals(logs, { now });
	} catch (error) {
		return { ok: false, sessions: 0, newSessions: 0, loads: 0, applied: 0, error: String(error?.message ?? error) };
	}
}

/** 提取同一时间只跑一轮，避免面板连点或定时任务与手动提取叠在一起。 */
let extractInFlight = null;

export function isExtractRunning() {
	return extractInFlight !== null;
}

export async function withExtractLock(fn) {
	if (extractInFlight) {
		const error = new UserError("正在提取，请稍后再点。");
		error.code = "EXTRACT_BUSY";
		throw error;
	}
	const job = Promise.resolve().then(fn).finally(() => {
		if (extractInFlight === job) extractInFlight = null;
	});
	extractInFlight = job;
	return job;
}

/**
 * ：点名蒸馏——只读指定会话。先按路径里带会话 id 的文件找（会话目录通常以 id 命名，不用解压别的）；
 * 找不到再退回窗口内全量解析后按 id 过滤。
 */
export async function findSessionLogsById(root, ids, windowDays) {
	const want = new Set((ids ?? []).filter((x) => typeof x === "string" && x !== ""));
	if (want.size === 0) return [];
	const files = (await findSessionFiles(root)).filter((f) => [...want].some((id) => f.includes(id)));
	const found = [];
	for (const file of files) {
		const log = await readSessionLog(file);
		if (!log || !want.has(log.session?.id)) continue;
		let mtime = 0;
		let size = 0;
		try {
			const st = await stat(file);
			mtime = st.mtimeMs;
			size = st.size;
		} catch {
			/* stat 失败不影响 */
		}
		found.push({ file, mtime, size, log });
	}
	if (found.length > 0) return found.sort(byMtimeDesc);
	return (await collectSessionLogs(root, windowDays)).filter((e) => want.has(e.log?.session?.id));
}

/** 读一份会话日志（面板「跳回来源会话」用）。 */
export async function readSessionLogFile(file) {
	return readSessionLog(file);
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.sessionIds] ：只蒸馏这些会话（点名蒸馏）
 * @param {(cands: object[], info: object) => Promise<object>} [opts.onCandidates] ：候选交给蒸馏模块做草稿
 *   （过评估门才入库、相似的走合并提案）；给了就不走下面的直接合并 / 自动入库路径
 */
/**
 * @param {() => Promise<{ok: boolean, reason?: string}>} [opts.admit] B3：下游（蒸馏草稿队列）此刻还收不收；
 *   不收就不调提取模型（点名 / 「记住」除外）
 */
export async function runExtraction(cfg, root = sessionsRoot(), { now = Date.now(), llm = null, agent = null, forceReview = false, sessionIds = null, onCandidates = null, admit = null } = {}) {
	if (!cfg.enabled) return { ok: false, message: "提取已禁用" };
	// N-03：本轮枚举/解析出来的会话日志同时喂给「真实使用信号」采集 ——
	// 采集消费这一轮的结果，不另扫目录、不另解压；它自己 best-effort，失败不影响提取。
	const named = Array.isArray(sessionIds) && sessionIds.length > 0;
	// B2：未点名时走带缓存的收集——没变过的会话不再解压解析，完整消息只留要做摘要的最新 12 份
	const scan = named ? null : await scanSessionsForExtraction(root, cfg.windowDays, 12);
	const logs = named ? await findSessionLogsById(root, sessionIds, cfg.windowDays) : scan.logs;
	const usageSignals = await collectUsageSignals(logs, now);
	if (!llm && !(cfg.llmBaseUrl && cfg.llmApiKey && cfg.llmModel)) {
		const message = "没有可用的模型通道：DSH 侧未提供 llm 服务，且未配置 baseUrl/apiKey/model";
		// 补 site：没有模型通道时也记一次运行时间，否则面板每轮都会重扫一遍会话目录
		return { ok: false, message, usageSignals, site: { lastRunAt: new Date(now).toISOString(), lastRunSummary: shortenSummary(message) } };
	}
	const digs = named ? logs.filter((e) => e.log.msgs.length > 0).slice(0, 12) : scan.digs;
	if (digs.length === 0) {
		const message = named ? `点名的会话没找到或没有消息：${sessionIds.join(", ")}` : "近期无会话可提取";
		// 同样补 site：不记运行时间的话，定时器每分钟都会把窗口内的会话重新解压扫一遍
		return { ok: true, message, candidates: [], digests: 0, usageSignals, site: { lastRunAt: new Date(now).toISOString(), lastRunSummary: shortenSummary(message) } };
	}
	const digestsText = digs.map((d) => buildDigest(d.log, 20, 200, d.mtime));
	// WO-BORROW-7：来源证据链 —— 这一轮的会话 id 与摘要指纹
	const provenanceSessions = digs.map((d) => d.log?.session?.id).filter((x) => typeof x === "string" && x !== "");
	const provenanceDigest = createHash("sha256").update(digestsText.join("\n")).digest("hex").slice(0, 16);
	const prompt = buildPrompt(digestsText, cfg);
	// B3：最多 8000 输出 token 的一次调用，在两种情况下纯属浪费——
	//   ① 提示词（最近 12 个会话的摘要 + 口径）与上一轮调过模型的那份逐字节相同：同样的输入，上一轮的候选已经处理过；
	//   ② 下游草稿队列已满：产出的候选只会各落一份 queue-full。
	// 点名蒸馏与「记住」是所有者明确要的，不受这两条限制。
	const promptDigest = createHash("sha256").update(prompt).digest("hex").slice(0, 32);
	const explicit = named || forceReview;
	const skipRun = (message) => ({ ok: true, skipped: true, message, candidates: [], drafts: [], accepted: [], merged: [], dropped: [], guarded: [], digests: digs.length, usageSignals, site: { lastRunAt: new Date(now).toISOString(), lastRunSummary: shortenSummary(message) } });
	if (!explicit && typeof cfg.lastDigest === "string" && cfg.lastDigest === promptDigest) return skipRun(`最近 ${digs.length} 个会话的摘要与上一轮相同，未调用提取模型`);
	if (!explicit && typeof admit === "function") {
		let gate = { ok: true };
		try {
			gate = (await admit()) ?? { ok: true };
		} catch {
			gate = { ok: true };
		}
		if (gate.ok === false) return skipRun(`${gate.reason || "草稿队列已满"}，未调用提取模型`);
	}
	const raw = await callLLM(cfg, prompt, { llm, agent, maxTokens: 8000 });
	const cands = parseLlmCandidates(raw).slice(0, cfg.maxCandidatesPerRun);

	// ：蒸馏硬化——候选一律成草稿（不直接写库、不直接并进已有技能），过评估门 / 合并提案由蒸馏模块处理
	if (typeof onCandidates === "function") {
		const r = (await onCandidates(cands, { logs: digs, sessions: provenanceSessions, digest: provenanceDigest, at: now, forceReview, named })) ?? {};
		const drafts = Array.isArray(r.drafts) ? r.drafts : [];
		const message = `扫描 ${digs.length} 个会话，产出 ${cands.length} 个候选 → 新草稿 ${drafts.length} 个${r.skipped ? `（跳过 ${r.skipped} 个已有草稿 / 被拦）` : ""}；草稿过评估门后才进技能库（skillmgr_distill_status 查看）`;
		return { ok: true, message, dropped: [], candidates: [], drafts, accepted: [], guarded: r.guarded ?? [], merged: [], digests: digs.length, queued: r.queued ?? drafts.length, usageSignals, site: { lastRunAt: new Date(now).toISOString(), lastRunSummary: shortenSummary(message), ...(named ? {} : { lastDigest: promptDigest }) } };
	}

	const index = await buildSkillIndex(cfg.agentSkillDir);
	const existing = new Set(index.map((s) => s.name));
	const queue = await loadCandidates();
	const queuedNames = new Set(queue.map((c) => c.name));
	const fresh = cands.filter((c) => !existing.has(c.name) && !queuedNames.has(c.name));

	// 全量裁决：本地相似度抓不住措辞差异，交给模型看整份清单
	let decisions = new Map();
	if (fresh.length > 0 && index.length > 0) {
		try {
			decisions = await judgePlacement(cfg, llm, agent, index, fresh);
		} catch {
			/* 裁决失败退回本地相似度兜底 */
		}
	}
	// 归档过的名字：模型会反复造同名 skill，命中就强制并入最接近的既有项
	const tombstone = await archivedNames();

	const merged = [];
	const dropped = [];
	const survivors = [];
	// WO-BORROW-2：守门拦下的候选（不进正式库，转候选队列）
	const guarded = [];
	for (const c of fresh) {
		const d = decisions.get(c.name);
		let hit = null;
		let reason = "";
		let rejected = false;
		if (tombstone.has(c.name)) {
			const cat = categoryOf(c.name);
			const pool = bestMatches(index, c, 5).filter((x) => (x.item.category || categoryOf(x.item.name)) === cat);
			const list = pool.length > 0 ? pool : bestMatches(index, c, 3);
			if (list.length > 0) {
				// 同类里选正文最长的：主 skill 通常最全，避免内容摊到碎片上
				let best = list[0];
				for (const x of list) if ((x.item.body?.length ?? 0) > (best.item.body?.length ?? 0)) best = x;
				hit = best.item;
				reason = "tombstone";
			}
		}
		if (!hit && d && String(d.action).toUpperCase() === "FOLD_INTO" && typeof d.into === "string") {
			const target = index.find((s) => s.name === d.into) ?? null;
			if (target) {
				// 本地复核：类别不一致且相似度不足 → 改判 SAVE，避免把反编译的塞进探针对拍里
				const sameCat = categoryOf(c.name) === (target.category || categoryOf(target.name));
				const sim = similarityOf(c, target);
				// 同类直接放行；跨类别只在描述几乎一模一样时才允许（0.3 太松，会跨类污染）
				if (sameCat || sim >= 0.5) {
					hit = target;
					reason = "model";
				} else {
					reason = "rejected";
					rejected = true;
				}
			}
		}
		if (!hit && !rejected) {
			const h = bestMatches(index, c, 1)[0];
			if (h && h.score >= cfg.mergeThreshold * 2) {
				hit = h.item;
				reason = "local";
			}
		}
		if (!hit) {
			survivors.push(c);
			continue;
		}
		try {
			const decision = await tryMerge(cfg, llm, agent, hit, c, { force: reason === "tombstone" });
			if (decision) {
				// WO-BORROW-2：合并后的正文同样过守门，命中就不写回
				const g = guardContent(decision.body);
				if (!g.ok) {
					guarded.push({ name: c.name, into: decision.hit.name, hits: g.hits });
					survivors.push({ ...c, guard: { hits: g.hits } });
					continue;
				}
				// · G2：版本记录的 actor / 来源会话（只影响记录，不改合并行为）
				const mergeCtx = { actor: "extractor:merge", sessionIds: provenanceSessions, reason: `${c.name} 并入（${reason || "unknown"}）` };
				await runWithWriteContext(mergeCtx, () => writeSkill(cfg.agentSkillDir, { name: decision.hit.name, description: decision.hit.desc, group: decision.hit.group ?? c.group, body: decision.body }, { force: true }));
				if (cfg.mirrorDir) await runWithWriteContext(mergeCtx, () => writeSkill(cfg.mirrorDir, { name: decision.hit.name, description: decision.hit.desc, group: decision.hit.group ?? c.group, body: decision.body }, { force: true }));
				merged.push({ into: decision.hit.name, from: c.name, by: reason || "unknown", rationale: c.rationale ?? "" });
				continue;
			}
		} catch {
			/* 合并失败按新 skill 处理，不丢候选 */
		}
		if (reason === "tombstone") {
			// 名字以前被合并过、这次又合不进去 → 丢弃，绝不再写一份重复
			dropped.push({ name: c.name, rationale: c.rationale ?? "" });
			continue;
		}
		survivors.push(c);
	}

	const staged = survivors.map((c, i) => ({
		id: `${now}-${i}`,
		status: "pending",
		created: now,
		sourceCount: digs.length,
		...c
	}));

	// autoAccept：直接写入正式库（dedup 由 writeSkillDual 负责）；写失败的才留在队列里
	let pendingStaged = staged;
	const accepted = [];
	// forceReview：用户点名「记住」的那批不进自动入库，留给人工确认
	if (cfg.autoAccept && cfg.agentSkillDir && !forceReview) {
		pendingStaged = [];
		for (const c of staged) {
			// WO-BORROW-2：守门命中的候选不直落，连同原因进队列 —— 「不确认」原则下唯一的人工介入点
			const g = guardContent(guardTextOf(c));
			if (!g.ok) {
				guarded.push({ name: c.name, hits: g.hits });
				pendingStaged.push({ ...c, guard: { hits: g.hits } });
				continue;
			}
			const r = await runWithWriteContext({ actor: "extractor:auto-accept", sessionIds: provenanceSessions }, () => writeSkillDual(cfg.agentSkillDir, cfg.mirrorDir, c));
			if (r.written && r.written.length) accepted.push({ name: c.name, path: r.written[0], rationale: c.rationale ?? "" });
			else pendingStaged.push(c);
		}
	}

	// WO-BORROW-7：三条裁决路径都留证据链
	for (const a of accepted) {
		await writeProvenance({ name: a.name, action: "SAVE", sessions: provenanceSessions, digest: provenanceDigest, rationale: a.rationale, at: now });
	}
	for (const m of merged) {
		await writeProvenance({ name: m.from, action: "FOLD_INTO", into: m.into, sessions: provenanceSessions, digest: provenanceDigest, rationale: m.rationale ?? "", at: now });
	}
	for (const d of dropped) {
		await writeProvenance({ name: d.name, action: "tombstone", sessions: provenanceSessions, digest: provenanceDigest, rationale: d.rationale ?? "", at: now });
	}
	const nextQueue = [...queue, ...pendingStaged];
	// N-06：1296 行那次 load 只用于去重判定；写入侧进锁后重新 load 最新队列再追加，
	// 本轮新候选的 id 是 `${now}-${i}`，与并发周期的不撞，追加不会丢别人的写入。
	let queued = nextQueue.length;
	await withFileLock(candidatePath(), async () => {
		const latest = await loadCandidates();
		const merged2 = [...latest, ...pendingStaged];
		await saveCandidates(merged2);
		queued = merged2.length;
	});
	const acceptedNote = accepted.length > 0 ? `，直接写入 ${accepted.length} 个（${accepted.map((a) => a.name).join(", ")}）` : "";
	const mergedNote = merged.length > 0 ? `，合并 ${merged.length} 个（${merged.map((m) => `${m.from}→${m.into}`).join(", ")}）` : "";
	const droppedNote = dropped.length > 0 ? `，丢弃 ${dropped.length} 个已归档同名（${dropped.map((d) => d.name ?? d).join(", ")}）` : "";
	const message = `扫描 ${digs.length} 个会话，产出 ${staged.length + merged.length} 个候选（跳过 ${cands.length - fresh.length} 个同名）${mergedNote}${droppedNote}${acceptedNote}`;
	return {
		ok: true,
		message,
		dropped,
		candidates: staged,
		accepted,
		guarded,
		merged,
		digests: digs.length,
		queued,
		usageSignals,
		site: { lastRunAt: new Date(now).toISOString(), lastRunSummary: shortenSummary(message), ...(named ? {} : { lastDigest: promptDigest }) }
	};
}

export const _internal = { configPath, candidatePath, sessionsRoot };
