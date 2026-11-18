// N-11 fixture：scanner 条目级解析缓存（按文件 mtime/size 校验）的等价性、重读证据、
// readFile 计数与三段耗时。
//
// 全部在伪 HOME 里跑：真机 ~/.dsh、两棵技能根、真机会话一律不碰。
//   cwd/workspace   <fakeHome>/workspace        project 级根（.dsh/skills + .agents/skills）
//   user-agents 根  <fakeHome>/.agents/skills   主树（≥420 个 SKILL.md）+ 平铺 .md + 无 name 的 md
//   user-dsh 根     <fakeHome>/.dsh/skills      同名遮蔽的另一半
//   custom 源       <fakeHome>/mirror           extractor.json 的 mirrorDir（同名条目走 custom 丢弃分支）
//
// 对拍：baseline = `git show af7daae:lib/<4 个文件>` 写到 <fakeHome>/baseline-lib
//（scanner 的相对 import 需要整目录存在；只取基线里的 scanner + extractor + 它的两个依赖，
// 同批其它改动不影响这次对拍）。每次取 baseline 都带唯一 query 重新 import → 冷模块、无缓存，
// 永远读当前磁盘状态。
//
// readFile 计数：registerHooks 仅在「parentURL 是 scanner.js」时把 node:fs/promises 换成
// data: URL 计数 shim（转发真实实现），因此只统计 scanner 自己的 IO，不污染 fixture 本身。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const BASELINE = "af7daae";
const BASELINE_FILES = ["scanner.js", "extractor.js", "guard-content.js", "state-lock.js"];

// ── 伪 HOME：三件套指向它，并清掉会影响扫描根/读取配置的环境变量（进程级、只在这个子进程里）──
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-scanner-cache-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
process.env.DSH_HOME = path.join(fakeHome, ".dsh");
for (const key of Object.keys(process.env)) {
	if (
		key === "DSH_SKILL_MANAGER_SKILL_DIRS" ||
		key === "DSH_SKILL_EXTRACTOR_CONFIG" ||
		key === "DSH_SKILL_EXTRACTOR_CANDIDATES" ||
		key === "DSH_AGENTS_HOME" ||
		/^DSH_[A-Z]+_HOME$/.test(key)
	) {
		delete process.env[key];
	}
}

const workspace = path.join(fakeHome, "workspace");
const agentsRoot = path.join(fakeHome, ".agents", "skills");
const dshRoot = path.join(fakeHome, ".dsh", "skills");
const mirrorRoot = path.join(fakeHome, "mirror");
const currentLib = path.join(pluginRoot, "lib");
const baselineLib = path.join(fakeHome, "baseline-lib");

// ── scanner 的 IO 计数（只拦 scanner.js 自己的 node:fs/promises）──
const IO = { readFile: 0, readdir: 0, stat: 0, realpath: 0, readFilePaths: [], statPaths: [] };
globalThis.__scannerIO = IO;
function resetIO() {
	IO.readFile = 0;
	IO.readdir = 0;
	IO.stat = 0;
	IO.realpath = 0;
	IO.readFilePaths.length = 0;
	IO.statPaths.length = 0;
}
const SHIM_SOURCE = [
	'import * as fsp from "node:fs/promises";',
	"const bump = (kind, arg) => {",
	"\tconst s = globalThis.__scannerIO;",
	"\tif (!s) return;",
	"\ts[kind] += 1;",
	'\tif (kind === "readFile") s.readFilePaths.push(String(arg));',
	'\tif (kind === "stat") s.statPaths.push(String(arg));',
	"};",
	'export const readFile = (...a) => { bump("readFile", a[0]); return fsp.readFile(...a); };',
	'export const readdir = (...a) => { bump("readdir"); return fsp.readdir(...a); };',
	'export const stat = (...a) => { bump("stat", a[0]); return fsp.stat(...a); };',
	'export const realpath = (...a) => { bump("realpath"); return fsp.realpath(...a); };',
	"export default { readFile, readdir, stat, realpath };"
].join("\n");
const SHIM_URL = "data:text/javascript;base64," + Buffer.from(SHIM_SOURCE, "utf8").toString("base64");
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "node:fs/promises" && typeof context.parentURL === "string") {
			let parent = context.parentURL;
			try {
				parent = decodeURIComponent(new URL(context.parentURL).pathname);
			} catch {
				/* 非 URL/相对父模块：不拦 */
			}
			if (/[\\/]scanner\.js$/.test(parent)) return { url: SHIM_URL, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	}
});

