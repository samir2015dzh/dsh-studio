/**
 * 版本与溯源：技能库两个 store 与 MCP 注册表的每一次写入都留一条版本记录，
 * 并能把单个 skill / 整份注册表回滚到任意历史版本点（回滚本身也记一条）。
 *
 * 存储（见 history-paths.js，默认 `~/.dsh-studio/history/`，独立于 `~/.dsh`）：
 *   - versions.jsonl：append-only，一行一条记录（字段表见 VERSION_FIELDS 注释与 PR 描述）；
 *   - objects/<sha前2位>/<sha>.gz：内容寻址的文件内容，同一内容只存一份。
 * 不用 git：Windows 真机不保证有 git，也不想引入「仓库被误推到远端」的可能；格式简单到
 * 可以用文本编辑器直接看。
 *
 * 状态（state）= 一个 skill 目录（或根上的单文件 .md）在某一刻的完整文件清单
 * `{exists, kind, files: {相对路径: {sha, size, stored}}}`。注册表的状态是脱敏后的 mcp.json 文本：
 * **凭据值永远不进版本史**（与快照同一套 redactCredentials 口径），回滚时凭据按 mergeRedacted
 * 从本机现值补回，本机也没有的就不留这个键。
 *
 * 旁路原则：记录失败只写日志、不抛给调用方——版本史坏了不许连累正常的写入。
 *
 * 写入点在落盘前后各取一次状态（versionedSkillWrite / versionedRegistryWrite）；若「写之前」的
 * 状态与该 key 最后一条记录对不上（有人绕过插件手改过、或这是该 skill 第一次被记录），先补一条
 * baseline，保证回滚总能回到「改之前」。
 */
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { atomicWriteFile } from "./fs-atomic.js";
import { CREDENTIAL_FILE_MODE, hardenPermissions } from "./fs-perms.js";
import { diffLines } from "./diff-lines.js";
import { HISTORY_OBJECTS, historyLogPath, historyRoot, parseVersionLog } from "./history-paths.js";
import { isInside, isSafeEntryPath } from "./paths.js";
import { withFileLock } from "./state-lock.js";
import { currentWriteContext } from "./write-context.js";
import { UserError, notFound } from "./errors.js";
import { getTelemetry } from "./telemetry.js";
import { removedServers, stashRemovedServers, readStashLenient } from "./mcp-credential-stash.js";

export const VERSION_SCHEMA = 1;
/** 注册表在版本史里的唯一 key。 */
export const REGISTRY_KEY = "mcp:registry";
/** 单文件超过这个大小只记 sha 不存内容（skill 里偶尔有几十 MB 的素材包）。 */
export const MAX_STORED_FILE_BYTES = 2 * 1024 * 1024;
/** 扫 skill 目录时跳过的子目录（与快照的 ALWAYS_SKIP 同类：VCS 元数据与依赖）。 */
const SKIP_DIRS = new Set([".git", ".svn", ".hg", "node_modules"]);
/** 注册表里「运行时会自动刷新」的字段：只有它们变了不算一次注册表改动，不出版本记录。 */
// ：verify（验证状态 / 最近校验时间 / 失败原因）随每次真实握手刷新，属于运行时观测，同样不算改动
const VOLATILE_SERVER_KEYS = new Set(["tools", "toolsCheckedAt", "verify"]);
const VOLATILE_SOURCE_KEYS = new Set(["nativeState", "nativeDisabled"]);
/** 判定「只改了分组 / 只改了调用策略」用的 frontmatter 键。 */
const POLICY_KEYS = new Set(["disable-model-invocation", "user-invocable"]);

