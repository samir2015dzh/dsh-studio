/**
 * darwin 体检调度器 —— 从独立插件 dsh-darwin-auto 并入 dsh-studio。
 *
 * 两个注入点与原插件一致：
 *   tools/post-execute     写入 SKILL.md → 记 pending；模型加载 darwin-skill → 静默
 *   system-prompt/assemble pending 非空 → 追加 section，模型下一轮必读
 *
 * 合并带来的增强：借用插件已有的 llm 服务自动生成同族去重表 families.json。
 * 原插件零 @deepseek-ai 依赖，装不了模型客户端，只能把聚类交给模型手工做。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { callLLM } from "./extractor.js";
import { atomicWriteFileSync, isObjectJson, readJsonStateSync } from "./json-file.js";
import { loadLock } from "./skillsrc.js";
import { createUpstreamBudget, upstreamHint } from "./upstream.js";

const HOME = os.homedir();
// 沿用原插件目录：已有 state.json 的 seen / scores 直接复用，不会全量重扫
const STATE_DIR = path.join(HOME, ".dsh", "darwin-auto");
const STATE_FILE = path.join(STATE_DIR, "state.json");

/** 默认配置；导出给 update_check 用同一份口径（N-10 的 upstreamTtlMs 不另立一份默认值）。 */
export const DEFAULTS = {
	enabled: true,
	/** 只在这几棵树下写的 SKILL.md 才触发 */
	roots: [path.join(HOME, ".agents", "skills"), path.join(HOME, ".dsh", "skills")],
	/** 加载 darwin-skill 后静默多久，防自激循环（它自己会改 SKILL.md） */
	suppressMs: 15 * 60_000,
	/**
	 * ：无人值守体检点名的 skill，从提示注入起这么久之内不许模型直接写它们的 SKILL.md
	 * （改写一律经 skillmgr_darwin_submit 过评估门与分级）；回收到结果行或超时即解除。
	 */
	unattendedGuardMs: 60 * 60_000,
	/** 用户显式调用 darwin-skill（有人在场的交互流程）之后这么久之内，不拦直接改写 */
	interactiveMs: 30 * 60_000,
	/** pending 项最长存活，超时丢弃 */
	pendingTtlMs: 6 * 60 * 60_000,
	/** 巡检间隔 */
	sweepHours: 24,
	/** 超过这么多天没记录的 skill 进巡检清单 */
	staleDays: 14,
	/** 巡检一次最多列几个 */
	sweepLimit: 5,
	/** 同族去重表；文件不存在则不做任何过滤 */
	familyFile: path.join(STATE_DIR, "families.json"),
	/** 状态文件；可覆盖以便测试隔离 */
	stateFile: STATE_FILE,
	/** families.json 超过这么多天就在下次有 pending 时用 LLM 重聚一次；0 = 关闭自动重聚 */
	familyRefreshDays: 7,
	/** 模型回写评估结果的位置（9 列 TSV，列序与原版 darwin-skill 一致） */
	resultsFile: path.join(STATE_DIR, "results.tsv"),
	/** 上游检查（U-1）：单个上游 ls-remote 的超时；结果缓存多久再查一次 */
	upstreamTimeoutMs: 8000,
	upstreamTtlMs: 10 * 60_000,
	/** 每轮对话最多联网几次 ls-remote；超出静默跳过（缓存命中不计次） */
	upstreamBudget: 3,
	/** lock 文件位置；留空用 lib/skillsrc.js 的默认路径，测试可覆盖以隔离 */
	lockFile: void 0,
};

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "write_file", "multi_edit"]);

