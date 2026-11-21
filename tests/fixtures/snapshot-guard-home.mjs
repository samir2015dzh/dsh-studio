import { historicalSource } from "../helpers/historical-source.mjs";
// N-04 fixture：恢复侧白名单镜像（S-05 残留）。
//
// 四件事全在伪 HOME 里做，不碰真机 ~/.dsh：
//   1. 恶意包对拍：同一份手搓包分别交给「基线版 snapshot.js」（git show d99332c:lib/snapshot.js）
//      与当前版恢复 —— 基线版把手搓的 dsh-studio/sync.json 写穿本机同步凭据，当前版必须原样不动。
//   2. 白名单外路径（profiles/<名>/evil.sh、根级 random.txt）被跳过并列明，profiles/<名>/package.json 照常恢复。
//   3. 正规包 round-trip：现行 createSnapshot 打一份完整 HOME，恢复到空 HOME，文件集合与内容逐项一致、跳过清单为空。
//   4. dryRun：跳过计数与清单齐全，且磁盘零写入。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const lib = (name) => import(pathToFileURL(path.join(pluginRoot, "lib", name)).href);
const snapshot = await lib("snapshot.js");

const dsh = path.join(home, ".dsh");
const external = path.join(home, ".agents", "skills");
const LOCAL_SYNC = JSON.stringify({ channel: "git", token: "LOCAL-SECRET-TOKEN" }, null, 2) + "\n";
const POISON_SYNC = JSON.stringify({ channel: "gist", token: "POISONED-BY-PACKAGE" }, null, 2) + "\n";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const write = (file, data) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
};

/** 一个「完整」的伪 HOME：两个 file 条目、skills、dsh-studio 状态文件、profiles、外部 skill 根各至少一份。 */
function layOutHome() {
	write(path.join(dsh, "cordis.patch.yml"), "plugins: []\n");
	write(path.join(dsh, "AGENTS.md"), "# 伪 HOME 的 AGENTS.md\n");
	write(path.join(dsh, "skills", "local-one", "SKILL.md"), "---\nname: local-one\n---\nbody one\n");
	write(path.join(dsh, "dsh-studio", "extractor.json"), JSON.stringify({ agentSkillDir: external }, null, 2) + "\n");
	write(path.join(dsh, "dsh-studio", "sync.json"), LOCAL_SYNC);
	write(path.join(dsh, "dsh-studio", "quality.json"), JSON.stringify({ roll: [] }, null, 2) + "\n");
	write(path.join(dsh, "profiles", "p1", "package.json"), JSON.stringify({ name: "p1" }, null, 2) + "\n");
	write(path.join(dsh, "profiles", "p1", "cordis.patch.yml"), "plugins: []\n");
	write(path.join(external, "ext-one", "SKILL.md"), "---\nname: ext-one\n---\nbody ext\n");
}

/** 只清「用户内容」，快照目录留着（restoreSnapshot 要从那里读包）。 */
function clearUserContent() {
	const kill = (target) => fs.rmSync(target, { recursive: true, force: true });
	kill(path.join(dsh, "cordis.patch.yml"));
	kill(path.join(dsh, "AGENTS.md"));
	kill(path.join(dsh, "skills"));
	kill(path.join(dsh, "profiles"));
	for (const name of ["extractor.json", "sync.json", "quality.json", "skill-lock.json", "skill-lifecycle.json", "usage-signals.json", "candidates.json"]) {
		kill(path.join(dsh, "dsh-studio", name));
	}
	kill(external);
}