let logger = null;
let lastWarnAt = 0;
/** index.js 装配时注入宿主 logger；没有就退回 stderr（限频，免得刷屏）。 */
export function setVersionLogger(next) {
	logger = next ?? null;
}
/** 正常的维护信息（不是失败）：只走宿主 logger.info，没有就不打。 */
function note(message) {
	try {
		logger?.info?.("[dsh-studio] " + message);
	} catch {
		/* ignore */
	}
}
function warn(message) {
	const text = "[dsh-studio] 版本记录失败（不影响本次写入）：" + message;
	if (logger?.warn) {
		try {
			logger.warn(text);
			return;
		} catch {
			/* logger 自己坏了就退回 stderr */
		}
	}
	const now = Date.now();
	if (now - lastWarnAt < 60_000) return;
	lastWarnAt = now;
	try {
		process.stderr.write(text + "\n");
	} catch {
		/* 连 stderr 都写不了就算了 */
	}
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const toPosix = (p) => p.split(sep).join("/");

function versionId(now = Date.now()) {
	const d = new Date(now);
	const p = (n, w = 2) => String(n).padStart(w, "0");
	const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}Z`;
	return `v${stamp}-${randomBytes(3).toString("hex")}`;
}

// ── 对象存储 ───────────────────────────────────────────────────────────────

function objectPath(sha) {
	return join(historyRoot(), HISTORY_OBJECTS, sha.slice(0, 2), sha + ".gz");
}

async function putObject(buf) {
	const sha = sha256(buf);
	const file = objectPath(sha);
	try {
		await stat(file);
		return sha;
	} catch {
		/* 不存在才写 */
	}
	await atomicWriteFile(file, gzipSync(buf), { mode: 0o600 });
	return sha;
}

/** 取对象并校验 sha：快照导入的包可能被手改过，内容对不上名字就拒绝使用。 */
export async function getObject(sha) {
	if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) throw new Error("对象 id 不合法：" + sha);
	const buf = gunzipSync(await readFile(objectPath(sha)));
	if (sha256(buf) !== sha) throw new Error("对象内容与 sha 不符：" + sha);
	return buf;
}

// ── 日志 ──────────────────────────────────────────────────────────────────

/** 全量读：保留 / 自检 / 重脱敏这类要遍历全部记录的低频活用。热路径走下面的索引。 */
export async function readVersionRecords() {
	try {
		return parseVersionLog(await readFile(historyLogPath(), "utf8"));
	} catch {
		return [];
	}
}

// ── 版本日志索引（B1）──────────────────────────────────────────────
// 到保留上限（200 个技能 × 200 条，约 60 MB）时整份读入并逐行 JSON.parse 一次约 700 ms，而每次带版本的写入、
// 历史查询、回滚以前都要来一遍。整份记录常驻内存要两百多 MB，不划算；这里只常驻一份轻量索引
// （每条 id / key / kind / name / 是否带合并溯源 / 字节区间），要哪几条再按字节区间单独读出来解析。
// 日志是 append-only：同一个文件（dev+ino 不变）长大了、且上次读到的末尾几十个字节没变，就只读新增的尾巴；
// 被保留 / 重脱敏原子改写（换了 inode）、变短、或末尾对不上，就整份重建。跨进程的追加（快照恢复、脚本）同样
// 走尾巴增量，不需要谁来通知。

const INDEX_TAIL_BYTES = 64;
const INDEX_CHUNK_BYTES = 4 * 1024 * 1024;
let logIndex = null;
let indexChain = Promise.resolve();
/** 诊断计数（测试 / 量测用）：整份重建了几次、增量读了多少字节、按区间读了多少条。 */
export const indexCounters = { rebuilds: 0, tailBytes: 0, loaded: 0 };

function emptyIndex(file, st) {
	return { file, dev: st?.dev ?? 0, ino: st?.ino ?? 0, consumed: 0, fileSize: 0, mtimeMs: -1, tail: Buffer.alloc(0), entries: [], byKey: new Map(), byId: new Map(), trailing: null };
}

function indexEntryOf(rec, start, len) {
	return {
		id: rec.id,
		key: typeof rec.key === "string" ? rec.key : null,
		kind: typeof rec.kind === "string" ? rec.kind : null,
		name: typeof rec.name === "string" ? rec.name : null,
		merge: rec.merge !== undefined && rec.merge !== null,
		start,
		len
	};
}

function parseRecordLine(buf) {
	const line = buf.toString("utf8");
	if (line.trim() === "") return null;
	try {
		const rec = JSON.parse(line);
		return rec && typeof rec === "object" && typeof rec.id === "string" && rec.id !== "" ? rec : null;
	} catch {
		return null;
	}
}

function addIndexEntry(ix, entry) {
	const i = ix.entries.length;
	ix.entries.push(entry);
	if (entry.key !== null) {
		let list = ix.byKey.get(entry.key);
		if (list === undefined) ix.byKey.set(entry.key, (list = []));
		list.push(i);
	}
	// 与 records.find 同口径：同 id 取第一条
	if (!ix.byId.has(entry.id)) ix.byId.set(entry.id, i);
}

async function readRange(fh, start, len) {
	const buf = Buffer.alloc(len);
	let off = 0;
	while (off < len) {
		const { bytesRead } = await fh.read(buf, off, len - off, start + off);
		if (bytesRead === 0) break;
		off += bytesRead;
	}
	return off === len ? buf : buf.subarray(0, off);
}

async function extendIndex(fh, ix, st) {
	let pos = ix.consumed;
	let carry = Buffer.alloc(0);
	let carryStart = pos;
	while (pos < st.size) {
		const chunk = await readRange(fh, pos, Math.min(INDEX_CHUNK_BYTES, st.size - pos));
		if (chunk.length === 0) break;
		indexCounters.tailBytes += chunk.length;
		pos += chunk.length;
		const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
		let lineStart = 0;
		for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, lineStart)) {
			const rec = parseRecordLine(data.subarray(lineStart, nl));
			if (rec !== null) addIndexEntry(ix, indexEntryOf(rec, carryStart + lineStart, nl - lineStart));
			lineStart = nl + 1;
		}
		carryStart += lineStart;
		carry = data.subarray(lineStart);
	}
	// 没有换行结尾的最后一段（正在写的半行，或手改丢了换行）：能解析就当一条临时记录，下次从它开头重读
	ix.consumed = carryStart;
	const rec = carry.length > 0 ? parseRecordLine(carry) : null;
	ix.trailing = rec === null ? null : indexEntryOf(rec, carryStart, carry.length);
	ix.fileSize = pos;
	ix.mtimeMs = st.mtimeMs;
	const tailLen = Math.min(INDEX_TAIL_BYTES, ix.consumed);
	ix.tail = tailLen > 0 ? await readRange(fh, ix.consumed - tailLen, tailLen) : Buffer.alloc(0);
}

async function indexStillValid(fh, ix, file, st) {
	if (ix === null || ix.file !== file || ix.dev !== st.dev || ix.ino !== st.ino) return false;
	if (st.size < ix.fileSize) return false;
	// 大小没变、修改时间却变了：可能是原地改写成同样长度，保守起见重建
	if (st.size === ix.fileSize && st.mtimeMs !== ix.mtimeMs) return false;
	if (ix.tail.length === 0) return ix.consumed === 0;
	const now = await readRange(fh, ix.consumed - ix.tail.length, ix.tail.length);
	return now.equals(ix.tail);
}

/**
 * 在最新的索引上执行 fn(view)。view 提供按 key / id 取条目与按字节区间读出完整记录。
 * 进程内串行（索引是共享的可变结构）；fn 里只做读，不许回调外部代码。
 */
function withLogIndex(fn) {
	const run = async () => {
		const file = historyLogPath();
		let fh;
		try {
			fh = await open(file, "r");
		} catch {
			logIndex = null;
			return fn(indexView(emptyIndex(file, null), null));
		}
		try {
			const st = await fh.stat();
			if (!(await indexStillValid(fh, logIndex, file, st))) {
				logIndex = emptyIndex(file, st);
				indexCounters.rebuilds += 1;
			}
			if (st.size !== logIndex.fileSize || st.mtimeMs !== logIndex.mtimeMs) await extendIndex(fh, logIndex, st);
			return await fn(indexView(logIndex, fh));
		} finally {
			await fh.close().catch(() => {});
		}
	};
	const p = indexChain.then(run, run);
	indexChain = p.then(
		() => undefined,
		() => undefined
	);
	return p;
}

function indexView(ix, fh) {
	const all = () => (ix.trailing === null ? ix.entries : [...ix.entries, ix.trailing]);
	const forKey = (key) => {
		const list = (ix.byKey.get(key) ?? []).map((i) => ix.entries[i]);
		if (ix.trailing !== null && ix.trailing.key === key) list.push(ix.trailing);
		return list;
	};
	return {
		entries: all,
		forKey,
		lastForKey(key) {
			if (ix.trailing !== null && ix.trailing.key === key) return ix.trailing;
			const list = ix.byKey.get(key);
			return list === undefined || list.length === 0 ? null : ix.entries[list[list.length - 1]];
		},
		byId(id) {
			const i = ix.byId.get(id);
			if (i !== undefined) return ix.entries[i];
			return ix.trailing !== null && ix.trailing.id === id ? ix.trailing : null;
		},
		async load(entries) {
			const out = [];
			if (fh === null) return out;
			for (const e of entries) {
				const rec = parseRecordLine(await readRange(fh, e.start, e.len));
				indexCounters.loaded += 1;
				if (rec !== null) out.push(rec);
			}
			return out;
		}
	};
}

/** 某个 key 的全部记录（按日志顺序）。 */
export async function readKeyRecords(key) {
	return withLogIndex((view) => view.load(view.forKey(key)));
}

/** 某个 key 的最后一条记录；没有就 null。 */
export async function lastKeyRecord(key) {
	return withLogIndex(async (view) => {
		const e = view.lastForKey(key);
		return e === null ? null : (await view.load([e]))[0] ?? null;
	});
}

/** 按 id 取一条记录；没有就 null。 */
export async function findVersionRecord(id) {
	return withLogIndex(async (view) => {
		const e = view.byId(id);
		return e === null ? null : (await view.load([e]))[0] ?? null;
	});
}

/**
 * 只在索引字段上筛（id / key / kind / name / merge），命中的再按需读出。
 * @param {(entry: {id:string,key:string|null,kind:string|null,name:string|null,merge:boolean}) => boolean} pred
 * @param {{limit?: number, newestFirst?: boolean}} [options] limit 只截取读出的条数，total 仍是命中总数
 */
export async function queryVersionRecords(pred, options = {}) {
	return withLogIndex(async (view) => {
		let hits = view.entries().filter(pred);
		const total = hits.length;
		if (options.newestFirst === true) hits = hits.reverse();
		if (Number.isFinite(options.limit)) hits = hits.slice(0, Math.max(0, options.limit));
		return { total, records: await view.load(hits) };
	});
}

/** 索引里所有 skill 记录的 (key, name) 去重表（解析 name → key 用，不读记录本体）。 */
export async function skillKeysByName(name) {
	return withLogIndex((view) => [...new Set(view.entries().filter((e) => e.kind === "skill" && e.name === name).map((e) => e.key))]);
}

async function keyKnown(key) {
	return withLogIndex((view) => view.lastForKey(key) !== null);
}

/** 测试用：丢掉进程内索引，下次整份重建。 */
export function resetVersionIndex() {
	logIndex = null;
}

async function appendRecordUnlocked(rec) {
	await mkdir(historyRoot(), { recursive: true });
	await appendFile(historyLogPath(), JSON.stringify(rec) + "\n", { encoding: "utf8", mode: 0o600 });
	return rec;
}

/** 版本日志的跨进程锁（：备份包导入版本史时也要拿这把锁）。 */
export function withHistoryLock(fn) {
	return withFileLock(historyLogPath(), fn);
}


// ── skill 状态 ─────────────────────────────────────────────────────────────

/** SKILL.md → 它所在的目录；根上的 `<name>.md` 单文件 skill → 文件本身。 */
export function skillTargetOf(file) {
	const full = resolve(String(file));
	return /^skill\.md$/i.test(basename(full)) ? dirname(full) : full;
}

/** 版本史里 skill 的 key：home 前缀换成 `~`，统一正斜杠（Windows 上不分大小写）。 */
export function skillKeyOf(target) {
	let full = toPosix(resolve(String(target)));
	const home = toPosix(resolve(homedir()));
	const cmp = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
	if (cmp(full) === cmp(home) || cmp(full).startsWith(cmp(home) + "/")) full = "~" + full.slice(home.length);
	return "skill:" + cmp(full);
}

async function walkFiles(root, base = root, out = []) {
	let entries;
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await walkFiles(root, join(base, entry.name), out);
		} else if (entry.isFile()) {
			out.push(toPosix(relative(root, join(base, entry.name))));
		}
	}
	return out;
}

/** 大文件指纹缓存：绝对路径 → {size, mtimeMs, sha}（进程内，上限防增长）。 */
const largeShaMemo = new Map();
const LARGE_SHA_MEMO_MAX = 512;
/** 诊断计数（测试用）：大文件真正流式读了几次。 */
export const captureCounters = { largeStreamed: 0, largeReused: 0, smallRead: 0, smallReused: 0 };
/** 小文件指纹缓存（B7）：绝对路径 → {size, mtimeMs, ino, sha}。 */
const smallShaMemo = new Map();
const SMALL_SHA_MEMO_MAX = 8192;

/** 流式 sha256；结果与 sha256(readFile(file)) 逐位相同。 */
export function sha256File(file) {
	return new Promise((resolvePromise, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(file);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolvePromise(hash.digest("hex")));
	});
}

async function largeFileSha(abs, st) {
	const key = resolve(abs);
	const hit = largeShaMemo.get(key);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
		captureCounters.largeReused += 1;
		return hit.sha;
	}
	const sha = await sha256File(abs);
	captureCounters.largeStreamed += 1;
	largeShaMemo.delete(key);
	largeShaMemo.set(key, { size: st.size, mtimeMs: st.mtimeMs, sha });
	if (largeShaMemo.size > LARGE_SHA_MEMO_MAX) largeShaMemo.delete(largeShaMemo.keys().next().value);
	return sha;
}

/**
 * 取一个 skill 目标当前的完整状态，内容顺手写进对象库。
 * @returns {Promise<{exists:boolean, kind:"dir"|"file"|null, files:Record<string,{sha:string,size:number,stored:boolean}>}>}
 */
export async function captureSkillState(target) {
	let info;
	try {
		info = await stat(target);
	} catch {
		return { exists: false, kind: null, files: {} };
	}
	const files = {};
	const add = async (abs, rel) => {
		const st = await stat(abs);
		if (st.size > MAX_STORED_FILE_BYTES) {
			// 大文件只记指纹：回滚时保持现状不动，并在结果里报出来。
			// 审计 5：流式算 sha256（不把整份大文件读进内存）；(路径, size, mtimeMs) 与上次一致就复用
			files[rel] = { sha: await largeFileSha(abs, st), size: st.size, stored: false };
			return;
		}
		// B7：写入前后各取一次状态，以前每次都把技能目录里的全部文件读一遍、算 sha、gzip 比对对象库；
		// (路径, size, mtimeMs, ino) 没变且对象还在对象库里，就直接复用上次的 sha。
		const memoKey = resolve(abs);
		const hit = smallShaMemo.get(memoKey);
		if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) {
			try {
				await stat(objectPath(hit.sha));
				captureCounters.smallReused += 1;
				files[rel] = { sha: hit.sha, size: st.size, stored: true };
				return;
			} catch {
				/* 对象被保留 GC 收走了：照常读一遍、补回对象库 */
			}
		}
		const buf = await readFile(abs);
		captureCounters.smallRead += 1;
		const sha = await putObject(buf);
		files[rel] = { sha, size: buf.length, stored: true };
		smallShaMemo.delete(memoKey);
		smallShaMemo.set(memoKey, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, sha });
		if (smallShaMemo.size > SMALL_SHA_MEMO_MAX) smallShaMemo.delete(smallShaMemo.keys().next().value);
	};
	if (info.isDirectory()) {
		for (const rel of (await walkFiles(target)).sort()) await add(join(target, rel), rel);
		return { exists: true, kind: "dir", files };
	}
	await add(target, basename(target));
	return { exists: true, kind: "file", files };
}

function sameState(a, b) {
	const ea = a?.exists === true;
	const eb = b?.exists === true;
	if (ea !== eb) return false;
	if (!ea) return true;
	const ka = Object.keys(a.files ?? {}).sort();
	const kb = Object.keys(b.files ?? {}).sort();
	if (ka.length !== kb.length) return false;
	return ka.every((k, i) => k === kb[i] && a.files[k].sha === b.files[k].sha);
}

// ── diff 摘要 ─────────────────────────────────────────────────────────────

/** 极简 frontmatter 读法：顶层键 → 原文值；metadata 下只取 group。只用于 diff 摘要。 */
function frontmatterOf(text) {
	const m = String(text ?? "").replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const out = {};
	if (!m) return { fields: out, body: String(text ?? "") };
	let inMetadata = false;
	for (const line of m[1].split(/\r?\n/)) {
		const top = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
		if (top) {
			inMetadata = top[1] === "metadata";
			if (!inMetadata) out[top[1]] = top[2].trim();
			continue;
		}
		const group = inMetadata ? line.match(/^\s+group\s*:\s*(.*)$/) : null;
		if (group) out["metadata.group"] = group[1].trim().replace(/^["']|["']$/g, "");
	}
	return { fields: out, body: String(text).slice(m[0].length) };
}

async function textOf(entry) {
	if (!entry || entry.stored !== true) return null;
	try {
		const buf = await getObject(entry.sha);
		return buf.includes(0) ? null : buf.toString("utf8");
	} catch {
		return null;
	}
}

/**
 * 两个 skill 状态之间的 diff 摘要：逐文件的增删行数 + SKILL.md frontmatter 改了哪些键。
 * 不放正文行本身（版本日志会随快照出机，正文要看就按 sha 取对象）。
 */
async function diffSkillStates(before, after) {
	const files = [];
	const changedKeys = [];
	let bodyChanged = false;
	const relSet = new Set([...Object.keys(before?.files ?? {}), ...Object.keys(after?.files ?? {})]);
	for (const rel of [...relSet].sort()) {
		const a = before?.exists ? before.files[rel] : undefined;
		const b = after?.exists ? after.files[rel] : undefined;
		if (a && b && a.sha === b.sha) continue;
		const change = !a ? "added" : !b ? "removed" : "modified";
		const item = { path: rel, change, added: 0, removed: 0 };
		const ta = a ? await textOf(a) : "";
		const tb = b ? await textOf(b) : "";
		if (ta !== null && tb !== null) {
			for (const line of diffLines(ta, tb)) {
				if (line.type === "add") item.added += 1;
				else if (line.type === "del") item.removed += 1;
			}
			if (/^skill\.md$/i.test(basename(rel)) || (before?.kind === "file" && rel === basename(rel))) {
				const fa = frontmatterOf(ta);
				const fb = frontmatterOf(tb);
				if (fa.body !== fb.body) bodyChanged = true;
				for (const key of new Set([...Object.keys(fa.fields), ...Object.keys(fb.fields)])) {
					if (fa.fields[key] === fb.fields[key]) continue;
					changedKeys.push(key === "metadata.group" ? { key, from: fa.fields[key] ?? "", to: fb.fields[key] ?? "" } : { key });
				}
			} else bodyChanged = true;
		} else {
			item.binary = true;
			bodyChanged = true;
		}
		files.push(item);
	}
	return { files, changedKeys, bodyChanged };
}

function summarizeSkillDiff(action, before, after, diff) {
	if (!after?.exists) return `${actionLabel(action)}（${Object.keys(before?.files ?? {}).length} 个文件）`;
	const parts = diff.files.map((f) =>
		f.binary ? `${f.path} ${f.change === "added" ? "新增" : f.change === "removed" ? "删除" : "改动"}（二进制）` : `${f.path} +${f.added} −${f.removed}`
	);
	const keys = diff.changedKeys.map((k) => (k.key === "metadata.group" ? `分组 ${k.from || "（无）"}→${k.to || "（无）"}` : k.key));
	const head = actionLabel(action);
	return [head, parts.join("，"), keys.length > 0 ? "frontmatter: " + keys.join("、") : ""].filter((s) => s !== "").join("；");
}

const ACTION_LABELS = {
	baseline: "基线（首次纳入或检测到插件外改动）",
	create: "新建",
	merge: "语义合并",
	rewrite: "改写",
	edit: "编辑",
	policy: "调用策略变更",
	"group-change": "分组变更",
	delete: "移入回收站",
	restore: "从回收站恢复",
	recycle: "闲置回收（归档）",
	import: "导入",
	update: "上游更新",
	rollback: "回滚",
	"studio-restore": "从 studio 备份包恢复",
	optimize: "自动优化（低风险，过评估门后自动应用）",
	"optimize-approved": "优化提案（所有者批准后应用）",
	"optimize-override": "所有者点名放行（未过评估门，留痕）",
	"governance-merge": "合并提案（所有者批准后应用；溯源两个来源）",
	"merge-archive": "被合并后移入回收站（溯源到合并结果）",
	"lesson-patch": "教训补丁（所有者批准后应用）",
	"lesson-withdraw": "撤回教训补丁（所有者批准后应用）",
	"registry-add": "注册表新增",
	"registry-remove": "注册表删除",
	"registry-edit": "注册表修改",
	"registry-setting": "注册表全局设置",
	"registry-migrate": "注册表迁移（schema 升级）",
	"registry-missing": "注册表文件整份消失（缺口）",
	"registry-corrupt": "注册表文件损坏（无法解析）"
};
/** 缺口 / 损坏记录：state.exists=false，没有可回滚的内容。 */
const GAP_ACTIONS = new Set(["registry-missing", "registry-corrupt"]);
function actionLabel(action) {
	return ACTION_LABELS[action] ?? action;
}

/** 调用方给的动作提示 + diff 结果 → 最终动作名。只把「编辑」细化，不改写明确的动作。 */
function refineSkillAction(hint, before, after, diff) {
	if (!before?.exists && after?.exists) return hint === "restore" || hint === "import" || hint === "rollback" || hint === "update" || hint === "studio-restore" ? hint : "create";
	if (before?.exists && !after?.exists) return hint === "recycle" || hint === "rollback" || hint === "merge-archive" ? hint : "delete";
	if (hint !== "edit" && hint !== "rewrite" && hint !== undefined && hint !== "") return hint;
	if (!diff.bodyChanged && diff.changedKeys.length > 0) {
		if (diff.changedKeys.every((k) => k.key === "metadata.group")) return "group-change";
		if (diff.changedKeys.every((k) => POLICY_KEYS.has(k.key))) return "policy";
	}
	return hint === "rewrite" ? "rewrite" : "edit";
}

// ── 记录 ──────────────────────────────────────────────────────────────────

function attribution(meta) {
	const ctx = currentWriteContext();
	const actor = meta?.actor ?? ctx.actor ?? "unknown";
	const sessionIds = [...new Set([...(meta?.sessionIds ?? ctx.sessionIds ?? []), meta?.sessionId ?? ctx.sessionId ?? ""].filter((x) => typeof x === "string" && x !== ""))];
	return {
		actor: String(actor),
		trigger: typeof (meta?.trigger ?? ctx.trigger) === "string" ? meta?.trigger ?? ctx.trigger : null,
		sessionId: sessionIds[0] ?? null,
		sessionIds
	};
}

function distillOf(meta) {
	const value = meta?.distill ?? currentWriteContext().distill;
	return value && typeof value === "object" ? { distill: JSON.parse(JSON.stringify(value)) } : {};
}

function reasonOf(meta) {
	const value = meta?.reason ?? currentWriteContext().reason;
	return typeof value === "string" ? value : "";
}

function baseRecord(kind, key, target, now) {
	return { v: VERSION_SCHEMA, id: versionId(now), at: new Date(now).toISOString(), kind, key, target };
}

async function recordSkillUnlocked(target, before, after, meta, now = Date.now()) {
	const key = skillKeyOf(target);
	let last = await lastKeyRecord(key);
	const written = [];
	// 写之前的状态与最后一条记录对不上：先补 baseline（不然回滚回不到「改之前」）
	if (before !== null && (last === null ? before.exists : !sameState(last.state, before))) {
		const diff = last === null ? { files: [], changedKeys: [], bodyChanged: false } : await diffSkillStates(last.state, before);
		const rec = {
			...baseRecord("skill", key, target, now),
			name: basename(target).replace(/\.md$/i, ""),
			action: "baseline",
			actor: last === null ? "observed" : "external",
			trigger: null,
			sessionId: null,
			sessionIds: [],
			reason: last === null ? "首次纳入版本史" : "检测到插件外的改动（手工编辑或其它程序）",
			parent: last?.id ?? null,
			state: before,
			diff: { summary: last === null ? `基线：${Object.keys(before.files).length} 个文件` : summarizeSkillDiff("baseline", last.state, before, diff), files: diff.files, frontmatter: diff.changedKeys },
			eval: null
		};
		written.push(await appendRecordUnlocked(rec));
		last = rec;
	}
	const prevState = before ?? last?.state ?? { exists: false, kind: null, files: {} };
	if (sameState(prevState, after)) return written;
	const diff = await diffSkillStates(prevState, after);
	const action = refineSkillAction(meta?.action, prevState, after, diff);
	const who = attribution(meta);
	const rec = {
		...baseRecord("skill", key, target, now + written.length),
		name: basename(target).replace(/\.md$/i, ""),
		action,
		...who,
		reason: reasonOf(meta),
		parent: last?.id ?? null,
		...(typeof meta?.rollbackOf === "string" ? { rollbackOf: meta.rollbackOf } : {}),
		// ：从备份包恢复时指向包内对应的版本（跨机的版本链靠它接上：parent 是本机上一条，restoreOf 是来源机那条）
		...(typeof meta?.restoreOf === "string" ? { restoreOf: meta.restoreOf } : {}),
		// ：合并溯源（结果一侧 {role:"result", sources:[…]}；来源一侧 {role:"source", into:{…}}）与教训来源
		...(meta?.merge && typeof meta.merge === "object" ? { merge: JSON.parse(JSON.stringify(meta.merge)) } : {}),
		...(meta?.lesson && typeof meta.lesson === "object" ? { lesson: JSON.parse(JSON.stringify(meta.lesson)) } : {}),
		// ：蒸馏出处（会话 id / 时间 / 关键轮次 / 草稿 id / 门结果）；可由 meta 或写入上下文带入
		...distillOf(meta),
		state: after,
		diff: { summary: summarizeSkillDiff(action, prevState, after, diff), files: diff.files, frontmatter: diff.changedKeys },
		// G1 评测门：优化回路写入时带 {suite, before, after, verdict, at, ...}；其它写入仍为 null
		eval: meta?.eval && typeof meta.eval === "object" ? JSON.parse(JSON.stringify(meta.eval)) : null
	};
	written.push(await appendRecordUnlocked(rec));
	notifySkillVersion(rec);
	return written;
}

/** · G7：技能新版本落地的旁路监听（增量冲突检查用）。监听器异常只记日志，永不影响写入。 */
const skillVersionListeners = new Set();
export function onSkillVersion(listener) {
	skillVersionListeners.add(listener);
	return () => skillVersionListeners.delete(listener);
}
function notifySkillVersion(rec) {
	if (skillVersionListeners.size === 0) return;
	// 推到锁外：监听器可能要读版本史，在锁里同步回调会自锁
	const t = setTimeout(() => fireSkillVersion(rec), 0);
	t.unref?.();
}
function fireSkillVersion(rec) {
	for (const listener of skillVersionListeners) {
		try {
			const out = listener({ id: rec.id, key: rec.key, name: rec.name, target: rec.target, action: rec.action, exists: rec.state?.exists === true });
			if (out && typeof out.catch === "function") out.catch((error) => warn("版本监听器失败：" + (error instanceof Error ? error.message : String(error))));
		} catch (error) {
			warn("版本监听器失败：" + (error instanceof Error ? error.message : String(error)));
		}
	}
}

/** 安全取状态：失败返回 null（记录侧把 null 当「写前状态未知」处理）。 */
async function captureSafe(target) {
	try {
		return await captureSkillState(target);
	} catch (error) {
		warn(`读取 ${target} 失败：${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

/**
 * 包一次 skill 写入：写前取状态 → 执行 fn → 写后取状态并落版本记录。
 * fn 的返回值 / 异常原样透传；版本记录本身失败只记日志。
 * @template T
 * @param {string} target skill 目录或单文件 .md 的绝对路径（SKILL.md 会自动换成所在目录）
 * @param {{action?:string, actor?:string, reason?:string, sessionId?:string, sessionIds?:string[], eval?:object}} meta
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function versionedSkillWrite(target, meta, fn) {
	const tgt = skillTargetOf(target);
	const before = await captureSafe(tgt);
	const result = await fn();
	await recordSkillAfter(tgt, before, meta);
	return result;
}

/** 写完之后补记（before 由调用方提前用 captureSkillBefore 取好；拿不到传 null）。永不抛。 */
export async function recordSkillAfter(target, before, meta) {
	try {
		const tgt = skillTargetOf(target);
		const after = await captureSkillState(tgt);
		return await withHistoryLock(() => recordSkillUnlocked(tgt, before, after, meta));
	} catch (error) {
		warn(`${target}：${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

/** 写前取状态（给拆成两段的调用方用）。永不抛，失败返回 null。 */
export async function captureSkillBefore(target) {
	return captureSafe(skillTargetOf(target));
}

// ── 注册表 ─────────────────────────────────────────────────────────────────

/** mcp.json 文本 → 脱敏后的规范 JSON 文本（解析失败返回 null）。 */
async function redactRegistryText(text) {
	if (typeof text !== "string" || text.trim() === "") return null;
	// 懒加载：snapshot.js → scanner.js → extractor.js，而 extractor.js 自己要 import 本模块
	const { redactCredentials } = await import("./snapshot.js");
	let parsed;
	try {
		parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return null;
	}
	redactCredentials(parsed);
	return JSON.stringify(parsed, null, 2) + "\n";
}

/** 注册表的语义形态（去掉运行时刷新字段）。备份包恢复按它判定「同一个 server 是否相同」。 */
export function semanticRegistry(parsed) {
	const servers = Array.isArray(parsed?.servers) ? parsed.servers : [];
	return {
		idleTimeoutMinutes: parsed?.idleTimeoutMinutes ?? null,
		toolDescriptionMaxLength: parsed?.toolDescriptionMaxLength ?? null,
		servers: servers.map((s) => {
			const out = {};
			for (const [k, v] of Object.entries(s ?? {})) {
				if (VOLATILE_SERVER_KEYS.has(k)) continue;
				if (k === "source" && v && typeof v === "object") {
					out.source = Object.fromEntries(Object.entries(v).filter(([sk]) => !VOLATILE_SOURCE_KEYS.has(sk)));
					continue;
				}
				out[k] = v;
			}
			return out;
		})
	};
}

export function stableJson(value) {
	if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
	if (value !== null && typeof value === "object") {
		return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
	}
	return JSON.stringify(value ?? null);
}

function diffRegistry(beforeText, afterText) {
	const parse = (t) => {
		try {
			return t === null ? { servers: [] } : JSON.parse(t);
		} catch {
			return { servers: [] };
		}
	};
	const a = semanticRegistry(parse(beforeText));
	const b = semanticRegistry(parse(afterText));
	const mapA = new Map(a.servers.map((s) => [s.name, s]));
	const mapB = new Map(b.servers.map((s) => [s.name, s]));
	const added = [...mapB.keys()].filter((n) => !mapA.has(n));
	const removed = [...mapA.keys()].filter((n) => !mapB.has(n));
	const changed = [];
	for (const [name, sb] of mapB) {
		const sa = mapA.get(name);
		if (sa === undefined) continue;
		const fields = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].filter((k) => stableJson(sa[k]) !== stableJson(sb[k])).sort();
		if (fields.length > 0) changed.push({ name, fields });
	}
	const settings = ["idleTimeoutMinutes", "toolDescriptionMaxLength"].filter((k) => stableJson(a[k]) !== stableJson(b[k])).map((k) => ({ key: k, from: a[k], to: b[k] }));
	return { added, removed, changed, settings, semanticSame: stableJson(a) === stableJson(b) };
}

function registryAction(hint, diff) {
	if (hint === "rollback") return "rollback";
	if (hint === "studio-restore") return "studio-restore";
	if (hint === "migrate") return "registry-migrate";
	if (diff.added.length > 0 && diff.removed.length === 0 && diff.changed.length === 0) return "registry-add";
	if (diff.removed.length > 0 && diff.added.length === 0 && diff.changed.length === 0) return "registry-remove";
	if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 && diff.settings.length > 0) return "registry-setting";
	return "registry-edit";
}

function summarizeRegistry(action, diff) {
	const parts = [];
	if (diff.added.length > 0) parts.push("新增 " + diff.added.join("、"));
	if (diff.removed.length > 0) parts.push("删除 " + diff.removed.join("、"));
	for (const c of diff.changed) parts.push(`${c.name} 改 ${c.fields.join("/")}`);
	for (const s of diff.settings) parts.push(`${s.key} ${s.from}→${s.to}`);
	return [actionLabel(action), parts.join("；")].filter((s) => s !== "").join("：");
}

/**
 * 尾巴①：上一条记录说注册表还在，现在文件却整份没了 / 解析不了——先落一条显式的
 * 缺口记录（registry-missing / registry-corrupt），再谈后面的 baseline 或这次写入。以前这种情况会被
 * 下一次写入的 diff 静默吞成「删了全部 server」并记到无辜的 actor 头上，版本史里看不出注册表曾整体消失过。
 * 损坏的文件只记指纹（sha256 + 字节数），不存内容——原文里可能有没脱敏的凭据。
 * @returns {Promise<object|null>} 写出的缺口记录
 */
async function recordRegistryGapUnlocked(file, raw, last, now) {
	if (last === null || last.state?.exists !== true) return null;
	let action = null;
	let state = null;
	if (raw === null) {
		action = "registry-missing";
		state = { exists: false };
	} else if ((await redactRegistryText(raw)) === null) {
		action = "registry-corrupt";
		const buf = Buffer.from(raw, "utf8");
		state = { exists: false, corrupt: true, fingerprint: sha256(buf), size: buf.length };
	}
	if (action === null) return null;
	const lastText = (await getObject(last.state.sha).catch(() => null))?.toString("utf8") ?? null;
	const diff = diffRegistry(lastText, null);
	const rec = {
		...baseRecord("mcp-registry", REGISTRY_KEY, file, now),
		name: "mcp-registry",
		action,
		actor: "external",
		trigger: null,
		sessionId: null,
		sessionIds: [],
		reason: action === "registry-missing" ? "检测到 mcp.json 整份不存在（被删除或目录被清空）" : "检测到 mcp.json 无法解析（内容损坏）",
		parent: last.id,
		state,
		diff: { summary: `${actionLabel(action)}：上一版 ${diff.removed.length} 个 server 不可见`, added: [], removed: diff.removed, changed: [], settings: [] },
		eval: null
	};
	return appendRecordUnlocked(rec);
}

const TELEMETRY_ACTION = { "registry-add": "add", "registry-remove": "remove", "registry-edit": "edit", "registry-setting": "setting", rollback: "rollback", "registry-migrate": "migrate" };

/** 注册表语义写入 → 遥测 mcp.registry（与版本记录一一对应，旁路）。 */
function noteRegistryTelemetry(rec) {
	try {
		const action = TELEMETRY_ACTION[rec.action];
		if (action === undefined) return;
		const names = [...new Set([...(rec.diff?.added ?? []), ...(rec.diff?.removed ?? []), ...(rec.diff?.changed ?? []).map((c) => c.name)])];
		const sid = typeof rec.sessionId === "string" ? rec.sessionId : undefined;
		for (const server of names.length > 0 ? names : ["*"]) void getTelemetry().record("mcp.registry", { sid, server, action });
	} catch {
		/* 旁路 */
	}
}

async function recordRegistryUnlocked(file, beforeRaw, afterRaw, meta, now = Date.now()) {
	const written = [];
	let last = await lastKeyRecord(REGISTRY_KEY);
	const gap = await recordRegistryGapUnlocked(file, beforeRaw, last, now);
	if (gap !== null) {
		written.push(gap);
		last = gap;
	}
	const beforeText = await redactRegistryText(beforeRaw);
	const afterText = await redactRegistryText(afterRaw);
	const lastText = last?.state?.exists ? (await getObject(last.state.sha).catch(() => null))?.toString("utf8") ?? null : null;
	if (beforeText !== null && (last === null || !diffRegistry(lastText, beforeText).semanticSame)) {
		const diff = diffRegistry(lastText, beforeText);
		const sha = await putObject(Buffer.from(beforeText, "utf8"));
		const rec = {
			...baseRecord("mcp-registry", REGISTRY_KEY, file, now + written.length),
			name: "mcp-registry",
			action: "baseline",
			actor: last === null ? "observed" : "external",
			trigger: null,
			sessionId: null,
			sessionIds: [],
			reason: last === null ? "首次纳入版本史" : "检测到插件外的改动（手工编辑或其它程序）",
			parent: last?.id ?? null,
			state: { exists: true, sha, size: Buffer.byteLength(beforeText) },
			diff: { summary: last === null ? `基线：${diff.added.length} 个 server` : summarizeRegistry("baseline", diff), ...diff },
			eval: null
		};
		delete rec.diff.semanticSame;
		written.push(await appendRecordUnlocked(rec));
		last = rec;
	}
	const prevText = beforeText ?? lastText;
	const diff = diffRegistry(prevText, afterText);
	if (diff.semanticSame && meta?.action !== "rollback" && meta?.action !== "migrate") return written;
	if (afterText === null) return written;
	const action = registryAction(meta?.action, diff);
	const sha = await putObject(Buffer.from(afterText, "utf8"));
	const rec = {
		...baseRecord("mcp-registry", REGISTRY_KEY, file, now + written.length),
		name: "mcp-registry",
		action,
		...attribution(meta),
		reason: reasonOf(meta),
		parent: last?.id ?? null,
		...(typeof meta?.rollbackOf === "string" ? { rollbackOf: meta.rollbackOf } : {}),
		// ：合并溯源（结果一侧 {role:"result", sources:[…]}；来源一侧 {role:"source", into:{…}}）与教训来源
		...(meta?.merge && typeof meta.merge === "object" ? { merge: JSON.parse(JSON.stringify(meta.merge)) } : {}),
		...(meta?.lesson && typeof meta.lesson === "object" ? { lesson: JSON.parse(JSON.stringify(meta.lesson)) } : {}),
		state: { exists: true, sha, size: Buffer.byteLength(afterText) },
		diff: { summary: summarizeRegistry(action, diff), added: diff.added, removed: diff.removed, changed: diff.changed, settings: diff.settings },
		eval: null
	};
	written.push(await appendRecordUnlocked(rec));
	noteRegistryTelemetry(rec);
	return written;
}

function parseServers(raw) {
	try {
		const parsed = raw === null ? null : JSON.parse(String(raw).replace(/^\uFEFF/, ""));
		return Array.isArray(parsed?.servers) ? parsed.servers : [];
	} catch {
		return [];
	}
}

async function readTextOrNull(file) {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * 包一次注册表写入（McpStore.save 用）。只有语义字段变了才出记录：
 * 工具清单缓存（tools / toolsCheckedAt）与回文件现算的接管状态属于自动刷新，不算改动。
 * @template T
 * @param {string} file mcp.json 绝对路径
 * @param {{action?:string, actor?:string, reason?:string}} meta
 * @param {() => Promise<T>} fn
 */
export async function versionedRegistryWrite(file, meta, fn) {
	const beforeRaw = await readTextOrNull(file);
	const result = await fn();
	try {
		const afterRaw = await readTextOrNull(file);
		// · B：从注册表消失的条目先把凭据原值暂存在本机，回滚恢复时才补得回来
		await stashRemovedServers(removedServers(parseServers(beforeRaw), parseServers(afterRaw)));
		await withHistoryLock(() => recordRegistryUnlocked(file, beforeRaw, afterRaw, { ...(meta ?? {}), ...(currentWriteContext().registryAction ? { action: currentWriteContext().registryAction } : {}) }));
	} catch (error) {
		warn(`MCP 注册表：${error instanceof Error ? error.message : String(error)}`);
	}
	return result;
}

/**
 * 启动时体检一次注册表文件（尾巴①）：上一条记录说它在、现在却没了 / 坏了，就落缺口记录。
 * 不写 mcp.json，不抛。
 * @returns {Promise<object|null>} 写出的缺口记录
 */
export async function auditRegistryPresence(file) {
	try {
		const raw = await readTextOrNull(file);
		return await withHistoryLock(async () => recordRegistryGapUnlocked(file, raw, await lastKeyRecord(REGISTRY_KEY), Date.now()));
	} catch (error) {
		warn(`MCP 注册表体检：${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

// ── 保留口径（：所有者 2026-11-16 拍板「每 key 保留最近 200 条」）──────────────
//
// 主日志 versions.jsonl 每个 key 只留最近 VERSION_KEEP_PER_KEY 条（按日志顺序 = 写入顺序），更早的记录
// 移进归档段 archive/versions-<时间>.jsonl.gz（只追加、不再被 readVersionRecords 读回；快照也只带主日志与
// objects/，归档段只留本机）。objects/ 按「仍被主日志里保留的记录引用」做 GC：未被引用、且已过宽限期
// （防正在写的版本：对象先落、记录后追加）的对象才删。保留后主日志有界，readVersionRecords 的全量读随之有界。

export const VERSION_KEEP_PER_KEY = 200;
const ARCHIVE_DIR = "archive";
const OBJECT_GC_GRACE_MS = 60 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{64}$/;

/** 一条记录引用到的全部对象 sha（深度遍历，保守：任何字段里的 64 位十六进制串都算引用）。 */
function referencedShas(rec, into = new Set()) {
	const walk = (node) => {
		if (typeof node === "string") {
			if (SHA_RE.test(node)) into.add(node);
			return;
		}
		if (Array.isArray(node)) for (const v of node) walk(v);
		else if (node && typeof node === "object") for (const v of Object.values(node)) walk(v);
	};
	walk(rec?.state);
	return into;
}

async function listObjectFiles() {
	const root = join(historyRoot(), HISTORY_OBJECTS);
	const out = [];
	let buckets = [];
	try {
		buckets = await readdir(root);
	} catch {
		return out;
	}
	for (const b of buckets) {
		if (!/^[0-9a-f]{2}$/.test(b)) continue;
		let names = [];
		try {
			names = await readdir(join(root, b));
		} catch {
			continue;
		}
		for (const n of names) {
			const m = /^([0-9a-f]{64})\.gz$/.exec(n);
			if (m && m[1].startsWith(b)) out.push({ sha: m[1], file: join(root, b, n) });
		}
	}
	return out;
}

/** 按保留口径切分：返回 {kept, pruned}（kept 保持原日志顺序）。纯函数。 */
export function splitByRetention(records, keep = VERSION_KEEP_PER_KEY) {
	const seen = new Map();
	const keepFlags = new Array(records.length).fill(false);
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const key = String(records[i].key ?? "");
		const n = seen.get(key) ?? 0;
		if (n < keep) keepFlags[i] = true;
		seen.set(key, n + 1);
	}
	const kept = [];
	const pruned = [];
	records.forEach((rec, i) => (keepFlags[i] ? kept : pruned).push(rec));
	return { kept, pruned };
}

/**
 * 执行一次保留：超出每 key 最近 keep 条的记录归档出主日志，未被引用的对象 GC。拿版本日志锁。
 * @param {{keep?: number, dryRun?: boolean, graceMs?: number, now?: number}} [options]
 */
export async function applyVersionRetention(options = {}) {
	const keep = Number.isInteger(options.keep) && options.keep > 0 ? options.keep : VERSION_KEEP_PER_KEY;
	const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, options.graceMs) : OBJECT_GC_GRACE_MS;
	const at = Number.isFinite(options.now) ? options.now : Date.now();
	return withHistoryLock(async () => {
		const records = await readVersionRecords();
		const { kept, pruned } = splitByRetention(records, keep);
		const referenced = new Set();
		for (const rec of kept) referencedShas(rec, referenced);
		const objects = await listObjectFiles();
		const orphans = [];
		for (const obj of objects) {
			if (referenced.has(obj.sha)) continue;
			let young = false;
			try {
				young = at - (await stat(obj.file)).mtimeMs < graceMs;
			} catch {
				continue;
			}
			if (!young) orphans.push(obj);
		}
		const result = {
			keep,
			dryRun: options.dryRun === true,
			records: records.length,
			kept: kept.length,
			archived: pruned.length,
			objects: objects.length,
			referencedObjects: referenced.size,
			deletedObjects: options.dryRun === true ? 0 : orphans.length,
			orphanObjects: orphans.length,
			archiveFile: null
		};
		if (options.dryRun === true) return result;
		if (pruned.length > 0) {
			// 先落归档段、再改写主日志：中途失败最多多一份归档副本，不丢记录
			const archiveFile = join(historyRoot(), ARCHIVE_DIR, `versions-${new Date(at).toISOString().replace(/[:.]/g, "-")}.jsonl.gz`);
			await atomicWriteFile(archiveFile, gzipSync(Buffer.from(pruned.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")), { mode: 0o600 });
			await atomicWriteFile(historyLogPath(), kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length > 0 ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
			result.archiveFile = archiveFile;
		}
		for (const obj of orphans) await rm(obj.file, { force: true }).catch(() => {});
		if (pruned.length > 0 || orphans.length > 0) {
			note(`版本史保留（每 key 最近 ${keep} 条）：主日志 ${records.length} → ${kept.length} 条（归档 ${pruned.length}），对象 GC ${orphans.length} 个`);
		}
		return result;
	});
}

/**
 * 保留口径自检（回滚能力验收用，只读）：每 key 记录数不超过口径；主日志里每条记录引用的对象都在、且内容与 sha 相符
 * （= 最近 keep 条内任一版本仍可回滚）；对象库里没有未被引用的对象（GC 后应为 0，宽限期内的除外）。
 */
export async function verifyVersionRetention(options = {}) {
	const keep = Number.isInteger(options.keep) && options.keep > 0 ? options.keep : VERSION_KEEP_PER_KEY;
	const records = await readVersionRecords();
	const perKey = new Map();
	for (const rec of records) perKey.set(rec.key, (perKey.get(rec.key) ?? 0) + 1);
	const referenced = new Set();
	for (const rec of records) referencedShas(rec, referenced);
	// 只读记录里 stored=true 的文件 / 注册表 sha 才必须在对象库里（大文件只记指纹，本来就不存）
	const required = new Set();
	for (const rec of records) {
		if (rec.state?.exists !== true) continue;
		if (typeof rec.state.sha === "string" && SHA_RE.test(rec.state.sha)) required.add(rec.state.sha);
		for (const f of Object.values(rec.state.files ?? {})) if (f?.stored === true && SHA_RE.test(String(f.sha))) required.add(f.sha);
	}
	const missing = [];
	for (const sha of required) {
		try {
			await getObject(sha);
		} catch {
			missing.push(sha);
		}
	}
	const objects = await listObjectFiles();
	const unreferenced = objects.filter((o) => !referenced.has(o.sha)).map((o) => o.sha);
	const maxPerKey = Math.max(0, ...perKey.values());
	return {
		ok: maxPerKey <= keep && missing.length === 0,
		keep,
		keys: perKey.size,
		records: records.length,
		maxPerKey,
		overLimitKeys: [...perKey].filter(([, n]) => n > keep).map(([k]) => k),
		requiredObjects: required.size,
		missingObjects: missing,
		objects: objects.length,
		unreferencedObjects: unreferenced.length
	};
}

// ── ：旧版本史里注册表内嵌凭据的重新脱敏 ───────────────────────────
// 之前，注册表版本只按整字段脱敏：args 里的 `--api-key xxx`、URL 查询串里的 token 原样进了对象库，
// 而版本史随每份快照 / studio 备份包出机。这里把这些旧对象按现在的口径重新脱敏：新对象先落、主日志原子改写
// （只改 state.sha / state.size）、再删已不被引用的旧对象——中途失败最多留几个孤儿对象，下次保留 GC 会收走。
// 幂等：没有要改的就什么都不写。顺带让「升级后第一次写注册表」不再因为新旧脱敏口径不同而多出一条 external 基线。

/**
 * @param {{dryRun?: boolean}} [options]
 * @returns {Promise<{dryRun: boolean, registryRecords: number, objectsChecked: number, objectsRewritten: number, recordsRewritten: number, missingObjects: string[]}>}
 */
export async function redactRegistryHistory(options = {}) {
	const dryRun = options.dryRun === true;
	const { redactCredentials } = await import("./snapshot.js");
	return withHistoryLock(async () => {
		const records = await readVersionRecords();
		const isRegistryState = (rec) => rec.key === REGISTRY_KEY && rec.state?.exists === true && typeof rec.state.sha === "string" && SHA_RE.test(rec.state.sha);
		const replaced = new Map();
		const checked = new Set();
		const missing = [];
		for (const rec of records) {
			if (!isRegistryState(rec)) continue;
			const old = rec.state.sha;
			if (checked.has(old)) continue;
			checked.add(old);
			let parsed;
			try {
				parsed = JSON.parse((await getObject(old)).toString("utf8"));
			} catch {
				missing.push(old);
				continue;
			}
			const before = stableJson(parsed);
			redactCredentials(parsed);
			if (stableJson(parsed) === before) continue;
			const text = JSON.stringify(parsed, null, 2) + "\n";
			const buf = Buffer.from(text, "utf8");
			replaced.set(old, { sha: sha256(buf), size: buf.length, buf });
		}
		const registryRecords = records.filter(isRegistryState);
		const touched = registryRecords.filter((rec) => replaced.has(rec.state.sha));
		const result = { dryRun, registryRecords: registryRecords.length, objectsChecked: checked.size, objectsRewritten: replaced.size, recordsRewritten: touched.length, missingObjects: missing };
		if (dryRun || replaced.size === 0) return result;
		for (const item of replaced.values()) await putObject(item.buf);
		const next = records.map((rec) => {
			if (!isRegistryState(rec) || !replaced.has(rec.state.sha)) return rec;
			const item = replaced.get(rec.state.sha);
			return { ...rec, state: { ...rec.state, sha: item.sha, size: item.size } };
		});
		await atomicWriteFile(historyLogPath(), next.map((r) => JSON.stringify(r)).join("\n") + (next.length > 0 ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
		const referenced = new Set();
		for (const rec of next) referencedShas(rec, referenced);
		for (const old of replaced.keys()) if (!referenced.has(old)) await rm(objectPath(old), { force: true }).catch(() => {});
		note(`版本史：${replaced.size} 份注册表旧版本按新口径重新脱敏（参数 / URL 里的内嵌凭据），${touched.length} 条记录改指新对象`);
		return result;
	});
}

// ── 查询 ──────────────────────────────────────────────────────────────────

/** 去掉 state 里的大块清单，只留给人看的字段（工具 / 路由返回值用）。 */
export function publicRecord(rec) {
	const { state, ...rest } = rec;
	const out = {
		...rest,
		state: state?.exists === true ? { exists: true, files: state.files ? Object.keys(state.files).length : undefined, sha: state.sha } : { exists: false }
	};
	// 宿主 output schema 要求无损 JSON：undefined 字段不能留在对象里
	return JSON.parse(JSON.stringify(out));
}

/**
 * 列版本记录（新的在前）。
 * @param {{key?:string, name?:string, kind?:string, limit?:number}} [filter]
 */
export async function listVersions(filter = {}) {
	const name = typeof filter.name === "string" ? filter.name.trim() : "";
	const limit = Number.isFinite(Number(filter.limit)) && Number(filter.limit) > 0 ? Math.min(Number(filter.limit), 1000) : 50;
	// B1：只在索引字段上筛，读出的只有最终要返回的那几条
	return queryVersionRecords(
		(rec) => {
			if (filter.kind && rec.kind !== filter.kind) return false;
			if (filter.key && rec.key !== filter.key) return false;
			if (name !== "" && rec.name !== name && rec.key !== name) return false;
			return true;
		},
		{ newestFirst: true, limit }
	);
}

/** 把用户给的 name / key 解析成唯一的 skill key；同名出现在两个 store 时要求给 key。 */
export async function resolveSkillKey(nameOrKey) {
	const text = String(nameOrKey ?? "").trim();
	if (text === "") throw new UserError("需要 skill 名或 key");
	if (text.startsWith("skill:")) {
		if (!(await keyKnown(text))) throw notFound("版本史里没有 " + text);
		return text;
	}
	const keys = await skillKeysByName(text);
	if (keys.length === 0) throw notFound(`版本史里没有名为「${text}」的 skill`);
	if (keys.length > 1) throw new UserError(`「${text}」在多个 store 里都有版本记录，请改用 key：${keys.join("、")}`);
	return keys[0];
}

// ── 回滚 ──────────────────────────────────────────────────────────────────

function trashStamp() {
	const d = new Date();
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

/** 回到「不存在」的版本：不硬删，按回收站的 manifest 格式搬进 trash，面板 / skillmgr_restore 能恢复。 */
async function moveToTrash(target, name) {
	const { trashRoot } = await import("./trash.js");
	const id = `${trashStamp()}-rollback-${name.replace(/[^\w.-]+/g, "_")}`;
	const batch = join(trashRoot(), id);
	await mkdir(batch, { recursive: true });
	const to = join(batch, basename(target));
	await rename(target, to);
	await writeFile(join(batch, "manifest.json"), JSON.stringify([{ name, from: target, to, root: dirname(target), at: Date.now() }], null, 2), "utf8");
	return { trashId: id, to };
}

/**
 * 把一个 skill 回滚到指定版本。目标状态写盘后再取一次实际状态记成 action=rollback 的新版本。
 * @param {{name?:string, key?:string, versionId:string, actor?:string, sessionId?:string, reason?:string}} args
 */
export async function rollbackSkill(args) {
	const versionIdArg = String(args?.versionId ?? "").trim();
	if (versionIdArg === "") throw new UserError("需要 versionId（用 skillmgr_history 查）");
	const key = args?.key ? await resolveSkillKey(args.key) : await resolveSkillKey(args?.name);
	return withHistoryLock(async () => {
		const rec = await findVersionRecord(versionIdArg);
		if (rec === null) throw notFound("找不到版本 " + versionIdArg);
		if (rec.key !== key) throw new UserError(`版本 ${versionIdArg} 不属于 ${key}（它属于 ${rec.key}）`);
		const target = rec.target;
		if (typeof target !== "string" || target === "") throw new UserError("版本记录缺少目标路径");
		const desired = rec.state;
		const before = await captureSkillState(target);
		const skippedLarge = [];
		let trashed = null;
		if (desired?.exists !== true) {
			if (before.exists) trashed = await moveToTrash(target, rec.name ?? basename(target));
		} else if (desired.kind === "file") {
			const [rel, entry] = Object.entries(desired.files)[0] ?? [];
			if (entry === undefined) throw new UserError("版本记录里没有文件内容");
			if (entry.stored !== true) throw new UserError(`${rel} 超过 ${MAX_STORED_FILE_BYTES} 字节，当初只记了指纹，无法回滚`);
			if (before.exists && before.kind === "dir") throw new UserError("目标位置现在是目录，与版本里的单文件形态冲突，未改动");
			await atomicWriteFile(target, await getObject(entry.sha));
		} else {
			if (before.exists && before.kind === "file") throw new UserError("目标位置现在是单文件，与版本里的目录形态冲突，未改动");
			// 先把所有要写的内容取齐（任何一个对象坏了就零改动退出），再落盘
			const plan = [];
			for (const [rel, entry] of Object.entries(desired.files)) {
				if (!isSafeEntryPath(rel)) throw new UserError("版本记录里的路径不安全：" + rel);
				if (entry.stored !== true) {
					skippedLarge.push(rel);
					continue;
				}
				plan.push({ rel, data: await getObject(entry.sha) });
			}
			await mkdir(target, { recursive: true });
			for (const item of plan) {
				const abs = join(target, item.rel);
				if (!isInside(target, abs)) throw new UserError("版本记录里的路径越界：" + item.rel);
				const cur = before.files[item.rel];
				if (cur !== undefined && cur.sha === desired.files[item.rel].sha) continue;
				await atomicWriteFile(abs, item.data);
			}
			for (const rel of Object.keys(before.files)) {
				if (Object.hasOwn(desired.files, rel)) continue;
				// 版本史里只有指纹、没有内容的大文件不删：删了就再也回不来（往前回滚同样只会报 skippedLarge）。
				// 与 captureSkillState 的口径一致——「大文件回滚时保持现状不动，并在结果里报出来」。
				if (before.files[rel]?.stored !== true) {
					skippedLarge.push(rel);
					continue;
				}
				const abs = join(target, rel);
				if (isInside(target, abs)) await rm(abs, { force: true });
			}
		}
		const after = await captureSkillState(target);
		const who = attribution({ actor: args?.actor, sessionId: args?.sessionId });
		const written = await recordSkillUnlocked(target, before, after, {
			action: "rollback",
			actor: who.actor === "unknown" ? "manual:rollback" : who.actor,
			sessionId: who.sessionId ?? undefined,
			reason: (typeof args?.reason === "string" && args.reason !== "" ? args.reason + "；" : "") + `回滚到 ${rec.id}`,
			rollbackOf: rec.id
		});
		// 目标状态与当前一致时 recordSkillUnlocked 不出记录；回滚请求本身仍要留痕
		let rollbackRec = written.find((r) => r.action === "rollback") ?? null;
		if (rollbackRec === null) {
			const last = await lastKeyRecord(key);
			rollbackRec = await appendRecordUnlocked({
				...baseRecord("skill", key, target, Date.now()),
				name: rec.name,
				action: "rollback",
				...attribution({ actor: who.actor === "unknown" ? "manual:rollback" : who.actor, sessionId: who.sessionId ?? undefined }),
				reason: `回滚到 ${rec.id}（内容本来就与该版本一致，未改动文件）`,
				parent: last?.id ?? null,
				rollbackOf: rec.id,
				state: after,
				diff: { summary: "回滚：内容未变", files: [], frontmatter: [] },
				eval: null
			});
		}
		return { ok: true, key, target, restoredTo: rec.id, version: publicRecord(rollbackRec), skippedLarge, trashed };
	});
}

/**
 * 版本里的注册表（凭据是占位符）→ 可落盘的注册表：占位符按 **server 名**从本机现值补回；
 * 本机已经没有这个 server（被注销过）就从凭据暂存里取；两边都没有的整字段键直接不写，
 * 内嵌占位符（参数 / URL 里的一段，）原样留着。补不回的逐项回调 `onMissing(server 名, 字段路径)`，
 * 顶层设置项的 server 名记作 `@settings`。
 *
 * servers 按名字逐个配对（本机现值找不到再找凭据暂存），不交给 mergeRedacted 的数组分支——
 * 暂存只在这里查得到。
 * @param {((server: string, field: string) => void) | null} [onMissing]
 */
export async function mergeRegistryCredentials(desired, current, onMissing = null) {
	const { mergeRedacted } = await import("./snapshot.js");
	const { servers: desiredServers, ...desiredTop } = desired ?? {};
	const { servers: currentServers, ...currentTop } = current !== null && typeof current === "object" ? current : {};
	const topMissing = [];
	const merged = mergeRedacted(desiredTop, currentTop, topMissing) ?? {};
	for (const field of topMissing) onMissing?.("@settings", field);
	const byName = new Map((Array.isArray(currentServers) ? currentServers : []).filter((s) => s && typeof s.name === "string").map((s) => [s.name, s]));
	const stash = await readStashLenient();
	merged.servers = (Array.isArray(desiredServers) ? desiredServers : [])
		.map((server) => {
			const name = typeof server?.name === "string" ? server.name : "";
			const peer = byName.get(name) ?? stash.servers?.[name]?.server ?? {};
			// ：补不回的（整字段的不写、内嵌的留占位符）逐项交给调用方报出来
			const missing = [];
			const out = mergeRedacted(server, peer, missing);
			for (const field of missing) onMissing?.(name, field);
			return out;
		})
		.filter((s) => s !== undefined);
	return merged;
}

/**
 * 把整份 MCP 注册表回滚到指定版本。版本里的凭据是占位符：按 mergeRedacted 用本机现值补回，
 * 整字段凭据本机没有的键直接不写；参数 / URL 里内嵌的补不回时占位符留在原处
 * （运行时拒绝带占位符连接）。两种都列进返回值的 missingCredentials。
 * @param {{versionId:string, file:string, actor?:string, sessionId?:string, reason?:string}} args
 */
export async function rollbackRegistry(args) {
	const versionIdArg = String(args?.versionId ?? "").trim();
	if (versionIdArg === "") throw new UserError("需要 versionId（用 skillmgr_history 查，name 填 mcp-registry）");
	const file = String(args?.file ?? "");
	if (file === "") throw new UserError("缺少注册表路径");
	return withHistoryLock(async () => {
		const rec = await findVersionRecord(versionIdArg);
		if (rec === null) throw notFound("找不到版本 " + versionIdArg);
		if (rec.key !== REGISTRY_KEY) throw new UserError(`版本 ${versionIdArg} 不是注册表版本（它属于 ${rec.key}）`);
		if (rec.state?.exists !== true || GAP_ACTIONS.has(rec.action)) {
			throw new UserError(`版本 ${versionIdArg} 是注册表${rec.action === "registry-corrupt" ? "损坏" : "缺口"}记录，没有可恢复的内容；请回滚到它之前的版本（parent = ${rec.parent ?? "无"}）`);
		}
		const desired = JSON.parse((await getObject(rec.state.sha)).toString("utf8"));
		const beforeRaw = await readTextOrNull(file);
		let current = null;
		try {
			current = beforeRaw === null ? null : JSON.parse(beforeRaw.replace(/^\uFEFF/, ""));
		} catch {
			current = null;
		}
		const missingCredentials = [];
		const merged = await mergeRegistryCredentials(desired, current, (server, field) => missingCredentials.push({ server, field }));
		// 回滚让某些 server 消失：同样先暂存它们的凭据，再回滚回来时还能补
		await stashRemovedServers(removedServers(Array.isArray(current?.servers) ? current.servers : [], merged.servers));
		const text = JSON.stringify(merged, null, 2) + "\n";
		await mkdir(dirname(file), { recursive: true });
		await atomicWriteFile(file, text, { encoding: "utf8", mode: CREDENTIAL_FILE_MODE });
		await hardenPermissions(file);
		const who = attribution({ actor: args?.actor, sessionId: args?.sessionId });
		const written = await recordRegistryUnlocked(file, beforeRaw, text, {
			action: "rollback",
			actor: who.actor === "unknown" ? "manual:rollback" : who.actor,
			sessionId: who.sessionId ?? undefined,
			reason: (typeof args?.reason === "string" && args.reason !== "" ? args.reason + "；" : "") + `回滚到 ${rec.id}`,
			rollbackOf: rec.id
		});
		const rollbackRec = written.find((r) => r.action === "rollback") ?? null;
		return { ok: true, key: REGISTRY_KEY, target: file, restoredTo: rec.id, version: rollbackRec ? publicRecord(rollbackRec) : null, missingCredentials };
	});
}
