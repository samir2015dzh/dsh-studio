/**
 * 技能自动优化回路（：R5 + G1 评估门 + G3 自治分级 + G9 节奏 / 成本 / 报告）。
 *
 * 一轮 = 挑候选（遥测）→ 每个候选做达尔文式迭代（变异 → 评估 → 留最优）→ 过 G1 硬门
 *        → 按 G3 分级：低风险自动应用 / 结构性只出提案 → 写变更报告。
 *
 * 写入一律走的版本化（versions.js：captureSkillBefore + recordSkillAfter），
 * 版本记录的 eval 字段带上评估结果；回滚用既有 skillmgr_rollback。
 * 优化回路自己的数据（评估集 / 候选正文 / 提案 / 丢弃记录 / 放行记录 / 报告）放在
 * `~/.dsh-studio/optimizer/`，与版本史一样在 `.dsh` 之外。
 *
 * 安全：红线（lib/skill-redlines.js）先于评估检查，违反直接丢弃且不可放行；
 * 发现冲突迹象（同名技能多处存在、文件在本轮期间被改、模型报告与相邻技能职责冲突）立即停轮报告，不裁决。
 */
import { pruneEvolutionStore, readJsonDir } from "./store-retention.js";
import { appendFile, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserError } from "./errors.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { defaultAgentSkillDir } from "./extractor.js";
import { isInside } from "./paths.js";
import { inIdleWindow, optimizerConfigFile, optimizerRoot, readOptimizerConfigFile, resolveOptimizerConfig } from "./optimizer-config.js";
import { classifyChange } from "./optimizer-classify.js";
import { evalFile, gateVerdict, generateEvalSet, loadEvalSet, scoreSkill, sha256 } from "./optimizer-eval.js";
import { BudgetStop, callWithBudget, createBudget, extractTag } from "./optimizer-model.js";
import { bigramSimilarity, normalizeNewlines, parseSkillDoc } from "./skill-doc.js";
import { loadLibrary } from "./governance-scan.js";
import { checkRedlines, describeRedlines, effectiveRedlines, protectedContent } from "./skill-redlines.js";
import { captureSkillBefore, recordSkillAfter, rollbackSkill, skillKeyOf, skillTargetOf } from "./versions.js";
import { currentWriteContext, runWithWriteContext } from "./write-context.js";

export const REPORT_SCHEMA = 1;

const p2 = (n, w = 2) => String(n).padStart(w, "0");
function stamp(at) {
	const d = new Date(at);
	return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
const newId = (prefix, at) => `${prefix}-${stamp(at)}-${randomBytes(3).toString("hex")}`;

const dirs = {
	reports: () => join(optimizerRoot(), "reports"),
	proposals: () => join(optimizerRoot(), "proposals"),
	candidates: () => join(optimizerRoot(), "candidates"),
	discards: () => join(optimizerRoot(), "discards.jsonl"),
	overrides: () => join(optimizerRoot(), "overrides.jsonl"),
	state: () => join(optimizerRoot(), "state.json"),
	lock: () => join(optimizerRoot(), "round.lock"),
	// ：自动应用后的观察名单（含退化回滚后不再自动应用的技能）与退化回滚记录
	watches: () => join(optimizerRoot(), "watches.json"),
	regressions: () => join(optimizerRoot(), "regressions.jsonl")
};

async function readJson(file, fallback) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return fallback;
	}
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
	await mkdir(optimizerRoot(), { recursive: true });
	await appendFile(file, JSON.stringify(value) + "\n", "utf8");
}

async function saveCandidateText(text) {
	const sha = sha256(text);
	const file = join(dirs.candidates(), sha + ".md");
	try {
		await stat(file);
	} catch {
		await atomicWriteFile(file, text, "utf8");
	}
	return { sha, file };
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

/** 优化回路只碰用户自己的两个技能根（或配置里显式给的根）。 */
export function optimizerSkillRoots(config) {
	if (Array.isArray(config.roots) && config.roots.length > 0) return config.roots;
	return [join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "skills"), defaultAgentSkillDir()];
}

async function exists(file) {
	try {
		return (await stat(file)).isFile();
	} catch {
		return false;
	}
}

/** 技能名 → 文件。同名出现在多处 = 冲突迹象（交给，这里只停手报告）。 */
export async function resolveSkillFile(name, config) {
	const hits = [];
	const seen = new Set();
	// 技能名来自模型可调用的 skillmgr_optimize_run {skill} 或遥测里记下的原始工具参数，不可信：
	// 只接受单段名。`../../Documents/notes` 这类名字拼出来的 .md 会被读给模型、再被候选改写。
	const safe = typeof name === "string" && name.trim() !== "" && !/[\\/]/.test(name) && name !== "." && name !== ".." && !name.includes("\0");
	if (!safe) return hits;
	for (const root of optimizerSkillRoots(config)) {
		for (const file of [join(root, name, "SKILL.md"), join(root, name + ".md")]) {
			if (!isInside(root, file)) continue;
			if (seen.has(file)) continue;
			seen.add(file);
			if (await exists(file)) hits.push(file);
		}
	}
	return hits;
}

/** 相邻技能（description 与本技能相似的），喂给变异模型做冲突自查；最多 8 个。 */
async function peerSkills(name, description, config) {
	// B6：走治理那份带缓存的技能库读取，不再每次把各个根完整读一遍
	const out = [];
	for (const skill of await loadLibrary(optimizerSkillRoots(config))) {
		// 只看目录形态的技能（<root>/<dir>/SKILL.md），与原口径一致
		if (!/[\\/]SKILL\.md$/.test(skill.file) || skill.dirName === name) continue;
		const desc = String(skill.description ?? "");
		const sim = bigramSimilarity(description, desc);
		if (sim >= 0.2) out.push({ name: skill.dirName, description: desc.slice(0, 200), similarity: Math.round(sim * 100) / 100 });
	}
	return out.sort((a, b) => b.similarity - a.similarity).slice(0, 8);
}

const MODE_TEXT = {
	conservative: "只允许改：措辞、示例、段落 / 条目顺序、排版。不得增删步骤，不得改 frontmatter（description 只许润色、不改含义），不得增删或改动任何工具调用 / 命令。",
	free: "允许结构性改动：增删或合并步骤、调整触发描述（description）、调整工具调用。仍然必须遵守下面的「红线」。"
};

function mutationPrompt({ name, parent, mode, weak, usage, protectedView, peers, generation }) {
	return [
		`你在用达尔文式迭代优化技能「${name}」（第 ${generation} 代）。目标：让照这份技能办事的助手在典型场景里做得更好。`,
		usage ? `遥测：最近 ${usage.weeks} 周使用 ${usage.uses} 次，失败率 ${(usage.failureRate * 100).toFixed(1)}%。` : "遥测：无（所有者手动点名）。",
		weak.length > 0 ? "评估中得分偏低的场景（优先改进）：\n" + weak.map((c) => `- ${c.id}：${c.score} 分。${c.reason}`).join("\n") : "",
		"",
		"改动范围：" + MODE_TEXT[mode],
		"",
		"红线（以下内容必须逐字原样保留，不得删改、不得新增同类内容）：",
		...Object.entries(protectedView.frontmatter)
			.filter(([, v]) => v !== null)
			.map(([k]) => `- frontmatter 键 ${k}`),
		...protectedView.sections.map((s) => `- 整段：${s.split("\n")[0]}`),
		...protectedView.lines.map((l) => `- 行：${l}`),
		"",
		peers.length > 0 ? "相邻技能（职责可能重叠）：\n" + peers.map((p) => `- ${p.name}：${p.description}`).join("\n") : "",
		"如果你判断本技能与相邻技能的职责互相矛盾、需要有人裁决，不要改写，在 <conflict> 里说明；否则 <conflict> 填 none。",
		"",
		"输出格式（严格）：",
		"<summary>一句话说明改了什么</summary>",
		"<conflict>none</conflict>",
		"<skill>",
		"完整的新 SKILL.md（含 frontmatter）",
		"</skill>",
		"",
		"当前版本：",
		"<current>",
		parent,
		"</current>"
	]
		.filter((line) => line !== null)
		.join("\n");
}

