// N-06 fixture：共享 JSON 状态的并发写保护。全部在伪 HOME 里跑，不读真机状态、不联网。
//
// 每个场景都在「基线版 lib」（git show d99332c:lib/*，拷到临时目录再按基线覆盖）与当前 lib
// 各跑一遍：旧代码给出丢失的具体形态与数字，新代码给出精确计数。
//
// 并发一律用 Promise.all 并发真实入口（markSkillUsed / recordSkillLoads / importSkill /
// pullPending(satisfied→relock) / updateCandidate / archiveCandidates），交错由各周期内部的
// await 天然产生，不注入假延时。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const BASELINE = "d99332c";
const dsh = path.join(home, ".dsh");
const dataDir = path.join(dsh, "dsh-studio");
const external = path.join(home, ".agents", "skills");
const T = 1794016800000;

/** 本批改动过的 lib 文件：基线版要逐个换回去（state-lock.js 在基线里不存在，删掉）。 */
const CHANGED = [
	"lifecycle.js",
	"usage-signals.js",
	"skillsrc.js",
	"pending.js",
	"update-apply.js",
	"extractor.js",
	"snapshot.js",
	"index.js"
];

function buildBaselineLib() {
	const dir = path.join(home, "baseline-lib");
	fs.cpSync(path.join(pluginRoot, "lib"), dir, { recursive: true, filter: (src) => !src.endsWith(".bak-mcp-20261102") });
	for (const file of CHANGED) {
		fs.writeFileSync(path.join(dir, file), execFileSync("git", ["show", `${BASELINE}:lib/${file}`], { cwd: pluginRoot, encoding: "utf8" }), "utf8");
	}
	fs.rmSync(path.join(dir, "state-lock.js"), { force: true });
	return dir;
}

const baselineLib = buildBaselineLib();
const load = (root, name) => import(pathToFileURL(path.join(root, name)).href);

/** 两套 lib 各自独立加载（不同路径 = 不同模块实例），共用同一个伪 HOME。 */
const baseline = {
	lifecycle: await load(baselineLib, "lifecycle.js"),
	skillsrc: await load(baselineLib, "skillsrc.js"),
	pending: await load(baselineLib, "pending.js"),
	extractor: await load(baselineLib, "extractor.js")
};
const current = {
	lifecycle: await load(path.join(pluginRoot, "lib"), "lifecycle.js"),
	skillsrc: await load(path.join(pluginRoot, "lib"), "skillsrc.js"),
	pending: await load(path.join(pluginRoot, "lib"), "pending.js"),
	extractor: await load(path.join(pluginRoot, "lib"), "extractor.js"),
	lock: await load(path.join(pluginRoot, "lib"), "state-lock.js")
};

const lifecycleFile = () => path.join(dataDir, "skill-lifecycle.json");
const candidatesFile = () => path.join(dataDir, "candidates.json");
const archiveFile = () => path.join(dataDir, "candidates-archive.json");
const lockFile = () => path.join(dataDir, "skill-lock.json");
const usageFile = () => path.join(dataDir, "usage-signals.json");
const sha = (file) => {
	try {
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
};
const readJson = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
};
const resetState = (...files) => {
	for (const file of files) fs.rmSync(file, { force: true });
};

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(external, { recursive: true });
fs.writeFileSync(path.join(dataDir, "extractor.json"), JSON.stringify({ agentSkillDir: external }, null, 2) + "\n");

/** 并发跑一批真实入口：基线版会有周期直接抛（同一个 .tmp 被抢先 rename），如实记数不中断。 */
async function runAll(jobs) {
	const settled = await Promise.allSettled(jobs);
	const rejected = settled.filter((s) => s.status === "rejected");
	return {
		ok: settled.length - rejected.length,
		rejected: rejected.length,
		firstError: rejected.length > 0 ? String(rejected[0].reason?.message ?? rejected[0].reason) : ""
	};
}

// ── 场景 1：lifecycle 并发不丢（markSkillUsed × 8 + recordSkillLoads × 8 + 同名 mark × 4）──
const MARK_N = 8;
const LOAD_M = 8;
const SAME_N = 4;