// ── 技能树 ──
const TOP = 360;
const PACKS = 6;
const PER_PACK = 10;
const FLAT = 40;
const NOTES = 5;
const NO_NAME_FM = 2;

const skillText = (name, body, extra = "") => `---\nname: ${name}\ndescription: ${name} 的说明\n${extra}---\n${body}\n`;
function writeFileAt(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, "utf8");
}

function buildTree() {
	for (let i = 0; i < TOP; i += 1) {
		const id = String(i).padStart(3, "0");
		const extra =
			(i % 18 === 0 ? `metadata:\n  group: 组-${i % 3}\n  tags: [甲${i}, 乙]\n` : "") +
			(i % 29 === 0 ? "disable-model-invocation: true\n" : "") +
			(i === 5 ? "user-invocable: false\n" : "");
		writeFileAt(path.join(agentsRoot, `top-${id}`, "SKILL.md"), skillText(`top-${id}`, `# top-${id}\n正文 ${id}`, extra));
	}
	for (let p = 0; p < PACKS; p += 1) {
		for (let j = 0; j < PER_PACK; j += 1) {
			writeFileAt(
				path.join(agentsRoot, `pack-${p}`, `inner-${j}`, "SKILL.md"),
				skillText(`inner-${p}-${j}`, `# inner\n正文 ${p}-${j}`, j % 3 === 0 ? "metadata:\n  group: 嵌套组\n  tags:\n    - 丙\n    - 丁\n" : "")
			);
		}
	}
	for (let i = 0; i < FLAT; i += 1) {
		const id = String(i).padStart(2, "0");
		writeFileAt(path.join(agentsRoot, `flat-${id}.md`), skillText(`flat-${id}`, `# flat\n正文`));
	}
	// 无 name 的 md：读得到但不是 skill（旧行为就是跳过）
	for (let i = 0; i < NOTES; i += 1) writeFileAt(path.join(agentsRoot, `note-${i}.md`), `# 说明 ${i}\n没有 frontmatter，不是技能\n`);
	for (let i = 0; i < NO_NAME_FM; i += 1) writeFileAt(path.join(agentsRoot, `fm-no-name-${i}.md`), `---\ndescription: 有 frontmatter 但没有 name\n---\n正文\n`);
	// 带 BOM
	writeFileAt(path.join(agentsRoot, "bom-skill", "SKILL.md"), "\ufeff" + skillText("bom-skill", "# bom\n正文"));
	// frontmatter name 不是 kebab-case → nameValid=false，显示名退回目录名
	writeFileAt(path.join(agentsRoot, "legacy-dir", "SKILL.md"), skillText("Bad_Name", "# bad\n正文"));
	// 跨来源同名遮蔽：user-dsh 先扫到 → user-agents 两个后扫到（顶层 + 嵌套各一个）
	writeFileAt(path.join(dshRoot, "shadow-a", "SKILL.md"), skillText("shared-skill", "# shared\n正文 A"));
	writeFileAt(path.join(agentsRoot, "shadow-b", "SKILL.md"), skillText("shared-skill", "# shared\n正文 B"));
	writeFileAt(path.join(agentsRoot, "pack-shadow", "inner-shadow", "SKILL.md"), skillText("shared-skill", "# shared\n正文 C"));
	// custom 源（mirrorDir）：一个与既有条目同名 → 走 custom 丢弃分支；一个独有 → 保留并标 source=custom
	writeFileAt(path.join(mirrorRoot, "shadow-mirror", "SKILL.md"), skillText("shared-skill", "# shared\n正文 D"));
	writeFileAt(path.join(mirrorRoot, "mirror-only", "SKILL.md"), skillText("mirror-only", "# mirror\n正文 M"));
	// project 级两个根
	writeFileAt(path.join(workspace, ".dsh", "skills", "proj-dsh", "SKILL.md"), skillText("proj-dsh", "# project\n正文 P"));
	writeFileAt(path.join(workspace, ".agents", "skills", "proj-agents", "SKILL.md"), skillText("proj-agents", "# project\n正文 Q"));
	// 变更场景的固定靶子：正文里带可检出的标记
	writeFileAt(path.join(agentsRoot, "top-007", "SKILL.md"), skillText("top-007", "# top-007\n正文 007\nMARK-SIZE-BEFORE"));
	writeFileAt(path.join(agentsRoot, "top-008", "SKILL.md"), skillText("top-008", "# top-008\n正文 008\nMARK-MT-A1"));
	// extractor 配置：把 mirrorDir 指到伪 HOME 下（configuredExtraSkillDirs → custom 根）
	fs.mkdirSync(path.join(fakeHome, ".dsh", "dsh-studio"), { recursive: true });
	fs.writeFileSync(path.join(fakeHome, ".dsh", "dsh-studio", "extractor.json"), JSON.stringify({ mirrorDir: mirrorRoot }, null, 2) + "\n", "utf8");
}

