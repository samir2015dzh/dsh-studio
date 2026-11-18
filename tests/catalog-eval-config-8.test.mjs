/**
 * ：目录自检配置通道——~/.dsh-studio/catalog-eval/config.json 与其他四个子系统同构的三层合并
 * （默认值 → 插件配置 mcp.catalogEval → config.json），状态文案注明开关 / 窗口生效来源；改文件不用重启。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-catalog-cfg-8-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_STUDIO_CATALOG_EVAL_DIR = join(fakeHome, "catalog-eval");
const cw = await import(pathToFileURL(join(pluginRoot, "lib/catalog-watch.js")).href);
const { createCatalogWatch, resolveCatalogEvalLayers, catalogEvalConfigFile, renderCatalogEvalStatus } = cw;
test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

const writeCfg = (obj) => {
	mkdirSync(dirname(catalogEvalConfigFile()), { recursive: true });
	writeFileSync(catalogEvalConfigFile(), typeof obj === "string" ? obj : JSON.stringify(obj));
};

test("[#8 目录自检] 三层合并：config.json 覆盖插件配置；来源逐项注明；非法值忽略", () => {
	const r = resolveCatalogEvalLayers({ enabled: false, idleWindow: { start: "01:00", end: "02:00" }, keep: 5 }, { enabled: true, idleWindow: { start: "19:00", end: "07:00" } });
	assert.equal(r.config.enabled, true);
	assert.deepEqual(r.config.idleWindow, { start: "19:00", end: "07:00" });
	assert.equal(r.config.keep, 5, "文件没写的字段沿用插件配置");
	assert.deepEqual(r.from, { enabled: "file", idleWindow: "file" });
	assert.deepEqual(resolveCatalogEvalLayers(undefined, undefined).from, { enabled: "default", idleWindow: "default" });
	const mixed = resolveCatalogEvalLayers({ enabled: true }, { enabled: "yes", idleWindow: { start: "25:00", end: "07:00" } });
	assert.equal(mixed.config.enabled, true, "文件里类型不对：沿用插件配置");
	assert.equal(mixed.from.enabled, "plugin");
	assert.equal(mixed.from.idleWindow, "start:default/end:file");
	assert.deepEqual(mixed.config.idleWindow, { start: "02:00", end: "07:00" });
});

test("[#8 目录自检] 写 config.json 即开启（19:00–07:00 跨午夜），不用重启；状态文案带来源；坏文件忽略并报原因", async () => {
	let t = new Date(2026, 10, 16, 20, 0, 0).getTime();
	const watch = createCatalogWatch({ pluginConfig: { enabled: false, checkEveryMinutes: 0, idleMinutes: 30 }, loadRegistry: async () => ({ servers: [] }), now: () => t, logger: { warn() {} } });
	t += 31 * 60_000;
	assert.equal((await watch.tick()).reason, "disabled", "插件配置关、无文件");
	let s = await watch.status();
	assert.equal(s.from.enabled, "plugin");
	assert.match(renderCatalogEvalStatus(s), /开关 ← 插件配置 mcp\.catalogEval/);
	assert.match(renderCatalogEvalStatus(s), /不存在；写入/);

	writeCfg({ enabled: true, idleWindow: { start: "19:00", end: "07:00" } });
	const ran = await watch.tick();
	assert.equal(ran.reason, "ok", "同一实例、不重启：读到文件就开");
	s = await watch.status();
	assert.equal(s.config.enabled, true);
	assert.deepEqual(s.from, { enabled: "file", idleWindow: "file" });
	assert.match(renderCatalogEvalStatus(s), /开关 ← config\.json；闲时窗口 ← config\.json/);

	// 跨午夜窗口：上面 20:31 在窗口内已跑过；次周 08:00 不在窗口内
	t = new Date(2026, 10, 24, 8, 0, 0).getTime();
	assert.equal((await watch.tick()).reason, "outside-window");

	writeCfg("{ broken");
	s = await watch.status();
	assert.equal(s.config.enabled, false, "坏文件忽略，回到插件配置");
	assert.match(s.configError, /解析失败/);
	assert.match(renderCatalogEvalStatus(s), /解析失败，已忽略/);
});
