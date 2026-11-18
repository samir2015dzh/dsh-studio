/**
 * 全库审查第二批：面板硬伤。服务端的两条是真跑；客户端的几条在这里只做源码级守卫，
 * 真正的行为验证在 scripts/e2e-panels.mjs（无头 Chromium 实际点一遍，需要 playwright，手动跑）。
 *
 *   [1] 导入 skill 路由不再引用未定义的 store（面板导入此前必报 "store is not defined"）
 *   [2] 定时快照的保留份数至少 1（0.5 曾被 floor 成 0，一次修剪清空全部）
 *   [3] 客户端源码与产物里没有字面控制字符（模型下拉的分隔符曾是一个看不见的 NUL）
 *   [4] 模型下拉的取值到处用同一个分隔符常量
 *   [5] SnapshotPanel 用到的 changeSchedule 有定义
 *   [6] MCP 工具过滤：两种模式下「勾选 = 在名单里」
 *   [7] 详情页：页签切换过未保存确认；开关后重新取回磁盘内容
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const home = mkdtempSync(join(tmpdir(), "dsh-panel-fixes-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(home, "telemetry");
process.env.DSH_SKILL_EXTRACTOR_CONFIG = join(home, "extractor", "extractor.json");
test.after(() => rmSync(home, { recursive: true, force: true }));

const src = (name) => readFileSync(join(pluginRoot, "src", "client", name), "utf8");

function fakeReq(method, url, body) {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
	req.method = method;
	req.url = url;
	req.headers = { host: "127.0.0.1:3000" };
	req.socket = { remoteAddress: "127.0.0.1" };
	return req;
}
function fakeRes() {
	return { status: 0, body: "", writeHead(status) { this.status = status; }, end(payload) { this.body = payload; } };
}

test("[1] 导入 skill 路由：能读到目标目录并真的导入", async () => {
	const { makeRoutes } = await import(modUrl("lib/routes.js"));
	const { ExtractorStore } = await import(modUrl("lib/extractor.js"));
	const { packTarGz } = await import(modUrl("lib/snapshot.js"));
	const target = join(home, "skills-target");
	mkdirSync(dirname(process.env.DSH_SKILL_EXTRACTOR_CONFIG), { recursive: true });
	writeFileSync(process.env.DSH_SKILL_EXTRACTOR_CONFIG, JSON.stringify({ agentSkillDir: target }));
	const tar = join(home, "pkg.tar.gz");
	writeFileSync(tar, packTarGz([{ rel: "pkg/SKILL.md", data: Buffer.from("---\nname: imported-one\ndescription: Use when imported\n---\nbody\n") }]));
	const ctx = { logger: { info() {}, warn() {}, error() {} }, skills: { list: async () => [], get: async () => null } };

	for (const routes of [makeRoutes(ctx, new ExtractorStore()), makeRoutes(ctx)]) {
		rmSync(target, { recursive: true, force: true });
		const route = routes.find((r) => r.path === "/api/dsh-studio/skill-import");
		const res = fakeRes();
		await route.handler(fakeReq("POST", route.path, { source: tar }), res);
		const body = JSON.parse(res.body);
		assert.equal(res.status, 200);
		assert.equal(body.ok, true, res.body);
		assert.equal(body.name, "imported-one");
		assert.ok(existsSync(join(target, "imported-one", "SKILL.md")));
	}
});

test("[2] 定时快照保留份数至少 1", async () => {
	const { saveSchedule, loadSchedule } = await import(modUrl("lib/snapshot.js"));
	await saveSchedule({ keep: 7 });
	assert.equal((await saveSchedule({ keep: 0.5 })).keep, 7, "0.5 不许 floor 成 0");
	assert.equal((await saveSchedule({ keep: 0 })).keep, 7);
	assert.equal((await saveSchedule({ keep: 3.9 })).keep, 3);
	assert.equal((await loadSchedule()).keep, 3);
});

test("[3] 客户端源码与产物里没有字面控制字符", () => {
	const files = [...readdirSync(join(pluginRoot, "src", "client")).map((n) => join(pluginRoot, "src", "client", n)), join(pluginRoot, "lib", "client.js")];
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		// 制表、换行、回车之外的 C0 控制字符：编辑器里看不见，却会进字符串比较
		const hit = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.exec(text);
		assert.equal(hit, null, `${file} 第 ${hit ? text.slice(0, hit.index).split("\n").length : 0} 行有字面控制字符 U+${hit ? hit[0].charCodeAt(0).toString(16).padStart(4, "0") : ""}`);
	}
});

test("[4] 模型下拉：取值到处用同一个分隔符常量", () => {
	const text = src("ExtractorPanel.js");
	assert.match(text, /const MODEL_SEP = "\\u0000";/);
	const joins = [...text.matchAll(/\.provider \+ ([^+]+) \+ (?:v|m)\.model/g)].map((m) => m[1].trim());
	assert.ok(joins.length >= 3, "拼接点都找到了：" + joins.length);
	assert.deepEqual([...new Set(joins)], ["MODEL_SEP"], "回填 / 选项值 / 是否在列表里 三处同一个分隔符");
	const splits = [...text.matchAll(/modelChoice\.split\(([^)]+)\)/g)].map((m) => m[1].trim());
	assert.ok(splits.length >= 3);
	assert.deepEqual([...new Set(splits)], ["MODEL_SEP"]);
});

test("[5] SnapshotPanel：changeSchedule 有定义，数字框失焦才提交", () => {
	const text = src("SnapshotPanel.js");
	assert.match(text, /const changeSchedule = async \(patch\) =>/);
	assert.match(text, /api\.snapshotSchedule\(patch\)/);
	assert.match(text, /onBlur: commit/);
});

test("[6] MCP 工具过滤：两种模式下勾选都表示「在名单里」", () => {
	const text = src("McpPanel.js");
	assert.ok(text.includes('checked: mode === "all" ? true : names.has(t.name),'));
	assert.ok(!text.includes("!names.has(t.name)"), "deny 模式不再取反显示（取反 + 勾上即加入 = 每次点击都是空操作）");
});

test("[7] 详情页：页签切换过未保存确认；开关后取回磁盘内容、脏草稿时不许切", () => {
	const text = src("SkillManagerPanel.js");
	const chips = text.slice(text.indexOf('["skills", "trash"].map'), text.indexOf('key === "skills" ? "技能"'));
	assert.ok(chips.includes("switchView(key)") && !chips.includes("setSelected(null)"), "页签不再直接 setSelected(null)");
	const switchView = text.slice(text.indexOf("const switchView"), text.indexOf("const switchView") + 500);
	assert.ok(switchView.includes("confirmDiscard(isDirty(selected, draft, selected.content), UNSAVED_LEAVE)"));
	const toggle = text.slice(text.indexOf("const toggle = (patch)"), text.indexOf("const switchView"));
	assert.ok(toggle.includes("isDirty(selected, draft, selected.content)"), "脏草稿时拦住开关");
	assert.ok(toggle.includes("await api.get(selected.name)") && toggle.includes("setDraft(fresh.skill.content)"), "开关后基线与草稿一起换成磁盘内容");
});
