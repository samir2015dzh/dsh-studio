/**
 * 审计 2：凭据类小文件同族修复——原子写；解析失败保留原文件并留档、报错，不静默回默认。
 *   sync.json（loadSync / saveSync）、凭据暂存（readStash / stashRemovedServers，读-改-写套 withFileLock）、
 *   darwin 状态文件（readState / writeState）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-state-files-8-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");

const { loadSync, saveSync } = await import(modUrl("lib/sync.js"));
const { readStash, readStashLenient, stashRemovedServers, stashPath } = await import(modUrl("lib/mcp-credential-stash.js"));
const { CorruptFileError, readJsonState } = await import(modUrl("lib/json-file.js"));
const { applyDarwin, darwinStateCorruption } = await import(modUrl("lib/darwin.js"));
const { isWhitelistedEntry } = await import(modUrl("lib/snapshot.js"));

const studioDir = join(fakeHome, ".dsh", "dsh-studio");
const archives = (dir, base) => readdirSync(dir).filter((n) => n.startsWith(base + ".corrupt-"));
const silence = () => {
	const orig = console.error;
	console.error = () => {};
	return () => (console.error = orig);
};

test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

test("[#8 审计 2] sync.json：不存在给默认；损坏抛错、原文件保留、留档一次、saveSync 不覆盖", async () => {
	assert.equal((await loadSync()).channel, "git", "不存在 = 默认");
	await saveSync({ channel: "webdav", webdav: { url: "https://dav.example/x", password: "p@ss" } });
	assert.equal((await loadSync()).webdav.password, "p@ss");
	assert.deepEqual(readdirSync(studioDir).filter((n) => n.endsWith(".tmp")), [], "原子写不留 tmp");
	const file = join(studioDir, "sync.json");
	const broken = readFileSync(file, "utf8").slice(0, 30);
	writeFileSync(file, broken);
	const restore = silence();
	try {
		await assert.rejects(() => loadSync(), (e) => e instanceof CorruptFileError && e.code === "STATE_FILE_CORRUPT");
		await assert.rejects(() => saveSync({ channel: "git" }), CorruptFileError, "saveSync 拒绝覆盖");
		await assert.rejects(() => loadSync(), CorruptFileError);
	} finally {
		restore();
	}
	assert.equal(readFileSync(file, "utf8"), broken, "原文件原样保留");
	const a = archives(studioDir, "sync.json");
	assert.equal(a.length, 1, "同一份坏内容只留档一次");
	assert.equal(readFileSync(join(studioDir, a[0]), "utf8"), broken);
	assert.equal(isWhitelistedEntry("dsh-studio/" + a[0]), false, "留档（可能含明文凭据）不进快照");
	// 修好后恢复
	writeFileSync(file, JSON.stringify({ channel: "s3", s3: {} }));
	assert.equal((await loadSync()).channel, "s3");
});

test("[#8 审计 2] 凭据暂存：损坏不覆盖、宽松读当空；并发暂存不互相覆盖", async () => {
	const withCred = (name) => ({ name, env: { API_TOKEN: "tok-" + name } });
	// 并发两批注销：withFileLock 串起读-改-写，两边都留得住
	const [a, b] = await Promise.all([stashRemovedServers([withCred("one")]), stashRemovedServers([withCred("two")])]);
	assert.deepEqual([a, b], [["one"], ["two"]]);
	const stash = await readStash();
	assert.deepEqual(Object.keys(stash.servers).sort(), ["one", "two"], "并发写不丢");
	const broken = '{"version":1,"servers":{"one":{"server":{"env":{"API_TOKEN":"tok-one"';
	writeFileSync(stashPath(), broken);
	const restore = silence();
	try {
		await assert.rejects(() => readStash(), CorruptFileError);
		assert.deepEqual(await stashRemovedServers([withCred("three")]), [], "坏暂存不写");
		assert.deepEqual((await readStashLenient()).servers, {}, "只读路径（回滚补凭据）当空，不连累回滚");
	} finally {
		restore();
	}
	assert.equal(readFileSync(stashPath(), "utf8"), broken, "原文件原样保留（里面的凭据还能手工救）");
	assert.equal(archives(studioDir, "mcp-credential-stash.json").length, 1);
});

test("[#8 审计 2] darwin 状态：损坏留档、不被默认值覆盖", async () => {
	const root = mkdtempSync(join(tmpdir(), "darwin-8-"));
	const skills = join(root, "skills");
	mkdirSync(join(skills, "a"), { recursive: true });
	writeFileSync(join(skills, "a", "SKILL.md"), "---\nname: a\ndescription: x\n---\nbody");
	const stateFile = join(root, "state.json");
	const broken = '{"scores": {"a": 1';
	writeFileSync(stateFile, broken);
	const h = new Map();
	const ctx = { on: (ev, fn) => h.set(ev, fn), logger: { info() {}, warn() {} } };
	const restore = silence();
	try {
		applyDarwin(ctx, { roots: [skills], stateFile, familyFile: join(root, "f.json"), familyRefreshDays: 0, sweepHours: 999 }, {});
		await h.get("tools/post-execute")({ name: "write", arguments: { file_path: join(skills, "a", "SKILL.md") } }, {}, async () => {});
		await h.get("system-prompt/assemble")({}, {}, async () => ({ sections: [] }));
	} finally {
		restore();
	}
	assert.equal(readFileSync(stateFile, "utf8"), broken, "坏状态文件没被默认值覆盖");
	assert.ok(darwinStateCorruption(stateFile), "记成损坏");
	assert.equal(archives(root, "state.json").length, 1, "留档一份");
	rmSync(root, { recursive: true, force: true });
});

test("[#8 审计 2] readJsonState：missing / ok / corrupt 三态", async () => {
	const dir = mkdtempSync(join(tmpdir(), "jsonstate-"));
	const f = join(dir, "x.json");
	assert.equal((await readJsonState(f)).status, "missing");
	writeFileSync(f, "﻿" + JSON.stringify({ a: 1 }));
	assert.deepEqual(await readJsonState(f), { status: "ok", value: { a: 1 } }, "带 BOM 也认");
	writeFileSync(f, "[1,2]");
	const restore = silence();
	try {
		const r = await readJsonState(f, { validate: (v) => (Array.isArray(v) ? "顶层不是 JSON 对象" : undefined) });
		assert.equal(r.status, "corrupt");
		assert.ok(existsSync(r.archivedTo));
	} finally {
		restore();
	}
	rmSync(dir, { recursive: true, force: true });
});