/** 手搓一个快照包（entries 原样进 tar.gz），落在 snapshotsDir()/<id>/config.tar.gz。 */
function packSnapshot(id, entries) {
	const dir = path.join(snapshot.snapshotsDir(), id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.tar.gz"), snapshot.packTarGz(entries));
	fs.writeFileSync(
		path.join(dir, "manifest.json"),
		JSON.stringify({ id, label: id, at: Date.now(), archiveBytes: 0, files: entries.map((entry) => ({ rel: entry.rel, bytes: entry.data.length, sha: sha(entry.data) })) }, null, 2) + "\n"
	);
	return id;
}

/** 基线版 snapshot.js（d99332c）—— 与当前 lib 同目录共存，只为「红的形态」留证。 */
async function loadBaselineSnapshot() {
	const source = historicalSource("d99332c", "lib/snapshot.js");
	if (source === null) return null;
	const dir = path.join(home, "baseline-lib");
	fs.cpSync(path.join(pluginRoot, "lib"), dir, { recursive: true, filter: (src) => !src.endsWith(".bak-mcp-20261102") });
	fs.writeFileSync(path.join(dir, "snapshot.js"), source, "utf8");
	return import(pathToFileURL(path.join(dir, "snapshot.js")).href);
}

const readSyncBytes = () => {
	try {
		return fs.readFileSync(path.join(dsh, "dsh-studio", "sync.json"));
	} catch {
		return null;
	}
};
const exists = (rel) => fs.existsSync(path.join(home, rel));

// ---- 0. 完整 HOME + 恶意包
layOutHome();
const compromiseId = packSnapshot("snapshot-compromise", [
	{ rel: "dsh-studio/sync.json", data: Buffer.from(POISON_SYNC, "utf8") },
	{ rel: "dsh-studio/snapshots/evil.txt", data: Buffer.from("should never land\n", "utf8") },
	{ rel: "dsh-studio/sync-work/x.txt", data: Buffer.from("should never land\n", "utf8") },
	{ rel: "AGENTS.md", data: Buffer.from("# 包里的 AGENTS.md\n", "utf8") }
]);

// ---- 1. 基线版：手搓包写穿本机同步凭据（红）
const baseline = await loadBaselineSnapshot();
fs.writeFileSync(path.join(dsh, "dsh-studio", "sync.json"), LOCAL_SYNC);
const baselineRestore = baseline ? await baseline.restoreSnapshot(compromiseId) : null;
const baselineSync = readSyncBytes();
const baselineWroteEvil = fs.existsSync(path.join(dsh, "dsh-studio", "snapshots", "evil.txt"));
const baselineWroteSyncWork = fs.existsSync(path.join(dsh, "dsh-studio", "sync-work"));
// 基线版写进去的毒文件要清掉，否则「当前版有没有写」就测不出来了
fs.rmSync(path.join(dsh, "dsh-studio", "snapshots", "evil.txt"), { force: true });
fs.rmSync(path.join(dsh, "dsh-studio", "sync-work"), { recursive: true, force: true });

// ---- 2. 当前版：同一份包，sync.json 逐字节不变（绿）
fs.writeFileSync(path.join(dsh, "dsh-studio", "sync.json"), LOCAL_SYNC);
const currentRestore = await snapshot.restoreSnapshot(compromiseId);
const currentSync = readSyncBytes();

// ---- 3. dryRun：跳过清单齐全、磁盘零写入
const dryReference = readSyncBytes();
const dryRestore = await snapshot.restoreSnapshot(compromiseId, { dryRun: true });
const dryAfter = readSyncBytes();

// ---- 4. 白名单外路径 + 不安全路径（rejected 语义不混）
const whitelistId = packSnapshot("snapshot-whitelist", [
	{ rel: "profiles/p1/evil.sh", data: Buffer.from("#!/bin/sh\necho evil\n", "utf8") },
	{ rel: "random.txt", data: Buffer.from("root level junk\n", "utf8") },
	{ rel: "profiles/p1/package.json", data: Buffer.from(JSON.stringify({ name: "p1-from-pack" }, null, 2) + "\n", "utf8") },
	{ rel: "../escape.txt", data: Buffer.from("traversal\n", "utf8") }
]);
const whitelistDry = await snapshot.restoreSnapshot(whitelistId, { dryRun: true });
const whitelistRestore = await snapshot.restoreSnapshot(whitelistId);

// ---- 5. 正规包 round-trip：完整 HOME → 空 HOME
const roundId = (await snapshot.createSnapshot("round-trip")).id;
const collected = await snapshot.collectFiles({ maxSkillFileBytes: 0 });
const collectedMap = new Map();
for (const file of collected) collectedMap.set(file.rel, fs.readFileSync(file.abs));
clearUserContent();
const roundRestore = await snapshot.restoreSnapshot(roundId);
const restoredMap = new Map();
for (const [rel, bytes] of collectedMap) {
	const target = rel.startsWith("agents-skills/")
		? path.join(external, rel.slice("agents-skills/".length))
		: path.join(dsh, rel);
	let actual = null;
	try {
		actual = fs.readFileSync(target);
	} catch {
		actual = null;
	}
	restoredMap.set(rel, actual);
}
const roundMismatch = [];
for (const [rel, bytes] of collectedMap) {
	const actual = restoredMap.get(rel);
	if (actual === null || actual === undefined) roundMismatch.push(rel + "=missing");
	else if (!actual.equals(bytes)) roundMismatch.push(rel + "=bytes");
}

process.stdout.write(
	JSON.stringify({
		compromiseId,
		baseline: baseline ? {
			ok: baselineRestore.dryRun === false,
			syncSha: sha(baselineSync ?? Buffer.alloc(0)),
			syncText: (baselineSync ?? Buffer.alloc(0)).toString("utf8"),
			// 基线版没有白名单镜像字段
			hasSkippedField: Object.hasOwn(baselineRestore, "skipped"),
			wroteEvil: baselineWroteEvil,
			wroteSyncWork: baselineWroteSyncWork
		} : null,
		current: {
			syncUnchanged: sha(currentSync ?? Buffer.alloc(0)) === sha(Buffer.from(LOCAL_SYNC, "utf8")),
			syncSha: sha(currentSync ?? Buffer.alloc(0)),
			skipped: currentRestore.skipped,
			skippedPaths: currentRestore.skippedPaths,
			rejected: currentRestore.rejected,
			wroteEvil: fs.existsSync(path.join(dsh, "dsh-studio", "snapshots", "evil.txt")),
			wroteSyncWork: fs.existsSync(path.join(dsh, "dsh-studio", "sync-work")),
			agentsWritten: fs.readFileSync(path.join(dsh, "AGENTS.md"), "utf8")
		},
		dry: {
			skipped: dryRestore.skipped,
			skippedPaths: dryRestore.skippedPaths,
			planLength: dryRestore.plan.length,
			planRels: dryRestore.plan.map((p) => p.rel),
			dryRun: dryRestore.dryRun,
			diskUnchanged: sha(dryAfter ?? Buffer.alloc(0)) === sha(dryReference ?? Buffer.alloc(0))
		},
		whitelist: {
			skippedPaths: whitelistRestore.skippedPaths,
			// rejected 的路径清单只在 dry-run 返回值里（既有形态），真恢复只给计数
			rejectedPaths: whitelistDry.rejectedPaths,
			dryPlanRels: whitelistDry.plan.map((p) => p.rel),
			skipped: whitelistRestore.skipped,
			rejected: whitelistRestore.rejected,
			evilExists: exists(path.join(".dsh", "profiles", "p1", "evil.sh")),
			randomExists: exists(path.join(".dsh", "random.txt")),
			escapeExists: exists("escape.txt"),
			pkg: (() => {
				try {
					return JSON.parse(fs.readFileSync(path.join(dsh, "profiles", "p1", "package.json"), "utf8")).name;
				} catch {
					return null;
				}
			})(),
			written: whitelistRestore.written
		},
		roundTrip: {
			id: roundId,
			collected: [...collectedMap.keys()].sort(),
			mismatch: roundMismatch,
			skipped: roundRestore.skipped,
			skippedPaths: roundRestore.skippedPaths,
			written: roundRestore.written,
			failed: roundRestore.failed
		}
	})
);