async function raceLifecycle(api) {
	resetState(lifecycleFile());
	const jobs = [];
	for (let i = 0; i < MARK_N; i += 1) jobs.push(api.markSkillUsed(`write-${i}`, T + i));
	for (let i = 0; i < LOAD_M; i += 1) {
		jobs.push(api.recordSkillLoads([{ name: `load-${i}`, sessionId: `s-${i}`, at: T + i }], { now: T }));
	}
	for (let i = 0; i < SAME_N; i += 1) jobs.push(api.markSkillUsed("same-target", T + i));
	const run = await runAll(jobs);
	const raw = (() => {
		try {
			return fs.readFileSync(lifecycleFile(), "utf8");
		} catch {
			return null;
		}
	})();
	const state = readJson(lifecycleFile()) ?? {};
	const keys = Object.keys(state).filter((k) => !k.startsWith("__"));
	return {
		run,
		file: {
			exists: raw !== null,
			parsable: readJson(lifecycleFile()) !== null,
			bytes: raw === null ? 0 : Buffer.byteLength(raw, "utf8")
		},
		keys: keys.sort(),
		keyCount: keys.length,
		expectedKeys: MARK_N + LOAD_M + 1,
		writeCounts: Object.fromEntries(keys.filter((k) => k.startsWith("write-")).map((k) => [k, state[k]?.writeCount])),
		loadCounts: Object.fromEntries(keys.filter((k) => k.startsWith("load-")).map((k) => [k, state[k]?.useCount])),
		loadSessions: Object.fromEntries(keys.filter((k) => k.startsWith("load-")).map((k) => [k, state[k]?.loadSessions])),
		sameTargetWriteCount: state["same-target"]?.writeCount
	};
}

const lifecycleRaceOld = await raceLifecycle(baseline.lifecycle);
const lifecycleRaceNew = await raceLifecycle(current.lifecycle);

// ── 场景 2：skill-lock 并发不丢（importSkill × 8 + pullPending 的 satisfied→relock 1 路）──
const IMPORT_N = 8;

function fakePkg(name) {
	const text = `---\nname: ${name}\ndescription: fixture ${name}\n---\nbody ${name}\n`;
	return {
		parsed: { kind: "tarball", path: path.join(home, `${name}.tgz`), ref: "", subPath: "" },
		sha256: createHash("sha256").update(name).digest("hex"),
		found: { rootRel: "", files: [{ rel: "SKILL.md", data: Buffer.from(text, "utf8") }], skillText: text },
		name
	};
}

