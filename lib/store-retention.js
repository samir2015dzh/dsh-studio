/**
 * C5：进化回路（优化 / 治理 / 蒸馏）各自的工作目录只增不减——
 * `candidates/*.md`、`proposals/*.json`、`reports/`、`discards.jsonl`、蒸馏的终局草稿，
 * 而且每次状态查询都把提案目录整个重读一遍。这里放两件事：
 *
 *   1. readJsonDir：按 (mtimeMs, size) 缓存目录里每个 JSON 的解析结果，返回深拷贝（调用方改了不串到缓存）；
 *   2. pruneEvolutionStore：每轮结束时做一次保留——
 *        - 提案：未决的（pending）永远留；已决的按 decidedAt / createdAt 超过 keepDays 才删；
 *        - discards：超过 keepDays 的行删掉（放行 override 只认还在的那些，和「文件在丢弃之后被改过就不许放行」是一个意思）；
 *        - 候选正文：被留下的提案 / discards 引用的不删，其余超过 keepDays 的删；
 *        - 报告：只留最近 keepReports 轮（.json 与 .md 成对）；
 *        - 草稿（蒸馏）：终局状态且超过 keepDays 的删（排队中 / 待合并的永远留）。
 *      全部失败只记一笔，不影响轮次本身。
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWriteFile } from "./fs-atomic.js";

export const RETENTION_DEFAULTS = Object.freeze({ keepDays: 90, keepReports: 100 });

const DAY_MS = 86_400_000;

/**
 * 读目录里全部 *.json（按文件名排序），每个文件按 (mtimeMs, size) 复用上次的解析结果。
 * @param {Map<string, {mtimeMs:number, size:number, value:any}>} cache 调用方持有（每个目录一份）
 * @returns {Promise<any[]>} 深拷贝；解析失败的跳过
 */
export async function readJsonDir(dir, cache) {
	let names = [];
	try {
		names = await readdir(dir);
	} catch {
		cache.clear();
		return [];
	}
	const files = names.filter((n) => n.endsWith(".json")).sort().map((n) => join(dir, n));
	const out = [];
	const live = new Set(files);
	for (let i = 0; i < files.length; i += 64) {
		const part = await Promise.all(
			files.slice(i, i + 64).map(async (file) => {
				let st;
				try {
					st = await stat(file);
				} catch {
					return null;
				}
				const hit = cache.get(file);
				if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
				let value = null;
				try {
					value = JSON.parse(await readFile(file, "utf8"));
				} catch {
					value = null;
				}
				cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
				return value;
			})
		);
		for (const value of part) if (value !== null && value !== undefined) out.push(structuredClone(value));
	}
	for (const file of cache.keys()) if (!live.has(file)) cache.delete(file);
	return out;
}

const timeOf = (...values) => {
	for (const v of values) {
		const t = typeof v === "number" ? v : Date.parse(String(v ?? ""));
		if (Number.isFinite(t)) return t;
	}
	return NaN;
};

async function listNames(dir) {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

/**
 * @param {{
 *   proposalsDir?: string, candidatesDir?: string, reportsDir?: string, discardsFile?: string, draftsDir?: string,
 *   now?: number, keepDays?: number, keepReports?: number,
 *   isOpenProposal?: (p: any) => boolean, isOpenDraft?: (d: any) => boolean
 * }} opts
 */
export async function pruneEvolutionStore(opts) {
	const now = Number.isFinite(opts.now) ? opts.now : Date.now();
	const keepDays = Number.isFinite(opts.keepDays) && opts.keepDays > 0 ? opts.keepDays : RETENTION_DEFAULTS.keepDays;
	const keepReports = Number.isInteger(opts.keepReports) && opts.keepReports > 0 ? opts.keepReports : RETENTION_DEFAULTS.keepReports;
	const cutoff = now - keepDays * DAY_MS;
	const isOpenProposal = opts.isOpenProposal ?? ((p) => p?.status === "pending");
	const result = { proposals: 0, discards: 0, candidates: 0, reports: 0, drafts: 0 };
	const referenced = new Set();
	const ref = (file) => {
		if (typeof file === "string" && file !== "") referenced.add(basename(file));
	};

	if (opts.proposalsDir) {
		for (const name of (await listNames(opts.proposalsDir)).filter((n) => n.endsWith(".json"))) {
			const file = join(opts.proposalsDir, name);
			let p = null;
			try {
				p = JSON.parse(await readFile(file, "utf8"));
			} catch {
				continue; // 读不懂的不动：留给人看
			}
			const t = timeOf(p?.decidedAt, p?.createdAt);
			if (!isOpenProposal(p) && Number.isFinite(t) && t < cutoff) {
				await rm(file, { force: true });
				result.proposals += 1;
				continue;
			}
			ref(p?.candidateFile);
		}
	}

	if (opts.discardsFile) {
		let text = null;
		try {
			text = await readFile(opts.discardsFile, "utf8");
		} catch {
			text = null;
		}
		if (text !== null) {
			const kept = [];
			for (const line of text.split(/\r?\n/)) {
				if (line.trim() === "") continue;
				let rec = null;
				try {
					rec = JSON.parse(line);
				} catch {
					rec = null;
				}
				const t = timeOf(rec?.at);
				if (rec !== null && Number.isFinite(t) && t < cutoff) {
					result.discards += 1;
					continue;
				}
				ref(rec?.candidateFile);
				kept.push(line);
			}
			if (result.discards > 0) await atomicWriteFile(opts.discardsFile, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
		}
	}

	if (opts.candidatesDir) {
		for (const name of await listNames(opts.candidatesDir)) {
			if (referenced.has(name)) continue;
			const file = join(opts.candidatesDir, name);
			try {
				if ((await stat(file)).mtimeMs >= cutoff) continue;
				await rm(file, { force: true });
				result.candidates += 1;
			} catch {
				/* 删不掉下次再说 */
			}
		}
	}

	if (opts.reportsDir) {
		const names = await listNames(opts.reportsDir);
		const ids = [...new Set(names.filter((n) => /\.(?:json|md)$/.test(n)).map((n) => n.replace(/\.(?:json|md)$/, "")))].sort().reverse();
		for (const id of ids.slice(keepReports)) {
			for (const ext of [".json", ".md"]) await rm(join(opts.reportsDir, id + ext), { force: true });
			result.reports += 1;
		}
	}

	if (opts.draftsDir) {
		const isOpenDraft = opts.isOpenDraft ?? ((d) => d?.status === "queued" || d?.status === "merge-proposed");
		for (const name of (await listNames(opts.draftsDir)).filter((n) => n.endsWith(".json"))) {
			const file = join(opts.draftsDir, name);
			let d = null;
			try {
				d = JSON.parse(await readFile(file, "utf8"));
			} catch {
				continue;
			}
			const last = Array.isArray(d?.history) && d.history.length > 0 ? d.history[d.history.length - 1]?.at : undefined;
			const t = timeOf(last, d?.createdAt);
			if (isOpenDraft(d) || !Number.isFinite(t) || t >= cutoff) continue;
			await rm(file, { force: true });
			result.drafts += 1;
		}
	}
	return result;
}
