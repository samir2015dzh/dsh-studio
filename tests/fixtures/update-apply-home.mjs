// N-01 fixture：skillmgr_update_apply 的七个场景 + 备份不变式。
//
// 全程离线：GitHub 地址用 git 的 `url.<base>.insteadOf` 重写到伪 HOME 里的 bare 仓库
// （与 N-02 的 import-commit-home.mjs 同一手法，只改本进程及其 git 子进程，不写任何持久化配置）；
// codeload 下载用 fetchImpl 注入本地 `git archive` 出的 tar.gz，字节形态与 codeload 一致
// （顶层 <repo>-<ref>/）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const lib = (name) => import(pathToFileURL(path.join(pluginRoot, "lib", name)).href);

const { applySkillUpdate, defaultBackupsRoot } = await lib("update-apply.js");
const { loadLock } = await lib("skillsrc.js");
const { checkUpstream } = await lib("upstream.js");
const { isInside } = await lib("paths.js");

const NOW = 1794016800000;
const ORG = "fixture-org";
const agentRoot = path.join(home, ".agents", "skills");
const diskRoot = path.join(home, ".dsh", "skills");
const lockFile = path.join(home, ".dsh", "dsh-studio", "skill-lock.json");
const roots = [agentRoot, diskRoot];
fs.mkdirSync(agentRoot, { recursive: true });
fs.mkdirSync(diskRoot, { recursive: true });

const SIGN = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

const writeFiles = (root, files) => {
	for (const [rel, text] of Object.entries(files)) {
		const target = path.join(root, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text);
	}
};

const commitAll = (cwd, message) => {
	git([...SIGN, "add", "-A"], cwd);
	git([...SIGN, "commit", "--no-verify", "-m", message], cwd);
	return git(["rev-parse", "HEAD"], cwd);
};

const repositories = new Map();
const archives = new Map();

// 先钉住 core.autocrlf=false：git archive 不做换行转换，后面的逐字节断言才有意义。
// 只作用于本进程与它的 git 子进程（GIT_CONFIG_GLOBAL 指向伪 HOME 里的临时文件）。
const cfgFile = path.join(home, "gitconfig");
fs.writeFileSync(cfgFile, "[core]\n\tautocrlf = false\n");
process.env.GIT_CONFIG_GLOBAL = cfgFile;

/** 造一个「GitHub 仓库」：dev 工作树 + bare 远端 + 一份 tar.gz（= codeload 的响应体）。 */
function makeRepo(name, files) {
	const dev = path.join(home, "dev-" + name);
	const bare = path.join(home, "bare-" + name + ".git");
	fs.mkdirSync(dev, { recursive: true });
	git(["init", "-b", "main"], dev);
	writeFiles(dev, files);
	const sha = commitAll(dev, "v1");
	git(["init", "--bare", "-b", "main", bare], home);
	git(["remote", "add", "origin", bare], dev);
	git(["push", "origin", "main"], dev);
	repositories.set(`${ORG}/${name}`, bare);
	archives.set(`${ORG}/${name}`, pack(bare, name));
	return { name, dev, bare, sha };
}

function pack(bare, name) {
	return execFileSync("git", ["-C", bare, "archive", "--format=tar.gz", `--prefix=${name}-main/`, "main"], {
		stdio: "pipe",
		maxBuffer: 64 * 1024 * 1024
	});
}

/** 往上游推一代：改文件 → 提交 → 推送 → 重打 tar.gz。返回新 commit。 */
function pushNext(repo, files) {
	writeFiles(repo.dev, files);
	repo.sha = commitAll(repo.dev, "next");
	git(["push", "origin", "main"], repo.dev);
	archives.set(`${ORG}/${repo.name}`, pack(repo.bare, repo.name));
	return repo.sha;
}

/** 假 GitHub 的实际响应：按地址里的 owner/repo 取预制的 tar.gz。 */
const fetchImpl = async (url) => {
	const m = /codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\//.exec(String(url));
	if (m === null) return new Response("no such archive", { status: 404 });
	const bytes = archives.get(`${m[1]}/${m[2]}`);
	if (bytes === undefined) return new Response("no such archive", { status: 404 });
	return new Response(bytes, { status: 200 });
};

/** 逐文件 sha256（不给 .git 记账：那份内脏不参与取舍，也不该出现在断言里）。 */
function hashDir(dir) {
	const out = {};
	const walk = (prefix) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
			if (entry.isDirectory()) walk(rel);
			else if (entry.isFile()) out[rel] = createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex");
		}
	};
	walk("");
	return out;
}

const lock = {};
const install = (name, files, record) => {
	const dir = path.join(agentRoot, name);
	writeFiles(dir, files);
	if (record !== undefined) lock[name] = record;
	return dir;
};
const record = (repoName, extra = {}) => ({
	source: `https://github.com/${ORG}/${repoName}`,
	ref: "main",
	sha256: "0".repeat(64),
	at: "2026-01-01T00:00:00.000Z",
	subPath: "",
	...extra
});

