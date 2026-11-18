/**
 * 技能库治理：R6 相似技能合并提案 / G7 冲突检测 / G8 教训 / 展示未用报告 / G9 轮次报告。
 *
 * 红线（与 #3 同一套）：
 *   - **不自动合并、不自动改技能**：合并与教训补丁只出提案，所有者批准（skillmgr_governance_decide / 面板）后
 *     才按 #1 的版本机制写入；冲突与展示未用只报告。
 *   - 合并稿与补丁都先过红线：权限 / 安全段落（lib/skill-redlines.js）逐字保留，碰了直接拦下、不可批准。
 *   - 合并稿必须过 #3 的评估门：两个来源各自的评估集上，合并稿都不得低于来源（关键场景零回退）。
 *   - 自动轮次默认关、只在闲时跑、每轮上限很低；测试一律假模型。
 *
 * 数据：~/.dsh-studio/governance/（DSH_STUDIO_GOVERNANCE_DIR 可改）
 *   proposals/<id>.json   合并 / 教训补丁 / 撤回补丁提案      candidates/<sha>.md  提案正文（内容寻址）
 *   conflicts.json        冲突条目（open / ruled / dismissed / resolved）
 *   lessons.json          教训（带版本、计数、来源引用、撤回留痕）
 *   discards.jsonl        未过门 / 碰红线的合并稿与补丁（同 #3 丢弃口径）
 *   reports/<id>.json|md  每轮报告       state.json  调度状态       round.lock  轮次锁
 */
import { pruneEvolutionStore, readJsonDir } from "./store-retention.js";
import { appendFile, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { UserError } from "./errors.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { diffLines, formatDiff } from "./diff-lines.js";
import { governanceConfigFile, governanceRoot, readGovernanceConfigFile, resolveGovernanceConfig } from "./governance-config.js";
import { checkMergeRedlines, describeSkill, detectConflicts, discoverMergeCandidates, loadLibrary, pairKeyOf, usageFromEvents } from "./governance-scan.js";
import { classifyChange } from "./optimizer-classify.js";
import { inIdleWindow, optimizerRoot, resolveOptimizerConfig } from "./optimizer-config.js";
import { evalFile, gateVerdict, generateEvalSet, loadEvalSet, scoreSkill, sha256 } from "./optimizer-eval.js";
import { BudgetStop, callWithBudget, createBudget, extractTag } from "./optimizer-model.js";
import { optimizerSkillRoots } from "./optimizer.js";
import { normalizeNewlines } from "./skill-doc.js";
import { checkRedlines, describeRedlines, effectiveRedlines, protectedContent } from "./skill-redlines.js";
import { readTelemetryEvents } from "./telemetry.js";
import { trashSkill } from "./trash.js";
import { captureSkillBefore, listVersions, queryVersionRecords, recordSkillAfter, skillKeysByName } from "./versions.js";
import { currentWriteContext } from "./write-context.js";

export const GOVERNANCE_REPORT_SCHEMA = 1;
const DAY_MS = 86_400_000;
const LESSON_HEADING = "## 经验教训（治理整理，所有者批准后写入）";
const LESSON_MARK = /<!-- lesson:(lesson-[\w]+) v(\d+) x(\d+) -->/;
const KIND_LABEL = { precheck: "前置检查", counterexample: "反例", note: "注意" };
const CONFLICT_LABEL = { "duplicate-name": "同名多根", "trigger-overlap": "触发重叠", contradiction: "指令矛盾", "tool-conflict": "工具调用冲突" };

const p2 = (n) => String(n).padStart(2, "0");
const stamp = (at) => {
	const d = new Date(at);
	return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
};
const newId = (prefix, at) => `${prefix}-${stamp(at)}-${randomBytes(3).toString("hex")}`;
const clip = (s, n = 160) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? t.slice(0, n) + "…" : t;
};

const dirs = {
	proposals: () => join(governanceRoot(), "proposals"),
	candidates: () => join(governanceRoot(), "candidates"),
	reports: () => join(governanceRoot(), "reports"),
	conflicts: () => join(governanceRoot(), "conflicts.json"),
	lessons: () => join(governanceRoot(), "lessons.json"),
	discards: () => join(governanceRoot(), "discards.jsonl"),
	state: () => join(governanceRoot(), "state.json"),
	lock: () => join(governanceRoot(), "round.lock")
};

async function readJson(file, fallback) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return fallback;
	}
}
async function writeJson(file, value) {
	await mkdir(dirname(file), { recursive: true });
	await atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}
async function readJsonl(file) {
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch {
		return [];
	}
	const out = [];
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			/* 坏行跳过 */
		}
	}
	return out;
}
async function appendJsonl(file, value) {
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, JSON.stringify(value) + "\n", "utf8");
}
async function readText(file) {
	return normalizeNewlines(await readFile(file, "utf8"));
}
async function fileSha(file) {
	try {
		return sha256(await readText(file));
	} catch {
		return null;
	}
}
async function saveCandidate(text) {
	const sha = sha256(text);
	const file = join(dirs.candidates(), sha + ".md");
	try {
		await stat(file);
	} catch {
		await mkdir(dirs.candidates(), { recursive: true });
		await atomicWriteFile(file, text, "utf8");
	}
	return { sha, file };
}
const diffText = (a, b, max = 400) => {
	const lines = diffLines(a, b).filter((l) => l.type !== "eq");
	const head = formatDiff(lines.slice(0, max));
	return lines.length > max ? head + `\n… 另有 ${lines.length - max} 行改动` : head;
};
const rollbackHint = (key, versionId) => (versionId ? { tool: "skillmgr_rollback", target: key, versionId } : null);

/**
 * @param {{
 *   pluginConfig?: object, optimizerConfig?: object,
 *   model?: object | (() => object), logger?: object, now?: () => number,
 *   telemetryDir?: () => string, onSkillsChanged?: () => void
 * }} deps
 */
