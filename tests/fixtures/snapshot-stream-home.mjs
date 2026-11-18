// N-12 fixture：createSnapshot 流式打包的等价性与边界。
//
// 全部在伪 HOME 里做（USERPROFILE / HOME / DSH_HOME 三件套指向它），不碰真机 ~/.dsh：
//   1. 同一份伪 HOME，基线版（git show af7daae:lib/snapshot.js）与当前版各打一份包 →
//      解包后逐条 (rel, data) 深比对、manifest.files 逐项比对、三份说明文件比对。
//   2. 互通往返：基线 unpackTarGz 解当前版包；当前版 restoreSnapshot 恢复到空 HOME。
//   3. 长名：prefix 可拆（name+prefix 双向装得下）与需 GNU longname（'L'）两条路径。
//   4. 超硬上限（>4096 字节相对路径）仍报错拒绝，且不留快照目录/临时文件。
//   5. 打包中途源文件消失：不留正式包、不留临时文件、不留快照目录。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const lib = (dir, name) => import(pathToFileURL(path.join(dir, name)).href);
const current = await lib(path.join(pluginRoot, "lib"), "snapshot.js");

const dsh = path.join(home, ".dsh");
const external = path.join(home, ".agents", "skills");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const write = (file, data) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
};
const exists = (target) => fs.existsSync(target);
const readOrNull = (target) => {
	try {
		return fs.readFileSync(target);
	} catch {
		return null;
	}
};

/** 基线版 snapshot.js（af7daae）—— 整目录 cp 后覆盖，相对 import 才解析得开。 */
async function loadBaseline() {
	const dir = path.join(home, "baseline-lib");
	fs.cpSync(path.join(pluginRoot, "lib"), dir, { recursive: true, filter: (src) => !src.includes(".bak-mcp-") });
	const source = execFileSync("git", ["show", "af7daae:lib/snapshot.js"], { cwd: pluginRoot, encoding: "utf8" });
	fs.writeFileSync(path.join(dir, "snapshot.js"), source, "utf8");
	return lib(dir, "snapshot.js");
}

const MB = 1024 * 1024;
/** prefix 装得下的长名：80 段名 + 40 文件名（name 137 字节 > 100，但能从斜杠处拆开）。 */
const midSeg = "p".repeat(80);
const leafName = "f".repeat(40);
const prefixRel = `skills/${midSeg}/${leafName}.md`;
/** 装不下的长名：单段 120 字符 + 文件名，整串没有一个能拆的斜杠。 */
const longSeg = "L".repeat(120);
const longnameRel = `skills/${longSeg}/SKILL.md`;

function layOutHome() {
	write(path.join(dsh, "cordis.patch.yml"), "plugins: []\n");
	write(path.join(dsh, "AGENTS.md"), "# N-12 伪 HOME\n");
	write(path.join(dsh, "skills", "local-one", "SKILL.md"), "---\nname: local-one\n---\nbody one\n");
	write(path.join(dsh, prefixRel), "prefix split body\n");
	write(path.join(dsh, longnameRel), "longname body\n");
	// 大 skill 且来源可确定（skill-lock.json）→ 只记链接，内容不进包
	write(path.join(dsh, "skills", "big-skill", "SKILL.md"), "---\nname: big-skill\n---\nbig\n");
	write(path.join(dsh, "skills", "big-skill", "blob.bin"), Buffer.alloc(Math.floor(5.2 * MB), 0x41));
	// 大 skill 但来源不可确定 → C-2 单文件上限生效，文件进 SKIPPED.json
	write(path.join(dsh, "skills", "skip-skill", "SKILL.md"), "---\nname: skip-skill\n---\nskip\n");
	write(path.join(dsh, "skills", "skip-skill", "huge.bin"), Buffer.alloc(Math.floor(5.3 * MB), 0x42));
	write(path.join(dsh, "dsh-studio", "extractor.json"), JSON.stringify({ agentSkillDir: external }, null, 2) + "\n");
	// 含凭据字段 → 字段级脱敏 + REDACTED.json
	write(
		path.join(dsh, "dsh-studio", "mcp.json"),
		JSON.stringify({ servers: [{ name: "dev", authorization: "Bearer LOCAL-SECRET-VALUE" }] }, null, 2) + "\n"
	);
	write(path.join(dsh, "dsh-studio", "quality.json"), JSON.stringify({ roll: [] }, null, 2) + "\n");
	write(path.join(dsh, "dsh-studio", "sync.json"), JSON.stringify({ channel: "git", token: "NEVER-IN-SNAPSHOT" }, null, 2) + "\n");
	write(
		path.join(dsh, "dsh-studio", "skill-lock.json"),
		JSON.stringify({ "big-skill": { source: "https://github.com/org/big-skill", ref: "main", sha256: "f".repeat(64) } }, null, 2) + "\n"
	);
	write(path.join(dsh, "profiles", "p1", "package.json"), JSON.stringify({ name: "p1" }, null, 2) + "\n");
	write(path.join(dsh, "profiles", "p1", "cordis.patch.yml"), "plugins: []\n");
	write(path.join(external, "ext-one", "SKILL.md"), "---\nname: ext-one\n---\nbody ext\n");
}