// ==================== 场景 1：普通直升（独立仓库形态，subPath 空表串）====================
const repoA = makeRepo("skill-a", {
	"SKILL.md": "---\nname: skill-a\ndescription: fixture A\n---\nv1 body\n",
	"extra.txt": "upstream extra\n"
});
const dirA = install(
	"skill-a",
	{ "SKILL.md": "---\nname: skill-a\ndescription: fixture A\n---\nv1 body\n", "extra.txt": "upstream extra\n" },
	record("skill-a", { commit: repoA.sha })
);
const shaA1 = repoA.sha;
const shaA2 = pushNext(repoA, { "SKILL.md": "---\nname: skill-a\ndescription: fixture A v2\n---\nv2 body\n" });
const beforeA = hashDir(dirA);

// ==================== 场景 2：monorepo 子目录（huashu-slides 形态）====================
const repoB = makeRepo("fixture-mono", {
	"skills/sub-skill/SKILL.md": "---\nname: sub-skill\ndescription: mono\n---\nmono v1\n",
	"skills/sub-skill/notes.txt": "notes\n",
	"other/SKILL.md": "---\nname: other\ndescription: 同仓别的技能\n---\nother\n",
	"README.md": "mono repo\n"
});
const dirB = install(
	"sub-skill",
	{ "SKILL.md": "---\nname: sub-skill\ndescription: mono\n---\nmono v1\n", "notes.txt": "notes\n" },
	record("fixture-mono", { subPath: "skills/sub-skill", commit: repoB.sha })
);
const shaB2 = pushNext(repoB, { "skills/sub-skill/SKILL.md": "---\nname: sub-skill\ndescription: mono\n---\nmono v2\n" });

// ==================== 场景 3：独立仓库整仓即技能（huashu-design 形态）====================
const repoC = makeRepo("fixture-design", {
	"SKILL.md": "---\nname: design-skill\ndescription: design\n---\ndesign v1\n",
	".github/workflows/ci.yml": "name: ci\n",
	"docs/a.md": "doc\n"
});
const dirC = install(
	"design-skill",
	{ "SKILL.md": "---\nname: design-skill\ndescription: design\n---\ndesign v1\n" },
	record("fixture-design", { commit: repoC.sha })
);
const shaC2 = pushNext(repoC, { "SKILL.md": "---\nname: design-skill\ndescription: design v2\n---\ndesign v2\n" });

// ==================== 场景 4：标注重打（旧有 metadata.group，上游没有）====================
const upstreamD = "---\nname: group-skill\ndescription: group v2\nmetadata:\n  tags:\n    - x\n---\nv2\n";
const repoD = makeRepo("fixture-group", {
	"SKILL.md": "---\nname: group-skill\ndescription: group v1\nmetadata:\n  group: 花叔\n---\nv1\n"
});
const dirD = install(
	"group-skill",
	{ "SKILL.md": "---\nname: group-skill\ndescription: group v1\nmetadata:\n  group: 花叔\n---\nv1\n" },
	record("fixture-group", { commit: repoD.sha })
);
const shaD2 = pushNext(repoD, { "SKILL.md": upstreamD });

// ==================== 场景 5：本地独有文件保留 + commit 标记更新 ====================
const repoE = makeRepo("fixture-keep", { "SKILL.md": "---\nname: keep-skill\ndescription: keep\n---\nkeep v1\n" });
const dirE = install(
	"keep-skill",
	{
		"SKILL.md": "---\nname: keep-skill\ndescription: keep\n---\nkeep v1\n",
		".huashu-skill-meta.json":
			JSON.stringify({ name: "keep-skill", repo: `https://github.com/${ORG}/fixture-keep`, commit: repoE.sha, installed_at: "2026-01-01" }, null, 2) + "\n",
		"local-only.md": "只有本地有\n"
	},
	record("fixture-keep", { commit: repoE.sha })
);
const shaE2 = pushNext(repoE, { "SKILL.md": "---\nname: keep-skill\ndescription: keep\n---\nkeep v2\n" });

// ==================== 场景 6：无来源拒绝 ====================
const dirF1 = install("no-source", { "SKILL.md": "---\nname: no-source\ndescription: 没有 lock 记录\n---\nbody\n" });
const dirF2 = install(
	"tarball-skill",
	{ "SKILL.md": "---\nname: tarball-skill\ndescription: 本地 tarball 来源\n---\nbody\n" },
	{ source: path.join(home, "pkg.tgz"), ref: "", sha256: "c".repeat(64), at: "2026-01-01T00:00:00.000Z", subPath: "" }
);