export function createGovernance(deps = {}) {
	const now = typeof deps.now === "function" ? deps.now : () => Date.now();
	const logger = deps.logger ?? null;
	const getModel = () => (typeof deps.model === "function" ? deps.model() : deps.model);
	let running = null;
	let lastActivityAt = now();
	let lastCheckAt = 0;
	let lastCheckEveryMs = 0;
	let incrementalTimer = null;
	const incrementalQueue = new Set();
	/** 测试可注入（数 loadLibrary 调用次数）；默认就是 governance-scan 的 loadLibrary。 */
	const readLibrary = typeof deps.loadLibrary === "function" ? deps.loadLibrary : loadLibrary;

	async function effective() {
		const file = await readGovernanceConfigFile();
		const { config, sources } = resolveGovernanceConfig(deps.pluginConfig, file.value);
		// 门与红线沿用 #3 的生效配置（同一个闸门、同一份红线清单；有优化回路实例时连它的 config.json 一起读）
		const optEff = deps.optimizer?.effective ? await deps.optimizer.effective() : { config: resolveOptimizerConfig(deps.optimizerConfig, null).config };
		const opt = optEff.config;
		const redlines = optEff.redlines ?? effectiveRedlines(opt.redlines);
		const roots = config.roots.length > 0 ? config.roots : optimizerSkillRoots(opt);
		return { config, sources, fileError: file.error, optimizer: opt, redlines, roots };
	}

	// ── 存储 ──
	async function loadConflicts() {
		return readJson(dirs.conflicts(), { v: 1, items: {} });
	}
	async function loadLessons() {
		return readJson(dirs.lessons(), { v: 1, items: {} });
	}
	// C5：提案目录按 stat 缓存解析结果（每次状态查询、每轮治理都要列一遍）
	const proposalCache = new Map();
	async function listProposals(filter = {}) {
		const out = [];
		for (const p of await readJsonDir(dirs.proposals(), proposalCache)) {
			if (!p) continue;
			if (filter.status && p.status !== filter.status) continue;
			if (filter.type && p.type !== filter.type) continue;
			out.push(p);
		}
		return out.reverse();
	}
	async function saveProposal(p) {
		await writeJson(join(dirs.proposals(), p.id + ".json"), p);
		return p;
	}
	async function recordDiscard(rec) {
		const full = { id: newId("gdisc", now()), at: new Date(now()).toISOString(), ...rec };
		await appendJsonl(dirs.discards(), full);
		return full;
	}

	async function telemetryEvents(weeks) {
		const to = now() + 1;
		try {
			return await readTelemetryEvents({ dir: typeof deps.telemetryDir === "function" ? deps.telemetryDir() : undefined, fromTs: to - weeks * 7 * DAY_MS, toTs: to });
		} catch {
			return [];
		}
	}

	// ── G7 冲突 ──
	/** 把一次检测结果并进冲突库。full=true 时，库里 open 但这次没再检出的标 resolved。 */
	/** comparedPairs：全量扫描被上限截断时，这一轮真正比过的对；只有比过的对才允许标 resolved（没比到 ≠ 冲突消失）。 */
	async function upsertConflicts(found, { full, roundId, comparedPairs = null }) {
		const store = await loadConflicts();
		const at = new Date(now()).toISOString();
		const seen = new Set();
		const fresh = [];
		for (const c of found) {
			seen.add(c.id);
			const old = store.items[c.id];
			if (!old) {
				store.items[c.id] = { ...c, status: "open", firstSeenAt: at, lastSeenAt: at, roundId: roundId ?? null };
				fresh.push(c.id);
			} else {
				store.items[c.id] = { ...old, ...c, status: old.status === "resolved" ? "open" : old.status, lastSeenAt: at };
				if (old.status === "resolved") fresh.push(c.id);
			}
		}
		const resolved = [];
		if (full) {
			for (const item of Object.values(store.items)) {
				if (item.status === "open" && !seen.has(item.id)) {
					if (comparedPairs !== null && !(Array.isArray(item.pair) && item.pair.length === 2 && comparedPairs.has(pairKeyOf(item.pair[0]?.key, item.pair[1]?.key)))) continue;
					item.status = "resolved";
					item.resolvedAt = at;
					resolved.push(item.id);
				}
			}
		}
		await writeJson(dirs.conflicts(), store);
		return { fresh, resolved, open: Object.values(store.items).filter((i) => i.status === "open").length };
	}

	/**
	 * 新增技能 / 新版本落地后的增量冲突检查（只读技能库，只写冲突库）。
	 * shared：批量队列复用同一份生效配置与技能库（审计 3：一批 N 个 key 只 loadLibrary 一次）。
	 */
	async function checkIncremental(key, shared) {
		const { config, roots } = shared?.eff ?? (await effective());
		if (config.incrementalConflicts !== true) return { ran: false, reason: "disabled" };
		const library = shared?.library ?? (await readLibrary(roots));
		if (!library.some((s) => s.key === key)) return { ran: false, reason: "not-in-library" };
		const found = detectConflicts(library, config.conflicts, { focus: key, exclude: config.exclude, maxPairs: config.limits.maxPairs });
		const r = await upsertConflicts(found, { full: false, roundId: "incremental" });
		if (r.fresh.length > 0) logger?.info?.(`[dsh-studio] 技能冲突增量检查：${key} 新增 ${r.fresh.length} 条冲突（skillmgr_governance_status 查看）`);
		return { ran: true, found: found.length, fresh: r.fresh };
	}

	/**
	 * 一批 key 的增量检查：生效配置与技能库各读一次，逐 key 复用；逐 key 结果与单独调 checkIncremental 一致
	 * （库在一批之内不变——增量检查只写冲突库，不写技能）。单个 key 失败不拖累其余。
	 */
	async function checkIncrementalBatch(keys) {
		const out = {};
		if (!Array.isArray(keys) || keys.length === 0) return out;
		const eff = await effective();
		if (eff.config.incrementalConflicts !== true) {
			for (const key of keys) out[key] = { ran: false, reason: "disabled" };
			return out;
		}
		const library = await readLibrary(eff.roots);
		for (const key of keys) {
			try {
				out[key] = await checkIncremental(key, { eff, library });
			} catch (error) {
				out[key] = { ran: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
				logger?.warn?.("[dsh-studio] 技能冲突增量检查失败：" + out[key].error);
			}
		}
		return out;
	}

	/** 版本监听入口：去抖 2 秒，批量检查。 */
	function noteSkillVersion(info) {
		if (!info || info.exists !== true || typeof info.key !== "string") return;
		if (info.action === "baseline") return;
		incrementalQueue.add(info.key);
		if (incrementalTimer !== null) return;
		incrementalTimer = setTimeout(async () => {
			incrementalTimer = null;
			const keys = [...incrementalQueue];
			incrementalQueue.clear();
			try {
				await checkIncrementalBatch(keys);
			} catch (error) {
				logger?.warn?.("[dsh-studio] 技能冲突增量检查失败：" + (error instanceof Error ? error.message : String(error)));
			}
		}, 2000);
		incrementalTimer.unref?.();
	}

	// ── R6 合并提案 ──
	function mergePrompt(keep, drop, protectedView) {
		return [
			`把下面两份功能相近的技能合并成一份。保留方是「${keep.name}」（沿用它的 name 与 frontmatter），来源是「${drop.name}」。`,
			"要求：两份技能的全部有效步骤、示例、注意事项都要保留（重复的去重）；触发描述要覆盖两者的使用场景；不要编造新能力。",
			"受保护内容（权限 / 安全 / 禁令）必须逐字保留、不得改写或新增：",
			...protectedView.map((x) => "  - " + x),
			"输出格式：<summary>一句话说明合并了什么</summary><skill>合并后的完整 SKILL.md</skill>",
			"",
			"<keep>",
			keep.text,
			"</keep>",
			"<source>",
			drop.text,
			"</source>"
		].join("\n");
	}

	/**
	 * 取这份技能的评估集（按名字存）。`accept` 判定已有的那份能不能给这份技能用；不能用时现生成一份，
	 * 文件没被占才落盘——同名的另一份技能已经占着就只在内存里用，不覆盖人家冻结的那份。
	 */
	async function ensureEvalSet(name, key, text, ctx, accept = () => true) {
		const existing = await loadEvalSet(name);
		if (existing && accept(existing)) return existing;
		return generateEvalSet({ model: ctx.model, budget: ctx.budget, name, key, baseline: text, count: ctx.optimizer.gate.casesPerSkill, maxOutputTokens: ctx.config.limits.maxOutputTokens, persist: !existing });
	}

	async function buildMergeProposal(cand, library, ctx) {
		const keep = library.find((s) => s.key === cand.keep.key);
		// ：来源可以是蒸馏草稿（不在库里，没有文件）：cand.drop = {draft:true, draftId, name, key:"draft:…", text, sha, provenance}
		const drop = cand.drop?.draft === true ? cand.drop : library.find((s) => s.key === cand.drop.key);
		const base = {
			type: "merge",
			roundId: ctx.roundId,
			candidateId: cand.id,
			score: cand.score,
			reasons: cand.reasons,
			evidence: cand.evidence,
			keep: { name: keep.name, key: keep.key, file: keep.file, sha: keep.sha },
			drop: drop.draft === true ? { name: drop.name, key: drop.key, file: null, sha: drop.sha, draft: true, draftId: drop.draftId, provenance: drop.provenance ?? null } : { name: drop.name, key: drop.key, file: drop.file, sha: drop.sha }
		};
		const pk = protectedContent(keep.text, ctx.redlines);
		const pd = protectedContent(drop.text, ctx.redlines);
		const protectedView = [...new Set([...Object.entries(pk.frontmatter).filter(([, v]) => v !== null).map(([k]) => "frontmatter 键 " + k + "（保留方原样）"), ...pk.sections.map((s) => s.split("\n")[0]), ...pd.sections.map((s) => s.split("\n")[0]), ...pk.lines, ...pd.lines])];
		const raw = await callWithBudget(ctx.model, ctx.budget, { purpose: "merge", system: "你是技能库维护者，负责把重复的技能合并成一份。", prompt: mergePrompt(keep, drop, protectedView), maxTokens: ctx.config.limits.maxOutputTokens, meta: { keep: keep.name, drop: drop.name, keepText: keep.text, dropText: drop.text } });
		const merged = normalizeNewlines(extractTag(raw, "skill") ?? "").trim() + "\n";
		const summary = clip(extractTag(raw, "summary") ?? "", 300);
		const at = new Date(now()).toISOString();
		const id = newId("gprop", now());
		if (merged.trim() === "" || !/^---\n/.test(merged)) {
			const d = await recordDiscard({ kind: "static", type: "merge", proposalId: id, candidateId: cand.id, reasons: ["模型没有给出带 frontmatter 的合并稿"] });
			return saveProposal({ id, status: "discarded", createdAt: at, ...base, summary, discardId: d.id, blockReasons: d.reasons });
		}
		const { sha, file } = await saveCandidate(merged);
		if (drop.draft === true) base.drop.textFile = (await saveCandidate(drop.text)).file;
		const diff = { keep: diffText(keep.text, merged), drop: diffText(drop.text, merged) };
		const red = checkMergeRedlines(keep.text, drop.text, merged, ctx.redlines);
		if (!red.ok) {
			const d = await recordDiscard({ kind: "redline", type: "merge", proposalId: id, candidateId: cand.id, candidateSha: sha, candidateFile: file, reasons: red.violations.map((v) => `${v.kind} ${v.change}：${v.what}`) });
			return saveProposal({ id, status: "blocked", createdAt: at, ...base, summary, candidateFile: file, candidateSha: sha, diff, redlines: red, discardId: d.id, blockReasons: d.reasons });
		}
		// 评估预演：走 #3 的门。两个来源各用自己的评估集；合并稿在两套上都不得低于来源。
		// · A3：评估集按名字存，同名的两份（两个根里各一份、或与库里同名的蒸馏草稿）会取到同一个文件，
		// 被并方的行为实际没被评过。同名时按集里记的 key 认主：属于对方的不拿来用，自己那份没有就现生成（不落盘）。
		const sameName = keep.name === drop.name;
		const setKeep = await ensureEvalSet(keep.name, keep.key, keep.text, ctx, (set) => !sameName || set.key !== drop.key);
		const setDrop = await ensureEvalSet(drop.name, drop.key, drop.text, ctx, (set) => !sameName || set.key === drop.key);
		const sk = await scoreSkill({ model: ctx.model, budget: ctx.budget, name: keep.name, text: keep.text, evalSet: setKeep, maxOutputTokens: ctx.config.limits.maxOutputTokens, label: "keep" });
		const sd = await scoreSkill({ model: ctx.model, budget: ctx.budget, name: drop.name, text: drop.text, evalSet: setDrop, maxOutputTokens: ctx.config.limits.maxOutputTokens, label: "drop" });
		const mk = await scoreSkill({ model: ctx.model, budget: ctx.budget, name: keep.name, text: merged, evalSet: setKeep, maxOutputTokens: ctx.config.limits.maxOutputTokens, label: "merged@keep" });
		const md = await scoreSkill({ model: ctx.model, budget: ctx.budget, name: drop.name, text: merged, evalSet: setDrop, maxOutputTokens: ctx.config.limits.maxOutputTokens, label: "merged@drop" });
		const vk = gateVerdict(sk, mk, ctx.optimizer.gate);
		const vd = gateVerdict(sd, md, ctx.optimizer.gate);
		const pass = vk.pass && vd.pass;
		const evalInfo = {
			at,
			roundId: ctx.roundId,
			verdict: pass ? "pass" : "fail",
			keep: { suite: setKeep.transient === true ? null : evalFile(keep.name), source: sk.mean, merged: mk.mean, cases: mk.cases, sourceCases: sk.cases, reasons: vk.reasons },
			drop: { suite: setDrop.transient === true ? null : evalFile(drop.name), source: sd.mean, merged: md.mean, cases: md.cases, sourceCases: sd.cases, reasons: vd.reasons },
			reasons: [...vk.reasons.map((r) => keep.name + "：" + r), ...vd.reasons.map((r) => drop.name + "：" + r)]
		};
		if (!pass) {
			const d = await recordDiscard({ kind: "gate", type: "merge", proposalId: id, candidateId: cand.id, candidateSha: sha, candidateFile: file, reasons: evalInfo.reasons, eval: { keep: [sk.mean, mk.mean], drop: [sd.mean, md.mean] } });
			return saveProposal({ id, status: "gate-failed", createdAt: at, ...base, summary, candidateFile: file, candidateSha: sha, diff, redlines: red, eval: evalInfo, discardId: d.id, blockReasons: evalInfo.reasons });
		}
		return saveProposal({ id, status: "pending", createdAt: at, ...base, summary, candidateFile: file, candidateSha: sha, diff, redlines: red, eval: evalInfo });
	}

	// ── G8 教训 ──
	async function harvestLessons(ctx, library) {
		const { config } = ctx;
		const byName = new Map(library.map((s) => [s.name, s]));
		const signals = [];
		// ① 遥测失败（按技能 + 错误类聚合；每条来源引用到具体事件）
		const events = await telemetryEvents(config.lessons.weeks);
		const fails = new Map();
		for (const ev of events) {
			if ((ev.type !== "skill.trigger" && ev.type !== "skill.inject") || ev.ok !== false || typeof ev.skill !== "string") continue;
			const err = typeof ev.err === "string" ? ev.err : "error";
			const k = ev.skill + "|" + err;
			if (!fails.has(k)) fails.set(k, { skill: ev.skill, err, refs: [] });
			fails.get(k).refs.push({ source: "telemetry", ref: `${ev.file}@${ev.ts}`, at: ev.ts, event: ev.type, sid: ev.sid ?? null, err });
		}
		for (const f of fails.values()) {
			if (f.refs.length < config.lessons.minTelemetryFailures) continue;
			signals.push({ skill: f.skill, kind: "precheck", signature: "telemetry:" + f.err, refs: f.refs, text: `执行前先确认依赖的工具 / 服务可用、输入齐全：最近 ${config.lessons.weeks} 周这份技能执行失败过（错误类 ${f.err}），失败时把错误类如实告诉用户。` });
		}
		// ② #3 丢弃 / 放行记录
		for (const d of await readJsonl(join(optimizerRoot(), "discards.jsonl"))) {
			if (!["gate", "redline", "static"].includes(d.kind) || typeof d.skill !== "string") continue;
			const first = String((d.reasons ?? [])[0] ?? "").replace(/\d+(\.\d+)?/g, "#");
			signals.push({
				skill: d.skill,
				kind: "counterexample",
				signature: `discard:${d.kind}:${first}`,
				refs: [{ source: "optimizer.discard", ref: d.id, at: d.at, kind: d.kind, reasons: d.reasons ?? [] }],
				text: d.kind === "gate" ? `一次改写候选被评估门挡下（${clip((d.reasons ?? []).join("；"), 120)}）：改这份技能时保住这些场景的行为。` : `一次改写候选因${d.kind === "redline" ? "碰了受保护内容" : "结构不完整"}被丢弃（${clip((d.reasons ?? []).join("；"), 120)}）：受保护段落与 frontmatter 保持原样。`
			});
		}
		for (const o of await readJsonl(join(optimizerRoot(), "overrides.jsonl"))) {
			if (typeof o.skill !== "string") continue;
			signals.push({ skill: o.skill, kind: "note", signature: "override", refs: [{ source: "optimizer.override", ref: o.discardId, at: o.at, reason: o.reason }], text: `评估门曾挡下这份技能的一次改写，所有者放行了（理由：「${clip(o.reason, 120)}」）：类似改动不必过度保守。` });
		}
		// ③ 所有者裁决过的冲突
		const conflicts = await loadConflicts();
		for (const c of Object.values(conflicts.items)) {
			if (c.status !== "ruled") continue;
			for (const [self, other] of [[c.pair[0], c.pair[1]], [c.pair[1], c.pair[0]]]) {
				signals.push({ skill: self.name, kind: "note", signature: "conflict:" + c.id, refs: [{ source: "conflict.ruling", ref: c.id, at: c.ruledAt, ruling: c.ruling }], text: `与「${other.name}」有${CONFLICT_LABEL[c.type] ?? c.type}（${clip(c.evidence?.[0]?.quote, 60)}），所有者裁决：「${clip(c.ruling, 120)}」。` });
			}
		}
		// 并进教训库：同一 (技能, 种类, 签名) 合并计数；来源按 ref 去重；频次 = 优先级
		const store = await loadLessons();
		const at = new Date(now()).toISOString();
		const touched = { created: [], merged: [] };
		for (const s of signals) {
			const id = "lesson-" + sha256(s.skill + "|" + s.kind + "|" + s.signature).slice(0, 10);
			const lib = byName.get(s.skill);
			const old = store.items[id];
			if (!old) {
				const refs = s.refs;
				store.items[id] = {
					id,
					skill: s.skill,
					key: lib?.key ?? null,
					file: lib?.file ?? null,
					kind: s.kind,
					signature: s.signature,
					text: s.text,
					sources: refs.slice(-config.lessons.maxCitations),
					seenRefs: refs.map((r) => r.ref),
					count: refs.length,
					priority: refs.length,
					version: 1,
					status: "active",
					createdAt: at,
					updatedAt: at,
					applied: null,
					history: [{ version: 1, at, change: "created", count: refs.length, sources: refs.length }]
				};
				touched.created.push(id);
				continue;
			}
			const known = new Set(old.seenRefs ?? old.sources.map((r) => r.ref));
			const added = s.refs.filter((r) => !known.has(r.ref));
			if (added.length === 0) continue;
			old.seenRefs = [...known, ...added.map((r) => r.ref)];
			old.sources = [...old.sources, ...added].slice(-config.lessons.maxCitations);
			old.count += added.length;
			old.priority = old.count;
			old.updatedAt = at;
			if (lib) Object.assign(old, { key: lib.key, file: lib.file });
			if (old.status === "active") {
				old.version += 1;
				old.text = s.text;
				old.history.push({ version: old.version, at, change: "merged", added: added.length, count: old.count });
				touched.merged.push(id);
			} else old.history.push({ version: old.version, at, change: "evidence-while-withdrawn", added: added.length, count: old.count });
		}
		await writeJson(dirs.lessons(), store);
		return { store, touched, signals: signals.length };
	}

	const lessonLine = (l) => `- [${KIND_LABEL[l.kind] ?? l.kind}] ${l.text}（出现 ${l.count} 次） <!-- lesson:${l.id} v${l.version} x${l.count} -->`;

	/** 在技能文本里插入 / 更新 / 删除一条教训行（只动「经验教训」段）。 */
	function patchLessonText(text, lesson, { remove = false } = {}) {
		const lines = text.replace(/\n+$/, "").split("\n");
		const idx = lines.findIndex((l) => LESSON_MARK.exec(l)?.[1] === lesson.id);
		if (remove) {
			if (idx < 0) return null;
			lines.splice(idx, 1);
			const h = lines.indexOf(LESSON_HEADING);
			if (h >= 0 && !lines.slice(h + 1).some((l) => LESSON_MARK.test(l))) {
				lines.splice(h, lines.length - h);
				while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			}
			return lines.join("\n") + "\n";
		}
		if (idx >= 0) {
			lines[idx] = lessonLine(lesson);
			return lines.join("\n") + "\n";
		}
		const h = lines.indexOf(LESSON_HEADING);
		if (h < 0) return [...lines, "", LESSON_HEADING, "", lessonLine(lesson)].join("\n") + "\n";
		let end = h + 1;
		while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
		lines.splice(end, 0, lessonLine(lesson));
		return lines.join("\n") + "\n";
	}

	async function buildLessonProposal(lesson, ctx, { withdraw = false, reason = "" } = {}) {
		const at = new Date(now()).toISOString();
		const id = newId("gprop", now());
		const type = withdraw ? "lesson-withdraw" : "lesson";
		if (!lesson.file) return null;
		let baseline;
		try {
			baseline = await readText(lesson.file);
		} catch {
			return null;
		}
		const candidate = patchLessonText(baseline, lesson, { remove: withdraw });
		if (candidate === null || candidate === baseline) return null;
		const { sha, file } = await saveCandidate(candidate);
		const base = { id, type, createdAt: at, roundId: ctx.roundId ?? null, lessonIds: [lesson.id], lessonVersion: lesson.version, skill: lesson.skill, key: lesson.key, target: lesson.file, baseSha: sha256(baseline), candidateFile: file, candidateSha: sha, priority: lesson.count, summary: withdraw ? `撤回教训 ${lesson.id}：${clip(lesson.text, 80)}${reason ? "（" + reason + "）" : ""}` : `[${KIND_LABEL[lesson.kind]}] ${clip(lesson.text, 120)}（${lesson.count} 次）`, sources: lesson.sources.slice(0, 5), diff: diffText(baseline, candidate) };
		const red = checkRedlines(baseline, candidate, ctx.redlines);
		if (!red.ok) {
			const d = await recordDiscard({ kind: "redline", type, proposalId: id, lessonIds: [lesson.id], reasons: red.violations.map((v) => `${v.kind} ${v.change}：${v.what}`) });
			return saveProposal({ ...base, status: "blocked", redlines: red, discardId: d.id, blockReasons: d.reasons });
		}
		const cls = classifyChange(baseline, candidate, ctx.optimizer, ctx.redlines);
		return saveProposal({ ...base, status: "pending", tier: cls.tier, kinds: cls.kinds, redlines: red });
	}

	// ── 展示未用 ──
	async function unusedReport(config, library) {
		const events = await telemetryEvents(config.unused.weeks);
		const servers = new Map();
		for (const ev of events) {
			if (ev.type !== "catalog.outcome") continue;
			const used = new Set(Array.isArray(ev.used) ? ev.used : []);
			for (const name of Array.isArray(ev.shown) ? ev.shown : []) {
				if (!servers.has(name)) servers.set(name, { server: name, shownTurns: 0, usedTurns: 0, unusedTurns: 0, sessions: new Map() });
				const row = servers.get(name);
				row.shownTurns += 1;
				if (used.has(name)) row.usedTurns += 1;
				else {
					row.unusedTurns += 1;
					const sid = typeof ev.sid === "string" ? ev.sid : "(无会话 id)";
					row.sessions.set(sid, (row.sessions.get(sid) ?? 0) + 1);
				}
			}
		}
		const mcp = [...servers.values()]
			.filter((r) => r.unusedTurns > 0)
			.map((r) => ({ server: r.server, shownTurns: r.shownTurns, usedTurns: r.usedTurns, unusedTurns: r.unusedTurns, unusedRate: Math.round((r.unusedTurns / r.shownTurns) * 1000) / 1000, scenarios: [...r.sessions].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([sid, turns]) => ({ sid, turns })) }))
			.sort((a, b) => b.unusedTurns - a.unusedTurns || a.server.localeCompare(b.server));
		const usage = usageFromEvents(events);
		const skills = library.filter((s) => !usage.uses.has(s.name)).map((s) => ({ skill: s.name, key: s.key, file: s.file }));
		return { weeks: config.unused.weeks, mcp, skills, note: "技能没有「展示」信号（技能目录每轮都在系统提示里），技能侧按「在库但窗口内一次都没触发 / 注入」列出；MCP 侧按目录候选看了没用（catalog.outcome）逐 server、逐会话列出。只报告。" };
	}

	// ── 轮次 ──
	async function acquireLock(maxMs) {
		await mkdir(governanceRoot(), { recursive: true });
		const file = dirs.lock();
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fh = await open(file, "wx");
				await fh.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
				await fh.close();
				return async () => rm(file, { force: true });
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
				const held = await readJson(file, null);
				if (held && now() - Number(held.at) < maxMs + 60_000) throw new UserError(`另一轮治理正在进行（pid ${held.pid}），本次不启动`, 409);
				await rm(file, { force: true });
			}
		}
		throw new UserError("拿不到治理的轮次锁", 409);
	}

	/**
	 * 跑一轮治理。
	 * @param {{trigger?: "manual"|"auto", only?: string[]}} [opts] only ⊂ conflicts / merge / lessons / unused
	 */
	async function runRound(opts = {}) {
		if (running !== null) throw new UserError("已有一轮治理在进行，本次不启动", 409);
		const trigger = opts.trigger === "auto" ? "auto" : "manual";
		const parts = new Set(Array.isArray(opts.only) && opts.only.length > 0 ? opts.only : ["conflicts", "merge", "lessons", "unused"]);
		const eff = await effective();
		const release = await acquireLock(eff.config.limits.maxDurationMs);
		const roundId = newId("gov", now());
		const report = { v: GOVERNANCE_REPORT_SCHEMA, roundId, trigger, parts: [...parts], startedAt: new Date(now()).toISOString(), status: "completed", counts: { skills: 0, conflictsFound: 0, conflictsNew: 0, conflictsResolved: 0, conflictsOpen: 0, mergeCandidates: 0, mergeProposals: 0, mergeBlocked: 0, lessonsCreated: 0, lessonsMerged: 0, lessonProposals: 0, unusedMcp: 0, unusedSkills: 0 }, conflicts: [], merges: [], lessons: [], unused: null, budget: null };
		running = (async () => {
			const budget = createBudget(eff.config.limits, now);
			const ctx = { ...eff, roundId, budget, model: null };
			try {
				const library = await loadLibrary(eff.roots);
				report.counts.skills = library.length;
				if (parts.has("conflicts")) {
					// 库大到超过 maxPairs 时每轮只比一个窗口，游标记在 state 里逐轮往前推（见 pairsOf）
					const cursors = await readJson(dirs.state(), {});
					const stats = {};
					const found = detectConflicts(library, eff.config.conflicts, { exclude: eff.config.exclude, maxPairs: eff.config.limits.maxPairs, offset: Number(cursors.conflictCursor) || 0, stats });
					const r = await upsertConflicts(found, { full: true, roundId, comparedPairs: stats.truncated ? stats.pairKeys : null });
					report.coverage = { ...(report.coverage ?? {}), conflicts: { total: stats.total, compared: stats.compared, truncated: stats.truncated === true } };
					await writeJson(dirs.state(), { ...(await readJson(dirs.state(), {})), conflictCursor: stats.truncated ? ((Number(cursors.conflictCursor) || 0) + stats.compared) % stats.total : 0 });
					Object.assign(report.counts, { conflictsFound: found.length, conflictsNew: r.fresh.length, conflictsResolved: r.resolved.length, conflictsOpen: r.open });
					report.conflicts = found.map((c) => ({ id: c.id, type: c.type, pair: c.pair.map((p) => p.name), new: r.fresh.includes(c.id) }));
				}
				if (parts.has("merge")) {
					const events = await telemetryEvents(eff.config.merge.weeks);
					const mergeCursors = await readJson(dirs.state(), {});
					const mergeStats = {};
					const cands = discoverMergeCandidates(library, usageFromEvents(events), eff.config.merge, { exclude: eff.config.exclude, maxPairs: eff.config.limits.maxPairs, offset: Number(mergeCursors.mergeCursor) || 0, stats: mergeStats });
					report.coverage = { ...(report.coverage ?? {}), merge: { total: mergeStats.total, compared: mergeStats.compared, truncated: mergeStats.truncated === true } };
					await writeJson(dirs.state(), { ...(await readJson(dirs.state(), {})), mergeCursor: mergeStats.truncated ? ((Number(mergeCursors.mergeCursor) || 0) + mergeStats.compared) % mergeStats.total : 0 });
					report.counts.mergeCandidates = cands.length;
					const existing = await listProposals({ type: "merge" });
					const fresh = cands.filter((c) => !existing.some((p) => p.candidateId === c.id && (p.status === "pending" || (p.keep?.sha === library.find((s) => s.key === c.keep.key)?.sha && p.drop?.sha === library.find((s) => s.key === c.drop.key)?.sha))));
					for (const c of cands) if (!fresh.includes(c)) report.merges.push({ candidateId: c.id, keep: c.keep.name, drop: c.drop.name, score: c.score, outcome: "skipped", note: "同一对、同一内容已经出过提案（待批 / 已处理）" });
					for (const c of fresh.slice(0, eff.config.limits.maxMergeProposals)) {
						if (ctx.model === null) {
							ctx.model = getModel();
							if (!ctx.model) throw new Error("没有可用的模型（宿主 ctx.llm 不可用），出不了合并稿");
						}
						const entry = { candidateId: c.id, keep: c.keep.name, drop: c.drop.name, score: c.score, reasons: c.reasons, outcome: "running" };
						report.merges.push(entry);
						const p = await buildMergeProposal(c, library, ctx);
						Object.assign(entry, { outcome: p.status, proposalId: p.id, eval: p.eval ? { verdict: p.eval.verdict, keep: [p.eval.keep.source, p.eval.keep.merged], drop: [p.eval.drop.source, p.eval.drop.merged] } : null, blockReasons: p.blockReasons ?? [] });
						if (p.status === "pending") report.counts.mergeProposals += 1;
						else report.counts.mergeBlocked += 1;
					}
					for (const c of fresh.slice(eff.config.limits.maxMergeProposals)) report.merges.push({ candidateId: c.id, keep: c.keep.name, drop: c.drop.name, score: c.score, outcome: "deferred", note: `超过每轮上限 ${eff.config.limits.maxMergeProposals} 份，留到下一轮` });
				}
				if (parts.has("lessons")) {
					const h = await harvestLessons(ctx, library);
					report.counts.lessonsCreated = h.touched.created.length;
					report.counts.lessonsMerged = h.touched.merged.length;
					const pendingIds = new Set((await listProposals({ status: "pending" })).flatMap((p) => p.lessonIds ?? []));
					const pendingKeys = new Set((await listProposals({ status: "pending" })).map((p) => p.key ?? p.keep?.key));
					const ready = Object.values(h.store.items)
						.filter((l) => l.status === "active" && l.file && !pendingIds.has(l.id) && !pendingKeys.has(l.key) && (l.applied === null || l.applied.version < l.version))
						.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
					const proposedKeys = new Set();
					for (const l of ready) {
						if (report.counts.lessonProposals >= eff.config.limits.maxLessonProposals) break;
						if (proposedKeys.has(l.key)) continue;
						const p = await buildLessonProposal(l, ctx);
						if (!p) continue;
						proposedKeys.add(l.key);
						report.lessons.push({ lessonId: l.id, skill: l.skill, count: l.count, version: l.version, proposalId: p.id, outcome: p.status, blockReasons: p.blockReasons ?? [] });
						if (p.status === "pending") report.counts.lessonProposals += 1;
						const store = await loadLessons();
						if (store.items[l.id]) {
							store.items[l.id].proposalId = p.id;
							await writeJson(dirs.lessons(), store);
						}
					}
				}
				if (parts.has("unused")) {
					report.unused = await unusedReport(eff.config, library);
					report.counts.unusedMcp = report.unused.mcp.length;
					report.counts.unusedSkills = report.unused.skills.length;
				}
				const produced = report.counts.conflictsFound + report.counts.mergeCandidates + report.counts.lessonsCreated + report.counts.lessonsMerged + report.counts.lessonProposals;
				if (produced === 0) report.status = "no-candidates";
			} catch (error) {
				if (error instanceof BudgetStop) {
					report.status = "budget-stop";
					report.stop = { limit: error.limit, detail: error.detail };
					for (const m of report.merges) if (m.outcome === "running") m.outcome = "stopped";
				} else {
					report.status = "error";
					report.stop = { limit: "error", detail: error instanceof Error ? error.message : String(error) };
					for (const m of report.merges) if (m.outcome === "running") m.outcome = "stopped";
				}
			} finally {
				report.budget = budget.snapshot();
				report.finishedAt = new Date(now()).toISOString();
				// · A6：报告写失败也必须放锁（旧写法写报告一抛，轮次锁要等 maxDurationMs + 60s 才过期）
				try {
					report.markdown = renderReport(report);
					await writeJson(join(dirs.reports(), roundId + ".json"), report);
					await atomicWriteFile(join(dirs.reports(), roundId + ".md"), report.markdown + "\n", "utf8");
					await writeJson(dirs.state(), { ...(await readJson(dirs.state(), {})), lastRoundAt: now(), lastRoundId: roundId, lastStatus: report.status });
					// C5：每轮收尾做一次保留（只增不减的工作目录），失败只记一笔
					await pruneEvolutionStore({ proposalsDir: dirs.proposals(), candidatesDir: dirs.candidates(), reportsDir: dirs.reports(), discardsFile: dirs.discards(), now: now() }).catch((error) => logger?.warn?.("[dsh-studio] 治理工作目录保留失败：" + (error instanceof Error ? error.message : String(error))));
				} finally {
					await release();
				}
			}
			return report;
		})();
		try {
			return await running;
		} finally {
			running = null;
		}
	}

	async function tick() {
		const t = now();
		// 审计 10：节流判断提到读配置之前（用上次读到的 checkEveryMinutes；首次为 0 不节流），
		// 每分钟的定时器不再每次都读一遍配置文件；读到新配置后按新值再判一次，口径不变
		if (t - lastCheckAt < lastCheckEveryMs) return { ran: false, reason: "throttled" };
		const { config } = await effective();
		lastCheckEveryMs = config.checkEveryMinutes * 60_000;
		if (t - lastCheckAt < lastCheckEveryMs) return { ran: false, reason: "throttled" };
		lastCheckAt = t;
		if (config.enabled !== true) return { ran: false, reason: "disabled" };
		if (!inIdleWindow(config.idleWindow, t)) return { ran: false, reason: "outside-window" };
		if (t - lastActivityAt < config.idleMinutes * 60_000) return { ran: false, reason: "busy" };
		const state = await readJson(dirs.state(), {});
		if (t - Number(state.lastRoundAt || 0) < config.minIntervalHours * 3_600_000) return { ran: false, reason: "too-soon" };
		if (running !== null) return { ran: false, reason: "running" };
		const report = await runRound({ trigger: "auto" });
		return { ran: true, reason: "ok", roundId: report.roundId, status: report.status };
	}

	// ── 所有者决定 ──
	/** 写入 + 版本记录缺一不可（同 optimizer.applyVersioned）：写前状态拿不到不写，写后没出记录就还原再报错。 */
	async function applyVersioned({ file, content, action, reason, meta }) {
		const before = await captureSkillBefore(file);
		if (before === null) throw new Error("写前状态没取到（版本史暂不可用），未改动文件");
		const previous = await readFile(file, "utf8").catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
		await atomicWriteFile(file, content, "utf8");
		const written = await recordSkillAfter(file, before, { action, reason, ...meta });
		if (!written.some((r) => typeof r?.id === "string")) {
			if (previous === null) await rm(file, { force: true });
			else await atomicWriteFile(file, previous, "utf8");
			throw new Error("版本记录没写成，已把文件还原成改动前的内容");
		}
		try {
			deps.onSkillsChanged?.();
		} catch {
			/* ignore */
		}
		const rec = written.find((r) => r.action === action) ?? written.at(-1) ?? null;
		return { versionId: rec?.id ?? null, rollbackTo: rec?.parent ?? null, key: rec?.key ?? null };
	}

	const draftListeners = new Set();
	/** ：草稿作来源的合并提案被批准 / 拒绝时通知蒸馏模块。 */
	function onDraftDecision(fn) {
		draftListeners.add(fn);
		return () => draftListeners.delete(fn);
	}
	async function notifyDraft(proposal) {
		for (const fn of draftListeners) {
			try {
				await fn(proposal);
			} catch (error) {
				logger?.warn?.("[dsh-studio] 草稿合并回调失败：" + (error instanceof Error ? error.message : String(error)));
			}
		}
	}

	/**
	 * ：给一份蒸馏草稿出合并提案（并入库里最像的那份）。走与 R6 相同的合并稿 / 红线 / 评估门预演，
	 * 只出提案，批准与否归所有者。预算与模型由调用方给（蒸馏批次自己的 G9 上限）。
	 */
	async function proposeDraftMerge({ draft, keepKey, score, reasons, evidence }, { budget, model, roundId }) {
		const eff = await effective();
		const library = await loadLibrary(eff.roots);
		const keep = library.find((s) => s.key === keepKey);
		if (!keep) throw new UserError("合并目标不在技能库里：" + keepKey, 404);
		const cand = { id: "draft-merge-" + sha256(keep.key + "|" + draft.draftId).slice(0, 12), score, reasons: reasons ?? [], evidence: evidence ?? [], keep: { name: keep.name, key: keep.key }, drop: { ...draft, draft: true } };
		return buildMergeProposal(cand, library, { ...eff, roundId: roundId ?? null, budget, model });
	}

	async function approveMerge(p, note, actor) {
		const { redlines } = await effective();
		const dropIsDraft = p.drop.draft === true;
		const dropSha = dropIsDraft ? (p.drop.textFile ? await fileSha(p.drop.textFile) : null) : await fileSha(p.drop.file);
		if ((await fileSha(p.keep.file)) !== p.keep.sha || dropSha !== p.drop.sha) {
			const next = { ...p, status: "stale", decidedAt: new Date(now()).toISOString(), decidedBy: actor, reason: "提案生成后来源技能被改动过，提案作废；请重跑一轮" };
			await saveProposal(next);
			throw new UserError(next.reason, 409);
		}
		const merged = await readText(p.candidateFile);
		if (sha256(merged) !== p.candidateSha) throw new UserError("合并稿校验不一致（文件被改过），不应用");
		const keepText = await readText(p.keep.file);
		const dropText = await readText(dropIsDraft ? p.drop.textFile : p.drop.file);
		const red = checkMergeRedlines(keepText, dropText, merged, redlines);
		if (!red.ok) throw new UserError("合并稿触碰红线，不应用：" + red.violations.map((v) => v.what).join("、"), 403);
		const at = new Date(now()).toISOString();
		const written = await applyVersioned({
			file: p.keep.file,
			content: merged,
			action: "governance-merge",
			reason: `所有者批准合并提案 ${p.id}：把「${p.drop.name}」并入「${p.keep.name}」${note ? "；" + note : ""}`,
			meta: {
				eval: { verdict: "pass", at: p.eval?.at, roundId: p.roundId, proposalId: p.id, approvedAt: at, keep: { suite: p.eval?.keep?.suite, before: p.eval?.keep?.source, after: p.eval?.keep?.merged }, drop: { suite: p.eval?.drop?.suite, before: p.eval?.drop?.source, after: p.eval?.drop?.merged } },
				merge: { role: "result", proposalId: p.id, sources: [{ name: p.keep.name, key: p.keep.key, sha: p.keep.sha, role: "keep" }, dropIsDraft ? { name: p.drop.name, key: p.drop.key, sha: p.drop.sha, role: "draft", draftId: p.drop.draftId, provenance: p.drop.provenance ?? null } : { name: p.drop.name, key: p.drop.key, sha: p.drop.sha, file: p.drop.file, role: "source" }] }
			}
		});
		let trash = null;
		let archiveVersionId = null;
		let partial = null;
		if (dropIsDraft) {
			// 草稿没有文件，不进回收站：通知蒸馏模块把草稿标成「已并入」（草稿记录本身保留，可查去向）
			const next = { ...p, status: "approved", decidedAt: at, decidedBy: actor, reason: note, versionId: written.versionId, rollback: rollbackHint(p.keep.key, written.rollbackTo) };
			await saveProposal(next);
			await notifyDraft(next);
			return next;
		}
		try {
			// 目录技能：dir = 技能目录（整目录入站）；根上的单文件技能：dir = 根，path = 文件（只搬这个文件）
			trash = await trashSkill(
				{ name: p.drop.name, dir: dirname(p.drop.file), path: p.drop.file },
				{ meta: { action: "merge-archive", reason: `已合并进「${p.keep.name}」（提案 ${p.id}，新版本 ${written.versionId}）`, merge: { role: "source", proposalId: p.id, into: { name: p.keep.name, key: p.keep.key, versionId: written.versionId } } } }
			);
			archiveVersionId = (await listVersions({ key: p.drop.key, limit: 1 })).records[0]?.id ?? null;
		} catch (error) {
			partial = "合并结果已写入，但来源移入回收站失败：" + (error instanceof Error ? error.message : String(error));
		}
		try {
			deps.onSkillsChanged?.();
		} catch {
			/* ignore */
		}
		const next = { ...p, status: partial ? "applied-partial" : "approved", decidedAt: at, decidedBy: actor, reason: note, versionId: written.versionId, archiveVersionId, trashId: trash?.id ?? null, error: partial ?? undefined, rollback: rollbackHint(p.keep.key, written.rollbackTo), restore: trash ? { tool: "skillmgr_restore", id: trash.id, name: p.drop.name } : null };
		await saveProposal(next);
		return next;
	}

	async function approvePatch(p, note, actor) {
		const { redlines } = await effective();
		if ((await fileSha(p.target)) !== p.baseSha) {
			const next = { ...p, status: "stale", decidedAt: new Date(now()).toISOString(), decidedBy: actor, reason: "技能文件在提案生成后被改动过，提案作废；请重跑一轮" };
			await saveProposal(next);
			throw new UserError(next.reason, 409);
		}
		const content = await readText(p.candidateFile);
		if (sha256(content) !== p.candidateSha) throw new UserError("补丁正文校验不一致（文件被改过），不应用");
		const red = checkRedlines(await readText(p.target), content, redlines);
		if (!red.ok) throw new UserError("补丁触碰红线，不应用", 403);
		const store = await loadLessons();
		const lessons = (p.lessonIds ?? []).map((id) => store.items[id]).filter(Boolean);
		const written = await applyVersioned({
			file: p.target,
			content,
			action: p.type === "lesson-withdraw" ? "lesson-withdraw" : "lesson-patch",
			reason: `所有者批准${p.type === "lesson-withdraw" ? "撤回教训" : "教训补丁"} ${p.id}：${p.summary}${note ? "；" + note : ""}`,
			meta: { lesson: { proposalId: p.id, ids: p.lessonIds, versions: lessons.map((l) => ({ id: l.id, version: l.version, count: l.count, sources: l.sources.map((s) => s.source + ":" + s.ref).slice(0, 10) })) } }
		});
		const at = new Date(now()).toISOString();
		for (const l of lessons) {
			if (p.type === "lesson-withdraw") {
				l.applied = null;
				l.history.push({ version: l.version, at, change: "withdraw-applied", versionId: written.versionId, proposalId: p.id });
			} else {
				l.applied = { version: l.version, versionId: written.versionId, proposalId: p.id, at };
				l.history.push({ version: l.version, at, change: "applied", versionId: written.versionId, proposalId: p.id });
			}
			delete l.proposalId;
		}
		await writeJson(dirs.lessons(), store);
		const next = { ...p, status: "approved", decidedAt: at, decidedBy: actor, reason: note, versionId: written.versionId, rollback: rollbackHint(p.key, written.rollbackTo) };
		await saveProposal(next);
		return next;
	}

	/**
	 * 所有者的决定：
	 *   提案 gprop-… ：approve / reject
	 *   冲突 conf-…  ：rule（写裁决，进入教训来源）/ dismiss（误报）
	 *   教训 lesson-…：withdraw（撤回；已写入技能的会出一份撤回补丁提案）
	 */
	async function decide({ id, decision, reason } = {}) {
		const target = String(id ?? "").trim();
		const note = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
		const actor = currentWriteContext().actor ?? "unknown";
		const at = new Date(now()).toISOString();
		if (/^gprop-[\w-]+$/.test(target)) {
			const p = await readJson(join(dirs.proposals(), target + ".json"), null);
			if (!p) throw new UserError("找不到提案 " + target, 404);
			if (p.status !== "pending") throw new UserError(`提案 ${p.id} 是 ${p.status}，不能再处理${p.blockReasons?.length ? "（" + p.blockReasons.join("；") + "）" : ""}`);
			if (decision === "reject") {
				const next = { ...p, status: "rejected", decidedAt: at, decidedBy: actor, reason: note };
				await saveProposal(next);
				if (p.lessonIds) {
					const store = await loadLessons();
					for (const lid of p.lessonIds) if (store.items[lid]) {
						delete store.items[lid].proposalId;
						store.items[lid].history.push({ version: store.items[lid].version, at, change: "proposal-rejected", proposalId: p.id, reason: note });
					}
					await writeJson(dirs.lessons(), store);
				}
				if (p.drop?.draft === true) await notifyDraft(next);
				return { ok: true, kind: "proposal", proposal: next };
			}
			if (decision !== "approve") throw new UserError("提案的 decision 只能是 approve 或 reject");
			const next = p.type === "merge" ? await approveMerge(p, note, actor) : await approvePatch(p, note, actor);
			return { ok: true, kind: "proposal", proposal: next };
		}
		if (/^conf-[\w]+$/.test(target)) {
			const store = await loadConflicts();
			const c = store.items[target];
			if (!c) throw new UserError("找不到冲突 " + target, 404);
			if (decision === "rule") {
				if (note === "") throw new UserError("裁决必须写明以哪份为准 / 怎么处理（reason）");
				Object.assign(c, { status: "ruled", ruling: note, ruledAt: at, ruledBy: actor });
			} else if (decision === "dismiss") Object.assign(c, { status: "dismissed", ruling: note, ruledAt: at, ruledBy: actor });
			else throw new UserError("冲突的 decision 只能是 rule 或 dismiss");
			await writeJson(dirs.conflicts(), store);
			return { ok: true, kind: "conflict", conflict: c };
		}
		if (/^lesson-[\w]+$/.test(target)) {
			if (decision !== "withdraw") throw new UserError("教训的 decision 只能是 withdraw");
			if (note === "") throw new UserError("撤回教训要写理由（reason），会留痕");
			const store = await loadLessons();
			const l = store.items[target];
			if (!l) throw new UserError("找不到教训 " + target, 404);
			if (l.status === "withdrawn") throw new UserError("这条教训已撤回");
			l.status = "withdrawn";
			l.withdrawnAt = at;
			l.withdrawnBy = actor;
			l.withdrawReason = note;
			l.history.push({ version: l.version, at, change: "withdrawn", reason: note, actor });
			await writeJson(dirs.lessons(), store);
			let proposal = null;
			if (l.applied) {
				const eff = await effective();
				proposal = await buildLessonProposal(l, { ...eff, roundId: null }, { withdraw: true, reason: note });
			}
			return { ok: true, kind: "lesson", lesson: l, proposal };
		}
		throw new UserError("id 不认识：提案 gprop-… / 冲突 conf-… / 教训 lesson-…");
	}

	/** 合并溯源：这个技能作为合并结果 / 被合并来源的全部记录。 */
	async function lineage(nameOrKey) {
		const q = String(nameOrKey ?? "").trim();
		if (q === "") return [];
		// B1：只读带合并溯源的那几条，不再整份读版本日志
		const keys = new Set(q.startsWith("skill:") ? [q] : await skillKeysByName(q));
		const { records } = await queryVersionRecords((e) => e.merge);
		return records
			.filter((r) => r.merge && (keys.has(r.key) || (r.merge.sources ?? []).some((s) => keys.has(s.key)) || keys.has(r.merge.into?.key)))
			.map((r) => ({ id: r.id, at: r.at, key: r.key, name: r.name, action: r.action, role: r.merge.role, proposalId: r.merge.proposalId, into: r.merge.into ?? null, sources: r.merge.sources ?? null, parent: r.parent }))
			.reverse();
	}

	async function listReports(limit = 5) {
		let names = [];
		try {
			names = await readdir(dirs.reports());
		} catch {
			return [];
		}
		const out = [];
		for (const n of names.filter((x) => x.endsWith(".json")).sort().reverse().slice(0, limit)) {
			const r = await readJson(join(dirs.reports(), n), null);
			if (r) out.push({ roundId: r.roundId, trigger: r.trigger, status: r.status, startedAt: r.startedAt, counts: r.counts, stop: r.stop ?? null });
		}
		return out;
	}

	async function getReport(id) {
		const rid = String(id ?? "").trim();
		if (rid === "") {
			const latest = (await listReports(1))[0];
			if (!latest) throw new UserError("还没有任何治理报告", 404);
			return getReport(latest.roundId);
		}
		if (!/^gov-[\w-]+$/.test(rid)) throw new UserError("报告 id 不合法：" + rid);
		const report = await readJson(join(dirs.reports(), rid + ".json"), null);
		if (!report) throw new UserError("找不到报告 " + rid, 404);
		return { report, markdown: report.markdown ?? "" };
	}

	async function status({ skill } = {}) {
		const eff = await effective();
		const state = await readJson(dirs.state(), {});
		const conflicts = Object.values((await loadConflicts()).items);
		const lessons = Object.values((await loadLessons()).items).sort((a, b) => b.priority - a.priority);
		return {
			ok: true,
			dir: governanceRoot(),
			configFile: governanceConfigFile(),
			configSources: eff.sources,
			configError: eff.fileError,
			config: eff.config,
			roots: eff.roots,
			redlines: describeRedlines(eff.redlines),
			schedule: { inWindowNow: inIdleWindow(eff.config.idleWindow, now()), lastRoundAt: state.lastRoundAt ? new Date(state.lastRoundAt).toISOString() : null, lastRoundId: state.lastRoundId ?? null, lastStatus: state.lastStatus ?? null, running: running !== null },
			conflicts: conflicts.filter((c) => c.status === "open").map((c) => ({ id: c.id, type: c.type, pair: c.pair.map((p) => p.name), evidence: c.evidence, suggestion: c.suggestion, firstSeenAt: c.firstSeenAt })),
			conflictCounts: conflicts.reduce((m, c) => ((m[c.status] = (m[c.status] ?? 0) + 1), m), {}),
			proposals: (await listProposals({ status: "pending" })).map((p) => ({ id: p.id, type: p.type, summary: p.summary, skill: p.skill ?? p.keep?.name, drop: p.drop?.name, score: p.score, priority: p.priority, eval: p.eval ? { keep: [p.eval.keep.source, p.eval.keep.merged], drop: [p.eval.drop.source, p.eval.drop.merged] } : undefined, tier: p.tier, createdAt: p.createdAt })),
			lessons: lessons.slice(0, 20).map((l) => ({ id: l.id, skill: l.skill, kind: l.kind, text: l.text, count: l.count, version: l.version, status: l.status, applied: l.applied, sources: l.sources.slice(0, 3) })),
			reports: await listReports(5),
			...(skill ? { lineage: await lineage(skill) } : {})
		};
	}

	return { effective, runRound, tick, status, decide, getReport, lineage, checkIncremental, checkIncrementalBatch, noteSkillVersion, noteActivity: () => (lastActivityAt = now()), listProposals, buildMergeProposalFor: buildMergeProposal, proposeDraftMerge, onDraftDecision };
}

