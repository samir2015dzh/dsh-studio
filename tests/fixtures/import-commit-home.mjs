// N-02 fixture：本地 bare 仓库当 GitHub 上游，验证导入时 lock 补记 commit。
//
// 全程离线：用 git 的 `url.<base>.insteadOf` 把假 GitHub 地址重写到伪 HOME 里的 bare 仓库，
// 走的是产品代码真实的 `git ls-remote https://github.com/...` 路径，不给导入路径开测试口子。
// 下载这一步用预制的 pkg 绕过（N-02 只关心写 lock，不关心 codeload）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const lib = (name) => import(pathToFileURL(path.join(pluginRoot, "lib", name)).href);
const { importSkill, loadLock, parseSkillSource, resolveSourceCommit } = await lib("skillsrc.js");
const { checkUpstream } = await lib("upstream.js");

const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

// ---- 1. 工作仓库 + 一个提交 + bare 远端（本地 bare 就是「上游」）
const work = path.join(home, "work");
const bare = path.join(home, "upstream.git");
fs.mkdirSync(work, { recursive: true });
git(["init", "-b", "main"], work);
git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "v1"], work);
const headSha = git(["rev-parse", "HEAD"], work);
git(["init", "--bare", "-b", "main", bare]);
git(["remote", "add", "origin", bare], work);
git(["push", "origin", "main"], work);

// ---- 2. insteadOf：假 GitHub 地址 → 本地 bare；另一个指向不存在的仓库（失败路径）
const missing = path.join(home, "missing.git");
const cfgFile = path.join(home, "gitconfig");
fs.writeFileSync(
	cfgFile,
	[
		`[url "${pathToFileURL(bare).href}"]`,
		"\tinsteadOf = https://github.com/commit-fixture/repo",
		`[url "${pathToFileURL(missing).href}"]`,
		"\tinsteadOf = https://github.com/commit-fixture/missing",
		""
	].join("\n")
);
// 只作用于本 fixture 进程及其 git 子进程，不写任何持久化配置
process.env.GIT_CONFIG_GLOBAL = cfgFile;

const URL_OK = "https://github.com/commit-fixture/repo";
const URL_BAD = "https://github.com/commit-fixture/missing";

const makePkg = (source, name) => {
	const parsed = parseSkillSource(source);
	const skillText = `---\nname: ${name}\ndescription: N-02 fixture\n---\nbody\n`;
	return {
		name,
		parsed,
		sha256: createHash("sha256").update(skillText).digest("hex"),
		found: { rootRel: "", files: [{ rel: "SKILL.md", data: Buffer.from(skillText) }], skillText }
	};
};

const targetDir = path.join(home, ".agents", "skills");

// ---- 3. 正常路径：导入成功 → lock 里补记 ref 的 commit
const importedOk = await importSkill({ source: URL_OK, targetDir, pkg: makePkg(URL_OK, "commit-skill") });
const lockAfterOk = await loadLock();
const recOk = lockAfterOk["commit-skill"] ?? {};
// 读侧口径：resolveUpstream 取第一个能对齐的 commit → checkUpstream 应给出可比对结论
const check = await checkUpstream(path.join(targetDir, "commit-skill"), { lock: lockAfterOk });

// ---- 4. 失败路径：ls-remote 不可达 → 导入照常成功、commit 缺省
const importedBad = await importSkill({ source: URL_BAD, targetDir, pkg: makePkg(URL_BAD, "no-commit-skill") });
const lockAfterBad = await loadLock();
const recBad = lockAfterBad["no-commit-skill"] ?? {};
// N-02 之前没有这个导出：缺了就显式记成哨兵值，让父测试给出可读的红而不是崩在 TypeError 上
const commitOf = async (parsed) =>
	typeof resolveSourceCommit === "function" ? await resolveSourceCommit(parsed) : "<<no resolveSourceCommit export>>";
const badCommit = await commitOf(parseSkillSource(URL_BAD));

// tarball 来源没有 git ref 可查，必须留空（不许伪造 commit）
const tarballCommit = await commitOf(parseSkillSource(path.join(home, "x.tgz")));

process.stdout.write(
	JSON.stringify({
		headSha,
		importedOk,
		recOk,
		check,
		importedBad,
		recBad,
		badCommit,
		tarballCommit,
		targetDir
	})
);
