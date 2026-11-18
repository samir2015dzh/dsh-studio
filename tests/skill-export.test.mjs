/**
 * 导出单个技能为 tar.gz：目录技能带上附属文件；根上的单个 .md 只打包该文件。
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-skill-export-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");

const { exportSkill, resolveExportPath } = await import(pathToFileURL(join(pluginRoot, "lib/skill-export.js")).href);
const { unpackTarGz } = await import(pathToFileURL(join(pluginRoot, "lib/snapshot.js")).href);
const { UserError } = await import(pathToFileURL(join(pluginRoot, "lib/errors.js")).href);

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

const userRoot = join(fakeHome, ".dsh", "skills");
mkdirSync(userRoot, { recursive: true });

const dirSkill = join(userRoot, "pack-me");
mkdirSync(join(dirSkill, "refs"), { recursive: true });
mkdirSync(join(dirSkill, ".git"), { recursive: true });
mkdirSync(join(dirSkill, "node_modules", "x"), { recursive: true });
writeFileSync(join(dirSkill, "SKILL.md"), "---\nname: pack-me\ndescription: 目录技能\n---\n# 目录\n");
writeFileSync(join(dirSkill, "refs", "note.txt"), "附注\n");
writeFileSync(join(dirSkill, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(join(dirSkill, "node_modules", "x", "index.js"), "module.exports=1;\n");

writeFileSync(join(userRoot, "loose-one.md"), "---\nname: loose-one\ndescription: 单文件\n---\n# 单文件\n");
writeFileSync(join(userRoot, "sibling.md"), "---\nname: sibling\ndescription: 旁边的\n---\n# 旁边\n");

try {
	console.log("\n[1] 默认路径");
	{
		const dest = resolveExportPath("", "pack-me");
		assert(dest.endsWith(join(".dsh", "dsh-studio", "exports", "pack-me.tar.gz")), "默认写到 ~/.dsh/dsh-studio/exports: " + dest);
		assert(resolveExportPath(join(fakeHome, "out.tgz"), "pack-me") === join(fakeHome, "out.tgz"), "已有扩展名时原样使用");
		assert(resolveExportPath(join(fakeHome, "outdir"), "pack-me") === join(fakeHome, "outdir", "pack-me.tar.gz"), "给目录时补上文件名");
	}

	console.log("\n[2] 目录技能");
	{
		const dest = join(fakeHome, "pack-me.tar.gz");
		const result = await exportSkill({ name: "pack-me", path: dest, cwd: fakeHome });
		assert(result.ok && result.path === dest && result.files === 2, "导出 2 个文件（跳过 .git / node_modules）: " + result.files);
		assert(existsSync(dest) && result.bytes > 0, "包已落盘");
		const names = unpackTarGz(readFileSync(dest)).map((e) => e.rel).sort();
		assert(names.includes("pack-me/SKILL.md") && names.includes("pack-me/refs/note.txt"), "包内路径带技能目录前缀: " + names.join(","));
		assert(!names.some((n) => n.includes(".git") || n.includes("node_modules")), "不含 .git / node_modules");
		const skillText = unpackTarGz(readFileSync(dest)).find((e) => e.rel.endsWith("SKILL.md")).data.toString("utf8");
		assert(skillText.includes("# 目录"), "正文完整");
	}

	console.log("\n[3] 根上的单个 .md");
	{
		const dest = join(fakeHome, "loose-one.tar.gz");
		const result = await exportSkill({ name: "loose-one", path: dest, cwd: fakeHome });
		assert(result.ok && result.files === 1, "只打这一个文件");
		const names = unpackTarGz(readFileSync(dest)).map((e) => e.rel);
		assert(JSON.stringify(names) === JSON.stringify(["loose-one.md"]), "包里只有 loose-one.md，不含 sibling: " + names.join(","));
	}

	console.log("\n[4] 找不到 / 默认落点");
	{
		let err;
		try {
			await exportSkill({ name: "no-such-skill", cwd: fakeHome });
		} catch (error) {
			err = error;
		}
		assert(err instanceof UserError && err.statusCode === 404, "找不到时 404");
		const result = await exportSkill({ name: "pack-me", cwd: fakeHome });
		assert(result.path === resolveExportPath("", "pack-me") && existsSync(result.path), "省略路径时用默认落点");
	}
} finally {
	rmSync(fakeHome, { recursive: true, force: true });
}

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (skill-export) ===");
