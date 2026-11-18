/**
 * 打开后磁盘上的文件被改过：保存应拒绝（409 SKILL_CHANGED），原文不动；覆盖或 mtime 对得上才能写。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-skill-conflict-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");

const { saveSkill, getSkillDetail } = await import(pathToFileURL(join(pluginRoot, "lib/index.js")).href);
const { UserError } = await import(pathToFileURL(join(pluginRoot, "lib/errors.js")).href);

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

const userRoot = join(fakeHome, ".dsh", "skills");
const skillDir = join(userRoot, "demo-skill");
const skillFile = join(skillDir, "SKILL.md");
mkdirSync(skillDir, { recursive: true });
const original = "---\nname: demo-skill\ndescription: 原说明\n---\n# 原正文\n";
writeFileSync(skillFile, original);
const cwd = fakeHome;

function bumpMtime(path) {
	const now = Date.now() / 1000 + 3;
	utimesSync(path, now, now);
}

try {
	console.log("\n[1] 打开时带上 mtimeMs");
	{
		const detail = await getSkillDetail(ctx, "demo-skill", cwd);
		assert(detail && typeof detail.mtimeMs === "number" && detail.mtimeMs > 0, "详情含 mtimeMs");
		assert(detail.content.includes("# 原正文"), "正文完整");
	}

	console.log("\n[2] 不传 expectedMtime 时仍可保存（兼容旧调用）");
	{
		const next = "---\nname: demo-skill\ndescription: 兼容\n---\n# 兼容写入\n";
		const ok = await saveSkill(ctx, { name: "demo-skill", content: next }, cwd);
		assert(ok.ok && typeof ok.mtimeMs === "number" && ok.mtimeMs > 0, "兼容保存返回新 mtimeMs");
		assert(readFileSync(skillFile, "utf8") === next, "兼容路径写回");
	}

	console.log("\n[3] mtime 对得上时保存成功");
	{
		const opened = await getSkillDetail(ctx, "demo-skill", cwd);
		const next = "---\nname: demo-skill\ndescription: 正常\n---\n# 正常保存\n";
		const ok = await saveSkill(ctx, { name: "demo-skill", content: next, expectedMtime: opened.mtimeMs }, cwd);
		assert(ok.ok && readFileSync(skillFile, "utf8") === next, "mtime 一致时写回");
		assert(ok.mtimeMs !== opened.mtimeMs || statSync(skillFile).mtimeMs === ok.mtimeMs, "返回保存后的 mtime");
	}

	console.log("\n[4] 磁盘被改过后拒绝保存，原文不动");
	{
		const opened = await getSkillDetail(ctx, "demo-skill", cwd);
		const disk = "---\nname: demo-skill\ndescription: 别人改的\n---\n# 磁盘新内容\n";
		writeFileSync(skillFile, disk);
		bumpMtime(skillFile);
		const attempt = "---\nname: demo-skill\ndescription: 我的修改\n---\n# 我的正文\n";
		let err;
		try {
			await saveSkill(ctx, { name: "demo-skill", content: attempt, expectedMtime: opened.mtimeMs }, cwd);
		} catch (error) {
			err = error;
		}
		assert(err instanceof UserError, "冲突是 UserError");
		assert(err.statusCode === 409 && err.code === "SKILL_CHANGED", "409 SKILL_CHANGED");
		assert(/磁盘上的文件已经改过/.test(err.message), "提示要重新加载或覆盖: " + err.message);
		assert(err.payload?.current === disk, "payload 带上磁盘正文");
		assert(Array.isArray(err.payload?.diff) && err.payload.diff.some((row) => row.type === "add" && row.text === "# 我的正文"), "payload.diff 含新增行");
		assert(readFileSync(skillFile, "utf8") === disk, "拒绝后磁盘原文不动");
	}

	console.log("\n[5] overwrite 可强制覆盖");
	{
		const opened = await getSkillDetail(ctx, "demo-skill", cwd);
		writeFileSync(skillFile, "---\nname: demo-skill\ndescription: 又改了\n---\n# 又被改\n");
		bumpMtime(skillFile);
		const next = "---\nname: demo-skill\ndescription: 覆盖\n---\n# 强制覆盖\n";
		const ok = await saveSkill(ctx, { name: "demo-skill", content: next, expectedMtime: opened.mtimeMs, overwrite: true }, cwd);
		assert(ok.ok && readFileSync(skillFile, "utf8") === next, "overwrite 写回");
	}

	console.log("\n[6] 正文与磁盘相同则不必拒绝");
	{
		const opened = await getSkillDetail(ctx, "demo-skill", cwd);
		bumpMtime(skillFile);
		const same = readFileSync(skillFile, "utf8");
		const ok = await saveSkill(ctx, { name: "demo-skill", content: same, expectedMtime: opened.mtimeMs }, cwd);
		assert(ok.ok, "mtime 变了但内容相同仍成功");
		assert(readFileSync(skillFile, "utf8") === same, "内容保持不变");
	}
} finally {
	rmSync(fakeHome, { recursive: true, force: true });
	// restore env? not required, process is exiting
}

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (skill-conflict) ===");
