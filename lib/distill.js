/**
 * 对话蒸馏硬化。
 *
 * 提取器（逐轮 / 定时 / 点名）产出的候选不再直接写库，也不再直接并进已有技能，而是：
 *   1. **草稿**：每个候选成一份草稿（~/.dsh-studio/distill/drafts/<id>.json），带出处——
 *      会话 id、时间、关键轮次定位（按与草稿内容的词重叠挑出的消息序号 + 摘录）、会话日志路径。
 *      草稿不在任何技能根里，模型调不到。守门（guard-content）命中的直接淘汰并留记录。
 *   2. **先查重**：用的 findSimilar 在库里找最像的；≥ dedupe.minScore → 不新建，
 *      交给 #4 出合并提案（合并稿 + 差异 + 评估门预演 + 红线，所有者批准才写）。
 *   3. **评估门**：新技能没有基线，评估场景由「来源会话里的真实请求 + 草稿」生成并冻结在 #3 的评估集目录；
 *      用 #3 的 gateVerdict 判定（基线 = 绝对线 gate.minMean / gate.minCritical）。不过门 → 淘汰，
 *      记录口径同 #3 的 discards.jsonl；过门 → 按 #1 版本化写进技能库（版本记录带 distill 出处）。
 *   4. **节奏**：手动（skillmgr_distill_run，可点名会话）+ 闲时批量（默认关），每批受 G9 上限约束；
 *      每批一份报告：处理条数、过门率、合并去向。
 * 没有旁路：评估门没有开关，草稿也没有「直接放行」的决定。
 */