export function renderReport(r) {
	const c = r.counts;
	const lines = [
		`# 技能库治理报告 ${r.roundId}`,
		"",
		`- 触发：${r.trigger === "auto" ? "闲时自动" : "手动"}；范围：${r.parts.join(" / ")}；状态：**${r.status}**${r.stop ? `（${r.stop.limit}：${r.stop.detail}）` : ""}`,
		`- 技能 ${c.skills} 个；冲突 检出 ${c.conflictsFound}（新 ${c.conflictsNew}，已消失 ${c.conflictsResolved}，待处理 ${c.conflictsOpen}）`,
		...["conflicts", "merge"]
			.filter((k) => r.coverage?.[k]?.truncated === true)
			.map((k) => `- 覆盖：${k === "conflicts" ? "冲突扫描" : "合并发现"}本轮只比了 ${r.coverage[k].compared} / ${r.coverage[k].total} 对（上限 limits.maxPairs），其余的后续轮次接着比；没比到的冲突不会被标成已消失`),
		`- 合并候选 ${c.mergeCandidates}；合并提案 ${c.mergeProposals}（拦下 ${c.mergeBlocked}）`,
		`- 教训 新 ${c.lessonsCreated} / 合并计数 ${c.lessonsMerged}；补丁提案 ${c.lessonProposals}`,
		`- 展示未用：MCP ${c.unusedMcp} 个、在库未触发技能 ${c.unusedSkills} 个`,
		r.budget ? `- 花费：模型 ${r.budget.calls}/${r.budget.limits.maxModelCalls} 次 · ${r.budget.tokens}/${r.budget.limits.maxTokens} token · ${r.budget.ms} ms` : ""
	].filter(Boolean);
	if (r.status === "no-candidates") lines.push("", "本轮没有冲突、合并候选或教训来源：什么都没产出。");
	if (r.conflicts.length > 0) {
		lines.push("", "## 冲突（只报告）");
		for (const x of r.conflicts) lines.push(`- ${x.id} · ${CONFLICT_LABEL[x.type] ?? x.type} · ${x.pair.join(" ↔ ")}${x.new ? " · 新" : ""}`);
	}
	if (r.merges.length > 0) {
		lines.push("", "## 合并");
		for (const m of r.merges) lines.push(`- ${m.keep} ← ${m.drop}（分 ${m.score}）：${m.outcome}${m.proposalId ? " · 提案 " + m.proposalId : ""}${m.eval ? ` · 预演 ${m.keep} ${m.eval.keep[0]}→${m.eval.keep[1]}，${m.drop} ${m.eval.drop[0]}→${m.eval.drop[1]}` : ""}${m.blockReasons?.length ? " · " + m.blockReasons.join("；") : ""}${m.note ? " · " + m.note : ""}`);
	}
	if (r.lessons.length > 0) {
		lines.push("", "## 教训补丁提案");
		for (const l of r.lessons) lines.push(`- ${l.skill} · ${l.lessonId} v${l.version} ×${l.count}：${l.outcome}${l.proposalId ? " · " + l.proposalId : ""}${l.blockReasons?.length ? " · " + l.blockReasons.join("；") : ""}`);
	}
	if (r.unused && (r.unused.mcp.length > 0 || r.unused.skills.length > 0)) {
		lines.push("", `## 展示未用（最近 ${r.unused.weeks} 周，只报告）`);
		for (const m of r.unused.mcp.slice(0, 10)) lines.push(`- MCP ${m.server}：看了 ${m.shownTurns} 轮、没用 ${m.unusedTurns} 轮（${Math.round(m.unusedRate * 100)}%）；场景：${m.scenarios.map((s) => s.sid + "×" + s.turns).join("、")}`);
		if (r.unused.skills.length > 0) lines.push(`- 在库未触发技能：${r.unused.skills.slice(0, 20).map((s) => s.skill).join("、")}${r.unused.skills.length > 20 ? " …" : ""}`);
	}
	lines.push("", "所有写入都要所有者批准：skillmgr_governance_decide {id, decision}。");
	return lines.join("\n");
}

export { describeSkill };