function bodyLength(text) {
	return (parseSkillDoc(text).body ?? "").trim().length;
}

function staticChecks(baseline, candidate, gate) {
	const reasons = [];
	if (candidate.trim() === "") reasons.push("候选为空");
	const a = parseSkillDoc(baseline);
	const b = parseSkillDoc(candidate);
	if (b.fmText === null && a.fmText !== null) reasons.push("候选丢了 frontmatter");
	const la = Math.max(1, bodyLength(baseline));
	const ratio = bodyLength(candidate) / la;
	if (ratio < gate.minLengthRatio) reasons.push(`正文长度只剩基线的 ${(ratio * 100).toFixed(0)}%（下限 ${(gate.minLengthRatio * 100).toFixed(0)}%）`);
	if (ratio > gate.maxLengthRatio) reasons.push(`正文长度是基线的 ${(ratio * 100).toFixed(0)}%（上限 ${(gate.maxLengthRatio * 100).toFixed(0)}%）`);
	return reasons;
}

function weakCases(score, n = 3) {
	return score.cases
		.filter((c) => c.score !== null && c.score < 10)
		.sort((x, y) => x.score - y.score)
		.slice(0, n);
}

function rollbackHint(key, versionId) {
	return versionId ? { tool: "skillmgr_rollback", target: key, versionId, route: "POST /api/dsh-studio/history/rollback" } : null;
}

/**
 * @param {{
 *   pluginConfig?: object,
 *   model: {complete: Function} | (() => {complete: Function}),
 *   telemetry: () => {stats: Function},
 *   logger?: object,
 *   now?: () => number,
 *   onSkillsChanged?: () => void
 * }} deps
 */