/** 递归数 SKILL.md（根之外的层也算，用来证明树规模）。 */
function countSkillMd(dir) {
	let count = 0;
	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) walk(path.join(d, entry.name));
			else if (entry.isFile() && entry.name === "SKILL.md") count += 1;
		}
	};
	walk(dir);
	return count;
}

/** 基线 lib：只放基线里的 scanner + extractor + extractor 的两个依赖，逐个从 git 取。 */
function buildBaselineLib() {
	fs.mkdirSync(baselineLib, { recursive: true });
	for (const name of BASELINE_FILES) {
		const text = execFileSync("git", ["show", `${BASELINE}:lib/${name}`], { cwd: pluginRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
		fs.writeFileSync(path.join(baselineLib, name), text, "utf8");
	}
}

// ── 两套 lib 的加载与扫描 ──
let probeSeq = 0;
const fresh = (dir) => import(pathToFileURL(path.join(dir, "scanner.js")).href + "?probe=" + (probeSeq += 1));

async function scanOnce(mod) {
	resetIO();
	const started = performance.now();
	const skills = await mod.scanSkills(workspace);
	const ms = performance.now() - started;
	return {
		skills,
		ms,
		readFile: IO.readFile,
		readFilePaths: IO.readFilePaths.slice(),
		readdir: IO.readdir,
		stat: IO.stat,
		statPaths: IO.statPaths.slice(),
		realpath: IO.realpath
	};
}

function withoutContent(skill) {
	if (skill === undefined || skill === null) return skill;
	const { content, ...rest } = skill;
	return rest;
}

function compareLists(baselineSkills, currentSkills) {
	const diffs = [];
	if (baselineSkills.length !== currentSkills.length) diffs.push(`条目数 ${baselineSkills.length} vs ${currentSkills.length}`);
	const n = Math.min(baselineSkills.length, currentSkills.length);
	for (let i = 0; i < n && diffs.length < 3; i += 1) {
		const left = withoutContent(baselineSkills[i]);
		const right = withoutContent(currentSkills[i]);
		if (isDeepStrictEqual(left, right)) continue;
		const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
		const bad = [...keys].filter((k) => !isDeepStrictEqual(left[k], right[k]));
		diffs.push(`#${i}(${baselineSkills[i].name}) 字段不同: ${bad.join(",")}`);
	}
	return { equal: diffs.length === 0, diffs, count: currentSkills.length };
}

function bodyOf(skill) {
	if (typeof skill?.content === "string") return skill.content;
	if (typeof skill?.path === "string") return fs.readFileSync(skill.path, "utf8").replace(/^﻿/, "");
	return "";
}

const round = (ms) => Math.round(ms * 10) / 10;
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const countPaths = (paths, suffix) => paths.filter((p) => String(p).endsWith(suffix)).length;
const countMdStat = (paths) => paths.filter((p) => /\.md$/i.test(String(p))).length;

const out = { env: {}, fixture: {}, equivalence: {}, reread: {}, readFile: {}, timing: {} };

buildTree();
buildBaselineLib();

// 1) 首轮冷扫：新旧逐项深比对
const baselineColdMod = await fresh(baselineLib);
const currentMod = await fresh(currentLib);
const baseCold = await scanOnce(baselineColdMod);
const currentCold = await scanOnce(currentMod);
out.equivalence.cold = compareLists(baseCold.skills, currentCold.skills);
out.readFile.baselineCold = baseCold.readFile;
out.readFile.currentCold = currentCold.readFile;
out.readFile.baselineColdSkillMd = countPaths(baseCold.readFilePaths, "SKILL.md");
out.readFile.currentColdSkillMd = countPaths(currentCold.readFilePaths, "SKILL.md");
out.readFile.currentColdPathsSample = currentCold.readFilePaths.slice(0, 3);
out.readFile.currentColdRealpath = currentCold.realpath;
out.readFile.baselineColdStat = baseCold.stat;
out.readFile.currentColdStat = currentCold.stat;
out.readFile.baselineColdStatMd = countMdStat(baseCold.statPaths);
out.readFile.currentColdStatMd = countMdStat(currentCold.statPaths);

const shadowPairs = currentCold.skills
	.filter((skill) => skill.shadowedBy !== undefined || Array.isArray(skill.shadows))
	.map((skill) => ({ name: skill.name, shadowedBy: skill.shadowedBy ?? null, shadows: skill.shadows ?? [] }));
out.fixture = {
	skillMdFiles:
		countSkillMd(agentsRoot) + countSkillMd(dshRoot) + countSkillMd(mirrorRoot) + countSkillMd(path.join(workspace, ".dsh", "skills")) + countSkillMd(path.join(workspace, ".agents", "skills")),
	entries: currentCold.skills.length,
	nested: currentCold.skills.filter((skill) => skill.nested === true).length,
	flat: currentCold.skills.filter((skill) => skill.path.endsWith(".md") && !skill.path.endsWith("SKILL.md")).length,
	mdFiles: fs.readdirSync(agentsRoot).filter((name) => name.endsWith(".md") && name !== "SKILL.md").length,
	noNameSkipped: NOTES + NO_NAME_FM,
	sources: [...new Set(currentCold.skills.map((skill) => skill.source))].sort(),
	shadowPairs,
	nameValidFalse: currentCold.skills.filter((skill) => skill.nameValid === false).map((skill) => ({ name: skill.name, declaredName: skill.declaredName })),
	grouped: currentCold.skills.filter((skill) => skill.group !== "").length,
	modelDisabled: currentCold.skills.filter((skill) => skill.modelInvocable === false).length,
	userDisabled: currentCold.skills.filter((skill) => skill.userInvocable === false).length,
	bomStripped: currentCold.skills.filter((skill) => skill.name === "bom-skill").every((skill) => bodyOf(skill).charCodeAt(0) !== 0xfeff)
};

// 2) 四种变更：每步都用「持久 current 实例」复扫（走缓存），再与「旧逻辑在新目录状态下的输出」深比对
{
	const sizeTarget = path.join(agentsRoot, "top-007", "SKILL.md");
	const sizeBefore = fs.statSync(sizeTarget).size;
	fs.writeFileSync(sizeTarget, skillText("top-007", "# top-007\n正文 007\nMARK-SIZE-AFTER-更长的正文"), "utf8");
	const sizeAfter = fs.statSync(sizeTarget).size;
	const after = await scanOnce(currentMod);
	const base = await scanOnce(await fresh(baselineLib));
	const entry = after.skills.find((skill) => skill.name === "top-007");
	out.equivalence.size = compareLists(base.skills, after.skills);
	out.reread.size = {
		newValueSeen: /MARK-SIZE-AFTER/.test(bodyOf(entry)),
		oldValueGone: !/MARK-SIZE-BEFORE/.test(bodyOf(entry)),
		sizeChanged: sizeBefore !== sizeAfter,
		sizeBefore,
		sizeAfter,
		readFile: after.readFile,
		readFilePaths: after.readFilePaths
	};
}
{
	const mtimeTarget = path.join(agentsRoot, "top-008", "SKILL.md");
	const before = fs.statSync(mtimeTarget);
	const text = fs.readFileSync(mtimeTarget, "utf8");
	const replaced = text.replace("MARK-MT-A1", "MARK-MT-B1");
	fs.writeFileSync(mtimeTarget, replaced, "utf8");
	const afterWrite = fs.statSync(mtimeTarget);
	const future = new Date(Date.now() + 7000);
	fs.utimesSync(mtimeTarget, future, future);
	const afterTouch = fs.statSync(mtimeTarget);
	const after = await scanOnce(currentMod);
	const base = await scanOnce(await fresh(baselineLib));
	const entry = after.skills.find((skill) => skill.name === "top-008");
	out.equivalence.mtime = compareLists(base.skills, after.skills);
	out.reread.mtime = {
		newValueSeen: /MARK-MT-B1/.test(bodyOf(entry)),
		oldValueGone: !/MARK-MT-A1/.test(bodyOf(entry)),
		replaceHit: replaced !== text,
		sizeSame: before.size === afterWrite.size,
		mtimeChanged: before.mtimeMs !== afterTouch.mtimeMs,
		sizeBefore: before.size,
		sizeAfter: afterWrite.size,
		readFile: after.readFile,
		readFilePaths: after.readFilePaths
	};
}
{
	const deleteTarget = path.join(agentsRoot, "top-009");
	fs.rmSync(deleteTarget, { recursive: true, force: true });
	const after = await scanOnce(currentMod);
	const base = await scanOnce(await fresh(baselineLib));
	out.equivalence.delete = compareLists(base.skills, after.skills);
	out.reread.delete = {
		seenBeforeDelete: currentCold.skills.some((skill) => skill.name === "top-009"),
		entryGone: !after.skills.some((skill) => skill.name === "top-009"),
		baselineSawGone: !base.skills.some((skill) => skill.name === "top-009"),
		readFile: after.readFile,
		readFilePaths: after.readFilePaths
	};
}
{
	writeFileAt(path.join(agentsRoot, "top-new-001", "SKILL.md"), skillText("top-new-001", "# 新增\n正文 new"));
	const after = await scanOnce(currentMod);
	const base = await scanOnce(await fresh(baselineLib));
	out.equivalence.add = compareLists(base.skills, after.skills);
	out.reread.add = {
		entrySeen: after.skills.some((skill) => skill.name === "top-new-001"),
		baselineSawIt: base.skills.some((skill) => skill.name === "top-new-001"),
		readFile: after.readFile,
		readFilePaths: after.readFilePaths
	};
}

// 3) 三段耗时：同一目录状态（4 种变更之后）。baseline / current 冷扫交错各 5 次，
//    无变更复扫 5 次，全部取中位——交错是为了让文件系统缓存与后台抖动对两段公平。
{
	const baselineCold = [];
	const currentCold = [];
	let coldProbe = null;
	for (let i = 0; i < 5; i += 1) {
		baselineCold.push(round((await scanOnce(await fresh(baselineLib))).ms));
		const run = await scanOnce(await fresh(currentLib));
		currentCold.push(round(run.ms));
		if (i === 0) coldProbe = run;
	}
	const warmMod = await fresh(currentLib);
	await scanOnce(warmMod); // 先建一遍缓存，不计时
	const currentWarm = [];
	let warmProbe = null;
	for (let i = 0; i < 5; i += 1) {
		const run = await scanOnce(warmMod);
		currentWarm.push(round(run.ms));
		if (i === 0) warmProbe = run;
	}
	out.timing = {
		baselineCold,
		baselineColdMedian: median(baselineCold),
		currentCold,
		currentColdMedian: median(currentCold),
		currentWarm,
		currentWarmMedian: median(currentWarm),
		sameDirectoryState: true,
		interleaved: true
	};
	out.readFile.currentColdRealpathProbe = coldProbe.realpath;
	out.readFile.currentWarm = warmProbe.readFile;
	out.readFile.currentWarmPaths = warmProbe.readFilePaths;
	out.readFile.currentWarmReaddir = warmProbe.readdir;
	out.readFile.currentWarmStat = warmProbe.stat;
	out.readFile.currentWarmRealpath = warmProbe.realpath;
	out.readFile.baselineColdReaddir = baseCold.readdir;
	out.readFile.currentColdReaddir = currentCold.readdir;
	out.readFile.currentWarmStatMd = countMdStat(warmProbe.statPaths);
}

out.env = {
	USERPROFILE: process.env.USERPROFILE,
	HOME: process.env.HOME,
	DSH_HOME: process.env.DSH_HOME,
	homedir: os.homedir(),
	fakeHome,
	tripletMatches: process.env.USERPROFILE === fakeHome && process.env.HOME === fakeHome && process.env.DSH_HOME === path.join(fakeHome, ".dsh") && os.homedir() === fakeHome
};

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
try {
	fs.rmSync(fakeHome, { recursive: true, force: true });
} catch {
	/* 伪目录清理失败不影响结果 */
}