/** Windows 路径大小写不敏感，统一小写比较。 */
function norm(p) {
	try {
		return path.resolve(p).replace(/\//g, path.sep).toLowerCase();
	} catch {
		return String(p).toLowerCase();
	}
}

/** 状态文件解析失败的那些路径：留档后本进程内不再覆盖写（审计 2）。 */
const corruptStateFiles = new Map();

function readState(file) {
	let read;
	try {
		read = readJsonStateSync(file, { validate: isObjectJson });
	} catch {
		return { scores: {}, lastSweep: 0 };
	}
	if (read.status === "ok") {
		corruptStateFiles.delete(file);
		const v = read.value;
		return { ...v, scores: v.scores && typeof v.scores === "object" ? v.scores : {}, lastSweep: Number(v.lastSweep) || 0 };
	}
	if (read.status === "corrupt") {
		// 原文件保留并留档；这一轮按空状态跑（只读评分），但 writeState 不会覆盖它
		corruptStateFiles.set(file, read);
		return { scores: {}, lastSweep: 0, corrupt: { archivedTo: read.archivedTo, error: read.error } };
	}
	corruptStateFiles.delete(file);
	return { scores: {}, lastSweep: 0 };
}

/** 当前被判损坏、暂停写入的达尔文状态文件（诊断用）。 */
export function darwinStateCorruption(file) {
	return corruptStateFiles.get(file) ?? null;
}

function writeState(file, state) {
	if (corruptStateFiles.has(file)) {
		// 再确认一次：有人修好 / 删掉了就恢复写入
		const again = (() => {
			try {
				return readJsonStateSync(file, { validate: isObjectJson });
			} catch {
				return { status: "corrupt" };
			}
		})();
		if (again.status === "corrupt") return;
		corruptStateFiles.delete(file);
	}
	try {
		const { corrupt: _c, ...body } = state ?? {};
		atomicWriteFileSync(file, JSON.stringify(body, null, 2));
	} catch {
		/* 状态文件写不进去不影响主流程 */
	}
}

/**
 * 读模型回写的 results.tsv（WO-EVO-5），返回 Map<skill 名, 最新一条记录>。
 *
 * 列序照抄原版 alchaincyf/darwin-skill：timestamp / commit / skill / old_score /
 * new_score / status / dimension / note / eval_mode。表头对不上就当别人的文件，不动。
 */
/**
 * Darwin 的时间戳口径（所有者裁定 2026-11-17）：**产生与解析全程跟随运行机器的本机时区**，
 * 代码里不写死 UTC 或任何固定偏移。产生用 localStamp，解析用 parseStamp，两头同一个基准；
 * 换一台别的时区的机器同样成立。
 */
const pad2 = (n) => String(n).padStart(2, "0");

/** 本机时区的时间戳 `YYYY-MM-DDTHH:mm`（不带时区标记，读的时候同样按本机时区理解）。 */
export function localStamp(ms = Date.now()) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 时间戳 → 纪元毫秒（读不了返回 NaN）。
 * 日期 / 日期时间一律按**本机时区**理解——用本机分量构造，不经 `Date.parse`：
 * 规范规定 `Date.parse("2026-11-17")` 按 UTC 读，那等于在这里悄悄写死了一个时区。
 * 自带时区标记的（`…Z` / `…+08:00` / `…+0800`）也一样：标记不作数，按字面钟点作本机时间
 * （所有者裁定 2026-11-17，）——模型常照本机钟点写、却顺手带个 `Z`，
 * 按绝对时刻算会在非 UTC 机器上把新鲜结果误杀成几小时前的旧行。
 */
export function parseStamp(timestamp) {
	const text = String(timestamp ?? "").trim();
	let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (m !== null) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
	m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?$/.exec(text);
	if (m !== null) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)).getTime();
	return Date.parse(text);
}

/**
 * results.tsv 的一行是不是在 since（本机纪元毫秒）之后写的。
 * 这个守卫只为挡「几个月前的旧行把刚改完的技能记成已评」。
 *   - 只有日期：那一天（本机日历日）之内都算。
 *   - 日期时间：留 1 分钟余量（时间戳只精确到分钟）。
 *   - 读不了：按「是」（保持旧行为，不卡住）。
 */
export function resultIsAfter(timestamp, since) {
	const text = String(timestamp ?? "").trim();
	const parsed = parseStamp(text);
	if (!Number.isFinite(parsed)) return true;
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return parsed + 86_400_000 > since;
	return parsed >= since - 60_000;
}

/**
 * B7：system-prompt/assemble 每一轮都会走到这里，以前在这条路径上用同步 fs 读 results.tsv / families.json、
 * 遍历两棵技能树（阻塞事件循环）。改成异步，且两个小文件按 (mtimeMs, size) 复用上次的解析结果。
 */