/** 只清「用户内容」，snapshots 目录留着（restoreSnapshot 要从那里读包）。 */
function clearUserContent() {
	const kill = (target) => fs.rmSync(target, { recursive: true, force: true });
	kill(path.join(dsh, "cordis.patch.yml"));
	kill(path.join(dsh, "AGENTS.md"));
	kill(path.join(dsh, "skills"));
	kill(path.join(dsh, "profiles"));
	for (const name of ["extractor.json", "mcp.json", "quality.json", "skill-lock.json", "sync.json"]) {
		kill(path.join(dsh, "dsh-studio", name));
	}
	kill(external);
}

const snapshotRoot = () => current.snapshotsDir();
const snapshotDirs = () => {
	try {
		return fs.readdirSync(snapshotRoot()).sort();
	} catch {
		return [];
	}
};
const strayTmps = () =>
	snapshotDirs().flatMap((name) => {
		let files = [];
		try {
			files = fs.readdirSync(path.join(snapshotRoot(), name));
		} catch {
			return [];
		}
		return files.filter((f) => f.startsWith("config.tar.gz.") && f.endsWith(".tmp")).map((f) => `${name}/${f}`);
	});
const archiveOf = (id) => current.unpackTarGz(fs.readFileSync(path.join(snapshotRoot(), id, "config.tar.gz")));
const archiveBytesOf = (id) => fs.readFileSync(path.join(snapshotRoot(), id, "config.tar.gz"));

/** 逐条 (rel, data) 深比对；返回差异清单。顺带比 rel 顺序。 */
function deepDiff(expected, actual) {
	const diff = [];
	if (expected.length !== actual.length) diff.push(`count:${expected.length}!=${actual.length}`);
	const n = Math.min(expected.length, actual.length);
	for (let i = 0; i < n; i += 1) {
		if (expected[i].rel !== actual[i].rel) {
			diff.push(`rel#${i}:${expected[i].rel}!=${actual[i].rel}`);
			continue;
		}
		if (!expected[i].data.equals(actual[i].data)) diff.push(`data:${expected[i].rel}`);
	}
	return diff;
}

// ---- 1. 基线版与当前版各打一份包，逐条深比对
layOutHome();
const baseline = await loadBaseline();
const beforeDirs = snapshotDirs();
const baselineManifest = await baseline.createSnapshot("n12-baseline");
const currentManifest = await current.createSnapshot("n12-current");
const baselineEntries = archiveOf(baselineManifest.id);
const currentEntries = archiveOf(currentManifest.id);
const baselineArchiveSha = sha(archiveBytesOf(baselineManifest.id));
const currentArchiveSha = sha(archiveBytesOf(currentManifest.id));