import { pruneEvolutionStore, readJsonDir } from "./store-retention.js";
import { appendFile, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { UserError } from "./errors.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { distillConfigFile, distillRoot, readDistillConfigFile, resolveDistillConfig } from "./distill-config.js";
import { readSessionLogFile, writeProvenance, writeSkillDual } from "./extractor.js";
import { describeSkill, findSimilar, loadLibrary } from "./governance-scan.js";
import { guardContent, guardTextOf } from "./guard-content.js";
import { inIdleWindow, optimizerRoot, resolveOptimizerConfig } from "./optimizer-config.js";
import { EVAL_SCHEMA, evalFile, gateVerdict, loadEvalSet, scoreSkill, sha256 } from "./optimizer-eval.js";
import { BudgetStop, callWithBudget, createBudget, parseJsonObject } from "./optimizer-model.js";
import { optimizerSkillRoots } from "./optimizer.js";
import { listVersions, skillKeyOf, skillTargetOf } from "./versions.js";
import { runWithWriteContext } from "./write-context.js";
import { GOVERNANCE_DEFAULTS } from "./governance-config.js";

export const DISTILL_REPORT_SCHEMA = 1;
export const DRAFT_STATUSES = Object.freeze(["queued", "published", "failed", "merge-proposed", "merged", "merge-rejected", "discarded"]);

/** 一份草稿连续处理出错多少次后判失败出队（不再占着队首）。 */
export const MAX_DRAFT_ERRORS = 3;
/** 整批都过不去的错（没有模型 / 治理模块不可用）：停批，不记到某一份草稿头上。 */
class BatchAbort extends Error {}

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
	drafts: () => join(distillRoot(), "drafts"),
	reports: () => join(distillRoot(), "reports"),
	discards: () => join(distillRoot(), "discards.jsonl"),
	state: () => join(distillRoot(), "state.json"),
	lock: () => join(distillRoot(), "batch.lock")
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

/** 与 extractor.writeSkillUnversioned 新建分支逐字一致：门评的就是将要写进库的那份文本。 */
export function draftTextOf(cand) {
	const body = cand.body.startsWith("#") ? cand.body : `# ${cand.name}\n\n${cand.body}`;
	const group = typeof cand.group === "string" && cand.group.trim() !== "" ? `metadata:\n  group: ${cand.group.trim()}\n` : "";
	return `---\nname: ${cand.name}\ndescription: ${JSON.stringify(String(cand.description ?? ""))}\n${group}---\n` + "\n" + body + "\n";
}

/** 粗分词：英文单词 + 中文二元组（只用来定位关键轮次，不做判定）。 */
function tokens(text) {
	const out = new Set();
	const s = String(text ?? "").toLowerCase();
	for (const w of s.match(/[a-z0-9_][a-z0-9_.-]{2,}/g) ?? []) out.add(w);
	for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
	return out;
}

/**
 * 关键轮次定位：每个来源会话里挑与草稿内容重叠最多的消息（最多 2 条），turn = 消息序号（从 1 起）。
 * 没有任何重叠的会话仍列出会话 id（turns 为空），保证出处不丢。
 */
export function locateKeyTurns(cand, logs, { perSession = 2, maxSessions = 3 } = {}) {
	const want = tokens([cand.name, cand.description, cand.body].join(" "));
	const sessions = [];
	for (const e of logs ?? []) {
		const log = e?.log;
		if (!log?.session?.id) continue;
		const scored = [];
		(log.msgs ?? []).forEach((m, i) => {
			const t = tokens(m.text);
			if (t.size === 0) return;
			let hit = 0;
			for (const x of t) if (want.has(x)) hit += 1;
			if (hit > 0) scored.push({ turn: i + 1, role: m.role === "user" ? "user" : "assistant", excerpt: clip(m.text, 160), score: Math.round((hit / t.size) * 1000) / 1000, hits: hit });
		});
		scored.sort((a, b) => b.hits - a.hits || b.score - a.score || a.turn - b.turn);
		const turns = scored.slice(0, perSession).sort((a, b) => a.turn - b.turn);
		sessions.push({ id: log.session.id, file: e.file ?? null, createdAt: log.session.createdAt ?? null, cwd: log.session.cwd ?? null, messages: (log.msgs ?? []).length, turns, best: scored[0]?.hits ?? 0 });
	}
	sessions.sort((a, b) => b.best - a.best);
	const relevant = sessions.filter((s) => s.best > 0).slice(0, maxSessions);
	return (relevant.length > 0 ? relevant : sessions.slice(0, maxSessions)).map(({ best, ...s }) => s);
}

/**
 * @param {{
 *   pluginConfig?: object, governance?: object, optimizer?: object, optimizerConfig?: object,
 *   extractConfig: () => Promise<{agentSkillDir?: string, mirrorDir?: string}>,
 *   extract?: (opts: {sessionIds?: string[]}) => Promise<object>,
 *   model?: object | (() => object), logger?: object, now?: () => number, onSkillsChanged?: () => void
 * }} deps
 */
export function createDistill(deps = {}) {
	const now = typeof deps.now === "function" ? deps.now : () => Date.now();
	const logger = deps.logger ?? null;
	const getModel = () => (typeof deps.model === "function" ? deps.model() : deps.model);
	let running = null;
	let lastActivityAt = now();
	let lastCheckAt = 0;
	let lastCheckEveryMs = 0;

	async function effective() {
		const file = await readDistillConfigFile();
		const { config, sources } = resolveDistillConfig(deps.pluginConfig, file.value);
		const optEff = deps.optimizer?.effective ? await deps.optimizer.effective() : { config: resolveOptimizerConfig(deps.optimizerConfig, null).config };
		const govEff = deps.governance?.effective ? await deps.governance.effective() : null;
		const roots = govEff?.roots ?? optimizerSkillRoots(optEff.config);
		const similarity = govEff?.config?.merge ?? GOVERNANCE_DEFAULTS.merge;
		return { config, sources, fileError: file.error, optimizer: optEff.config, roots, similarity };
	}

	// ── 草稿存储 ──
	const draftFile = (id) => join(dirs.drafts(), id + ".json");
	async function loadDraft(id) {
		if (!/^draft-[\w-]+$/.test(String(id ?? ""))) return null;
		return readJson(draftFile(id), null);
	}
	async function saveDraft(d) {
		await writeJson(draftFile(d.id), d);
		return d;
	}
	// B3：草稿文件按 (mtimeMs, size) 缓存解析结果——终局草稿只增不改，以前每次列表（每轮提取、每次状态查询、
	// 每次闲时检查）都把它们全部重读重解析一遍。按状态筛先在缓存上筛，返回的是深拷贝：调用方改了不会串到缓存里。
	const draftCache = new Map();
	async function listDrafts(filter = {}) {
		let names = [];
		try {
			names = await readdir(dirs.drafts());
		} catch {
			draftCache.clear();
			return [];
		}
		const files = names.filter((x) => x.endsWith(".json")).sort().map((n) => join(dirs.drafts(), n));
		const stats = new Array(files.length);
		// stat 有界并行（Windows 上逐个 stat 两千个文件要上百毫秒）
		for (let i = 0; i < files.length; i += 64) {
			const part = await Promise.all(files.slice(i, i + 64).map((f) => stat(f).catch(() => null)));
			for (let k = 0; k < part.length; k += 1) stats[i + k] = part[k];
		}
		const out = [];
		const live = new Set(files);
		for (let i = 0; i < files.length; i += 1) {
			const file = files[i];
			const st = stats[i];
			if (st === null) continue;
			let hit = draftCache.get(file);
			if (hit === undefined || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
				let d = null;
				try {
					d = JSON.parse(await readFile(file, "utf8"));
				} catch {
					d = null;
				}
				hit = { mtimeMs: st.mtimeMs, size: st.size, d };
				draftCache.set(file, hit);
			}
			if (!hit.d) continue;
			if (filter.status && hit.d.status !== filter.status) continue;
			out.push(structuredClone(hit.d));
		}
		for (const file of draftCache.keys()) if (!live.has(file)) draftCache.delete(file);
		return out;
	}
	/** B3：草稿队列此刻还收不收（提取器在调模型之前问一句）。 */
	async function admit() {
		const { config } = await effective();
		const queued = (await listDrafts({ status: "queued" })).length;
		return queued >= config.maxQueued ? { ok: false, reason: `草稿队列已满（${queued}/${config.maxQueued}）`, queued, max: config.maxQueued } : { ok: true, queued, max: config.maxQueued };
	}
	async function recordDiscard(rec) {
		const full = { id: newId("ddisc", now()), at: new Date(now()).toISOString(), ...rec };
		await mkdir(distillRoot(), { recursive: true });
		await appendFile(dirs.discards(), JSON.stringify(full) + "\n", "utf8");
		return full;
	}
	const pushHistory = (d, change, extra = {}) => {
		d.history = [...(d.history ?? []), { at: new Date(now()).toISOString(), change, ...extra }];
	};

	/**
	 * 提取器回调：候选 → 草稿（不调模型、不写库）。
	 * @returns {Promise<{drafts: object[], skipped: number, guarded: object[], queued: number}>}
	 */
	async function ingest(cands, info = {}) {
		const { config } = await effective();
		const existing = await listDrafts();
		const live = existing.filter((d) => d.status !== "discarded");
		let queued = live.filter((d) => d.status === "queued").length;
		// 已经有结论的草稿（所有者丢弃 / 没过门 / 合并被拒 / 已入库 / 已并入）：提取器没有逐会话游标，每一轮都把最近的会话重新送来，
		// 旧写法只挡「同 sha 且未丢弃」和「同名且还在排队」，于是所有者刚丢弃的草稿下一轮原样回来。队列满而没收的不算有结论。
		const decided = existing.filter((d) => ["discarded", "failed", "merge-rejected", "published", "merged"].includes(d.status) && d.failure?.kind !== "queue-full");
		const explicit = info.named === true || info.forceReview === true;
		const at = new Date(Number(info.at ?? now())).toISOString();
		const drafts = [];
		const guarded = [];
		const overflow = [];
		let skipped = 0;
		for (const c of cands ?? []) {
			if (!c?.name || !c?.body) continue;
			const text = draftTextOf(c);
			const sha = sha256(text);
			if (live.some((d) => d.sha === sha || (d.name === c.name && (d.status === "queued" || d.status === "merge-proposed")))) {
				skipped += 1;
				continue;
			}
			const turnsBySession = locateKeyTurns(c, info.logs ?? []);
			if (!explicit) {
				// 同内容已有结论 → 不再收；同名且这次的出处会话没有一个是新的（没有新证据）→ 也不再收。
				// 用户点名要的（named / 记住）不受此限；出处定位不到会话时只按内容判，不按名字判。
				const support = turnsBySession.map((s) => s.id);
				const known = (d) => new Set((d.provenance?.sessions ?? []).map((s) => s.id));
				if (decided.some((d) => d.sha === sha || (d.name === c.name && support.length > 0 && support.every((id) => known(d).has(id))))) {
					skipped += 1;
					continue;
				}
			}
			const provenance = {
				extractedAt: at,
				trigger: info.named ? "named" : info.forceReview ? "remember" : "extract",
				sessionIds: info.sessions ?? turnsBySession.map((s) => s.id),
				digest: info.digest ?? null,
				sessions: turnsBySession
			};
			const d = { v: 1, id: newId("draft", now()), status: "queued", createdAt: at, name: c.name, description: c.description ?? "", group: c.group ?? "", rationale: c.rationale ?? "", body: c.body, text, sha, provenance, history: [] };
			const g = guardContent(guardTextOf(c));
			if (!g.ok) {
				d.status = "failed";
				const rec = await recordDiscard({ kind: "guard", draftId: d.id, skill: d.name, reasons: g.hits.map((h) => "守门命中：" + h.label) });
				d.failure = { kind: "guard", discardId: rec.id, reasons: rec.reasons };
				pushHistory(d, "guarded", { discardId: rec.id });
				guarded.push({ name: c.name, hits: g.hits });
			} else if (queued >= config.maxQueued) {
				// B3：队列满不再每个候选各落一份 failed 草稿 + 一行 discards（它们本来就不算有结论，
				// 下一轮还会再来）；整批只在 discards 里记一行，草稿文件不落盘
				overflow.push(c.name);
				continue;
			} else {
				queued += 1;
				pushHistory(d, "queued");
			}
			await saveDraft(d);
			live.push(d);
			drafts.push({ id: d.id, name: d.name, status: d.status });
		}
		if (overflow.length > 0) {
			await recordDiscard({ kind: "queue-full", skills: overflow, reasons: [`草稿队列已满（${config.maxQueued}），本轮 ${overflow.length} 份不收：${overflow.join("、")}`] });
			skipped += overflow.length;
		}
		return { drafts, skipped, guarded, queued, overflow };
	}

	// ── 评估门 ──
	/** 评估集：来源会话里的真实请求 + 草稿 → 场景；冻结在 #3 的评估集目录（之后优化回路会复用它当基线集）。 */
	async function ensureDraftEvalSet(d, ctx) {
		const existing = await loadEvalSet(d.name);
		if (existing) return existing;
		const asks = (d.provenance?.sessions ?? []).flatMap((s) => s.turns.filter((t) => t.role === "user").map((t) => `- ${t.excerpt}`)).slice(0, 6);
		const system = "你是技能（SKILL.md）验收测试设计者。只输出 JSON。";
		const prompt = [
			`下面是从对话里蒸馏出来的技能草稿「${d.name}」，以及蒸馏来源会话里用户的真实请求。`,
			`请设计 ${ctx.config.gate.cases} 条验收场景：每条是一个会触发这个技能的用户请求（scenario，优先贴近来源会话里的真实请求），`,
			"以及照这个技能办事时**应当出现的行为**（expect，可检查、具体）。把最核心的场景标 critical:true（至少 1 条）。",
			'输出格式：{"cases":[{"id":"c1","scenario":"…","expect":"…","critical":true}]}',
			"",
			"<source-requests>",
			...(asks.length > 0 ? asks : ["（来源会话里没有定位到与草稿相关的用户消息）"]),
			"</source-requests>",
			"<skill>",
			d.text,
			"</skill>"
		].join("\n");
		const raw = await callWithBudget(ctx.model, ctx.budget, { purpose: "cases", system, prompt, maxTokens: ctx.config.limits.maxOutputTokens, meta: { name: d.name, skillText: d.text, count: ctx.config.gate.cases, draftId: d.id } });
		const seen = new Set();
		const cases = [];
		for (const [i, c] of (Array.isArray(parseJsonObject(raw)?.cases) ? parseJsonObject(raw).cases : []).entries()) {
			const scenario = String(c?.scenario ?? "").trim();
			const expect = String(c?.expect ?? c?.expected ?? "").trim();
			if (scenario === "" || expect === "") continue;
			let id = String(c.id ?? `c${i + 1}`).trim().replace(/[^\w-]+/g, "_") || `c${i + 1}`;
			while (seen.has(id)) id += "_";
			seen.add(id);
			cases.push({ id, scenario: scenario.slice(0, 600), expect: expect.slice(0, 600), critical: c.critical === true });
		}
		if (cases.length === 0) throw new Error("模型没有给出可用的验收场景");
		if (!cases.some((c) => c.critical)) cases[0].critical = true;
		const set = { v: EVAL_SCHEMA, skill: d.name, key: "draft:" + d.id, createdAt: new Date(now()).toISOString(), createdFrom: d.sha, generatedBy: "model", origin: "distill", draftId: d.id, cases: cases.slice(0, ctx.config.gate.cases) };
		await mkdir(join(optimizerRoot(), "evals"), { recursive: true });
		await atomicWriteFile(evalFile(d.name), JSON.stringify(set, null, 2) + "\n", "utf8");
		return set;
	}

	/** 过门后的写入：#1 版本化（writeSkill 内部记版本），版本记录带 distill 出处。 */
	async function publish(d, verdictInfo, ctx) {
		const ext = (await deps.extractConfig?.()) ?? {};
		if (!ext.agentSkillDir) throw new Error("没有可写的技能根（提取器配置 agentSkillDir 为空）");
		const cand = { name: d.name, description: d.description, group: d.group, body: d.body };
		const distillMeta = { draftId: d.id, roundId: ctx.roundId, extractedAt: d.provenance?.extractedAt ?? null, sessions: (d.provenance?.sessions ?? []).map((s) => ({ id: s.id, turns: s.turns.map((t) => t.turn), file: s.file })), eval: { suite: verdictInfo.suite, mean: verdictInfo.mean, verdict: "pass", gate: verdictInfo.gate } };
		const r = await runWithWriteContext({ actor: "distill:gate-pass", sessionIds: d.provenance?.sessionIds ?? [], reason: `蒸馏草稿 ${d.id} 过评估门（均分 ${verdictInfo.mean} ≥ ${verdictInfo.gate.minMean}）`, distill: distillMeta }, () => writeSkillDual(ext.agentSkillDir, ext.mirrorDir, cand));
		if (!r.written || r.written.length === 0) return { ok: false, reason: r.results?.map((x) => x.message).join("；") || "写入失败" };
		try {
			await writeProvenance({ name: d.name, action: "SAVE", sessions: d.provenance?.sessionIds ?? [], digest: d.provenance?.digest ?? null, rationale: d.rationale ?? "", at: now(), source: "distill" });
		} catch {
			/* 旧证据链 best-effort */
		}
		const key = skillKeyOf(skillTargetOf(r.written[0]));
		const versionId = (await listVersions({ key, limit: 1 })).records?.[0]?.id ?? null;
		try {
			deps.onSkillsChanged?.();
		} catch {
			/* ignore */
		}
		return { ok: true, paths: r.written, key, versionId };
	}

	async function processDraft(d, library, ctx, entry) {
		// ① 先查重（#4 候选发现）
		if (d.skipDedupe !== true) {
			const view = describeSkill(d.text, { dirName: d.name });
			const top = findSimilar(view, library, ctx.similarity)[0];
			if (top && top.score >= ctx.config.dedupe.minScore) {
				if (!deps.governance?.proposeDraftMerge) throw new BatchAbort("治理模块不可用，出不了合并提案");
				if (ctx.model === null) ctx.model = getModel();
				if (!ctx.model) throw new BatchAbort("没有可用的模型（宿主 ctx.llm 不可用）");
				entry.into = top.name;
				entry.similarity = top.score;
				const reasons = [top.sameName ? "与库里技能同名" : `相似度 ${top.score} ≥ ${ctx.config.dedupe.minScore}`, `触发 ${top.evidence.trigger.sim} · 步骤 ${top.evidence.steps.sim} · 工具 ${top.evidence.tools.sim}`];
				const p = await deps.governance.proposeDraftMerge({ draft: { draftId: d.id, name: d.name, key: "draft:" + d.id, text: d.text, sha: d.sha, provenance: { extractedAt: d.provenance?.extractedAt, sessionIds: d.provenance?.sessionIds ?? [] } }, keepKey: top.key, score: top.score, reasons, evidence: [{ kind: "similarity", ...top.evidence }] }, { budget: ctx.budget, model: ctx.model, roundId: ctx.roundId });
				d.merge = { into: top.name, key: top.key, score: top.score, proposalId: p.id, outcome: p.status, at: new Date(now()).toISOString() };
				if (p.status === "pending") {
					d.status = "merge-proposed";
					pushHistory(d, "merge-proposed", { proposalId: p.id, into: top.name });
					Object.assign(entry, { outcome: "merge-proposed", proposalId: p.id });
				} else {
					d.status = "failed";
					const rec = await recordDiscard({ kind: "merge-" + p.status, draftId: d.id, skill: d.name, into: top.name, proposalId: p.id, reasons: p.blockReasons ?? [] });
					d.failure = { kind: "merge-" + p.status, discardId: rec.id, reasons: rec.reasons };
					pushHistory(d, "merge-" + p.status, { proposalId: p.id, discardId: rec.id });
					Object.assign(entry, { outcome: "merge-" + p.status, proposalId: p.id, reasons: rec.reasons });
				}
				return;
			}
		}
		// ② 评估门
		if (ctx.model === null) ctx.model = getModel();
		if (!ctx.model) throw new BatchAbort("没有可用的模型（宿主 ctx.llm 不可用）");
		const set = await ensureDraftEvalSet(d, ctx);
		const scored = await scoreSkill({ model: ctx.model, budget: ctx.budget, name: d.name, text: d.text, evalSet: set, maxOutputTokens: ctx.config.limits.maxOutputTokens, label: "draft" });
		const gate = { minMean: ctx.config.gate.minMean, minCritical: ctx.config.gate.minCritical };
		const line = { mean: gate.minMean, cases: set.cases.map((c) => ({ id: c.id, critical: c.critical, score: c.critical ? gate.minCritical : null })) };
		const v = gateVerdict(line, scored, { minDelta: 0, criticalTolerance: 0 }, { absoluteLine: true });
		const verdictInfo = { suite: evalFile(d.name), mean: scored.mean, cases: scored.cases, gate, reasons: v.reasons, at: new Date(now()).toISOString(), roundId: ctx.roundId };
		d.eval = { ...verdictInfo, verdict: v.pass ? "pass" : "fail" };
		entry.mean = scored.mean;
		if (!v.pass) {
			d.status = "failed";
			const rec = await recordDiscard({ kind: "gate", draftId: d.id, skill: d.name, roundId: ctx.roundId, candidateSha: d.sha, reasons: v.reasons, eval: { suite: verdictInfo.suite, mean: scored.mean, cases: scored.cases, gate } });
			d.failure = { kind: "gate", discardId: rec.id, reasons: v.reasons };
			pushHistory(d, "gate-failed", { discardId: rec.id, mean: scored.mean });
			Object.assign(entry, { outcome: "gate-failed", reasons: v.reasons });
			return;
		}
		const w = await publish(d, verdictInfo, ctx);
		if (!w.ok) {
			d.status = "failed";
			const rec = await recordDiscard({ kind: "publish", draftId: d.id, skill: d.name, roundId: ctx.roundId, reasons: [w.reason] });
			d.failure = { kind: "publish", discardId: rec.id, reasons: rec.reasons };
			pushHistory(d, "publish-failed", { discardId: rec.id });
			Object.assign(entry, { outcome: "publish-failed", reasons: rec.reasons });
			return;
		}
		d.status = "published";
		d.published = { at: new Date(now()).toISOString(), paths: w.paths, key: w.key, versionId: w.versionId };
		pushHistory(d, "published", { versionId: w.versionId });
		Object.assign(entry, { outcome: "published", versionId: w.versionId, key: w.key, file: w.paths?.[0] ?? null });
	}

	async function acquireLock(maxMs) {
		await mkdir(distillRoot(), { recursive: true });
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
				if (held && now() - Number(held.at) < maxMs + 60_000) throw new UserError(`另一批蒸馏正在进行（pid ${held.pid}），本次不启动`, 409);
				await rm(file, { force: true });
			}
		}
		throw new UserError("拿不到蒸馏批次锁", 409);
	}

	/**
	 * 跑一批：队列里的草稿（或指定的 ids）逐份 查重 → 合并提案 / 评估门 → 入库 / 淘汰。
	 * @param {{trigger?: "manual"|"auto", ids?: string[]}} [opts]
	 */
	/**
	 * 批次写回一份草稿。处理一份草稿要好几次模型调用，期间所有者可能已经 decide() 过它；
	 * 旧写法拿处理前读到的那份直接覆盖，所有者的决定就没了。写回前重读：盘上已经不是 queued，
	 * 以盘上的为准、只把本批的结果追加进历史；否则照常写。
	 */
	async function saveBatchDraft(d, entry) {
		const current = await loadDraft(d.id);
		if (current !== null && current.status !== "queued") {
			pushHistory(current, "batch-result-not-applied", { batchOutcome: entry.outcome, batchStatus: d.status });
			entry.note = `处理期间草稿已被改为 ${current.status}，以那次决定为准（本批结果只记进历史）`;
			await saveDraft(current);
			return false;
		}
		await saveDraft(d);
		return true;
	}

	async function runBatch(opts = {}) {
		if (running !== null) throw new UserError("已有一批蒸馏在进行，本次不启动", 409);
		const trigger = opts.trigger === "auto" ? "auto" : "manual";
		const eff = await effective();
		const release = await acquireLock(eff.config.limits.maxDurationMs);
		const roundId = newId("dist", now());
		const report = { v: DISTILL_REPORT_SCHEMA, roundId, trigger, startedAt: new Date(now()).toISOString(), status: "completed", counts: { queuedBefore: 0, processed: 0, published: 0, gateFailed: 0, mergeProposed: 0, mergeFailed: 0, otherFailed: 0, deferred: 0 }, passRate: null, drafts: [], merges: [], budget: null, extract: opts.extract ?? null };
		running = (async () => {
			const budget = createBudget(eff.config.limits, now);
			const ctx = { ...eff, roundId, budget, model: null };
			try {
				let queue = (await listDrafts({ status: "queued" })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
				if (Array.isArray(opts.ids)) queue = queue.filter((d) => opts.ids.includes(d.id));
				report.counts.queuedBefore = queue.length;
				const library = await loadLibrary(eff.roots);
				let firstError = null;
				const take = queue.slice(0, eff.config.limits.maxDrafts);
				for (const d of queue.slice(eff.config.limits.maxDrafts)) report.drafts.push({ id: d.id, name: d.name, outcome: "deferred", note: `超过每批上限 ${eff.config.limits.maxDrafts} 份，留在队列` });
				report.counts.deferred = queue.length - take.length;
				for (const queued of take) {
					const entry = { id: queued.id, name: queued.name, outcome: "running" };
					report.drafts.push(entry);
					// · A6：队列是批首读的；轮到它时重读一次——期间被所有者 decide() 过（淘汰）就不再处理
					const d = await loadDraft(queued.id);
					if (d === null || d.status !== "queued") {
						entry.outcome = "skipped";
						entry.note = d === null ? "草稿已不在" : `轮到它时已是 ${d.status}（所有者已处理），跳过`;
						continue;
					}
					try {
						await processDraft(d, library, ctx, entry);
					} catch (error) {
						if (error instanceof BudgetStop) {
							entry.outcome = "stopped";
							throw error;
						}
						entry.outcome = "error";
						entry.reasons = [error instanceof Error ? error.message : String(error)];
						pushHistory(d, "error", { reason: entry.reasons[0] });
						// 整批都过不去的错（没有模型 / 治理模块不可用）：不记到这份草稿头上，直接停
						if (error instanceof BatchAbort) {
							await saveBatchDraft(d, entry);
							throw error;
						}
						// 这份草稿自己的错：记一次，继续处理后面的。旧写法在这里直接抛——草稿留在 queued、排在队首（按时间最老优先），
						// 之后每一批都先在它身上花掉模型调用再报错，排在后面的草稿永远轮不到。连错 MAX_DRAFT_ERRORS 次判失败出队。
						d.errorCount = (Number(d.errorCount) || 0) + 1;
						if (d.errorCount >= MAX_DRAFT_ERRORS) {
							d.status = "failed";
							const rec = await recordDiscard({ kind: "error", draftId: d.id, skill: d.name, reasons: [`连续 ${d.errorCount} 次处理出错：${entry.reasons[0]}`] });
							d.failure = { kind: "error", discardId: rec.id, reasons: rec.reasons };
							pushHistory(d, "failed", { discardId: rec.id });
							entry.outcome = "failed";
						}
						await saveBatchDraft(d, entry);
						report.counts.otherFailed += 1;
						firstError ??= `${d.name}：${entry.reasons[0]}`;
						continue;
					}
					await saveBatchDraft(d, entry);
					// 本批刚入库的技能要立刻进查重视野：库只在批首读一次，同一批里两份内容相近、名字不同的草稿此前会双双入库
					if (entry.outcome === "published" && entry.key) library.push(describeSkill(d.text, { dirName: d.name, key: entry.key, file: entry.file ?? "" }));
					report.counts.processed += 1;
					if (entry.outcome === "published") report.counts.published += 1;
					else if (entry.outcome === "gate-failed") report.counts.gateFailed += 1;
					else if (entry.outcome === "merge-proposed") report.counts.mergeProposed += 1;
					else if (String(entry.outcome).startsWith("merge-")) report.counts.mergeFailed += 1;
					else report.counts.otherFailed += 1;
					if (entry.into) report.merges.push({ draftId: d.id, name: d.name, into: entry.into, similarity: entry.similarity, proposalId: entry.proposalId ?? null, outcome: entry.outcome });
				}
				if (report.counts.queuedBefore === 0) report.status = "empty";
				else if (firstError !== null) {
					report.status = "error";
					report.stop = { limit: "error", detail: firstError };
				}
			} catch (error) {
				if (error instanceof BudgetStop) {
					report.status = "budget-stop";
					report.stop = { limit: error.limit, detail: error.detail };
				} else {
					report.status = "error";
					report.stop = { limit: "error", detail: error instanceof Error ? error.message : String(error) };
				}
			} finally {
				const gated = report.counts.published + report.counts.gateFailed;
				report.passRate = gated === 0 ? null : Math.round((report.counts.published / gated) * 1000) / 1000;
				report.budget = budget.snapshot();
				report.finishedAt = new Date(now()).toISOString();
				// · A6：报告写失败（盘满 / 被占用）也必须放锁——旧写法 release 排在写报告之后，
				// 写报告一抛，轮次锁要等 maxDurationMs + 60s 才过期，这段时间手动 / 自动批次都起不来
				try {
					report.markdown = renderDistillReport(report);
					await writeJson(join(dirs.reports(), roundId + ".json"), report);
					await atomicWriteFile(join(dirs.reports(), roundId + ".md"), report.markdown + "\n", "utf8");
					await writeJson(dirs.state(), { ...(await readJson(dirs.state(), {})), lastRoundAt: now(), lastRoundId: roundId, lastStatus: report.status });
					// C5：每轮收尾做一次保留（只增不减的工作目录），失败只记一笔
					await pruneEvolutionStore({ draftsDir: dirs.drafts(), reportsDir: dirs.reports(), discardsFile: dirs.discards(), now: now() }).catch((error) => logger?.warn?.("[dsh-studio] 蒸馏工作目录保留失败：" + (error instanceof Error ? error.message : String(error))));
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

	/** 手动：点名会话 → 先蒸馏出草稿，再对这批草稿跑一批；不点名 → 只处理队列。 */
	async function runManual({ sessionId, extract = undefined } = {}) {
		const sid = typeof sessionId === "string" ? sessionId.trim() : "";
		if (sid !== "" || extract === true) {
			if (typeof deps.extract !== "function") throw new UserError("提取器不可用");
			const r = await deps.extract(sid !== "" ? { sessionIds: [sid] } : {});
			const ids = (r?.drafts ?? []).filter((d) => d.status === "queued").map((d) => d.id);
			const summary = { ok: r?.ok !== false, message: r?.message ?? "", drafts: r?.drafts ?? [] };
			if (r?.ok === false) return { roundId: null, status: "extract-failed", extract: summary, counts: null, markdown: "蒸馏未能产出草稿：" + (r?.message ?? "") };
			return runBatch({ trigger: "manual", ids: sid !== "" ? ids : undefined, extract: summary });
		}
		return runBatch({ trigger: "manual" });
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
		if ((await listDrafts({ status: "queued" })).length === 0) return { ran: false, reason: "empty" };
		const report = await runBatch({ trigger: "auto" });
		return { ran: true, reason: "ok", roundId: report.roundId, status: report.status };
	}

	/** #4 合并提案（草稿作来源）被所有者批准 / 拒绝 → 草稿状态跟着走。 */
	async function onMergeDecision(p) {
		const id = p?.drop?.draftId;
		const d = await loadDraft(id);
		if (!d) return;
		if (p.status === "approved") {
			d.status = "merged";
			d.merge = { ...(d.merge ?? {}), outcome: "approved", versionId: p.versionId, decidedAt: p.decidedAt };
			pushHistory(d, "merged", { proposalId: p.id, into: p.keep?.name, versionId: p.versionId });
		} else if (p.status === "rejected") {
			d.status = "merge-rejected";
			d.merge = { ...(d.merge ?? {}), outcome: "rejected", decidedAt: p.decidedAt, reason: p.reason ?? "" };
			pushHistory(d, "merge-rejected", { proposalId: p.id, reason: p.reason ?? "" });
		} else return;
		await saveDraft(d);
	}
	deps.governance?.onDraftDecision?.(onMergeDecision);

	/**
	 * 所有者对草稿的决定：discard（淘汰，留记录）/ requeue（重新排队；合并提案被拒的草稿重排时跳过查重，直接过门）。
	 * 没有「直接放行」：草稿要进库只能过评估门。
	 */
	async function decide({ id, decision, reason } = {}) {
		const d = await loadDraft(id);
		if (!d) throw new UserError("找不到草稿 " + String(id ?? ""), 404);
		const note = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
		if (decision === "discard") {
			if (!["queued", "failed", "merge-rejected"].includes(d.status)) throw new UserError(`草稿 ${d.id} 是 ${d.status}，不能淘汰`);
			const rec = await recordDiscard({ kind: "owner", draftId: d.id, skill: d.name, reasons: [note || "所有者淘汰"] });
			d.status = "discarded";
			pushHistory(d, "discarded", { discardId: rec.id, reason: note });
		} else if (decision === "requeue") {
			if (!["failed", "merge-rejected", "discarded"].includes(d.status)) throw new UserError(`草稿 ${d.id} 是 ${d.status}，不需要重排`);
			if (d.status === "merge-rejected") d.skipDedupe = true;
			d.status = "queued";
			delete d.failure;
			pushHistory(d, "requeued", { reason: note, skipDedupe: d.skipDedupe === true });
		} else throw new UserError("草稿的 decision 只能是 discard 或 requeue（没有直接放行：进库只能过评估门）");
		await saveDraft(d);
		return { ok: true, draft: summarizeDraft(d) };
	}

	/** 来源跳转：读出处里的会话日志，给出关键轮次前后各 2 条消息。 */
	async function source(id) {
		const d = await loadDraft(id);
		if (!d) throw new UserError("找不到草稿 " + String(id ?? ""), 404);
		const sessions = [];
		for (const s of d.provenance?.sessions ?? []) {
			const out = { id: s.id, file: s.file, createdAt: s.createdAt, cwd: s.cwd, turns: s.turns, context: [], readable: false };
			if (s.file) {
				const log = await readSessionLogFile(s.file);
				if (log && log.session?.id === s.id) {
					out.readable = true;
					const want = new Set();
					for (const t of s.turns) for (let i = t.turn - 2; i <= t.turn + 2; i++) if (i >= 1 && i <= log.msgs.length) want.add(i);
					out.context = [...want].sort((a, b) => a - b).map((i) => ({ turn: i, role: log.msgs[i - 1].role === "user" ? "user" : "assistant", key: s.turns.some((t) => t.turn === i), text: clip(log.msgs[i - 1].text, 400) }));
				}
			}
			sessions.push(out);
		}
		return { ok: true, draftId: d.id, name: d.name, extractedAt: d.provenance?.extractedAt ?? null, sessions };
	}

	function summarizeDraft(d) {
		return { id: d.id, name: d.name, status: d.status, createdAt: d.createdAt, description: clip(d.description, 120), sessions: (d.provenance?.sessions ?? []).map((s) => ({ id: s.id, turns: s.turns.map((t) => t.turn) })), eval: d.eval ? { verdict: d.eval.verdict, mean: d.eval.mean } : null, failure: d.failure ?? null, merge: d.merge ?? null, published: d.published ?? null };
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
			if (r) out.push({ roundId: r.roundId, trigger: r.trigger, status: r.status, startedAt: r.startedAt, counts: r.counts, passRate: r.passRate, merges: r.merges, stop: r.stop ?? null });
		}
		return out;
	}

	async function status({ id } = {}) {
		const eff = await effective();
		const state = await readJson(dirs.state(), {});
		const drafts = await listDrafts();
		const counts = drafts.reduce((m, d) => ((m[d.status] = (m[d.status] ?? 0) + 1), m), {});
		const discards = (await readJsonl(dirs.discards())).slice(-20).reverse();
		const out = {
			ok: true,
			dir: distillRoot(),
			configFile: distillConfigFile(),
			configSources: eff.sources,
			configError: eff.fileError,
			config: eff.config,
			roots: eff.roots,
			schedule: { inWindowNow: inIdleWindow(eff.config.idleWindow, now()), lastRoundAt: state.lastRoundAt ? new Date(state.lastRoundAt).toISOString() : null, lastRoundId: state.lastRoundId ?? null, lastStatus: state.lastStatus ?? null, running: running !== null },
			counts,
			queue: drafts.filter((d) => d.status === "queued").map(summarizeDraft),
			drafts: drafts.filter((d) => d.status !== "queued").slice(-30).reverse().map(summarizeDraft),
			discards,
			reports: await listReports(5)
		};
		if (id) {
			const d = await loadDraft(id);
			if (!d) throw new UserError("找不到草稿 " + String(id), 404);
			out.draft = d;
		}
		return out;
	}

	async function getReport(rid) {
		const id = String(rid ?? "").trim();
		if (id === "") {
			const latest = (await listReports(1))[0];
			if (!latest) throw new UserError("还没有任何蒸馏报告", 404);
			return getReport(latest.roundId);
		}
		if (!/^dist-[\w-]+$/.test(id)) throw new UserError("报告 id 不合法：" + id);
		const report = await readJson(join(dirs.reports(), id + ".json"), null);
		if (!report) throw new UserError("找不到报告 " + id, 404);
		return { report, markdown: report.markdown ?? "" };
	}

	return { effective, ingest, admit, runBatch, runManual, tick, decide, source, status, getReport, listDrafts, onMergeDecision, noteActivity: () => (lastActivityAt = now()) };
}

const OUTCOME = { skipped: "已被所有者处理，跳过", published: "过门入库", "gate-failed": "未过门淘汰", "merge-proposed": "转合并提案", "merge-gate-failed": "合并预演不过门", "merge-blocked": "合并稿碰红线", "merge-discarded": "合并稿无效", "publish-failed": "写入失败", deferred: "留队列", stopped: "停批", error: "出错", failed: "多次出错，判失败出队" };

export function renderDistillReport(r) {
	const c = r.counts;
	const lines = [
		`# 蒸馏报告 ${r.roundId}`,
		"",
		`- 触发：${r.trigger === "auto" ? "闲时批量" : "手动"}；状态：**${r.status}**${r.stop ? `（${r.stop.limit}：${r.stop.detail}）` : ""}`,
		r.extract ? `- 蒸馏：${r.extract.message}` : "",
		`- 队列 ${c.queuedBefore} 份，本批处理 ${c.processed} 份（留队列 ${c.deferred}）：过门入库 ${c.published}、未过门 ${c.gateFailed}、转合并提案 ${c.mergeProposed}、合并不成 ${c.mergeFailed}、其它失败 ${c.otherFailed}`,
		`- 过门率：${r.passRate === null ? "—（本批没有走评估门的草稿）" : Math.round(r.passRate * 100) + "%"}`,
		r.budget ? `- 花费：模型 ${r.budget.calls}/${r.budget.limits.maxModelCalls} 次 · ${r.budget.tokens}/${r.budget.limits.maxTokens} token · ${r.budget.ms} ms` : ""
	].filter(Boolean);
	if (r.status === "empty") lines.push("", "队列里没有待处理的草稿。");
	if (r.drafts.length > 0) {
		lines.push("", "## 草稿");
		for (const d of r.drafts) lines.push(`- ${d.id} · ${d.name}：${OUTCOME[d.outcome] ?? d.outcome}${d.mean !== undefined ? ` · 均分 ${d.mean}` : ""}${d.versionId ? " · 版本 " + d.versionId : ""}${d.reasons?.length ? " · " + d.reasons.join("；") : ""}${d.note ? " · " + d.note : ""}`);
	}
	if (r.merges.length > 0) {
		lines.push("", "## 合并去向");
		for (const m of r.merges) lines.push(`- ${m.name} → ${m.into}（相似度 ${m.similarity}）：${OUTCOME[m.outcome] ?? m.outcome}${m.proposalId ? " · 提案 " + m.proposalId + "（skillmgr_governance_decide 处理）" : ""}`);
	}
	return lines.join("\n");
}