const parsedMemo = new Map();
async function readParsedCached(file, parse) {
	let st;
	try {
		st = await fs.promises.stat(file);
	} catch {
		parsedMemo.delete(file);
		return parse(null);
	}
	const hit = parsedMemo.get(file);
	if (hit !== undefined && hit.parse === parse && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
	let text = null;
	try {
		text = await fs.promises.readFile(file, "utf8");
	} catch {
		text = null;
	}
	const value = parse(text);
	if (text !== null) parsedMemo.set(file, { parse, mtimeMs: st.mtimeMs, size: st.size, value });
	return value;
}

function readResults(file) {
	return readParsedCached(file, parseResultsText);
}

function parseResultsText(text) {
	const map = new Map();
	if (text === null) return map;
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
	if (lines.length === 0) return map;
	const header = lines[0].split("\t").map((h) => h.trim());
	if (header.length !== 9 || header[0] !== "timestamp" || header[2] !== "skill") return map;
	for (const line of lines.slice(1)) {
		const cols = line.split("\t");
		if (cols.length < 9) continue;
		const name = cols[2].trim().toLowerCase();
		if (!name) continue;
		map.set(name, {
			timestamp: cols[0].trim(),
			oldScore: cols[3].trim(),
			newScore: cols[4].trim(),
			status: cols[5].trim(),
			dimension: cols[6].trim(),
			note: cols[7].trim(),
			evalMode: cols[8].trim(),
		});
	}
	return map;
}

/** 递归列 SKILL.md，深度受限，跳过 .git / node_modules。（B7：异步，不阻塞提示词组装） */
async function listSkillFiles(root, out = [], depth = 0) {
	if (depth > 4) return out;
	let entries;
	try {
		entries = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) await listSkillFiles(full, out, depth + 1);
		else if (entry.isFile() && /^SKILL\.md$/i.test(entry.name)) out.push(full);
	}
	return out;
}

/** 从 SKILL.md 路径取 skill 名（父目录名）。 */
function skillNameOf(file) {
	return path.basename(path.dirname(file)).toLowerCase();
}

/** 读同族去重表，返回 Map<成员名, 宿主名>。 */
function loadFamilies(file) {
	return readParsedCached(file, parseFamiliesText);
}

function parseFamiliesText(text) {
	const map = new Map();
	if (text === null) return map;
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return map;
	}
	for (const fam of raw?.families ?? []) {
		const host = String(fam?.host ?? "").trim().toLowerCase();
		if (!host) continue;
		for (const m of fam?.members ?? []) {
			const name = String(m ?? "").trim().toLowerCase();
			if (name && name !== host) map.set(name, host);
		}
	}
	return map;
}

function readFamilyStamp(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const t = parseStamp(raw?.updatedAt);
		return Number.isFinite(t) ? t : 0;
	} catch {
		return 0;
	}
}

/** 从模型回复里抠出第一个 JSON 对象。 */
function pickJson(text) {
	const raw = String(text ?? "");
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
}

const CLUSTER_SYSTEM = "你判断一组 agent skill 是否属于同一职责家族。只输出 JSON，不解释。";

/**
 * 用插件已有的 llm 服务按职责语义把 skill 分组，写回 families.json。
 * 判断依据是 description 的职责，不是名字字面相似度。
 */
export async function clusterFamilies(llm, cfg, files) {
	const items = [];
	for (const file of files) {
		let text = "";
		try {
			text = fs.readFileSync(file, "utf8").slice(0, 1200);
		} catch {
			continue;
		}
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		const body = fm ? fm[1] : "";
		const nameMatch = /^name:\s*(.+)$/m.exec(body);
		const descMatch = /^description:\s*(.+)$/m.exec(body);
		items.push({
			name: skillNameOf(file),
			description: (descMatch ? descMatch[1] : "").trim().slice(0, 300),
			declaredName: (nameMatch ? nameMatch[1] : "").trim().slice(0, 80),
		});
	}
	if (items.length < 2) return null;

	const prompt = [
		"下面是一批 agent skill 的 name + description。",
		"把属于同一职责家族的分到一起：判据是「能不能用同一句话概括它们负责什么」。",
		"只共享场景词（都提到 subagent、都提到 GUI）不算同族。",
		"每族选一个当 host：调用状态为启用、正文最完整、被其他人引用的优先。",
		"只输出 JSON，格式：",
		'{"families":[{"id":"short-id","host":"skill-name","members":["skill-name"],"reason":"一句话"}]}',
		"没有重复就输出 {\"families\":[]}。",
		"",
		...items.map((i) => `- ${i.name}${i.description ? " :: " + i.description : ""}`),
	].join("\n");

	const text = await callLLM({}, prompt, { maxTokens: 4000, llm, system: CLUSTER_SYSTEM });
	const parsed = pickJson(text);
	// 回复被截断 / 不是 JSON 时什么都不写：旧写法会落到「families = []」并覆盖文件，一次坏回复就把既有的（含手工维护的）家族表清空，
	// 还顺手清掉 familiesPending，接下来 familyRefreshDays 天都不再重试
	if (!Array.isArray(parsed?.families)) return null;
	const families = [];
	const known = new Set(items.map((i) => i.name));
	for (const fam of parsed?.families ?? []) {
		const host = String(fam?.host ?? "").trim().toLowerCase();
		if (!known.has(host)) continue;
		const members = (fam?.members ?? [])
			.map((m) => String(m ?? "").trim().toLowerCase())
			.filter((m) => known.has(m) && m !== host);
		if (members.length === 0) continue;
		families.push({
			id: String(fam?.id ?? "").trim() || host,
			host,
			members,
			reason: String(fam?.reason ?? "").trim().slice(0, 300),
		});
	}

	const out = {
		version: 1,
		updatedAt: localStamp().slice(0, 10),
		note: "由 dsh-studio 的 darwin 调度器自动生成。host 进评分队列，members 被折叠。",
		families,
	};
	atomicWriteFileSync(cfg.familyFile, JSON.stringify(out, null, 2));
	return out;
}

