/**
 * ：快照内嵌凭据脱敏。
 *
 * MCP 配置的 args 与 URL 查询串里内嵌的凭据，此前展示侧已抹、快照文件里仍是原值，随 WebDAV 推到云端。
 *
 *   [1] 生成快照：快照目录里所有文件（解开 gzip 后）全文检索不到凭据原值；非凭据部分原样保留
 *   [2] 恢复到同名同键有现值的机器：凭据从现值补回、配置取快照的版本，端点里不剩占位符
 *   [3] 恢复到没有现值的机器：恢复报告（预演与真恢复）逐项列出未补回清单；占位符留在原处，运行时拒绝拿它去连
 *   [4] 补回只认同名 server 的同键：别的 server 的同键值不冒充，名字对不上不按下标配对
 *   [5] 兼容：旧快照（内嵌凭据是原值）照常恢复
 *   [6] 兼容：新快照交给旧版 restoreSnapshot，占位符不被当凭据写进目标机，跳过清单里点名要新版
 *   [7] studio 备份包与版本史共用同一套：包里没有原值、带内嵌占位符的包标 schema 2（旧版按「先升级」拒收），
 *       恢复报告 needsCredentials 列出内嵌项；版本史不存原值，回滚按现值补回、注销过的从暂存补回
 *   [8] 展示侧与存储侧同一份识别：maskArgs / maskUrlSecrets 输出不变
 *   [9] 升级前写下的版本史：注册表旧版本里的内嵌凭据一次性重新脱敏（幂等），之后的快照全文没有原值，旧版本仍可回滚
 *
 * 旧版代码取自开发历史中的旧版提交（公开导出不含该历史，相关用例会跳过）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const home = mkdtempSync(join(tmpdir(), "dsh-wo10-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(home, "telemetry");
process.env.DSH_STUDIO_BACKUP_DIR = join(home, "studio-backup");
process.env.DSH_SKILL_EXTRACTOR_CONFIG = join(home, "extractor", "extractor.json");
process.env.DSH_SKILL_EXTRACTOR_CANDIDATES = join(home, "extractor", "candidates.json");
process.env.DSH_SKILL_EXTRACTOR_SESSIONS = join(home, "sessions");
for (const k of ["DSH_STUDIO_OPTIMIZER_DIR", "DSH_STUDIO_GOVERNANCE_DIR", "DSH_STUDIO_DISTILL_DIR", "DSH_STUDIO_CATALOG_EVAL_DIR", "DSH_SKILL_MANAGER_SKILL_DIRS", "DSH_AGENTS_HOME"]) delete process.env[k];
test.after(() => rmSync(home, { recursive: true, force: true }));

const snap = await import(modUrl("lib/snapshot.js"));
const redact = await import(modUrl("lib/redact.js"));
const mcp = await import(modUrl("lib/mcp.js"));
const versions = await import(modUrl("lib/versions.js"));
const { createStudioBackup, verifyPackageBuffer, PACKAGE_SCHEMA } = await import(modUrl("lib/studio-backup.js"));

/** 之前的代码（旧版提交），整个 lib/ 取出来单独加载。 */
const BEFORE = "e100a6aa";
let HAS_BEFORE = true;
try { execFileSync("git", ["cat-file", "-e", BEFORE + "^{commit}"], { cwd: pluginRoot, stdio: "pipe" }); } catch { HAS_BEFORE = false; }
const SKIP_BEFORE = "公开导出不含开发历史，跳过旧版兼容用例";
async function loadBefore(rel) {
	const dir = join(home, "before-lib");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
		const tar = execFileSync("git", ["archive", "--format=tar", BEFORE, "lib"], { cwd: pluginRoot, maxBuffer: 64 * 1024 * 1024 });
		execFileSync("tar", ["-x", "-C", dir], { input: tar });
		// 旧版的依赖包从本仓库解析（junction 在 Windows 上不需要管理员权限）
		symlinkSync(join(pluginRoot, "node_modules"), join(dir, "node_modules"), "junction");
	}
	return import(pathToFileURL(join(dir, rel)).href);
}

const dsh = join(home, ".dsh");
const registryPath = join(dsh, "dsh-studio", "mcp.json");
const put = (abs, data) => {
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, data);
};
const readJson = (abs) => JSON.parse(readFileSync(abs, "utf8").replace(/^﻿/, ""));