export function createOptimizer(deps) {
	const now = typeof deps.now === "function" ? deps.now : () => Date.now();
	const logger = deps.logger ?? null;
	let running = null;
	let lastActivityAt = now();
	let lastCheckAt = 0;
	let lastCheckEveryMs = 0;
	const getModel = () => (typeof deps.model === "function" ? deps.model() : deps.model);

	async function effective() {
		const file = await readOptimizerConfigFile();
		const { config, sources } = resolveOptimizerConfig(deps.pluginConfig, file.value);
		const redlines = effectiveRedlines(config.redlines);
		return { config, sources, fileError: file.error, redlines };
	}

	async function readState() {
		return readJson(dirs.state(), { lastRoundAt: 0, lastRoundId: null, lastStatus: null });
	}

	async function writeState(patch) {
		const state = { ...(await readState()), ...patch };
		await atomicWriteFile(dirs.state(), JSON.stringify(state, null, 2) + "\n", "utf8");
		return state;
	}

	// ── ：应用后回归监测 ──
	async function readWatches() {
		const data = await readJson(dirs.watches(), null);
		return {
			v: 1,
			watches: Array.isArray(data?.watches) ? data.watches : [],
			blocked: data?.blocked && typeof data.blocked === "object" && !Array.isArray(data.blocked) ? data.blocked : {}
		};
	}
	async function writeWatches(data) {
		await mkdir(optimizerRoot(), { recursive: true });
		await atomicWriteFile(dirs.watches(), JSON.stringify(data, null, 2) + "\n", "utf8");
	}
	const scoreView = (score) => ({ mean: score.mean, cases: score.cases.map((c) => ({ id: c.id, score: c.score, critical: c.critical === true })) });

	/**
	 * 每轮开头复评观察名单里的技能。复评与 G1 评估门同一口径：拿应用前的评分当基线跑 gateVerdict，
	 * 不过门 = 退化 → 回滚到应用前那一版（版本记录里留 actor / 原因 / 分数），该技能此后不再自动应用、只出提案。
	 * 应用后文件被别处改过的不再按这次的基线复评、也不回滚（不覆盖别人的改动）。
	 */
	async function checkRegressions(report, { config, budget, model }) {
		if (config.regression.enabled !== true) return;
		const data = await readWatches();
		const active = data.watches.filter((w) => w.status === "watching");
		if (active.length === 0) return;
		try {
			for (const w of active) {
				const at = new Date(now()).toISOString();
				const row = { watchId: w.id, skill: w.skill, key: w.key, appliedVersionId: w.appliedVersionId, outcome: "running" };
				report.regression.push(row);
				let current = null;
				try {
					current = await readText(w.file);
				} catch {
					current = null;
				}
				if (current === null || sha256(current) !== w.appliedSha) {
					w.status = "superseded";
					w.closedAt = at;
					w.note = current === null ? "技能文件已不在" : "自动应用后技能文件被别处改过：不再按这次的基线复评，也不回滚";
					Object.assign(row, { outcome: "superseded", note: w.note });
					continue;
				}
				const evalSet = await loadEvalSet(w.skill);
				if (evalSet === null) {
					w.status = "closed";
					w.closedAt = at;
					w.note = "评估集已不在，无从复评";
					Object.assign(row, { outcome: "closed", note: w.note });
					continue;
				}
				const scoreIt = () => scoreSkill({ model, budget, name: w.skill, text: current, evalSet, maxOutputTokens: config.limits.maxOutputTokens, label: "regression" });
				let score = await scoreIt();
				if (score.cases.some((c) => c.score === null)) score = await scoreIt();
				if (score.cases.some((c) => c.score === null)) {
					Object.assign(row, { outcome: "inconclusive", note: "复评评分不完整，本轮不下结论，下轮再评" });
					continue;
				}
				const verdict = gateVerdict(w.before, score, config.gate);
				w.checks = [...(w.checks ?? []), { at, roundId: report.roundId, mean: score.mean, pass: verdict.pass, reasons: verdict.reasons }];
				Object.assign(row, { beforeApply: w.before.mean, atApply: w.after.mean, now: score.mean });
				if (verdict.pass) {
					const passed = w.checks.filter((c) => c.pass).length;
					if (passed >= config.regression.checks) {
						w.status = "confirmed";
						w.closedAt = at;
					}
					row.outcome = w.status === "confirmed" ? "confirmed" : "ok";
					continue;
				}
				// 退化：回滚到应用前那一版
				const reason = `回归监测：${w.skill} 自动应用（${w.appliedVersionId}）后复评退化（应用前 ${w.before.mean} → 应用时 ${w.after.mean} → 现在 ${score.mean}）：${verdict.reasons.join("；")}`;
				const rolled = await runWithWriteContext({ actor: "optimizer:regression" }, () => rollbackSkill({ key: w.key, versionId: w.rollbackTo, actor: "optimizer:regression", reason }));
				const rec = {
					id: newId("regr", now()),
					at,
					roundId: report.roundId,
					skill: w.skill,
					key: w.key,
					file: w.file,
					appliedVersionId: w.appliedVersionId,
					appliedAt: w.appliedAt,
					rolledBackTo: w.rollbackTo,
					rollbackVersionId: rolled?.version?.id ?? null,
					scores: { beforeApply: w.before.mean, atApply: w.after.mean, now: score.mean },
					reasons: verdict.reasons,
					cases: scoreView(score).cases
				};
				await appendJsonl(dirs.regressions(), rec);
				w.status = "rolled-back";
				w.closedAt = at;
				w.regressionId = rec.id;
				// 回滚之后不再触发新一轮自动应用：这个技能此后只出提案
				data.blocked[w.key] = { at, skill: w.skill, regressionId: rec.id, appliedVersionId: w.appliedVersionId };
				Object.assign(row, { outcome: "rolled-back", rolledBackTo: w.rollbackTo, rollbackVersionId: rec.rollbackVersionId, regressionId: rec.id, reasons: verdict.reasons });
			}
		} finally {
			await writeWatches(data);
		}
	}

	async function listRegressions(limit = 10) {
		return (await readJsonl(dirs.regressions())).slice(-limit).reverse();
	}

	// C5：提案目录按 stat 缓存解析结果（每次状态查询都要列一遍）
	const proposalCache = new Map();
	async function listProposals(status) {
		const out = [];
		for (const p of await readJsonDir(dirs.proposals(), proposalCache)) {
			if (p && (status === undefined || p.status === status)) out.push(p);
		}
		return out.reverse();
	}

	async function listReports(limit = 10) {
		let names = [];
		try {
			names = await readdir(dirs.reports());
		} catch {
			return [];
		}
		const ids = names.filter((n) => n.endsWith(".json")).sort().reverse().slice(0, limit);
		const out = [];
		for (const n of ids) {
			const r = await readJson(join(dirs.reports(), n), null);
			if (r) out.push({ roundId: r.roundId, trigger: r.trigger, status: r.status, startedAt: r.startedAt, counts: r.counts, stop: r.stop ?? null });
		}
		return out;
	}

	async function getReport(id) {
		const roundId = String(id ?? "").trim();
		if (roundId === "") {
			const latest = (await listReports(1))[0];
			if (!latest) throw new UserError("还没有任何优化报告", 404);
			return getReport(latest.roundId);
		}
		if (!/^opt-[\w-]+$/.test(roundId)) throw new UserError("报告 id 不合法：" + roundId);
		const report = await readJson(join(dirs.reports(), roundId + ".json"), null);
		if (!report) throw new UserError("找不到报告 " + roundId, 404);
		let markdown = "";
		try {
			markdown = await readFile(join(dirs.reports(), roundId + ".md"), "utf8");
		} catch {
			/* 只有 JSON 也行 */
		}
		return { report, markdown };
	}

	/** 从遥测挑候选：只看有数据的技能；高频 + 高失败率优先。 */
	async function selectCandidates(config, onlySkill) {
		const sel = config.selection;
		const stats = await deps.telemetry().stats({ weeks: sel.weeks });
		const agg = new Map();
		for (const week of stats?.weeks ?? []) {
			for (const s of week.skills ?? []) {
				const row = agg.get(s.skill) ?? { skill: s.skill, uses: 0, failures: 0 };
				row.uses += (Number(s.triggers) || 0) + (Number(s.injections) || 0);
				row.failures += Number(s.failures) || 0;
				agg.set(s.skill, row);
			}
		}
		const exclude = new Set(sel.exclude);
		const rows = [...agg.values()]
			.map((r) => ({ ...r, weeks: sel.weeks, failureRate: r.uses > 0 ? r.failures / r.uses : 0 }))
			.map((r) => ({ ...r, priority: Math.round(r.uses * (1 + sel.failureWeight * r.failureRate) * 1000) / 1000 }))
			.sort((a, b) => b.priority - a.priority || a.skill.localeCompare(b.skill));
		const ignored = [];
		const picked = [];
		for (const r of rows) {
			if (onlySkill && r.skill !== onlySkill) continue;
			if (exclude.has(r.skill)) ignored.push({ skill: r.skill, why: "在排除名单里" });
			else if (r.uses < sel.minUses) ignored.push({ skill: r.skill, why: `使用 ${r.uses} 次 < 门槛 ${sel.minUses}` });
			else picked.push({ ...r, selection: "telemetry" });
		}
		if (onlySkill && picked.length === 0 && !exclude.has(onlySkill)) {
			const tele = rows.find((r) => r.skill === onlySkill) ?? null;
			picked.push({ skill: onlySkill, uses: tele?.uses ?? 0, failures: tele?.failures ?? 0, failureRate: tele?.failureRate ?? 0, weeks: sel.weeks, priority: 0, selection: "manual" });
		}
		return { picked, ignored, telemetrySkills: rows.length };
	}

	async function recordDiscard(entry, attempt, kind, reasons, extra = {}) {
		const rec = {
			id: newId("disc", now()),
			at: new Date(now()).toISOString(),
			roundId: entry.roundId,
			skill: entry.skill,
			key: entry.key,
			target: entry.file,
			baseSha: entry.baseSha,
			candidateSha: attempt.sha ?? null,
			candidateFile: attempt.file ?? null,
			generation: attempt.generation,
			index: attempt.index,
			mode: attempt.mode,
			summary: attempt.summary ?? "",
			kind,
			reasons,
			overridable: kind !== "redline",
			...extra
		};
		await appendJsonl(dirs.discards(), rec);
		entry.discards.push({ id: rec.id, kind, reasons, generation: attempt.generation, index: attempt.index, mode: attempt.mode, tier: extra.tier ?? null, score: extra.score ?? null });
		return rec;
	}

	/**
	 * 写入 + 版本记录，二者缺一不可（G2：每次改动都要可回滚）。
	 * captureSkillBefore / recordSkillAfter 自己永不抛：版本史锁超时、目录写不了、技能目录里有文件被占用时
	 * 只返回 null / []。旧写法照样写文件并报「已应用」，结果是改了却没有版本记录、也没有可回滚的旧内容。
	 * 现在：写前状态拿不到就不写；写后没出记录就把原文还原，再报错。
	 */
	async function applyVersioned({ file, content, action, actor, reason, evalInfo }) {
		const before = await captureSkillBefore(file);
		if (before === null) throw new Error("写前状态没取到（版本史暂不可用），未改动文件");
		const previous = await readFile(file, "utf8");
		await atomicWriteFile(file, content, "utf8");
		const meta = { action, reason, eval: evalInfo };
		if (actor) meta.actor = actor;
		const written = await recordSkillAfter(file, before, meta);
		if (!written.some((r) => typeof r?.id === "string")) {
			await atomicWriteFile(file, previous, "utf8");
			throw new Error("版本记录没写成，已把文件还原成改动前的内容");
		}
		try {
			deps.onSkillsChanged?.();
		} catch {
			/* 缓存失效失败不影响写入 */
		}
		const rec = written.find((r) => r.action === action) ?? written.at(-1) ?? null;
		return { versionId: rec?.id ?? null, rollbackTo: rec?.parent ?? null, key: rec?.key ?? null };
	}

	/**
	 * 一个技能的评估起点：文件、key、待批提案检查、评估集（没有就按基线生成并冻结）、基线评分（不完整重问一次）。
	 * 不能评（已有待批提案、基线评分仍不完整）时在 entry 上写明原因并返回 null。优化回路与外部提交共用。
	 */
	async function prepareBaseline(entry, skill, file, { config, budget, model }) {
		entry.file = file;
		entry.key = skillKeyOf(skillTargetOf(file));
		const pending = (await listProposals("pending")).find((p) => p.key === entry.key);
		if (pending) {
			entry.outcome = "skipped";
			entry.note = `已有待批准的提案 ${pending.id}，先等所有者处理`;
			return null;
		}
		const baseline = await readText(file);
		entry.baseSha = sha256(baseline);
		let evalSet = await loadEvalSet(skill);
		entry.evalSet = { file: evalFile(skill), generated: false, cases: 0, critical: 0 };
		if (evalSet === null) {
			evalSet = await generateEvalSet({ model, budget, name: skill, key: entry.key, baseline, count: config.gate.casesPerSkill, maxOutputTokens: config.limits.maxOutputTokens });
			entry.evalSet.generated = true;
		}
		entry.evalSet.cases = evalSet.cases.length;
		entry.evalSet.critical = evalSet.cases.filter((c) => c.critical).length;
		let baseScore = await scoreSkill({ model, budget, name: skill, text: baseline, evalSet, maxOutputTokens: config.limits.maxOutputTokens, label: "baseline" });
		// 基线评分不完整（模型回复被截断 / 不是 JSON）就再问一次；仍不完整则这个技能本轮不优化——
		// 拿「均分 0」当基线，后面任何候选都算提升
		if (baseScore.cases.some((c) => c.score === null)) {
			baseScore = await scoreSkill({ model, budget, name: skill, text: baseline, evalSet, maxOutputTokens: config.limits.maxOutputTokens, label: "baseline" });
		}
		const baseMissing = baseScore.cases.filter((c) => c.score === null).map((c) => c.id);
		if (baseMissing.length > 0) {
			entry.outcome = "skipped";
			entry.note = `基线评分不完整（缺 ${baseMissing.join("、")}），没有可比的基线，本轮不优化这个技能`;
			return null;
		}
		entry.before = baseScore.mean;
		entry.baselineScores = baseScore.cases;
		return { file, baseline, evalSet, baseScore };
	}

	/**
	 * ：外部（darwin 无人值守体检）提交的一份改写候选，走与优化回路完全相同的口径：
	 * 红线 → 静态检查 → 分级（禁区直接丢）→ G1 评估门（不过门不落地，丢弃留记录）→ landCandidate 按 G3 分级落地
	 * （最低风险档可自动应用并进回归观察，其余进待批）。不许绕过分级直接写。
	 */
	async function evaluateSubmission(entry, { skill, content, summary, source }, ctx) {
		const { config, redlines, budget, model } = ctx;
		if (config.selection.exclude.includes(skill)) {
			entry.outcome = "skipped";
			entry.note = "在优化回路的排除名单里，不接受改写提交";
			return;
		}
		const hits = await resolveSkillFile(skill, config);
		if (hits.length === 0) {
			entry.outcome = "skipped";
			entry.note = "在用户技能根里找不到这个技能的文件";
			return;
		}
		if (hits.length > 1) {
			entry.outcome = "conflict";
			entry.conflict = { signal: "duplicate-name", detail: `同名技能出现在多处：${hits.join("、")}` };
			return;
		}
		const prepared = await prepareBaseline(entry, skill, hits[0], ctx);
		if (prepared === null) return;
		const { file, baseline, evalSet, baseScore } = prepared;
		const attempt = { generation: 1, index: 0, mode: source, summary: String(summary ?? "").trim().slice(0, 300) };
		const text = normalizeNewlines(String(content)).replace(/\s*$/, "\n");
		Object.assign(attempt, await saveCandidateText(text));
		const discard = async (kind, reasons, extra) => {
			await recordDiscard(entry, attempt, kind, reasons, { source, ...extra });
			entry.outcome = "discarded";
		};
		if (sha256(text) === sha256(baseline)) return discard("static", ["与当前版本完全相同"]);
		const red = checkRedlines(baseline, text, redlines);
		if (!red.ok) return discard("redline", red.violations.map((v) => `红线：${v.kind} ${v.change} ${v.what}`), { violations: red.violations });
		const statics = staticChecks(baseline, text, config.gate);
		if (statics.length > 0) return discard("static", statics);
		const cls = classifyChange(baseline, text, config, redlines);
		if (cls.tier === "forbidden") return discard("redline", cls.details.filter((d) => d.kind === "redline").map((d) => "红线：" + d.detail), { tier: cls.tier });
		let score = await scoreSkill({ model, budget, name: skill, text, evalSet, maxOutputTokens: config.limits.maxOutputTokens, label: "submission" });
		if (score.cases.some((c) => c.score === null)) score = await scoreSkill({ model, budget, name: skill, text, evalSet, maxOutputTokens: config.limits.maxOutputTokens, label: "submission" });
		const verdict = gateVerdict(baseScore, score, config.gate);
		if (!verdict.pass) return discard("gate", verdict.reasons, { tier: cls.tier, kinds: cls.kinds, score: score.mean, before: baseScore.mean, scores: score.cases });
		if (!(score.mean > baseScore.mean + config.gate.minGain)) return discard("no-gain", [`过了门但没有更好：${score.mean} ≤ 基线 ${baseScore.mean}${config.gate.minGain ? ` + ${config.gate.minGain}` : ""}`], { tier: cls.tier, kinds: cls.kinds, score: score.mean, before: baseScore.mean });
		await landCandidate(entry, { skill, file, evalSet, baseScore, best: { text, score, cls, verdict, attempt }, config, actor: `${source}:unattended`, reasonPrefix: `${source} 无人值守提交 ${entry.roundId} 低风险自动应用`, source });
	}

	/** 单个技能的达尔文迭代。entry 先挂进报告，BudgetStop 时报告里仍有部分结果。 */
	async function optimizeSkill(entry, cand, ctx) {
		const { config, redlines, budget, model } = ctx;
		const hits = await resolveSkillFile(cand.skill, config);
		if (hits.length === 0) {
			entry.outcome = "skipped";
			entry.note = "在用户技能根里找不到这个技能的文件（内置 / 插件技能不参与自动优化）";
			return;
		}
		if (hits.length > 1) {
			entry.outcome = "conflict";
			entry.conflict = { signal: "duplicate-name", detail: `同名技能出现在多处：${hits.join("、")}` };
			return;
		}
		const prepared = await prepareBaseline(entry, cand.skill, hits[0], ctx);
		if (prepared === null) return;
		const { file, baseline, evalSet, baseScore } = prepared;
		const protectedView = protectedContent(baseline, redlines);
		const peers = await peerSkills(cand.skill, String(parseSkillDoc(baseline).fields?.description ?? ""), config);
		let best = null;
		let parent = { text: baseline, score: baseScore };
		for (let generation = 1; generation <= config.limits.generations; generation++) {
			for (let index = 0; index < config.limits.population; index++) {
				const mode = index === 0 ? "conservative" : "free";
				const prompt = mutationPrompt({ name: cand.skill, parent: parent.text, mode, weak: weakCases(parent.score), usage: cand.selection === "telemetry" ? cand : null, protectedView, peers, generation });
				const raw = await callWithBudget(model, budget, {
					purpose: "mutate",
					system: "你是技能（SKILL.md）优化器。严格按要求的标签格式输出。",
					prompt,
					maxTokens: config.limits.maxOutputTokens,
					meta: { name: cand.skill, skillText: parent.text, baseline, mode, generation, index, weak: weakCases(parent.score), peers }
				});
				const conflict = (extractTag(raw, "conflict") ?? "none").trim();
				if (conflict !== "" && !/^(none|无|没有)$/i.test(conflict)) {
					entry.outcome = "conflict";
					entry.conflict = { signal: "model-reported", detail: conflict.slice(0, 500), peers: peers.map((p) => p.name) };
					return;
				}
				const content = extractTag(raw, "skill");
				const attempt = { generation, index, mode, summary: (extractTag(raw, "summary") ?? "").trim().slice(0, 300) };
				entry.attempts += 1;
				if (content === null || content.trim() === "") {
					await recordDiscard(entry, attempt, "static", ["模型输出里没有 <skill> 段"]);
					continue;
				}
				const text = normalizeNewlines(content).replace(/\s*$/, "\n");
				Object.assign(attempt, await saveCandidateText(text));
				if (sha256(text) === sha256(parent.text)) {
					await recordDiscard(entry, attempt, "static", ["与当前版本完全相同"]);
					continue;
				}
				const red = checkRedlines(baseline, text, redlines);
				if (!red.ok) {
					await recordDiscard(entry, attempt, "redline", red.violations.map((v) => `红线：${v.kind} ${v.change} ${v.what}`), { violations: red.violations });
					continue;
				}
				const statics = staticChecks(baseline, text, config.gate);
				if (statics.length > 0) {
					await recordDiscard(entry, attempt, "static", statics);
					continue;
				}
				const cls = classifyChange(baseline, text, config, redlines);
				if (cls.tier === "forbidden") {
					await recordDiscard(entry, attempt, "redline", cls.details.filter((d) => d.kind === "redline").map((d) => "红线：" + d.detail), { tier: cls.tier });
					continue;
				}
				const score = await scoreSkill({ model, budget, name: cand.skill, text, evalSet, maxOutputTokens: config.limits.maxOutputTokens, label: `g${generation}-${index}` });
				const verdict = gateVerdict(baseScore, score, config.gate);
				if (!verdict.pass) {
					await recordDiscard(entry, attempt, "gate", verdict.reasons, { tier: cls.tier, kinds: cls.kinds, score: score.mean, before: baseScore.mean, scores: score.cases });
					continue;
				}
				const bar = (best?.score.mean ?? baseScore.mean) + config.gate.minGain;
				if (!(score.mean > bar)) {
					await recordDiscard(entry, attempt, "no-gain", [`过了门但没有更好：${score.mean} ≤ 当前最优 ${best?.score.mean ?? baseScore.mean}${config.gate.minGain ? ` + ${config.gate.minGain}` : ""}`], { tier: cls.tier, kinds: cls.kinds, score: score.mean, before: baseScore.mean, scores: score.cases });
					continue;
				}
				if (best !== null) await recordDiscard(entry, best.attempt, "superseded", [`被更好的候选取代：${best.score.mean} < ${score.mean}`], { tier: best.cls.tier, kinds: best.cls.kinds, score: best.score.mean, before: baseScore.mean, scores: best.score.cases });
				best = { text, score, cls, verdict, attempt };
				parent = { text, score };
			}
		}
		if (best === null) {
			entry.outcome = "discarded";
			entry.after = null;
			return;
		}
		await landCandidate(entry, { skill: cand.skill, file, evalSet, baseScore, best, config, actor: "optimizer:auto", reasonPrefix: `优化回路 ${entry.roundId} 低风险自动应用` });
	}

	/**
	 * 过了门的最优候选 → 落地方式（G3）：低风险且允许自动应用 → 版本化写入并登记回归观察；
	 * 其余（结构性、低风险但关了自动应用、该技能退化回滚过）→ 只出提案。优化回路与 darwin 无人值守提交共用。
	 * @param {{skill:string, file:string, evalSet:object, baseScore:object, best:{text:string, score:object, cls:object, attempt:object}, config:object, actor:string, reasonPrefix:string, source?:string}} p
	 */
	async function landCandidate(entry, { skill, file, evalSet, baseScore, best, config, actor, reasonPrefix, source }) {
		entry.after = best.score.mean;
		entry.tier = best.cls.tier;
		entry.kinds = best.cls.kinds;
		entry.changes = best.cls.details;
		entry.summary = best.attempt.summary;
		entry.candidateSha = best.attempt.sha;
		// 冲突迹象：本轮期间文件被别人改了 → 停手报告
		if ((await fileSha(file)) !== entry.baseSha) {
			entry.outcome = "conflict";
			entry.conflict = { signal: "changed-during-round", detail: "本轮开始后技能文件被插件外改动，不覆盖、不裁决" };
			return;
		}
		const evalInfo = {
			suite: evalSet.transient === true ? null : evalFile(skill),
			cases: evalSet.cases.length,
			before: baseScore.mean,
			after: best.score.mean,
			verdict: "pass",
			at: new Date(now()).toISOString(),
			roundId: entry.roundId,
			tier: best.cls.tier,
			kinds: best.cls.kinds,
			...(source ? { source } : {})
		};
		const watchData = await readWatches();
		const blocked = watchData.blocked[entry.key] ?? null;
		if (best.cls.tier === "low" && config.autonomy.autoApplyLowRisk === true && blocked === null) {
			const written = await applyVersioned({
				file,
				content: best.text,
				action: "optimize",
				actor,
				reason: `${reasonPrefix}（${best.cls.kinds.join("、")}）：${best.attempt.summary}`,
				evalInfo
			});
			entry.outcome = "applied";
			entry.versionId = written.versionId;
			entry.rollback = rollbackHint(entry.key, written.rollbackTo);
			// ：记下应用前的评估结果与版本指针，之后的轮次复评，退化就回到这一版
			if (config.regression.enabled === true && written.rollbackTo) {
				const latest = await readWatches();
				for (const w of latest.watches) if (w.key === entry.key && w.status === "watching") Object.assign(w, { status: "superseded", closedAt: evalInfo.at, note: "同一技能又被自动应用了一次，改按新的一次观察" });
				latest.watches.push({
					id: newId("watch", now()),
					status: "watching",
					skill,
					key: entry.key,
					file,
					source: source ?? "optimizer",
					roundId: entry.roundId,
					appliedAt: evalInfo.at,
					appliedVersionId: written.versionId,
					rollbackTo: written.rollbackTo,
					appliedSha: sha256(best.text),
					before: scoreView(baseScore),
					after: scoreView(best.score),
					checks: []
				});
				// 观察名单只留最近 200 条已结束的
				const open = latest.watches.filter((w) => w.status === "watching");
				const closed = latest.watches.filter((w) => w.status !== "watching").slice(-200);
				latest.watches = [...closed, ...open];
				await writeWatches(latest);
				entry.watch = { checks: config.regression.checks };
			}
			return;
		}
		const proposal = {
			id: newId("prop", now()),
			status: "pending",
			createdAt: new Date(now()).toISOString(),
			roundId: entry.roundId,
			skill,
			key: entry.key,
			target: file,
			baseSha: entry.baseSha,
			candidateSha: best.attempt.sha,
			candidateFile: best.attempt.file,
			tier: best.cls.tier,
			kinds: best.cls.kinds,
			changes: best.cls.details,
			summary: best.attempt.summary,
			eval: evalInfo,
			scores: { before: baseScore.cases, after: best.score.cases },
			...(source ? { source } : {}),
			why:
				best.cls.tier === "low" && blocked !== null
					? `这个技能 ${blocked.at} 自动应用后复评退化、已回滚（${blocked.regressionId}），此后不再自动应用：只出提案`
					: best.cls.tier === "low"
						? "autonomy.autoApplyLowRisk=false：低风险也只出提案"
						: "结构性改动：只出提案，等所有者批准"
		};
		await atomicWriteFile(join(dirs.proposals(), proposal.id + ".json"), JSON.stringify(proposal, null, 2) + "\n", "utf8");
		entry.outcome = "proposed";
		entry.proposalId = proposal.id;
	}

	function renderReport(report) {
		const c = report.counts;
		const lines = [
			`# 技能优化报告 ${report.roundId}`,
			"",
			`- 触发：${report.trigger === "auto" ? "闲时自动" : report.trigger === "manual" ? "手动" : `${report.trigger} 无人值守提交`}；状态：**${report.status}**${report.stop ? `（${report.stop.limit ?? report.stop.signal ?? ""}：${report.stop.detail}）` : ""}`,
			`- 时间：${report.startedAt} → ${report.endedAt}`,
			`- 计数：自动应用 ${c.applied} · 提案 ${c.proposed} · 丢弃 ${c.discarded}（候选级丢弃 ${c.discardedCandidates}）· 冲突 ${c.conflicts} · 跳过 ${c.skipped}${c.rolledBack ? ` · 退化回滚 ${c.rolledBack}` : ""}`,
			`- 花费：模型 ${report.budget.calls}/${report.budget.limits.maxModelCalls} 次，token ${report.budget.tokens}/${report.budget.limits.maxTokens}${report.budget.estimatedTokens ? `（其中估算 ${report.budget.estimatedTokens}）` : ""}，耗时 ${report.budget.ms}/${report.budget.limits.maxDurationMs} ms`,
			""
		];
		if ((report.regression ?? []).length > 0) {
			lines.push("## 回归监测（自动应用后复评）");
			const label = { ok: "未退化", confirmed: "未退化，观察结束", "rolled-back": "退化，已回滚", superseded: "文件已被别处改过，结束观察", closed: "结束观察", inconclusive: "评分不完整，下轮再评", running: "未完成" };
			for (const r of report.regression) {
				const scores = r.now !== undefined ? `（应用前 ${r.beforeApply} → 应用时 ${r.atApply} → 现在 ${r.now}）` : "";
				lines.push(`- ${r.skill}：${label[r.outcome] ?? r.outcome}${scores}${r.rolledBackTo ? `；回滚到 ${r.rolledBackTo}，回滚版本 ${r.rollbackVersionId ?? "—"}；此后只出提案` : ""}${r.reasons?.length ? "；" + r.reasons.join("；") : ""}${r.note ? "；" + r.note : ""}`);
			}
			lines.push("");
		}
		if (report.skills.length === 0) lines.push(report.note ?? "本轮没有可优化的技能。");
		for (const s of report.skills) {
			lines.push(`## ${s.skill} — ${s.outcome}`);
			if (s.key) lines.push(`- key：${s.key}`);
			if (s.before !== null && s.before !== undefined) lines.push(`- 评分：${s.before} → ${s.after ?? "（无过门候选）"}`);
			if (s.tier) lines.push(`- 分级：${s.tier}（${(s.kinds ?? []).join("、")}）`);
			if (s.summary) lines.push(`- 改动：${s.summary}`);
			if (s.versionId) lines.push(`- 版本：${s.versionId}`);
			if (s.rollback) lines.push(`- 回滚入口：skillmgr_rollback {"target":"${s.rollback.target}","versionId":"${s.rollback.versionId}"}`);
			if (s.proposalId) lines.push(`- 提案：${s.proposalId}（skillmgr_optimize_decide 批准 / 拒绝）`);
			if (s.conflict) lines.push(`- 冲突迹象（${s.conflict.signal}）：${s.conflict.detail}——已停手，未裁决`);
			if (s.note) lines.push(`- 说明：${s.note}`);
			for (const d of s.discards ?? []) lines.push(`- 丢弃 ${d.id}（第 ${d.generation} 代 #${d.index}，${d.kind}）：${d.reasons.join("；")}`);
			lines.push("");
		}
		return lines.join("\n");
	}

	async function acquireLock(maxMs) {
		await mkdir(optimizerRoot(), { recursive: true });
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
				if (held && now() - Number(held.at) < maxMs + 60_000) throw new UserError(`另一轮优化正在进行（pid ${held.pid}），本次不启动`, 409);
				await rm(file, { force: true });
			}
		}
		throw new UserError("拿不到优化回路的轮次锁", 409);
	}

	/** 收尾：计数、写报告 JSON / Markdown、（轮次才）更新状态。写失败只记日志。 */
	async function finalizeReport(report, budget, { startedAt, updateState }) {
		report.endedAt = new Date(now()).toISOString();
		report.budget = budget.snapshot();
		report.counts.rolledBack = (report.regression ?? []).filter((r) => r.outcome === "rolled-back").length;
		for (const s of report.skills) {
			if (s.outcome === "applied") report.counts.applied++;
			else if (s.outcome === "proposed") report.counts.proposed++;
			else if (s.outcome === "discarded") report.counts.discarded++;
			else if (s.outcome === "conflict") report.counts.conflicts++;
			else if (s.outcome === "skipped") report.counts.skipped++;
			else if (s.outcome === "error") report.counts.errors++;
			else if (s.outcome === "stopped" || s.outcome === "running") {
				s.outcome = "stopped";
				report.counts.stopped++;
			}
			report.counts.discardedCandidates += (s.discards ?? []).length;
		}
		try {
			await mkdir(dirs.reports(), { recursive: true });
			await atomicWriteFile(join(dirs.reports(), report.roundId + ".json"), JSON.stringify(report, null, 2) + "\n", "utf8");
			await atomicWriteFile(join(dirs.reports(), report.roundId + ".md"), renderReport(report), "utf8");
			if (updateState) await writeState({ lastRoundAt: startedAt, lastRoundId: report.roundId, lastStatus: report.status });
		} catch (error) {
			logger?.warn?.("[dsh-studio] 优化报告写入失败：" + (error instanceof Error ? error.message : String(error)));
		}
		// C5：每轮收尾做一次保留（只增不减的工作目录），失败只记一笔
		await pruneEvolutionStore({ proposalsDir: dirs.proposals(), candidatesDir: dirs.candidates(), reportsDir: dirs.reports(), discardsFile: dirs.discards(), now: now() }).catch((error) => logger?.warn?.("[dsh-studio] 优化工作目录保留失败：" + (error instanceof Error ? error.message : String(error))));
	}

	/**
	 * ：外部提交一份技能改写候选（darwin 无人值守体检用 skillmgr_darwin_submit 调这里）。
	 * 与优化回路同一把轮次锁、同一套门与分级、同样出报告；不算一轮优化（不动 lastRoundAt，不影响自动轮次节奏）。
	 * @param {{skill: string, content: string, summary?: string, source?: string}} args
	 */
	async function submitCandidate(args = {}) {
		if (running !== null) throw new UserError("优化回路正在跑一轮，稍后再提交", 409);
		const skill = String(args.skill ?? "").trim();
		if (skill === "" || /[\\/]/.test(skill) || skill.startsWith(".")) throw new UserError("skill 要填技能名（不带路径）");
		if (typeof args.content !== "string" || args.content.trim() === "") throw new UserError("content 要填改进后的完整 SKILL.md 正文");
		const source = typeof args.source === "string" && /^[\w-]{1,32}$/.test(args.source) ? args.source : "darwin";
		const work = (async () => {
			const { config, redlines } = await effective();
			const release = await acquireLock(config.limits.maxDurationMs);
			const startedAt = now();
			const budget = createBudget(config.limits, now);
			const report = {
				v: REPORT_SCHEMA,
				roundId: newId("sub", startedAt),
				trigger: source,
				requestedBy: currentWriteContext().actor ?? null,
				startedAt: new Date(startedAt).toISOString(),
				endedAt: null,
				status: "running",
				stop: null,
				skills: [],
				ignored: [],
				regression: [],
				counts: { applied: 0, proposed: 0, discarded: 0, discardedCandidates: 0, conflicts: 0, skipped: 0, stopped: 0, errors: 0, rolledBack: 0 },
				budget: budget.snapshot(),
				gate: config.gate,
				autonomy: { autoApplyLowRisk: config.autonomy.autoApplyLowRisk, lowRisk: config.autonomy.lowRisk, structural: config.autonomy.structural }
			};
			const entry = { roundId: report.roundId, skill, selection: source, usage: null, outcome: "running", before: null, after: null, attempts: 1, discards: [] };
			report.skills.push(entry);
			try {
				const model = getModel();
				if (!model || typeof model.complete !== "function") throw new UserError("没有可用的模型接口，无法过评估门：改写未落地");
				await evaluateSubmission(entry, { skill, content: args.content, summary: args.summary, source }, { config, redlines, budget, model });
				report.status = entry.outcome === "conflict" ? "conflict-stop" : "completed";
				if (entry.outcome === "conflict") report.stop = { signal: entry.conflict.signal, detail: `${skill}：${entry.conflict.detail}` };
			} catch (error) {
				if (error instanceof BudgetStop) {
					report.status = "budget-stop";
					report.stop = { limit: error.limit, detail: error.detail };
				} else {
					if (entry.outcome === "running") entry.outcome = "error";
					entry.note = "出错：" + (error instanceof Error ? error.message : String(error));
					report.status = "error";
					report.stop = { detail: entry.note };
				}
			} finally {
				try {
					await finalizeReport(report, budget, { startedAt, updateState: false });
				} finally {
					await release();
				}
			}
			report.markdown = renderReport(report);
			return report;
		})();
		running = work;
		try {
			return await work;
		} finally {
			running = null;
		}
	}

	/**
	 * 跑一轮。
	 * @param {{trigger?: "manual"|"auto", skill?: string}} [opts]
	 */
	async function runRound(opts = {}) {
		if (running !== null) throw new UserError("已有一轮优化在进行，本次不启动", 409);
		const trigger = opts.trigger === "auto" ? "auto" : "manual";
		const onlySkill = typeof opts.skill === "string" && opts.skill.trim() !== "" ? opts.skill.trim() : "";
		const work = (async () => {
			const { config, redlines } = await effective();
			const release = await acquireLock(config.limits.maxDurationMs);
			const startedAt = now();
			const roundId = newId("opt", startedAt);
			const budget = createBudget(config.limits, now);
			const report = {
				v: REPORT_SCHEMA,
				roundId,
				trigger,
				requestedBy: currentWriteContext().actor ?? null,
				startedAt: new Date(startedAt).toISOString(),
				endedAt: null,
				status: "running",
				stop: null,
				skills: [],
				ignored: [],
				regression: [],
				counts: { applied: 0, proposed: 0, discarded: 0, discardedCandidates: 0, conflicts: 0, skipped: 0, stopped: 0, errors: 0, rolledBack: 0 },
				budget: budget.snapshot(),
				gate: config.gate,
				autonomy: { autoApplyLowRisk: config.autonomy.autoApplyLowRisk, lowRisk: config.autonomy.lowRisk, structural: config.autonomy.structural }
			};
			try {
				const model = getModel();
				if (!model || typeof model.complete !== "function") throw new UserError("没有可用的模型接口（宿主 ctx.llm 不可用，提取器也没配 HTTP 端点）");
				// ：先复评上几轮自动应用过的技能，退化就回滚（与本轮选不选得出候选无关）
				await checkRegressions(report, { config, budget, model });
				const sel = await selectCandidates(config, onlySkill);
				report.ignored = sel.ignored;
				report.telemetrySkills = sel.telemetrySkills;
				if (sel.picked.length === 0) {
					report.status = "no-candidates";
					report.note = sel.telemetrySkills === 0 ? "遥测里没有任何技能数据；无遥测的技能不进自动优化。" : "没有达到门槛的候选技能。";
				} else {
					report.status = "completed";
					for (const cand of sel.picked.slice(0, config.limits.maxSkills)) {
						const entry = { roundId, skill: cand.skill, selection: cand.selection, usage: { uses: cand.uses, failures: cand.failures, failureRate: Math.round(cand.failureRate * 1000) / 1000, priority: cand.priority }, outcome: "running", before: null, after: null, attempts: 0, discards: [] };
						report.skills.push(entry);
						try {
							await optimizeSkill(entry, cand, { config, redlines, budget, model });
						} catch (error) {
							if (entry.outcome === "running") entry.outcome = error instanceof BudgetStop ? "stopped" : "error";
							if (!(error instanceof BudgetStop)) entry.note = "出错：" + (error instanceof Error ? error.message : String(error));
							if (error instanceof BudgetStop) throw error;
						}
						if (entry.outcome === "error") {
							report.status = "error";
							report.stop = { detail: `${entry.skill}：${entry.note}` };
							break;
						}
						if (entry.outcome === "conflict") {
							report.status = "conflict-stop";
							report.stop = { signal: entry.conflict.signal, detail: `${entry.skill}：${entry.conflict.detail}` };
							break;
						}
					}
				}
			} catch (error) {
				if (error instanceof BudgetStop) {
					report.status = "budget-stop";
					report.stop = { limit: error.limit, detail: error.detail };
				} else {
					report.status = "error";
					report.stop = { detail: error instanceof Error ? error.message : String(error) };
				}
			} finally {
				try {
					await finalizeReport(report, budget, { startedAt, updateState: true });
				} finally {
					await release();
				}
			}
			report.markdown = renderReport(report);
			return report;
		})();
		running = work;
		try {
			return await work;
		} finally {
			running = null;
		}
	}

	/** 定时器入口：自动开关 + 闲时窗口 + 空闲时长 + 最小间隔全满足才跑。 */
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
		const state = await readState();
		if (t - Number(state.lastRoundAt || 0) < config.minIntervalHours * 3_600_000) return { ran: false, reason: "too-soon" };
		if (running !== null) return { ran: false, reason: "running" };
		const report = await runRound({ trigger: "auto" });
		return { ran: true, reason: "ok", roundId: report.roundId, status: report.status };
	}

	async function loadProposal(id) {
		const pid = String(id ?? "").trim();
		if (!/^prop-[\w-]+$/.test(pid)) throw new UserError("提案 id 不合法：" + pid);
		const file = join(dirs.proposals(), pid + ".json");
		const proposal = await readJson(file, null);
		if (!proposal) throw new UserError("找不到提案 " + pid, 404);
		return { proposal, file };
	}

	/** 所有者批准 / 拒绝提案。批准 = 按版本化写入（可回滚）；文件已变则拒绝（提案过期）。 */
	async function decide({ id, decision, reason }) {
		const { proposal, file } = await loadProposal(id);
		if (proposal.status !== "pending") throw new UserError(`提案 ${proposal.id} 已是 ${proposal.status}，不能再处理`);
		const note = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
		const actor = currentWriteContext().actor ?? "unknown";
		if (decision === "reject") {
			const next = { ...proposal, status: "rejected", decidedAt: new Date(now()).toISOString(), decidedBy: actor, reason: note };
			await atomicWriteFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
			return { ok: true, proposal: next };
		}
		if (decision !== "approve") throw new UserError("decision 只能是 approve 或 reject");
		const current = await fileSha(proposal.target);
		if (current !== proposal.baseSha) {
			const next = { ...proposal, status: "stale", decidedAt: new Date(now()).toISOString(), decidedBy: actor, reason: "技能文件在提案生成后被改动过，提案作废；请重跑一轮" };
			await atomicWriteFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
			throw new UserError(next.reason, 409);
		}
		const { config, redlines } = await effective();
		const content = await readText(proposal.candidateFile);
		if (sha256(content) !== proposal.candidateSha) throw new UserError("提案的候选正文校验不一致（文件被改过），不应用");
		const red = checkRedlines(await readText(proposal.target), content, redlines);
		if (!red.ok) throw new UserError("候选正文触碰红线，不应用：" + red.violations.map((v) => v.what).join("、"));
		void config;
		const written = await applyVersioned({
			file: proposal.target,
			content,
			action: "optimize-approved",
			reason: `所有者批准优化提案 ${proposal.id}（${(proposal.kinds ?? []).join("、")}）：${proposal.summary}${note ? "；" + note : ""}`,
			evalInfo: { ...proposal.eval, verdict: "pass", approvedAt: new Date(now()).toISOString(), proposalId: proposal.id }
		});
		const next = { ...proposal, status: "approved", decidedAt: new Date(now()).toISOString(), decidedBy: actor, reason: note, versionId: written.versionId, rollback: rollbackHint(proposal.key, written.rollbackTo) };
		await atomicWriteFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
		return { ok: true, proposal: next };
	}

	/**
	 * 所有者点名放行一个**未过门**的候选（只开在面板路由上，模型工具没有这个入口）。
	 * 红线类丢弃不可放行；必须写理由；放行本身记 overrides.jsonl + 版本记录（action=optimize-override）。
	 */
	async function override({ discardId, reason }) {
		const id = String(discardId ?? "").trim();
		const why = typeof reason === "string" ? reason.trim() : "";
		if (why === "") throw new UserError("点名放行必须写理由");
		const rec = (await readJsonl(dirs.discards())).find((d) => d.id === id);
		if (!rec) throw new UserError("找不到丢弃记录 " + id, 404);
		if (rec.overridable === false || rec.kind === "redline") throw new UserError("红线类丢弃不可放行（权限 / 安全段落只能人工修改）", 403);
		if (!rec.candidateFile) throw new UserError("这条丢弃记录没有候选正文，无法放行");
		const done = (await readJsonl(dirs.overrides())).find((o) => o.discardId === id);
		if (done) throw new UserError(`这条丢弃记录已在 ${done.at} 放行过`);
		if ((await fileSha(rec.target)) !== rec.baseSha) throw new UserError("技能文件在丢弃之后被改动过，放行会覆盖新内容；不应用", 409);
		const { redlines } = await effective();
		const content = await readText(rec.candidateFile);
		const red = checkRedlines(await readText(rec.target), content, redlines);
		if (!red.ok) throw new UserError("候选正文触碰红线，不可放行", 403);
		const actor = currentWriteContext().actor ?? "unknown";
		const written = await applyVersioned({
			file: rec.target,
			content,
			action: "optimize-override",
			reason: `所有者点名放行未过门候选 ${id}（原因：${rec.reasons.join("；")}）；放行理由：${why}`,
			evalInfo: { suite: evalFile(rec.skill), before: rec.before ?? null, after: rec.score ?? null, verdict: "override", at: new Date(now()).toISOString(), roundId: rec.roundId, discardId: id, gateReasons: rec.reasons }
		});
		const entry = { at: new Date(now()).toISOString(), discardId: id, skill: rec.skill, key: rec.key, actor, reason: why, versionId: written.versionId, rollback: rollbackHint(rec.key, written.rollbackTo) };
		await appendJsonl(dirs.overrides(), entry);
		return { ok: true, override: entry };
	}

	async function status() {
		const eff = await effective();
		const state = await readState();
		return {
			ok: true,
			dir: optimizerRoot(),
			configFile: optimizerConfigFile(),
			configSources: eff.sources,
			configError: eff.fileError,
			config: eff.config,
			redlines: describeRedlines(eff.redlines),
			schedule: {
				enabled: eff.config.enabled,
				idleWindow: eff.config.idleWindow,
				inWindowNow: inIdleWindow(eff.config.idleWindow, now()),
				idleForMinutes: Math.floor((now() - lastActivityAt) / 60_000),
				lastRoundAt: state.lastRoundAt ? new Date(state.lastRoundAt).toISOString() : null,
				lastRoundId: state.lastRoundId,
				lastStatus: state.lastStatus,
				running: running !== null
			},
			proposals: (await listProposals("pending")).map((p) => ({ id: p.id, skill: p.skill, tier: p.tier, kinds: p.kinds, summary: p.summary, before: p.eval?.before, after: p.eval?.after, createdAt: p.createdAt, ...(p.source ? { source: p.source } : {}) })),
			reports: await listReports(5),
			// ：自动应用后的观察名单、退化回滚记录、此后不再自动应用的技能
			regression: await (async () => {
				const w = await readWatches();
				return {
					watching: w.watches.filter((x) => x.status === "watching").map((x) => ({ skill: x.skill, key: x.key, appliedAt: x.appliedAt, appliedVersionId: x.appliedVersionId, rollbackTo: x.rollbackTo, checks: (x.checks ?? []).length, source: x.source })),
					recent: await listRegressions(10),
					blocked: w.blocked
				};
			})()
		};
	}

	return {
		effective,
		status,
		runRound,
		submitCandidate,
		tick,
		decide,
		override,
		getReport,
		listReports,
		listProposals,
		selectCandidates: async (skill) => selectCandidates((await effective()).config, skill),
		noteActivity(at = now()) {
			lastActivityAt = at;
		},
		isRunning: () => running !== null
	};
}