const entryDiff = deepDiff(baselineEntries, currentEntries);
const filesDiff = [];
const fn = Math.min(baselineManifest.files.length, currentManifest.files.length);
for (let i = 0; i < fn; i += 1) {
	const a = baselineManifest.files[i];
	const b = currentManifest.files[i];
	if (a.rel !== b.rel || a.bytes !== b.bytes || a.sha !== b.sha) filesDiff.push(`${a.rel}#${a.bytes}/${a.sha.slice(0, 8)}!=${b.bytes}/${b.sha.slice(0, 8)}`);
}
if (baselineManifest.files.length !== currentManifest.files.length) filesDiff.push(`count:${baselineManifest.files.length}!=${currentManifest.files.length}`);

const noteRel = { redacted: current.REDACTED_NOTE, external: current.EXTERNAL_SKILLS_NOTE, skipped: current.SKIPPED_NOTE };
const byRel = (entries, rel) => entries.find((entry) => entry.rel === rel) ?? null;
const notes = {};
for (const [key, rel] of Object.entries(noteRel)) {
	const b = byRel(baselineEntries, rel);
	const c = byRel(currentEntries, rel);
	notes[key] = { inBaseline: b !== null, inCurrent: c !== null, equal: b !== null && c !== null && b.data.equals(c.data) };
}
const skippedEqual =
	JSON.stringify(baselineManifest.skipped) === JSON.stringify(currentManifest.skipped) &&
	JSON.stringify(baselineManifest.excluded) === JSON.stringify(currentManifest.excluded) &&
	JSON.stringify(baselineManifest.redacted) === JSON.stringify(currentManifest.redacted);

// ---- 2. 互通往返
// 2a 基线 unpackTarGz 解当前版包
const crossDiff = deepDiff(baselineEntries, baseline.unpackTarGz(fs.readFileSync(path.join(snapshotRoot(), currentManifest.id, "config.tar.gz"))));
// 2b 当前版 restoreSnapshot 恢复到空 HOME
const expectRestore = currentEntries
	.filter((entry) => entry.rel !== current.REDACTED_NOTE && entry.rel !== current.EXTERNAL_SKILLS_NOTE && entry.rel !== current.SKIPPED_NOTE)
	.filter((entry) => !current.CREDENTIAL_FILES.has(entry.rel));
clearUserContent();
const restored = await current.restoreSnapshot(currentManifest.id);
const restoreDiff = [];
for (const entry of expectRestore) {
	const target = entry.rel.startsWith("agents-skills/")
		? path.join(external, entry.rel.slice("agents-skills/".length))
		: path.join(dsh, entry.rel);
	const actual = readOrNull(target);
	if (actual === null) restoreDiff.push(`missing:${entry.rel}`);
	else if (!actual.equals(entry.data)) restoreDiff.push(`bytes:${entry.rel}`);
}
// 凭据文件：占位符不落盘（N-04 同口径）
const restoredMcp = readOrNull(path.join(dsh, "dsh-studio", "mcp.json"));
const mcpText = restoredMcp === null ? "" : restoredMcp.toString("utf8");

// ---- 3. 长名往返（已在 1 里解过包，这里取明确证据）
const longnameEntry = byRel(currentEntries, longnameRel);
const prefixEntry = byRel(currentEntries, prefixRel);
const longName = {
	longnameRel,
	longnameLen: Buffer.byteLength(longnameRel, "utf8"),
	longnameOk: longnameEntry !== null && longnameEntry.data.toString("utf8") === "longname body\n",
	prefixRel,
	prefixLen: Buffer.byteLength(prefixRel, "utf8"),
	prefixOk: prefixEntry !== null && prefixEntry.data.toString("utf8") === "prefix split body\n"
};

