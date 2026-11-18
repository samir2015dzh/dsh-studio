/**
 * skill 生命周期：active → stale → archived，永不硬删（WO-BORROW-1）。
 *
 * 设计借用 hermes-agent（MIT）的 curator 分层 staleness 与 pinned 豁免。
 * 只借设计，未移植其代码（仓库不在本机，未取到源码）。
 *
 * 归档目录沿用既有墓碑机制：`~/.dsh/skill-archive-<stamp>/<name>/`。
 * extractor.archivedNames() 会把这类目录里的名字当成「以前合并过」的墓碑，
 * 所以归档后的名字不会被自动提取复活，也不需要额外记一份。
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isInside } from "./paths.js";
// 名字归一与 quality / provenance 同口径（N-03）。extractor 不 import 本模块，方向单向。
import { normalizeName } from "./extractor.js";
import { withFileLock } from "./state-lock.js";
import { versionedSkillWrite } from "./versions.js";
import { runWithWriteContext } from "./write-context.js";

/**
 * 只读 skill 根下的 name / path / protected。
 * 不复用 extractor.buildSkillIndex：那会让 extractor 与 lifecycle 互相 import。
 */
async function listSkills(dir) {
	const out = [];
	if (typeof dir !== "string" || dir === "") return out;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const file = e.isDirectory() ? join(dir, e.name, "SKILL.md") : e.name.endsWith(".md") ? join(dir, e.name) : null;
		if (file === null) continue;
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
		const name = (block.match(/^name:\s*(.+)$/m)?.[1] ?? e.name.replace(/\.md$/, "")).trim().replace(/^["']|["']$/g, "");
		const protectedSkill = /^\s*protected:\s*true\s*$/m.test(block) || (e.isDirectory() && await exists(join(dir, e.name, ".no-merge")));
		out.push({ name, path: file, protected: protectedSkill });
	}
	return out;
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** 默认：90 天没用标 stale，180 天没用归档。0 或负数 = 关闭该档。 */
export const DEFAULT_STALE_DAYS = 90;
export const DEFAULT_ARCHIVE_DAYS = 180;

/** 生命周期状态文件（与 candidates.json 同目录）。 */
export function lifecyclePath() {
	return resolve(homedir(), ".dsh", "dsh-studio", "skill-lifecycle.json");
}

/** 归档根：每次巡检一个目录，名字以 `skill-archive` 开头才被 archivedNames() 认。 */
export function archiveRoot(now = Date.now()) {
	return resolve(homedir(), ".dsh", `skill-archive-${stamp(now)}`);
}

function stamp(now) {
	const d = new Date(now);
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

export async function loadState() {
	try {
		const parsed = JSON.parse(await readFile(lifecyclePath(), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export async function saveState(state) {
	await mkdir(dirname(lifecyclePath()), { recursive: true });
	// tmp + rename：写一半崩掉不会留下坏 JSON
	const tmp = lifecyclePath() + ".tmp";
	await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	await rename(tmp, lifecyclePath());
	return state;
}

/**
 * 使用口径版本（N-03）：`useCount` 的含义从「写路径被调用次数」改成「发生过加载的会话数」。
 * 迁移标记写进状态文件顶层，键名以 `__` 开头，不可能与技能名相撞（normalizeName 会把下划线归一成连字符）。
 */
export const USAGE_MODEL = "load-sessions";
const MODEL_KEY = "__usageModel";

/**
 * 状态键口径：与 quality / provenance 一样走 normalizeName，保证「加载事件的名字」与
 * 「markSkillUsed 记的名字」命中同一条记录。纯字符归类（如中文名）归一后为空时保留原名。
 */
export function stateKeyOf(name) {
	const raw = typeof name === "string" ? name.trim() : "";
	if (raw === "") return "";
	const norm = normalizeName(raw);
	return norm !== "" ? norm : raw;
}

/**
 * 存量迁移（一次性）：旧 `useCount` 是写路径计数（正是本批要替代的失真源），搬到
 * `writeCount` 保留信息；`useCount` 从此刻起只由加载会话数写。幂等，重复调用无副作用。
 */
function migrateState(state) {
	if (state[MODEL_KEY] === USAGE_MODEL) return false;
	for (const [key, value] of Object.entries(state)) {
		if (key.startsWith("__")) continue;
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const target = stateKeyOf(key) || key;
		const merged = target !== key && state[target] && typeof state[target] === "object" ? { ...state[target], ...value } : { ...value };
		if (Number.isFinite(merged.useCount)) {
			merged.writeCount = (Number.isFinite(merged.writeCount) ? merged.writeCount : 0) + merged.useCount;
			delete merged.useCount;
		}
		if (target !== key) delete state[key];
		state[target] = merged;
	}
	state[MODEL_KEY] = USAGE_MODEL;
	return true;
}

/**
 * 记一次「写入」：自动提取落库、面板保存、darwin 回收结果时都算。
 * M-7：firstUsedAt 只写最早一次、lastUsedAt 跟最后一次；N-03：不再给 useCount +1 ——
 * 写路径证明的是「入库过」，不是「被调用过」，使用计数只认会话里的加载事件。
 */
export async function markSkillUsed(name, now = Date.now()) {
	const key = stateKeyOf(name);
	if (key === "") return;
	// N-06：整个 load → 改 → save 在同一把文件锁里；并发时后写者不会拿旧快照整体覆盖
	await withFileLock(lifecyclePath(), async () => {
		const state = await loadState();
		migrateState(state);
		const prev = state[key] ?? {};
		const firstUsedAt = Number.isFinite(prev.firstUsedAt) ? Math.min(prev.firstUsedAt, now) : now;
		const lastUsedAt = Number.isFinite(prev.lastUsedAt) ? Math.max(prev.lastUsedAt, now) : now;
		const writeCount = (Number.isFinite(prev.writeCount) ? prev.writeCount : 0) + 1;
		state[key] = { ...prev, firstUsedAt, lastUsedAt, writeCount, status: "active", lastCheckAt: now };
		await saveState(state);
	});
}

/**
 * 记一次「真的被加载进会话」（N-03）。一次调用可以带多批加载（每批一件事：某会话加载了某技能）。
 * @param {Array<{name:string, sessionId?:string, at?:number}>} loads
 * @returns {Promise<number>} 真正改变状态的条数（幂等重放返回 0）
 */
export async function recordSkillLoads(loads, { now = Date.now() } = {}) {
	if (!Array.isArray(loads) || loads.length === 0) return 0;
	// N-06：与 markSkillUsed 同一把文件锁 —— 两者并发时曾互相覆盖
	return withFileLock(lifecyclePath(), async () => {
		const state = await loadState();
		const migrated = migrateState(state);
		let applied = 0;
		for (const load of loads) {
			const key = stateKeyOf(load?.name);
			if (key === "") continue;
			const at = Number.isFinite(load?.at) ? load.at : now;
			const sessionId = typeof load?.sessionId === "string" ? load.sessionId : "";
			const prev = state[key] ?? {};
			const sessions = Array.isArray(prev.loadSessions) ? prev.loadSessions : [];
			// 同一会话已计入：计数与时间都不再动（重放幂等的第二道保险）
			if (sessionId !== "" && sessions.includes(sessionId)) continue;
			const nextSessions = sessionId === "" ? sessions : [...sessions, sessionId];
			state[key] = {
				...prev,
				firstUsedAt: Number.isFinite(prev.firstUsedAt) ? Math.min(prev.firstUsedAt, at) : at,
				lastUsedAt: Number.isFinite(prev.lastUsedAt) ? Math.max(prev.lastUsedAt, at) : at,
				loadSessions: nextSessions,
				useCount: nextSessions.length,
				status: "active",
				lastCheckAt: now
			};
			applied += 1;
		}
		if (applied > 0 || migrated) await saveState(state);
		return applied;
	});
}

/**
 * 纯判定：按「距上次使用多少天」给出应处的档位。
 * 归档优先于 stale；阈值 <= 0 表示该档关闭。
 */
export function classifySkill({ ageDays, staleAfterDays = DEFAULT_STALE_DAYS, archiveAfterDays = DEFAULT_ARCHIVE_DAYS }) {
	if (!Number.isFinite(ageDays)) return "active";
	if (archiveAfterDays > 0 && ageDays >= archiveAfterDays) return "archive";
	if (staleAfterDays > 0 && ageDays >= staleAfterDays) return "stale";
	return "active";
}

async function mtimeOf(path) {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return Date.now();
	}
}

/**
 * 跑一轮巡检。
 * @param {object} cfg 提取配置（用 agentSkillDir / staleAfterDays / archiveAfterDays）
 * @param {{now?:number, apply?:boolean}} options apply=false 时只报告、不动文件
 * @returns {{stale:object[], archived:object[], skipped:object[]}}
 */
export async function scanLifecycle(cfg, { now = Date.now(), apply = true } = {}) {
	const dir = cfg?.agentSkillDir;
	const staleAfterDays = Number.isFinite(cfg?.staleAfterDays) ? cfg.staleAfterDays : DEFAULT_STALE_DAYS;
	const archiveAfterDays = Number.isFinite(cfg?.archiveAfterDays) ? cfg.archiveAfterDays : DEFAULT_ARCHIVE_DAYS;
	const index = await listSkills(dir);
	const state = (await loadState()) ?? {};
	// 锁外读的 state 只用于判定（与改造前同一份读取）；真正落盘在锁内重新 load 后合并
	migrateState(state);
	const stale = [];
	const archived = [];
	const skipped = [];
	// N-06：本周期要写进状态文件的三项，锁内逐条合并 —— 不整份覆盖别人的计数
	const patches = new Map();
	let root = null;
	for (const skill of index) {
		// pinned 豁免：protected（frontmatter）或 .no-merge 标记，视为人工维护
		if (skill.protected === true) {
			skipped.push({ name: skill.name, reason: "pinned" });
			continue;
		}
		// 状态键与 markSkillUsed / 加载信号同口径（N-03）；老键读不到时回退原名
		const key = stateKeyOf(skill.name) || skill.name;
		const entry = state[key] ?? state[skill.name] ?? {};
		const recorded = entry.lastUsedAt;
		const lastUsed = Number.isFinite(recorded) ? recorded : await mtimeOf(skill.path);
		const ageDays = (now - lastUsed) / 86_400_000;
		const verdict = classifySkill({ ageDays, staleAfterDays, archiveAfterDays });
		if (verdict === "active") continue;
		if (verdict === "stale") {
			stale.push({ name: skill.name, ageDays: Math.round(ageDays) });
			if (apply) patches.set(key, { lastUsedAt: lastUsed, status: "stale", lastCheckAt: now });
			continue;
		}
		// archive：只归档目录版（单文件 skill 没有自己的目录，搬走会把整个 skill 根带走）
		const home = dirname(skill.path);
		if (dirname(home) === resolve(dir)) {
			if (apply) {
				if (root === null) root = archiveRoot(now);
				// 归档落点用**目录名**，不用 frontmatter 的 name：name 是技能自己写的自由文本，
				// `name: ../dsh-studio` 会让 cp 盖到归档根之外（~/.dsh/dsh-studio），两个目录同写一个 name 会在归档里互相覆盖。
				// 目录名是文件系统给的单段名；归档里已有同名的就加序号，绝不覆盖。
				const to = await freeArchiveTarget(root, basename(home));
				// 目录搬移是包内容落盘，留在锁外；锁内只碰状态文件
				await mkdir(root, { recursive: true });
				// · G2：闲置回收记一条版本（actor 默认 lifecycle；外层若是模型 / 面板触发则保留为 trigger）
				await runWithWriteContext({ actor: "lifecycle:idle-recycle" }, () =>
					versionedSkillWrite(home, { action: "recycle", reason: `闲置 ${Math.round(ageDays)} 天，归档到 ${to}` }, async () => {
						await cp(home, to, { recursive: true });
						await rm(home, { recursive: true, force: true });
					})
				);
				patches.set(key, { lastUsedAt: lastUsed, status: "archived", lastCheckAt: now });
				archived.push({ name: skill.name, path: to });
			} else {
				archived.push({ name: skill.name, path: null });
			}
			continue;
		}
		skipped.push({ name: skill.name, reason: "single-file" });
	}
	if (apply) {
		await withFileLock(lifecyclePath(), async () => {
			const latest = (await loadState()) ?? {};
			const migratedNow = migrateState(latest);
			for (const [key, patch] of patches) latest[key] = { ...(latest[key] ?? {}), ...patch };
			if (migratedNow || patches.size > 0) await saveState(latest);
		});
	}
	return { stale, archived, skipped };
}

/** 归档根下一个还没被占用的落点：`<dir>`，已存在就 `<dir>-2`、`<dir>-3`…… */
async function freeArchiveTarget(root, dirName) {
	for (let n = 1; ; n += 1) {
		const to = join(root, n === 1 ? dirName : `${dirName}-${n}`);
		if (!isInside(root, to) || to === resolve(root)) throw new Error(`归档落点越出归档根：${dirName}`);
		if (!(await exists(to))) return to;
	}
}

/** 归档目录里的条目（供面板列「已归档」）。 */
export async function listArchived() {
	const base = resolve(homedir(), ".dsh");
	const out = [];
	let entries;
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (!e.isDirectory() || !e.name.startsWith("skill-archive")) continue;
		let names = [];
		try {
			names = await readdir(join(base, e.name));
		} catch {
			continue;
		}
		for (const name of names) out.push({ name, batch: e.name, path: join(base, e.name, name) });
	}
	return out;
}