/** relock 形态：清单里一条 satisfied 条目，走 pullPending → relock 补 lock。 */
function makeRelockSource(name) {
	const stem = path.join(home, "stage-" + name);
	const root = path.join(stem, "repo-main", name);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\ndescription: fixture relock\n---\nbody relock\n`);
	const file = path.join(home, `${name}.tgz`);
	// 用 cwd + 相对路径打包：Windows 的 bsdtar 会把 `C:\...` 当 host:path 解析
	execFileSync("tar", ["-czf", path.basename(file), "-C", path.basename(stem), "repo-main"], { cwd: home, stdio: "pipe" });
	// 目标目录里的内容与包逐字节一致 → satisfied → relock（不写文件、只补 lock）
	const dest = path.join(external, name);
	fs.mkdirSync(dest, { recursive: true });
	fs.copyFileSync(path.join(root, "SKILL.md"), path.join(dest, "SKILL.md"));
	return file;
}

async function raceLock(api, pendingApi) {
	resetState(lockFile());
	const relockName = "relock-one";
	const relockSource = makeRelockSource(relockName);
	const queueRoot = path.join(home, "pending-root");
	fs.rmSync(queueRoot, { recursive: true, force: true });
	fs.mkdirSync(queueRoot, { recursive: true });
	fs.writeFileSync(
		path.join(queueRoot, "PENDING_PULLS.json"),
		JSON.stringify({ note: "fixture", at: new Date(T).toISOString(), pulls: [{ name: relockName, source: relockSource, ref: "", sha: "", subdir: "" }] }, null, 2) + "\n"
	);
	const jobs = [];
	for (let i = 0; i < IMPORT_N; i += 1) {
		const name = `import-${i}`;
		jobs.push(api.importSkill({ source: fakePkg(name).parsed.path, targetDir: external, now: T, pkg: fakePkg(name) }));
	}
	jobs.push(pendingApi.pullPending({ targetDir: external, root: queueRoot, now: T }));
	const settled = await Promise.allSettled(jobs);
	const rejected = settled.filter((s) => s.status === "rejected");
	const run = {
		ok: settled.length - rejected.length,
		rejected: rejected.length,
		firstError: rejected.length > 0 ? String(rejected[0].reason?.message ?? rejected[0].reason) : ""
	};
	const lock = readJson(lockFile()) ?? {};
	const keys = Object.keys(lock).sort();
	const allFieldsOk = keys.every((k) => {
		const rec = lock[k];
		return (
			rec !== null &&
			typeof rec === "object" &&
			typeof rec.source === "string" &&
			rec.source !== "" &&
			typeof rec.ref === "string" &&
			typeof rec.sha256 === "string" &&
			/^[0-9a-f]{64}$/.test(rec.sha256) &&
			typeof rec.at === "string" &&
			typeof rec.subPath === "string"
		);
	});
	return {
		run,
		lockCount: keys.length,
		keys,
		expected: IMPORT_N + 1,
		allFieldsOk,
		relocked: settled[settled.length - 1]?.value?.results?.[0]?.relocked
	};
}

const lockRaceOld = await raceLock(baseline.skillsrc, baseline.pending);
const lockRaceNew = await raceLock(current.skillsrc, current.pending);

// ── 场景 3：candidates 并发不丢（updateCandidate × 8 + archiveCandidates × 4）──
const UPDATE_N = 8;
const ARCHIVE_N = 4;

function seedCandidates() {
	const seeds = Array.from({ length: UPDATE_N }, (_, i) => ({
		id: `c-${i}`,
		status: "pending",
		created: T + i,
		sourceCount: 1,
		name: `cand-${i}`,
		description: `desc ${i}`,
		rationale: "",
		body: `body ${i}`
	}));
	fs.writeFileSync(candidatesFile(), JSON.stringify(seeds, null, 2), { mode: 0o600 });
}

async function raceCandidates(api) {
	seedCandidates();
	resetState(archiveFile());
	const jobs = [];
	for (let i = 0; i < UPDATE_N; i += 1) jobs.push(api.updateCandidate(`c-${i}`, { rationale: `updated-${i}` }));
	for (let i = 0; i < ARCHIVE_N; i += 1) jobs.push(api.archiveCandidates([{ id: `a-${i}`, name: `arch-${i}` }], { decision: "accepted", now: T + i }));
	const run = await runAll(jobs);
	const queue = readJson(candidatesFile()) ?? [];
	const archive = readJson(archiveFile()) ?? [];
	const rationaleUpdated = queue.filter((c) => c.rationale === `updated-${c.id.slice(2)}`).length;
	return {
		run,
		queueLength: queue.length,
		rationaleUpdated,
		queueNames: queue.map((c) => c.name).sort(),
		archiveLength: archive.length,
		archiveNames: archive.map((e) => e.name).sort(),
		archiveDecisions: [...new Set(archive.map((e) => e.decision))]
	};
}

const candidatesRaceOld = await raceCandidates(baseline.extractor);
const candidatesRaceNew = await raceCandidates(current.extractor);

// ── 场景 4：异常必释放（临界区内抛错 → 后续同文件周期在 5 秒内完成）──
// 用真实入口 + 会抛错的 Proxy：recordSkillLoads 在锁内读 load.name 时炸，finally 必须放行。
async function exceptionRelease(api, lockApi) {
	resetState(lifecycleFile());
	const bomb = new Proxy(
		{},
		{
			get() {
				throw new Error("boom-in-critical-section");
			}
		}
	);
	let threw = "";
	try {
		await api.recordSkillLoads([bomb], { now: T });
	} catch (error) {
		threw = String(error?.message ?? error);
	}
	const started = Date.now();
	const timeout = new Promise((done) => setTimeout(() => done("__timeout__"), 5000));
	const after = await Promise.race([api.markSkillUsed("after-bomb", T).then(() => "ok"), timeout]);
	const elapsed = Date.now() - started;
	// 原语层同一条队列也要恢复：不同 key 互不阻塞
	const keyA = path.join(dataDir, "probe-a.json");
	let primitiveThrew = "";
	try {
		await lockApi.withFileLock(keyA, async () => {
			throw new Error("boom-primitive");
		});
	} catch (error) {
		primitiveThrew = String(error?.message ?? error);
	}
	const primitiveAfter = await Promise.race([
		lockApi.withFileLock(keyA, async () => "ok"),
		new Promise((done) => setTimeout(() => done("__timeout__"), 5000))
	]);
	const state = readJson(lifecycleFile()) ?? {};
	return {
		threw,
		after,
		elapsed,
		primitiveThrew,
		primitiveAfter,
		afterRecorded: state["after-bomb"]?.writeCount === 1
	};
}

const exceptionNew = await exceptionRelease(current.lifecycle, current.lock);

// ── 场景 5：顺序等价（同一组顺序操作，基线版与当前版状态文件逐字节一致）──
async function sequentialRun(apis) {
	resetState(lifecycleFile(), lockFile(), candidatesFile(), archiveFile());
	await apis.lifecycle.markSkillUsed("alpha", T);
	await apis.lifecycle.markSkillUsed("alpha", T + 1000);
	await apis.lifecycle.recordSkillLoads(
		[
			{ name: "alpha", sessionId: "s1", at: T + 2000 },
			{ name: "beta", sessionId: "s1", at: T + 2000 }
		],
		{ now: T + 2000 }
	);
	await apis.lifecycle.markSkillUsed("beta", T + 3000);
	await apis.skillsrc.importSkill({ source: fakePkg("seq-one").parsed.path, targetDir: external, now: T, pkg: fakePkg("seq-one") });
	fs.writeFileSync(
		candidatesFile(),
		JSON.stringify(
			[
				{ id: "q-1", status: "pending", created: T, sourceCount: 1, name: "q-one", description: "d1", rationale: "", body: "b1" },
				{ id: "q-2", status: "pending", created: T + 1, sourceCount: 1, name: "q-two", description: "d2", rationale: "", body: "b2" }
			],
			null,
			2
		),
		{ mode: 0o600 }
	);
	await apis.extractor.updateCandidate("q-1", { rationale: "first" });
	await apis.extractor.updateCandidate("q-2", { description: "second" });
	await apis.extractor.archiveCandidates([{ id: "q-2", name: "q-two" }], { decision: "rejected", now: T + 9 });
	return {
		lifecycle: sha(lifecycleFile()),
		lock: sha(lockFile()),
		candidates: sha(candidatesFile()),
		archive: sha(archiveFile()),
		lifecycleState: readJson(lifecycleFile()),
		lockState: readJson(lockFile()),
		candidatesState: readJson(candidatesFile()),
		archiveState: readJson(archiveFile())
	};
}

const seqOld = await sequentialRun({ lifecycle: baseline.lifecycle, skillsrc: baseline.skillsrc, extractor: baseline.extractor });
const seqNew = await sequentialRun({ lifecycle: current.lifecycle, skillsrc: current.skillsrc, extractor: current.extractor });

// ── 场景 6：usage-signals 水位线并发（两路 ingest 各带独立会话，水位线不丢条目）──
async function raceWatermark(api) {
	resetState(usageFile());
	const A = [
		{ file: path.join(home, "sess-a.jsonl"), mtime: T, size: 10, log: { session: { id: "wa" }, skillLoads: [{ name: "sk-a", at: T }] } }
	];
	const B = [
		{ file: path.join(home, "sess-b.jsonl"), mtime: T + 1, size: 10, log: { session: { id: "wb" }, skillLoads: [{ name: "sk-b", at: T + 1 }] } }
	];
	await Promise.all([api.ingestUsageSignals(A, { now: T }), api.ingestUsageSignals(B, { now: T })]).catch(() => null);
	const mark = readJson(usageFile()) ?? { sessions: {} };
	return { keys: Object.keys(mark.sessions ?? {}).sort(), version: mark.version };
}

const watermarkOld = await raceWatermark(await load(baselineLib, "usage-signals.js"));
const watermarkNew = await raceWatermark(await load(path.join(pluginRoot, "lib"), "usage-signals.js"));

// ── 场景 7：串行化自身的开销（同一组顺序调用各跑 60 次，粗测）──
async function timeSequential(api) {
	resetState(lifecycleFile());
	const started = Date.now();
	for (let i = 0; i < 60; i += 1) await api.markSkillUsed(`timed-${i}`, T + i);
	return Date.now() - started;
}

const timing = {
	old: await timeSequential(baseline.lifecycle),
	new: await timeSequential(current.lifecycle)
};

process.stdout.write(
	JSON.stringify({
		baselineCommit: BASELINE,
		lifecycleRace: { old: lifecycleRaceOld, new: lifecycleRaceNew },
		lockRace: { old: lockRaceOld, new: lockRaceNew },
		candidatesRace: { old: candidatesRaceOld, new: candidatesRaceNew },
		exception: exceptionNew,
		sequential: {
			same: {
				lifecycle: seqOld.lifecycle === seqNew.lifecycle,
				lock: seqOld.lock === seqNew.lock,
				candidates: seqOld.candidates === seqNew.candidates,
				archive: seqOld.archive === seqNew.archive
			},
			hashes: {
				old: { lifecycle: seqOld.lifecycle, lock: seqOld.lock, candidates: seqOld.candidates, archive: seqOld.archive },
				new: { lifecycle: seqNew.lifecycle, lock: seqNew.lock, candidates: seqNew.candidates, archive: seqNew.archive }
			},
			fields: { old: { lifecycle: seqOld.lifecycleState, candidates: seqOld.candidatesState, archive: seqOld.archiveState }, new: { lifecycle: seqNew.lifecycleState, candidates: seqNew.candidatesState, archive: seqNew.archiveState } }
		},
		watermark: { old: watermarkOld, new: watermarkNew },
		timing
	})
);
