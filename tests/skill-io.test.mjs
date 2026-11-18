/**
 * 技能读写删除：原子保存、frontmatter 校验、回收站根目录保护、项目级与单文件技能。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;

const realHome = homedir();
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-skill-io-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");

const { atomicWriteFile } = await import(modUrl("lib/fs-atomic.js"));
const { saveSkill } = await import(modUrl("lib/index.js"));
const { trashSkill, restoreTrash, listTrash, purgeTrash } = await import(modUrl("lib/trash.js"));
const { scanSkills } = await import(modUrl("lib/scanner.js"));
const { UserError } = await import(modUrl("lib/errors.js"));

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

const ctx = {
	skills: { get: async () => null, list: async () => [] },
	logger: { warn() {}, error() {}, info() {} }
};

function writeSkillDir(root, name, body = `# ${name}\n`) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${body}`);
	return dir;
}

try {
	console.log("\n[1] atomicWriteFile");
	{
		const file = join(fakeHome, "atomic", "note.txt");
		await atomicWriteFile(file, "hello", "utf8");
		assert(readFileSync(file, "utf8") === "hello", "首次写入");
		await atomicWriteFile(file, "world", "utf8");
		assert(readFileSync(file, "utf8") === "world", "覆盖写入完整");
		const leftovers = (await import("node:fs")).readdirSync(dirname(file)).filter((n) => n.endsWith(".tmp"));
		assert(leftovers.length === 0, "成功后不留临时文件");
	}

	const userRoot = join(fakeHome, ".dsh", "skills");
	mkdirSync(userRoot, { recursive: true });
	writeSkillDir(userRoot, "demo-skill", "# 正文\n");

	console.log("\n[2] saveSkill 校验");
	{
		const cwd = fakeHome;
		const ok = await saveSkill(ctx, { name: "demo-skill", content: "---\nname: demo-skill\ndescription: 改过\n---\n# 新正文\n" }, cwd);
		assert(ok.ok && readFileSync(join(userRoot, "demo-skill", "SKILL.md"), "utf8").includes("# 新正文"), "合法内容写回");

		let msg = "";
		try {
			await saveSkill(ctx, { name: "demo-skill", content: "没有 frontmatter" }, cwd);
		} catch (error) {
			msg = error.message;
			assert(error instanceof UserError, "缺 name 是 UserError");
		}
		assert(/开头的 --- 里要写 name/.test(msg), "缺 name 被拒绝: " + msg);
		assert(readFileSync(join(userRoot, "demo-skill", "SKILL.md"), "utf8").includes("# 新正文"), "拒绝后原文件不变");

		msg = "";
		try {
			await saveSkill(ctx, { name: "demo-skill", content: "---\nname: other-skill\ndescription: x\n---\n# x\n" }, cwd);
		} catch (error) {
			msg = error.message;
		}
		assert(/要和技能名「demo-skill」一致/.test(msg), "改名被拒绝: " + msg);

		msg = "";
		try {
			await saveSkill(ctx, { name: "demo-skill", content: "---\nname: Not Valid\ndescription: x\n---\n# x\n" }, cwd);
		} catch (error) {
			msg = error.message;
		}
		assert(/小写字母、数字和连字符/.test(msg), "非法 name 被拒绝: " + msg);
	}

	console.log("\n[3] 用户根目录技能：移入回收站再恢复");
	{
		const moved = await trashSkill({ name: "demo-skill", dir: join(userRoot, "demo-skill"), path: join(userRoot, "demo-skill", "SKILL.md") }, { cwd: fakeHome });
		assert(!existsSync(join(userRoot, "demo-skill")), "目录已移走");
		assert(existsSync(userRoot), "技能根还在");
		const listed = await listTrash();
		assert(listed.some((b) => b.id === moved.id && b.entries.some((e) => e.name === "demo-skill")), "回收站看得到");
		const restored = await restoreTrash(moved.id, "demo-skill", { cwd: fakeHome });
		assert(restored.restored.includes("demo-skill") && existsSync(join(userRoot, "demo-skill", "SKILL.md")), "已恢复");
	}

	console.log("\n[4] 项目级技能：恢复不再误判根目录");
	{
		const project = join(fakeHome, "work", "show");
		mkdirSync(join(project, ".git"), { recursive: true });
		const projRoot = join(project, ".dsh", "skills");
		writeSkillDir(projRoot, "proj-skill", "# 项目\n");
		writeSkillDir(userRoot, "keep-user", "# 用户\n");
		const moved = await trashSkill(
			{ name: "proj-skill", dir: join(projRoot, "proj-skill"), path: join(projRoot, "proj-skill", "SKILL.md") },
			{ cwd: project }
		);
		assert(!existsSync(join(projRoot, "proj-skill")), "项目技能已移走");
		assert(existsSync(join(userRoot, "keep-user", "SKILL.md")), "用户技能没被碰到");
		const restored = await restoreTrash(moved.id, "proj-skill", { cwd: project });
		assert(restored.restored.includes("proj-skill") && existsSync(join(projRoot, "proj-skill", "SKILL.md")), "项目技能已恢复");
		await purgeTrash(moved.id).catch(() => {}); // 批次已空，忽略
	}

	console.log("\n[5] 根上的单个 .md：只搬走文件，不扔整个技能根");
	{
		writeSkillDir(userRoot, "keep-md", "# 留下\n");
		const loose = join(userRoot, "loose-skill.md");
		writeFileSync(loose, "---\nname: loose-skill\ndescription: 单文件\n---\n# 单文件\n");
		const scanned = await scanSkills(fakeHome);
		const hit = scanned.find((s) => s.name === "loose-skill");
		assert(!!hit && hit.dir === userRoot, "扫描把单文件技能的 dir 指到技能根");
		const moved = await trashSkill({ name: hit.name, dir: hit.dir, path: hit.path }, { cwd: fakeHome });
		assert(!existsSync(loose), "单文件已移走");
		assert(existsSync(join(userRoot, "keep-md", "SKILL.md")), "旁边的目录技能还在");
		assert(existsSync(userRoot), "技能根还在");
		const restored = await restoreTrash(moved.id, "loose-skill", { cwd: fakeHome });
		assert(restored.restored.includes("loose-skill") && existsSync(loose), "单文件已恢复");
		await purgeTrash((await listTrash()).find((b) => b.entries.some((e) => e.name === "loose-skill"))?.id ?? moved.id).catch(() => {});
	}

	console.log("\n[6] 拒绝把整个技能根扔进回收站");
	{
		let msg = "";
		try {
			await trashSkill({ name: "oops", dir: userRoot }, { cwd: fakeHome });
		} catch (error) {
			msg = error.message;
			assert(error instanceof UserError, "拒绝根目录是 UserError");
		}
		assert(/不能把整个技能根目录/.test(msg), "拒绝根目录: " + msg);
		assert(existsSync(userRoot) && existsSync(join(userRoot, "keep-md", "SKILL.md")), "技能根未被移动");
	}
} finally {
	rmSync(fakeHome, { recursive: true, force: true });
}

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (skill-io) ===");