// ==================== 场景 7：拉取失败零改动 ====================
// 7a 上游不可达（insteadOf 指向不存在的仓库）
repositories.set(`${ORG}/fixture-unreach`, path.join(home, "missing-unreach.git"));
const dirG1 = install(
	"unreach-skill",
	{ "SKILL.md": "---\nname: unreach-skill\ndescription: 上游不可达\n---\nv1\n" },
	record("fixture-unreach", { commit: "d".repeat(40) })
);
// 7b 包内没有 SKILL.md（上游确实前进了一代，不能走「已是最新」短路）
const repoG = makeRepo("fixture-noskill", { "README.md": "no skill here\n" });
const dirG2 = install(
	"noskill-skill",
	{ "SKILL.md": "---\nname: noskill-skill\ndescription: 包里没 SKILL.md\n---\nv1\n" },
	record("fixture-noskill", { commit: repoG.sha })
);
pushNext(repoG, { "NOTES.md": "moved on\n" });

// ---- 落 lock 文件 + insteadOf（进程级，仅本进程与它的 git 子进程可见）
fs.mkdirSync(path.dirname(lockFile), { recursive: true });
fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
fs.writeFileSync(
	cfgFile,
	[
		"[core]",
		"\tautocrlf = false",
		...[...repositories].map(([key, bare]) => `[url "${pathToFileURL(bare).href}"]\n\tinsteadOf = https://github.com/${key}`)
	].join("\n") + "\n"
);

const run = (name, extra = {}) => applySkillUpdate({ name, roots, fetchImpl, ttlMs: 0, now: NOW, ...extra });

// ==================== 执行 ====================
const applyA = await run("skill-a");
const afterA = hashDir(dirA);
const checkA = await checkUpstream(dirA);
const lockA = (await loadLock())["skill-a"] ?? {};
const backupA = applyA.backupPath === "" ? {} : hashDir(applyA.backupPath);
const againA = await run("skill-a", { now: NOW + 1000 });
const lockA2 = (await loadLock())["skill-a"] ?? {};

const applyB = await run("sub-skill");
const afterB = hashDir(dirB);
const checkB = await checkUpstream(dirB);

const applyC = await run("design-skill");
const afterC = hashDir(dirC);
const checkC = await checkUpstream(dirC);

const applyD = await run("group-skill");
const skillD = fs.readFileSync(path.join(dirD, "SKILL.md"), "utf8");
const bakD = fs.existsSync(path.join(dirD, "SKILL.md.bak-group")) ? fs.readFileSync(path.join(dirD, "SKILL.md.bak-group"), "utf8") : null;
const checkD = await checkUpstream(dirD);

const applyE = await run("keep-skill");
const metaE = JSON.parse(fs.readFileSync(path.join(dirE, ".huashu-skill-meta.json"), "utf8"));
const localE = fs.readFileSync(path.join(dirE, "local-only.md"), "utf8");

const beforeF = { files: hashDir(dirF1), lock: fs.readFileSync(lockFile, "utf8") };
const applyF1 = await run("no-source");
const applyF2 = await run("tarball-skill");
const afterF = { files: hashDir(dirF1), lock: fs.readFileSync(lockFile, "utf8") };

const beforeG1 = hashDir(dirG1);
const beforeG2 = hashDir(dirG2);
const lockBeforeG = fs.readFileSync(lockFile, "utf8");
const applyG1 = await run("unreach-skill");
const applyG2 = await run("noskill-skill");
const lockAfterG = fs.readFileSync(lockFile, "utf8");

// 备份不变式：备份路径不得落在任何扫描根之内
const backupOutside = !isInside(agentRoot, applyA.backupPath) && !isInside(diskRoot, applyA.backupPath);
const backupsUnderDataDir = applyA.backupPath.startsWith(defaultBackupsRoot());

process.stdout.write(
	JSON.stringify({
		now: NOW,
		scenes: {
			one: { apply: applyA, before: beforeA, after: afterA, check: checkA, lock: lockA, backup: backupA, again: againA, lockAgain: lockA2, shaOld: shaA1, shaNew: shaA2 },
			two: { apply: applyB, after: afterB, check: checkB, shaNew: shaB2 },
			three: { apply: applyC, after: afterC, check: checkC, shaNew: shaC2 },
			four: { apply: applyD, skill: skillD, bak: bakD, upstream: upstreamD, check: checkD, shaNew: shaD2 },
			five: { apply: applyE, meta: metaE, localOnly: localE, shaNew: shaE2 },
			six: { apply1: applyF1, apply2: applyF2, before: beforeF, after: afterF, dirs: [dirF1, dirF2] },
			seven: { apply1: applyG1, apply2: applyG2, before: [beforeG1, beforeG2], after: [hashDir(dirG1), hashDir(dirG2)], lockSame: lockBeforeG === lockAfterG }
		},
		backup: { path: applyA.backupPath, outsideRoots: backupOutside, underDataDir: backupsUnderDataDir, dir: dirA }
	})
);