// ---- 4. 超硬上限：42 段 × 100 字符 → 相对路径 > 4096 字节，仍须拒绝且不留东西
const deepParts = [];
for (let i = 0; i < 42; i += 1) deepParts.push(String(i).padStart(3, "0") + "y".repeat(96));
const overRel = `dsh-studio/${deepParts.join("/")}/f.txt`;
// Linux/macOS 的 PATH_MAX 只有 4096（含结尾 NUL），绝对路径必然更长，这种文件用绝对路径根本建不出来，
// 插件自己按绝对路径遍历也走不到这一层 —— 场景在 POSIX 上不可达，记为跳过；Windows（长路径）照常验证。
let overlimit;
try {
	write(path.join(dsh, overRel), "too long for tar\n");
} catch (error) {
	if (process.platform === "win32" || error?.code !== "ENAMETOOLONG") throw error;
	fs.rmSync(path.join(dsh, "dsh-studio", deepParts[0]), { recursive: true, force: true }); // mkdir 可能已建出前几层
	overlimit = {
		skipped: true,
		relLen: Buffer.byteLength(overRel, "utf8"),
		reason: `${process.platform} 上绝对路径超过 PATH_MAX，无法建出 >4096 字节的相对路径（ENAMETOOLONG）`
	};
}
if (!overlimit) {
	const beforeOver = snapshotDirs();
	let overError = null;
	try {
		await current.createSnapshot("n12-overlimit");
	} catch (error) {
		overError = error instanceof Error ? error.message : String(error);
	}
	const afterOver = snapshotDirs();
	fs.rmSync(path.join(dsh, "dsh-studio", deepParts[0]), { recursive: true, force: true });
	overlimit = {
		relLen: Buffer.byteLength(overRel, "utf8"),
		threw: overError !== null,
		message: overError ?? "",
		dirsUnchanged: beforeOver.join("|") === afterOver.join("|"),
		strayTmps: strayTmps().length
	};
}

// ---- 5. 中途失败：收集完成后源文件消失
write(path.join(dsh, "dsh-studio", "data", "a-slow.bin"), randomBytes(8 * MB));
const gonePath = path.join(dsh, "dsh-studio", "zz-gone.bin");
write(gonePath, "gone soon\n");
const beforeMid = snapshotDirs();
const pendingMid = current.createSnapshot("n12-midfail").then(
	() => null,
	(error) => error
);
let tmpSeen = false;
let deleted = false;
{
	const start = Date.now();
	while (Date.now() - start < 20000) {
		if (strayTmps().length > 0) {
			tmpSeen = true;
			try {
				fs.rmSync(gonePath, { force: true });
				deleted = true;
			} catch {
				deleted = false;
			}
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
const midError = await pendingMid;
const midDirs = snapshotDirs().filter((name) => name.endsWith("-n12-midfail"));
const midFail = {
	throw: midError !== null,
	message: midError instanceof Error ? midError.message : midError === null ? "" : String(midError),
	tmpSeen,
	deleted,
	dirGone: midDirs.length === 0,
	officialArchive: midDirs.some((name) => exists(path.join(snapshotRoot(), name, "config.tar.gz"))),
	strayTmps: strayTmps().length,
	dirsAdded: snapshotDirs().filter((name) => !beforeMid.includes(name))
};

process.stdout.write(
	JSON.stringify({
		env: {
			home,
			userprofile: process.env.USERPROFILE ?? "",
			homeVar: process.env.HOME ?? "",
			dshHome: dsh,
			dshHomeVar: process.env.DSH_HOME ?? ""
		},
		baselineId: baselineManifest.id,
		currentId: currentManifest.id,
		equivalence: {
			collectCount: currentEntries.length,
			entryDiff,
			filesDiff,
			skippedEqual,
			archiveBytes: { baseline: baselineManifest.archiveBytes, current: currentManifest.archiveBytes },
			archiveSha: { baseline: baselineArchiveSha, current: currentArchiveSha },
			notes
		},
		cross: {
			crossDiff,
			restoreDiff,
			restore: {
				written: restored.written,
				failed: restored.failed,
				skipped: restored.skipped,
				pendingPulls: restored.pendingPulls.length,
				expected: expectRestore.length
			},
			mcpHasPlaceholder: mcpText.includes("__dsh_studio_redacted__"),
			mcpHasSecret: mcpText.includes("LOCAL-SECRET-VALUE"),
			mcpText
		},
		longName,
		overlimit,
		midFail,
		beforeDirs
	})
);
