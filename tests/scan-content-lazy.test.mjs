/**
 * 列表扫描不带正文；打开技能时按需读取。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;

const fakeHome = mkdtempSync(join(tmpdir(), "dsh-scan-lazy-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");

const { scanSkills, readSkillText, stripBom, invalidateScanCache } = await import(modUrl("lib/scanner.js"));
const { listSkills, getSkillDetail } = await import(modUrl("lib/index.js"));

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

const huge = "正文标记：" + "啊".repeat(8000);
const root = join(fakeHome, ".dsh", "skills", "lazy-demo");
mkdirSync(root, { recursive: true });
const file = join(root, "SKILL.md");
writeFileSync(file, "\uFEFF---\nname: lazy-demo\ndescription: 演示\n---\n# 标题\n" + huge + "\n");

try {
	assert(stripBom("\uFEFF---").startsWith("---"), "stripBom 去掉 BOM");
	assert((await readSkillText(file)).startsWith("---"), "readSkillText 去掉 BOM");
	assert((await readSkillText(file)).includes("正文标记："), "readSkillText 读到正文");

	const scanned = await scanSkills(fakeHome);
	const hit = scanned.find((s) => s.name === "lazy-demo");
	assert(!!hit && hit.description === "演示", "扫描到技能");
	assert(hit && !("content" in hit), "默认扫描不带 content");

	const withBody = await scanSkills(fakeHome, { includeContent: true });
	const hit2 = withBody.find((s) => s.name === "lazy-demo");
	assert(!!hit2 && typeof hit2.content === "string" && hit2.content.includes("正文标记："), "includeContent 仍能拿到正文");
	assert(hit2.content.charCodeAt(0) !== 0xfeff, "includeContent 的正文已去 BOM");

	const listed = await listSkills(ctx, fakeHome);
	assert(listed.every((s) => !("content" in s)), "listSkills 摘要不带正文");

	const detail = await getSkillDetail(ctx, "lazy-demo", fakeHome);
	assert(detail && detail.content.includes("正文标记：") && detail.content.includes("# 标题"), "getSkillDetail 按需读全文");
	assert(detail.content.charCodeAt(0) !== 0xfeff, "详情正文已去 BOM");

	const listedJson = JSON.stringify(listed);
	assert(!listedJson.includes("正文标记："), "列表 JSON 不含正文");
	assert(JSON.stringify(detail).includes("正文标记："), "详情 JSON 含正文");

	invalidateScanCache();
	writeFileSync(file, "---\nname: lazy-demo\ndescription: 新说明\n---\n# 新正文\n");
	const again = await scanSkills(fakeHome);
	const hit3 = again.find((s) => s.name === "lazy-demo");
	assert(hit3 && hit3.description === "新说明" && !("content" in hit3), "失效后列表仍无正文、说明已更新");
	const detail2 = await getSkillDetail(ctx, "lazy-demo", fakeHome);
	assert(detail2 && detail2.content.includes("# 新正文") && !detail2.content.includes("正文标记："), "按需读取看到新正文");
} finally {
	rmSync(fakeHome, { recursive: true, force: true });
}

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (scan-content-lazy) ===");