// 每种内嵌形态各一枚，值互不相同，便于全文检索
const S = {
	argFlag: "ctx7sk-ARGFLAG-1111111111",
	argEq: "TOKEN-ARGEQ-2222222222",
	query: "URLQUERY-3333333333",
	userinfo: "USERINFO-4444444444",
	bare: "ghp_BARETOKEN5555555555555555555555",
	header: "HEADER-6666666666"
};
const T = {
	argFlag: "ctx7sk-TARGET-aaaaaaaaaa",
	argEq: "TOKEN-TARGET-bbbbbbbbbb",
	query: "URLQUERY-TARGET-cccccccc",
	userinfo: "USERINFO-TARGET-dddddddd",
	bare: "ghp_TARGETbareeeeeeeeeeeeeeeeeeeeeeee",
	header: "HEADER-TARGET-ffffffffff"
};

function registry(v, { port = "8080", profile = "fast" } = {}) {
	return {
		version: 2,
		idleTimeoutMinutes: 10,
		servers: [
			{ name: "ctx7", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp", "--api-key", v.argFlag, `--token=${v.argEq}`, "--port", port], env: { MODE: "x" } },
			{ name: "exa", transport: "streamable-http", url: `https://mcp.exa.ai/mcp?exaApiKey=${v.query}&profile=${profile}`, headers: {} },
			{ name: "gitsrv", transport: "stdio", command: "node", args: ["srv.js", `https://bot:${v.userinfo}@git.example.com/r.git`, v.bare], env: {} },
			{ name: "hdr", transport: "streamable-http", url: "https://h.example.com/mcp", headers: { Authorization: `Bearer ${v.header}` } }
		]
	};
}
const writeRegistry = (reg) => put(registryPath, JSON.stringify(reg, null, 2) + "\n");

/** 快照目录里每个文件的全文：config.tar.gz 解开 gzip 后的整包字节 + manifest.json。 */
function snapshotFullText(id) {
	const dir = join(snap.snapshotsDir(), id);
	let out = "";
	for (const name of readdirSync(dir)) {
		const buf = readFileSync(join(dir, name));
		out += (name.endsWith(".gz") ? gunzipSync(buf) : buf).toString("latin1");
	}
	return out;
}
async function entriesOf(id) {
	const out = new Map();
	await snap.forEachTarGzEntry(join(snap.snapshotsDir(), id, "config.tar.gz"), (e) => out.set(e.rel, e.data.toString("utf8")));
	return out;
}
const byName = (reg, name) => reg.servers.find((s) => s.name === name);

test("[1] 快照文件全文检索不到 args / URL 里内嵌的凭据原值；非凭据部分原样保留", async () => {
	writeRegistry(registry(S));
	const m = await snap.createSnapshot("wo10");
	const full = snapshotFullText(m.id);
	for (const [kind, secret] of Object.entries(S)) assert.ok(!full.includes(secret), `快照里不许有原值（${kind}）`);

	const entries = await entriesOf(m.id);
	const stored = entries.get(snap.NEEDS_NEWER_PREFIX + "dsh-studio/mcp.json");
	assert.ok(stored !== undefined, "有内嵌占位符的 mcp.json 挂在 needs-newer 前缀下");
	assert.ok(!entries.has("dsh-studio/mcp.json"), "原路径下不再放一份");
	const reg = JSON.parse(stored);
	const P = snap.REDACTED;
	assert.deepEqual(byName(reg, "ctx7").args, ["-y", "@upstash/context7-mcp", "--api-key", P, `--token=${P}`, "--port", "8080"]);
	assert.equal(byName(reg, "exa").url, `https://mcp.exa.ai/mcp?exaApiKey=${P}&profile=fast`);
	assert.deepEqual(byName(reg, "gitsrv").args, ["srv.js", `https://${P}@git.example.com/r.git`, P]);
	assert.equal(byName(reg, "hdr").headers.Authorization, P, "整字段凭据照旧整值换掉");

	const note = JSON.parse(entries.get(snap.REDACTED_NOTE));
	const fields = note.redacted.find((r) => r.file === "dsh-studio/mcp.json").fields;
	assert.deepEqual(fields, [
		"servers[0].args{flag:--api-key}",
		"servers[0].args{flag:--token}",
		"servers[1].url{query:exaApiKey}",
		"servers[2].args{userinfo}",
		"servers[2].args{value}",
		"servers[3].headers.Authorization"
	]);
	assert.equal(note.redacted.find((r) => r.file === "dsh-studio/mcp.json").storedAs, snap.NEEDS_NEWER_PREFIX + "dsh-studio/mcp.json");
	assert.match(note.embedded, /先升级再恢复/);
});

test("[2] 恢复到同名同键有现值的机器：凭据补回、配置取快照版本、端点可用", async () => {
	writeRegistry(registry(S, { port: "8080", profile: "fast" }));
	const m = await snap.createSnapshot("wo10-same-keys");
	// 目标机：同名 server、同键，但凭据值不同、非凭据配置也改过
	writeRegistry(registry(T, { port: "9090", profile: "slow" }));

	const dry = await snap.restoreSnapshot(m.id, { dryRun: true });
	assert.deepEqual(dry.missingCredentials, [], "预演：都有现值可补");
	const r = await snap.restoreSnapshot(m.id, {});
	assert.deepEqual(r.missingCredentials, []);
	assert.deepEqual(r.skippedPaths, [], "新版认识 needs-newer 前缀，不当白名单外跳过");

	const after = readJson(registryPath);
	assert.deepEqual(byName(after, "ctx7").args, ["-y", "@upstash/context7-mcp", "--api-key", T.argFlag, `--token=${T.argEq}`, "--port", "8080"], "凭据取现值，--port 取快照");
	assert.equal(byName(after, "exa").url, `https://mcp.exa.ai/mcp?exaApiKey=${T.query}&profile=fast`);
	assert.deepEqual(byName(after, "gitsrv").args, ["srv.js", `https://bot:${T.userinfo}@git.example.com/r.git`, T.bare]);
	assert.equal(byName(after, "hdr").headers.Authorization, `Bearer ${T.header}`);
	assert.ok(!JSON.stringify(after).includes(snap.REDACTED), "恢复后的配置里不剩占位符");
	for (const s of after.servers) assert.deepEqual(mcp.placeholderFields(s), [], `${s.name} 的端点可用（无占位符）`);
});

test("[3] 恢复到没有现值的机器：报告逐项列出未补回；占位符不静默留空，运行时拒绝拿它去连", async () => {
	writeRegistry(registry(S));
	const m = await snap.createSnapshot("wo10-no-values");
	rmSync(registryPath);

	const expected = [
		"servers[0].args{flag:--api-key}",
		"servers[0].args{flag:--token}",
		"servers[1].url{query:exaApiKey}",
		"servers[2].args{userinfo}",
		"servers[2].args{value}",
		"servers[3].headers.Authorization"
	].map((field) => ({ file: "dsh-studio/mcp.json", field }));
	const dry = await snap.restoreSnapshot(m.id, { dryRun: true });
	assert.deepEqual(dry.missingCredentials, expected, "预演就报出来");
	const r = await snap.restoreSnapshot(m.id, {});
	assert.deepEqual(r.missingCredentials, expected, "真恢复的报告逐项列明");

	const after = readJson(registryPath);
	const P = snap.REDACTED;
	assert.deepEqual(byName(after, "ctx7").args, ["-y", "@upstash/context7-mcp", "--api-key", P, `--token=${P}`, "--port", "8080"], "内嵌的保持占位，参数位置不乱");
	assert.equal(byName(after, "hdr").headers.Authorization, undefined, "整字段的照旧不写（不留空串）");
	for (const secret of Object.values(S)) assert.ok(!readFileSync(registryPath, "utf8").includes(secret));

	// 运行时：带占位符的端点不许连（不会把占位符当凭据发出去）
	assert.deepEqual(mcp.placeholderFields(byName(after, "ctx7")), ["args"]);
	assert.deepEqual(mcp.placeholderFields(byName(after, "exa")), ["url"]);
	const runtime = new mcp.McpRuntime({ info() {}, warn() {} });
	await assert.rejects(runtime.ensure(byName(after, "exa")), /凭据占位符/);
});

test("[4] 补回只认同名 server 的同键，不拿别处的值冒充", async () => {
	writeRegistry({ version: 2, servers: [{ name: "ctx7", transport: "stdio", command: "npx", args: ["--api-key", S.argFlag] }] });
	const m = await snap.createSnapshot("wo10-name-only");
	// 目标机：同一位置是别的 server，带同一个键；ctx7 本身有，但没有 --api-key 这个键
	writeRegistry({
		version: 2,
		servers: [
			{ name: "other", transport: "stdio", command: "npx", args: ["--api-key", "OTHER-SERVER-VALUE"] },
			{ name: "ctx7", transport: "stdio", command: "npx", args: ["--token", "DIFFERENT-KEY-VALUE"] }
		]
	});
	const r = await snap.restoreSnapshot(m.id, {});
	assert.deepEqual(r.missingCredentials, [{ file: "dsh-studio/mcp.json", field: "servers[0].args{flag:--api-key}" }]);
	const text = readFileSync(registryPath, "utf8");
	assert.ok(!text.includes("OTHER-SERVER-VALUE"), "别的 server 的值不冒充");
	assert.deepEqual(byName(JSON.parse(text), "ctx7").args, ["--api-key", snap.REDACTED], "不同键的值不冒充");

	// 名字对不上时不按下标配对（整字段凭据同理）
	const merged = snap.mergeRedacted({ servers: [{ name: "a", env: { API_KEY: snap.REDACTED } }] }, { servers: [{ name: "b", env: { API_KEY: "B-KEY" } }] }, []);
	assert.equal(merged.servers[0].env.API_KEY, undefined);
});

test("[5] 兼容：旧快照（内嵌凭据是原值）在新版上照常恢复", async (t) => { if (!HAS_BEFORE) return t.skip(SKIP_BEFORE);
	const before = await loadBefore("lib/snapshot.js");
	writeRegistry(registry(S));
	const old = await before.createSnapshot("wo10-old-format");
	assert.ok(snapshotFullText(old.id).includes(S.argFlag), "前提：旧版打的包里内嵌凭据是原值（此处要修的就是这个）");
	writeRegistry(registry(T));
	const r = await snap.restoreSnapshot(old.id, {});
	assert.deepEqual(r.missingCredentials, []);
	const expected = registry(S);
	byName(expected, "hdr").headers.Authorization = `Bearer ${T.header}`; // 整字段凭据旧版就脱敏了，照旧从现值补
	assert.deepEqual(readJson(registryPath), expected, "旧包里的内嵌原值照原样恢复");
});

test("[6] 兼容：新快照在旧版上恢复——占位符不被当凭据写进目标机，跳过清单点名要新版", async (t) => { if (!HAS_BEFORE) return t.skip(SKIP_BEFORE);
	const before = await loadBefore("lib/snapshot.js");
	writeRegistry(registry(S));
	const m = await snap.createSnapshot("wo10-new-on-old");
	writeRegistry(registry(T));
	const beforeText = readFileSync(registryPath, "utf8");
	const r = await before.restoreSnapshot(m.id, {});
	assert.equal(readFileSync(registryPath, "utf8"), beforeText, "旧版不动目标机的 mcp.json");
	assert.ok(!readFileSync(registryPath, "utf8").includes(snap.REDACTED), "目标机里没有占位符");
	assert.ok(r.skippedPaths.includes(snap.NEEDS_NEWER_PREFIX + "dsh-studio/mcp.json"), "旧版的恢复报告里点名：要新版 dsh-studio");

	// 只有整字段凭据的快照不挂前缀：旧版照常能恢复（不为此处改动牺牲兼容）
	writeRegistry({ version: 2, servers: [{ name: "hdr", transport: "streamable-http", url: "https://h.example.com/mcp", headers: { Authorization: `Bearer ${S.header}` } }] });
	const plain = await snap.createSnapshot("wo10-plain");
	assert.ok((await entriesOf(plain.id)).has("dsh-studio/mcp.json"));
	writeRegistry({ version: 2, servers: [{ name: "hdr", transport: "streamable-http", url: "https://h.example.com/old", headers: { Authorization: `Bearer ${T.header}` } }] });
	await before.restoreSnapshot(plain.id, {});
	assert.equal(byName(readJson(registryPath), "hdr").url, "https://h.example.com/mcp");
	assert.equal(byName(readJson(registryPath), "hdr").headers.Authorization, `Bearer ${T.header}`);
});

test("[7] studio 备份包与版本史共用同一套脱敏 / 补回", async (t) => { if (!HAS_BEFORE) return t.skip(SKIP_BEFORE);
	const quiet = { info() {}, warn() {}, error() {} };
	writeRegistry(registry(S));
	const b = createStudioBackup({ pluginConfig: { maxSkillFileBytes: 32 * 1024 }, logger: quiet });
	const pkg = await b.exportPackage({ label: "wo10" });
	const buf = readFileSync(pkg.file);
	const raw = gunzipSync(buf).toString("latin1");
	for (const [kind, secret] of Object.entries(S)) assert.ok(!raw.includes(secret), `备份包里不许有原值（${kind}）`);
	const v = verifyPackageBuffer(buf);
	assert.equal(v.ok, true, v.errors.join("\n"));
	assert.equal(v.manifest.schema, 2, "带内嵌占位符的包标 schema 2");
	assert.equal(PACKAGE_SCHEMA, 2);
	const beforeBackup = await loadBefore("lib/studio-backup.js");
	const oldVerify = beforeBackup.verifyPackageBuffer(buf);
	assert.equal(oldVerify.ok, false);
	assert.ok(oldVerify.errors.some((e) => /先升级 dsh-studio 再恢复/.test(e)), "旧版校验即拒收并提示版本不匹配");

	// 目标机没有这些 server：needsCredentials 逐项列出内嵌项
	rmSync(registryPath);
	const dry = await b.restore({ file: pkg.file });
	const need = dry.needsCredentials.map((n) => `${n.object}:${n.field}`);
	for (const f of ["registry:ctx7:args{flag:--api-key}", "registry:ctx7:args{flag:--token}", "registry:exa:url{query:exaApiKey}", "registry:gitsrv:args{userinfo}", "registry:gitsrv:args{value}", "registry:hdr:headers.Authorization"]) {
		assert.ok(need.includes(f), "needsCredentials 列出 " + f + "（实际：" + need.join(", ") + "）");
	}

	// 版本史：注册表写入的版本记录里不存原值；回滚按本机现值补回
	await versions.versionedRegistryWrite(registryPath, { action: "edit", actor: "test" }, async () => writeRegistry(registry(S)));
	const historyText = () => {
		let out = "";
		const walk = (d) => {
			for (const n of readdirSync(d)) {
				const f = join(d, n);
				if (statSync(f).isDirectory()) walk(f);
				else out += (n.endsWith(".gz") ? gunzipSync(readFileSync(f)) : readFileSync(f)).toString("latin1");
			}
		};
		if (existsSync(process.env.DSH_STUDIO_HISTORY_DIR)) walk(process.env.DSH_STUDIO_HISTORY_DIR);
		return out;
	};
	const recs = (await versions.readVersionRecords()).filter((r) => r.key === versions.REGISTRY_KEY && r.state?.exists === true);
	assert.ok(recs.length > 0, "前提：有注册表版本记录");
	for (const [kind, secret] of Object.entries(S)) assert.ok(!historyText().includes(secret), `版本史里不许有原值（${kind}）`);
	const target = recs.at(-1);
	writeRegistry(registry(T, { port: "7070" }));
	const rb = await versions.rollbackRegistry({ versionId: target.id, file: registryPath, actor: "test" });
	assert.deepEqual(rb.missingCredentials, []);
	assert.deepEqual(byName(readJson(registryPath), "ctx7").args, ["-y", "@upstash/context7-mcp", "--api-key", T.argFlag, `--token=${T.argEq}`, "--port", "8080"]);

	// 只有参数里带凭据的 server 被注销后，回滚从暂存补回（暂存认得内嵌凭据）
	const { hasCredentials } = await import(modUrl("lib/mcp-credential-stash.js"));
	assert.equal(hasCredentials({ name: "ctx7", args: ["--api-key", "x-value"] }), true);
	assert.equal(hasCredentials({ name: "exa", url: "https://a.example.com/mcp?apiKey=x-value" }), true);
	assert.equal(hasCredentials({ name: "plain", args: ["-y", "pkg"], url: "https://a.example.com/mcp" }), false);
	const withAll = registry(T, { port: "8080" });
	await versions.versionedRegistryWrite(registryPath, { action: "edit", actor: "test" }, async () => writeRegistry(withAll));
	const keep = (await versions.readVersionRecords()).filter((x) => x.key === versions.REGISTRY_KEY && x.state?.exists === true).at(-1);
	await versions.versionedRegistryWrite(registryPath, { action: "edit", actor: "test" }, async () => writeRegistry({ ...withAll, servers: withAll.servers.filter((x) => x.name !== "ctx7" && x.name !== "exa") }));
	const back = await versions.rollbackRegistry({ versionId: keep.id, file: registryPath, actor: "test" });
	assert.deepEqual(back.missingCredentials, [], "注销过的 server 的内嵌凭据从暂存补回");
	assert.deepEqual(byName(readJson(registryPath), "ctx7").args, withAll.servers[0].args);
	assert.equal(byName(readJson(registryPath), "exa").url, withAll.servers[1].url);
});

test("[8] 展示侧与存储侧共用一份识别：展示串照旧", () => {
	assert.deepEqual(redact.maskArgs(["-y", "pkg", "--api-key", "ctx7sk-123", "--token=abc", "--port", "8080", "https://x.y/?key=1", S.bare]), ["-y", "pkg", "--api-key", "***", "--token=***", "--port", "8080", "https://x.y/?key=***", "***"]);
	assert.equal(redact.maskUrlSecrets("https://mcp.exa.ai/mcp?exaApiKey=abc123&x=1"), "https://mcp.exa.ai/mcp?exaApiKey=***&x=1");
	assert.equal(redact.maskUrlSecrets("https://user:tok@github.com/a/b.git"), "https://***@github.com/a/b.git");
	// 存储侧对同一串命中的位置与展示侧一致
	const shown = redact.maskArgs(["--api-key", "v1", "--token=v2", "https://a.b/?sig=v3"]);
	const stored = JSON.parse(JSON.stringify({ args: ["--api-key", "v1", "--token=v2", "https://a.b/?sig=v3"] }));
	snap.redactCredentials(stored);
	assert.deepEqual(stored.args.map((a) => a.split(snap.REDACTED).join("***")), shown);
});

test("[9] 升级前写下的版本史：重新脱敏后快照全文没有原值，旧版本仍可回滚", async (t) => { if (!HAS_BEFORE) return t.skip(SKIP_BEFORE);
	// 独立的版本史目录，免得前面几例的记录混进来
	const historyDir = join(home, "history-9");
	process.env.DSH_STUDIO_HISTORY_DIR = historyDir;
	try {
		const beforeVersions = await loadBefore("lib/versions.js");
		rmSync(registryPath, { force: true });
		await beforeVersions.versionedRegistryWrite(registryPath, { action: "edit", actor: "test" }, async () => writeRegistry(registry(S, { port: "8080" })));
		await beforeVersions.versionedRegistryWrite(registryPath, { action: "edit", actor: "test" }, async () => writeRegistry(registry(S, { port: "8181" })));
		const historyText = () => {
			let out = "";
			const walk = (d) => {
				for (const n of readdirSync(d)) {
					const f = join(d, n);
					if (statSync(f).isDirectory()) walk(f);
					else out += (n.endsWith(".gz") ? gunzipSync(readFileSync(f)) : readFileSync(f)).toString("latin1");
				}
			};
			walk(historyDir);
			return out;
		};
		assert.ok(historyText().includes(S.argFlag), "前提：旧版写下的注册表版本里内嵌凭据是原值");
		const oldest = (await versions.readVersionRecords()).find((r) => r.key === versions.REGISTRY_KEY && r.state?.exists === true);

		const plan = await versions.redactRegistryHistory({ dryRun: true });
		assert.equal(plan.objectsRewritten, 2);
		assert.ok(historyText().includes(S.argFlag), "预演零写入");
		const done = await versions.redactRegistryHistory();
		assert.equal(done.objectsRewritten, 2);
		assert.equal(done.recordsRewritten, 2);
		assert.deepEqual(done.missingObjects, []);
		for (const [kind, secret] of Object.entries(S)) assert.ok(!historyText().includes(secret), `版本史里不再有原值（${kind}）`);
		assert.equal((await versions.redactRegistryHistory({ dryRun: true })).objectsRewritten, 0, "幂等：再跑一遍无事可做");
		const check = await versions.verifyVersionRetention();
		assert.deepEqual(check.missingObjects, [], "记录引用的对象都在且 sha 相符");
		assert.equal(check.unreferencedObjects, 0, "旧对象已删，不留孤儿");

		// 快照（含版本史前缀）全文检索不到原值
		const m = await snap.createSnapshot("wo10-history");
		for (const [kind, secret] of Object.entries(S)) assert.ok(!snapshotFullText(m.id).includes(secret), `含版本史的快照里没有原值（${kind}）`);

		// 旧版本仍可回滚：内嵌凭据从本机现值补回，非凭据配置回到当时
		writeRegistry(registry(T, { port: "9999" }));
		const rb = await versions.rollbackRegistry({ versionId: oldest.id, file: registryPath, actor: "test" });
		assert.deepEqual(rb.missingCredentials, []);
		assert.deepEqual(byName(readJson(registryPath), "ctx7").args, ["-y", "@upstash/context7-mcp", "--api-key", T.argFlag, `--token=${T.argEq}`, "--port", "8080"]);
	} finally {
		process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
	}
});