/**
 * @param ctx   插件 ctx（需要 tools 事件与 systemPrompt）
 * @param config cordis.patch.yml 里 config.darwin 段
 * @param deps  { llm } —— ctx.llm，缺省则不自动聚类
 */
export function applyDarwin(ctx, config = {}, deps = {}) {
	const cfg = { ...DEFAULTS, ...config };
	if (!cfg.enabled) return;

	const pending = new Map();
	const roots = cfg.roots.map(norm);
	let suppressUntil = 0;
	let state = readState(cfg.stateFile);
	let clusterBusy = false;
	let lastScan = 0;
	/** ：无人值守体检点名的 SKILL.md（norm 路径）→ 守护到期时间 */
	const guarded = new Map();
	/** 用户显式调用 darwin-skill（有人在场的交互流程）到这个时间之前，不拦直接写入 */
	let interactiveUntil = 0;

	const underRoots = (file) => {
		const f = norm(file);
		return roots.some((root) => f === root || f.startsWith(root + path.sep));
	};

	/** darwin-skill 本体是否装了：任一 skill 根下有 darwin-skill/SKILL.md 即算。 */
	const hasDarwinSkill = () => cfg.roots.some((root) => fs.existsSync(path.join(root, "darwin-skill", "SKILL.md")));

	/**
	 * 回收 results.tsv（WO-EVO-5）：只有回写了结果的 skill 才算评过。
	 * 「加载了 darwin-skill」不再等于「评过了」——模型不写回，pending 留着下轮再提。
	 * @returns 本轮清掉的 pending 数
	 */
	const recoverResults = async () => {
		const swept = Object.entries(state.swept ?? {});
		if (pending.size === 0 && swept.length === 0) return 0;
		const results = await readResults(cfg.resultsFile);
		if (results.size === 0) return 0;
		let recovered = 0;
		let dirty = false;
		for (const [key, meta] of pending) {
			const name = skillNameOf(meta.file);
			const record = results.get(name);
			// 结果行必须晚于这次改动：results.tsv 里几个月前的旧行不能把刚改完的技能直接算成「评过了」
			if (record === undefined || !resultIsAfter(record.timestamp, meta.at)) continue;
			state.scores[key] = Date.now();
			state.results = { ...(state.results ?? {}), [name]: { ...record, at: Date.now() } };
			pending.delete(key);
			guarded.delete(key);
			recovered += 1;
		}
		// 巡检列出过的技能同样靠回写的结果转成「评过」（此前只有 pending 项会记分，巡检项永远是未评）
		for (const [key, at] of swept) {
			const name = skillNameOf(key);
			const record = results.get(name);
			if (record === undefined || !resultIsAfter(record.timestamp, Number(at) || 0)) continue;
			state.scores[key] = Date.now();
			state.results = { ...(state.results ?? {}), [name]: { ...record, at: Date.now() } };
			delete state.swept[key];
			dirty = true;
		}
		if (recovered > 0 || dirty) writeState(cfg.stateFile, state);
		return recovered;
	};

	/**
	 * 有 pending 且表过期时，后台重聚一次。不 await —— 不阻塞本轮。
	 */
	const maybeCluster = async () => {
		const llm = deps.llm;
		if (!llm || clusterBusy) return;
		if (!(cfg.familyRefreshDays > 0)) return;
		if (state.familiesPending !== true) return;
		const now = Date.now();
		if (now - (state.lastFamilyJudge ?? 0) < 12 * 3_600_000) return;
		if (now - readFamilyStamp(cfg.familyFile) < cfg.familyRefreshDays * 86_400_000) return;

		clusterBusy = true;
		state.lastFamilyJudge = now;
		writeState(cfg.stateFile, state);
		const files = [];
		for (const root of cfg.roots) files.push(...(await listSkillFiles(root)));
		void clusterFamilies(llm, cfg, files)
			.then((out) => {
				if (out) {
					state.familiesPending = false;
					writeState(cfg.stateFile, state);
					ctx.logger?.info?.(`[dsh-studio] darwin families: ${out.families.length} 族 / ${files.length} 个 skill`);
				}
			})
			.catch((err) => ctx.logger?.warn?.("[dsh-studio] darwin families failed: " + (err?.message ?? err)))
			.finally(() => {
				clusterBusy = false;
			});
	};

	/** 扫 mtime，找被「非工具层」写入的文件（插件直接落盘）。首次只建基线。 */
	const scanChanged = async () => {
		const changed = [];
		if (state.seen === undefined) {
			state.seen = {};
			for (const root of cfg.roots) {
				for (const file of await listSkillFiles(root)) {
					try {
						state.seen[norm(file)] = (await fs.promises.stat(file)).mtimeMs;
					} catch {
						/* 读不到就跳过 */
					}
				}
			}
			writeState(cfg.stateFile, state);
			return changed;
		}
		for (const root of cfg.roots) {
			for (const file of await listSkillFiles(root)) {
				const key = norm(file);
				if (pending.has(key)) continue;
				let mtime = 0;
				try {
					mtime = (await fs.promises.stat(file)).mtimeMs;
				} catch {
					continue;
				}
				if ((state.seen[key] ?? 0) < mtime) {
					state.seen[key] = mtime;
					changed.push({ key, file });
				}
				if (changed.length >= 3) break;
			}
			if (changed.length >= 3) break;
		}
		if (changed.length > 0) writeState(cfg.stateFile, state);
		return changed;
	};

	const tryOn = (event, fn) => {
		try {
			ctx.on(event, fn);
		} catch {
			/* 旧宿主没有这个事件：放弃这一项 */
		}
	};

	// ：用户显式调用 darwin-skill = 有人在场的交互流程，那段时间里不拦直接改写
	tryOn("agent/inbox/claimed", (payload) => {
		try {
			const source = payload?.message?.source;
			if (source?.kind === "skill-invocation" && source.name === "darwin-skill") interactiveUntil = Date.now() + cfg.interactiveMs;
		} catch {
			/* 旁路 */
		}
	});

	// ：无人值守体检期间，模型直接写被点名的 SKILL.md 一律拒绝——改写只能经 skillmgr_darwin_submit 过评估门与分级
	tryOn("tools/pre-execute", async (exec, next) => {
		try {
			const toolName = String(exec?.name ?? "");
			const args = exec?.arguments ?? {};
			const file = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
			if (WRITE_TOOLS.has(toolName) && file && /(^|[\\/])SKILL\.md$/i.test(file) && underRoots(file)) {
				const key = norm(file);
				const until = guarded.get(key);
				const t = Date.now();
				if (until !== undefined && t >= until) guarded.delete(key);
				else if (until !== undefined && t >= interactiveUntil) {
					return {
						kind: "deny",
						reason:
							`darwin 无人值守体检期间不直接改写 ${file}：请用 skillmgr_darwin_submit {skill, content, summary} 提交改进后的完整正文，` +
							"由评估门（G1）与分级（G3）决定自动应用还是进待批。所有者在场要直接改，请显式调用 darwin-skill 走交互流程。"
					};
				}
			}
		} catch (err) {
			ctx.logger?.warn?.(`darwin: ${err?.message ?? err}`);
		}
		return next();
	});

	ctx.on("tools/post-execute", async (exec, result, next) => {
		try {
			const toolName = String(exec?.name ?? "");
			const args = exec?.arguments ?? {};
			const file =
				typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";

			// WO-EVO-3：只有写类工具才记 pending。读类工具（read / grep / glob）碰到
			// SKILL.md 不算改动，否则一次只读浏览就会把整个库推进体检队列。
			if (WRITE_TOOLS.has(toolName) && file && /(^|[\\/])SKILL\.md$/i.test(file) && underRoots(file)) {
				pending.set(norm(file), { at: Date.now(), file });
				state.familiesPending = true;
			}

			// 模型读了 darwin-skill：只关闸防自激，不再当作「已评分」（WO-EVO-5）——
			// 分数必须由 results.tsv 回收，只加载不写回的下轮还会再提。
			if (toolName === "skill" && String(args.name ?? "") === "darwin-skill") {
				suppressUntil = Date.now() + cfg.suppressMs;
				const unfinished = { ...(state.unfinished ?? {}) };
				for (const meta of pending.values()) {
					const name = skillNameOf(meta.file);
					unfinished[name] = (unfinished[name] ?? 0) + 1;
				}
				state.unfinished = unfinished;
				writeState(cfg.stateFile, state);
			}
		} catch (err) {
			ctx.logger?.warn?.(`darwin: ${err?.message ?? err}`);
		}
		return next();
	});

	ctx.on("system-prompt/assemble", async (assembly, context, next) => {
		const out = await next();
		try {
			// 静默期内也要回收：模型可能刚写完 results.tsv，早点清 pending 少提一轮
			await recoverResults();
			if (Date.now() < suppressUntil) return out;

			const now = Date.now();
			if (now - lastScan > 60_000) {
				lastScan = now;
				for (const c of await scanChanged()) {
					pending.set(c.key, { at: now, file: c.file });
					state.familiesPending = true;
				}
			}

			const editedRaw = [];
			for (const [key, meta] of pending) {
				if (now - meta.at > cfg.pendingTtlMs) {
					pending.delete(key);
					continue;
				}
				editedRaw.push(meta.file);
			}
			if (editedRaw.length > 0) void maybeCluster().catch(() => {});

			// 同族去重：成员折进宿主，成员的 scores 记为已处理，下轮不再重复送审
			const familyHost = await loadFamilies(cfg.familyFile);
			const edited = [];
			const folded = [];
			for (const file of editedRaw) {
				const name = skillNameOf(file);
				const host = familyHost.get(name);
				if (host && host !== name) {
					folded.push({ file, host });
					state.scores[norm(file)] = now;
					pending.delete(norm(file));
				} else {
					edited.push(file);
				}
			}
			if (folded.length > 0) writeState(cfg.stateFile, state);

			// 巡检：只按间隔跑，且只在没有待办时补位
			const stale = [];
			if (edited.length === 0 && now - (state.lastSweep ?? 0) > cfg.sweepHours * 3_600_000) {
				state.lastSweep = now;
				const cutoff = now - cfg.staleDays * 86_400_000;
				// 「上次列进巡检清单」也算一个时间戳：否则没人回写结果时，每次巡检列出来的永远是遍历顺序最靠前的那 sweepLimit 个，
				// 后面的技能永远轮不到。列过的在 staleDays 内不重复列，清单逐轮往后推；真评过的靠 recoverResults 记分。
				state.swept = state.swept ?? {};
				for (const root of cfg.roots) {
					for (const file of await listSkillFiles(root)) {
						const key = norm(file);
						if (Math.max(state.scores[key] ?? 0, Number(state.swept[key]) || 0) < cutoff) {
							stale.push(file);
							state.swept[key] = now;
						}
						if (stale.length >= cfg.sweepLimit) break;
					}
					if (stale.length >= cfg.sweepLimit) break;
				}
				writeState(cfg.stateFile, state);
			}

			if (edited.length === 0 && stale.length === 0) return out;

			// U-1：待评估的 skill 若能从 lock / .git 定源，顺带查一下上游有没有新提交。
			// 只查待评估项（巡检项不查，省掉每期额外网络往返）；无上游 / 网络失败 / 无差异一律静默。
			const hints = [];
			if (edited.length > 0) {
				const lock = await loadLock(cfg.lockFile);
				// M-1：本轮联网上限（默认 3 次；缓存命中不计次），超出静默跳过
				const budget = createUpstreamBudget(cfg.upstreamBudget);
				const found = await Promise.all(
					edited.map((file) =>
						upstreamHint(path.dirname(file), { lock, timeoutMs: cfg.upstreamTimeoutMs, ttlMs: cfg.upstreamTtlMs, budget }),
					),
				);
				for (let i = 0; i < found.length; i += 1) {
					if (found[i] !== "") hints.push(`- ${edited[i]}：${found[i]}`);
				}
			}

			const lines = ["## skill 自动体检（darwin）"];
			if (folded.length > 0) {
				lines.push(
					`下列 ${folded.length} 个 skill 属同族重复，已按 families.json 折叠，本轮不单独评估：`,
					...folded.map((f) => `- ${f.file} → ${f.host}`),
					"",
				);
			}
			const darwinReady = hasDarwinSkill();
			// ：本段点名的 skill 进守护——体检期间不许直接改写，只能经 skillmgr_darwin_submit 提交
			if (darwinReady) for (const f of [...edited, ...stale]) guarded.set(norm(f), now + cfg.unattendedGuardMs);
			if (edited.length > 0) {
				if (darwinReady) {
					lines.push(
						"本轮检测到下列 skill 文件被改写，必须在本轮结束前完成评估，不需要用户点名：",
						...edited.map((f) => `- ${f}`),
						...(hints.length > 0 ? ["", "上游状态（只提示，不改基线）：", ...hints] : []),
						"",
						"硬要求一：评估前先为每个 skill 建/查同目录的 `test-prompts.json`；没有就先生成 2–3 条能验证该 skill 的测试提示词，再开始打分。",
						"硬要求二：keep/revert 只认 paired 多数决（同一 judge 成对比较 + 奇数 N 多数决）。绝对分实测有 ±8 噪音，只能用来排序，不能当判据。",
						"",
						`步骤：用 skill 工具加载 darwin-skill → 按 9 维 rubric 评分 → 分数低于 70 或命中 meta-skill 黑名单时写出改进稿 → **不要直接改写 SKILL.md**，用 skillmgr_darwin_submit {skill, content（改进后的完整正文）, summary} 提交 → 把结果追加到 ${cfg.resultsFile}（9 列 TSV：timestamp/commit/skill/old_score/new_score/status/dimension/note/eval_mode；status 填提交工具返回的结论 applied / proposed / discarded；timestamp 写本机时间、不带时区，格式 YYYY-MM-DDTHH:mm，现在是 ${localStamp(now)}）→ 一句话汇报分数与提交结论。`,
						"没有回写结果的下轮还会再提：只加载 darwin-skill 不算完成。",
						"本次为无人值守模式：跳过 human-in-the-loop 确认，但改写一律经 skillmgr_darwin_submit：插件先过评估门（不过门不落地），再按分级决定——最低风险档自动应用（带版本记录、应用后回归监测），其余进待批提案等所有者批准。体检期间对上面这些 SKILL.md 的直接写入会被拒绝。",
						"自激保护：加载 darwin-skill 后本提示自动关闭 15 分钟，期间的改写不再触发。",
					);
				} else {
					ctx.logger?.warn?.(
						`[dsh-studio] darwin: darwin-skill 本体未安装（查过 ${cfg.roots.join(" / ")}），${edited.length} 个 skill 无法体检`,
					);
					lines.push(
						"⚠️ darwin-skill 本体未安装：下列 skill 需要体检，但两棵 skill 树里都找不到 darwin-skill/SKILL.md，评估无法开始。",
						"安装：把 https://github.com/alchaincyf/darwin-skill 克隆到任一 skill 根下的 darwin-skill/ 目录。",
						...edited.map((f) => `- ${f}`),
						...(hints.length > 0 ? ["", "上游状态（只提示，不改基线）：", ...hints] : []),
					);
				}
			}
			if (stale.length > 0) {
				lines.push(
					`下列 skill 已超过 ${cfg.staleDays} 天没有体检记录，本期巡检顺手评估：`,
					...stale.map((f) => `- ${f}`),
					...(darwinReady ? [] : ["⚠️ darwin-skill 本体未安装，以上无法评估。"]),
				);
			}

			return {
				...out,
				sections: [...(out.sections ?? []), { name: "darwin", text: lines.join("\n") }],
			};
		} catch (err) {
			ctx.logger?.warn?.(`darwin: ${err?.message ?? err}`);
			return out;
		}
	});
}
