/**
 * ：全库审查遗留缺陷 A1–A4。
 * 每条先按记录复现，断言的是「修之前会出事的那个结果不再出现」。
 *
 *   [A1] bundle 级接管的原生状态要叠上 profile 层覆盖块：已接管的 bundle MCP 不再每次启动都报漂移、面板红点常亮
 *   [A2] mcp.json 写失败后内存不留「幽灵」改动；POST /mcp/tools 与启动对账的读-改-写走串行链
 *   [A3] 同名技能合并的评估集分开（测试在 tests/skill-governance.test.mjs，复用那边的治理夹具）
 *   [A4] WebDAV：推送不原地覆盖唯一一份包，中途断掉 LATEST 指的那版仍完整；拉取按清单校验，对不上不落盘
 *   [A5] 在 tests/evolution-mcp-audit.test.mjs [13]；[A6] / [A7] 在 tests/distill-hardening.test.mjs（复用那边的夹具）
 *   [A8] 同一个目录名出现在 3 个以上的根里，消歧后的名字仍互不相同，每一份都按名字找得到
 *   [A9] 未保存草稿记基线 mtime：磁盘被改过之后恢复旧草稿再保存，走 409 冲突，不悄悄盖掉新内容
 *   [A10] 快照白名单按 Windows 规则归一：大小写 / 尾点 / 尾空格 / 备用数据流的变体绕不过 skip 与凭据合并
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const home = mkdtempSync(join(tmpdir(), "dsh-wo11-"));
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

const quiet = { info() {}, warn() {}, error() {} };
const put = (abs, data) => {
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, data);
};

const mcp = await import(modUrl("lib/mcp.js"));
const profileMcp = await import(modUrl("lib/profile-mcp.js"));

test("[A1] bundle 级接管：连续三次启动都读到「已接管」，不再报漂移", async () => {
	const profileDir = join(home, ".dsh", "profiles", "desktop");
	const profilePatch = join(profileDir, "cordis.patch.yml");
	const bundlePatch = join(profileDir, "node_modules", "some-bundle", "cordis.patch.yml");
	put(profilePatch, "");
	put(
		bundlePatch,
		`- insert:
    - id: mcp-bundled
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: bundled
        transport: stdio
        command: "node"
`
	);
	const bundleBefore = readFileSync(bundlePatch, "utf8");
	const store = new mcp.McpStore({ logger: quiet });
	const boot = () => profileMcp.reconcileProfileMcp(store, [profilePatch, bundlePatch], { overridePath: profilePatch, autoTakeover: true, logger: quiet });

	const first = await boot();
	assert.deepEqual(first.takenOver.map((t) => [t.name, t.via]), [["bundled", "override"]], "第一次启动：自动接管，写 profile 层覆盖");
	assert.match(readFileSync(profilePatch, "utf8"), /^- id: mcp-bundled\n {2}disabled: true$/m);
	assert.equal(readFileSync(bundlePatch, "utf8"), bundleBefore, "node_modules 里的文件不动");

	for (const n of [2, 3]) {
		const r = await boot();
		assert.deepEqual(r.drifted, [], `第 ${n} 次启动不报漂移`);
		assert.deepEqual(r.reasserted, [], `第 ${n} 次启动不必补回`);
		const entry = (await store.load()).servers.find((s) => s.name === "bundled");
		assert.equal(entry.source.nativeState, "disabled", `第 ${n} 次启动：原生状态读成已接管（面板不亮红点）`);
		assert.equal(entry.source.nativeDisabled, true);
	}

	// 真漂移仍然看得出来：覆盖块被人删掉 → active
	writeFileSync(profilePatch, "");
	const entry = (await store.load()).servers.find((s) => s.name === "bundled");
	assert.equal(entry.source.nativeState, "active", "覆盖块没了就是真漂移");
	const r = await profileMcp.reconcileProfileMcp(store, [profilePatch, bundlePatch], { overridePath: profilePatch, autoReassert: false, logger: quiet });
	assert.deepEqual(r.drifted.map((d) => [d.name, d.state]), [["bundled", "active"]]);
	// 覆盖块显式写 disabled: false 也算活着
	writeFileSync(profilePatch, "- id: mcp-bundled\n  disabled: false\n");
	assert.equal((await store.load()).servers.find((s) => s.name === "bundled").source.nativeState, "active");
	assert.equal(await profileMcp.readRowDisabled(bundlePatch, "mcp-bundled"), false);
	writeFileSync(profilePatch, "- id: mcp-bundled\n  disabled: true\n");
	assert.equal(await profileMcp.readRowDisabled(bundlePatch, "mcp-bundled"), true, "反向检查用的 readRowDisabled 同口径");
});

const registryFile = () => join(home, ".dsh", "dsh-studio", "mcp.json");
const holdFile = () => registryFile() + ".corrupt-hold.json";
const server = (name, extra = {}) => ({ name, tier: "on-demand", transport: "stdio", command: "node", args: [name + ".js"], ...extra });

test("[A2] 写失败后缓存作废：之后成功的写入不会把失败那次的改动落盘", async () => {
	rmSync(registryFile(), { force: true });
	const store = new mcp.McpStore({ logger: quiet });
	await store.upsert(server("alpha"));
	await store.upsert(server("beta"));
	assert.deepEqual((await store.load()).servers.map((s) => s.name), ["alpha", "beta"]);

	// 写入闸挡住 save（等价于目录只读 / Windows 改名重试到期：写不进去）
	put(holdFile(), JSON.stringify({ at: "test", archivedTo: null, error: "test" }));
	await assert.rejects(store.upsert(server("ghost")), /损坏保护/);
	// 缓存作废后的下一次 load 回文件读，文件可解析会自动解闸（既有设计）；重新挂闸再试 remove
	rmSync(holdFile(), { force: true });
	await store.load();
	put(holdFile(), JSON.stringify({ at: "test", archivedTo: null, error: "test" }));
	await assert.rejects(store.remove("alpha"), /损坏保护/);
	rmSync(holdFile(), { force: true });

	assert.deepEqual((await store.load()).servers.map((s) => s.name), ["alpha", "beta"], "失败的 upsert / remove 不留在内存里");
	await store.upsert(server("gamma"));
	const onDisk = JSON.parse(readFileSync(registryFile(), "utf8")).servers.map((s) => s.name);
	assert.deepEqual(onDisk, ["alpha", "beta", "gamma"], "下一次成功的写入只带它自己的改动");

	// 串行链外的读者看不到别人还没落盘的半截修改
	const a = await store.load();
	a.servers[0].command = "half-done";
	assert.equal((await store.load()).servers[0].command, "node");
});

test("[A2] POST /mcp/tools 与启动对账都在串行链里读-改-写", async () => {
	rmSync(registryFile(), { force: true });
	const store = new mcp.McpStore({ logger: quiet });
	await store.upsert(server("alpha"));
	const routes = mcp.buildMcpRoutes(store, new mcp.McpRuntime(quiet), {});
	const toolsRoute = routes.find((r) => r.path === "/api/dsh-studio/mcp/tools");
	const req = Object.assign((async function* () {
		yield Buffer.from(JSON.stringify({ name: "alpha", mode: "deny", names: ["danger"] }));
	})(), { method: "POST", url: "/api/dsh-studio/mcp/tools", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:1" } });
	const out = { status: 0 };
	const res = { writeHead: (st) => (out.status = st), end: (t) => (out.body = t) };

	// 串行链被一个进行中的读-改-写占着：路由必须排队等它，不能在中途读快照、改、写
	let release;
	const gate = new Promise((r) => (release = r));
	const slow = store.serial(async () => {
		await gate;
		const st = await store.load();
		st.servers.push(server("beta"));
		await store.save(st);
	});
	let routeLoadedEarly = false;
	const realLoad0 = store.load.bind(store);
	store.load = async () => {
		routeLoadedEarly = true;
		return realLoad0();
	};
	const pending = toolsRoute.handler(req, res);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(routeLoadedEarly, false, "路由在串行链上排队，前一个读-改-写结束前不读注册表");
	store.load = realLoad0;
	release();
	await Promise.all([slow, pending]);
	assert.equal(out.status, 200, String(out.body));
	const disk = JSON.parse(readFileSync(registryFile(), "utf8"));
	assert.deepEqual(disk.servers.map((s) => s.name), ["alpha", "beta"], "并发的写入没被路由冲掉");
	assert.deepEqual(disk.servers.find((s) => s.name === "alpha").toolFilter, { mode: "deny", names: ["danger"] }, "路由的改动也在");

	// 启动对账同理
	let release2;
	const gate2 = new Promise((r) => (release2 = r));
	const slow2 = store.serial(() => gate2);
	let loadedEarly = false;
	const realLoad = store.load.bind(store);
	store.load = async () => {
		loadedEarly = true;
		return realLoad();
	};
	const recon = profileMcp.reconcileProfileMcp(store, [], { logger: quiet });
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(loadedEarly, false, "对账在串行链上排队，前一个读-改-写结束前不读注册表");
	release2();
	await Promise.all([slow2, recon]);
	assert.equal(loadedEarly, true);
	store.load = realLoad;
});

/** 进程内假 WebDAV：PUT / GET / DELETE / MOVE / MKCOL；failPut(key, body) 返回 true 时只存一半字节并回 500（模拟传到一半断掉）。 */
function davServer({ failPut = () => false } = {}) {
	const files = new Map();
	const server = createServer((req, res) => {
		const key = decodeURIComponent(new URL(req.url, "http://x").pathname);
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			if (req.method === "MKCOL") return res.writeHead(files.has(key) ? 405 : 201).end();
			if (req.method === "PUT") {
				if (failPut(key, body)) {
					files.set(key, body.subarray(0, Math.floor(body.length / 2)));
					return res.writeHead(500).end();
				}
				files.set(key, body);
				return res.writeHead(201).end();
			}
			if (req.method === "GET") return files.has(key) ? res.writeHead(200).end(files.get(key)) : res.writeHead(404).end();
			if (req.method === "DELETE") return res.writeHead(files.delete(key) ? 204 : 404).end();
			if (req.method === "MOVE") {
				if (!files.has(key)) return res.writeHead(404).end();
				const dest = decodeURIComponent(new URL(req.headers.destination).pathname);
				files.set(dest, files.get(key));
				files.delete(key);
				return res.writeHead(204).end();
			}
			res.writeHead(405).end();
		});
	});
	return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, files, url: `http://127.0.0.1:${server.address().port}/dav` })));
}

test("[A4] WebDAV：推送中途断掉，LATEST 指的那版仍完整可拉；拉取校验不过不落盘", async () => {
	const snap = await import(modUrl("lib/snapshot.js"));
	const sync = await import(modUrl("lib/sync.js"));
	put(join(home, ".dsh", "AGENTS.md"), "# v1\n");
	const s1 = await snap.createSnapshot("dav1");
	put(join(home, ".dsh", "AGENTS.md"), "# v2 " + "x".repeat(4000) + "\n");
	const s2 = await snap.createSnapshot("dav2");
	const snapsDir = join(home, ".dsh", "dsh-studio", "snapshots");
	const localArchive = (id) => readFileSync(join(snapsDir, id, "config.tar.gz"));
	let breakArchive = false;
	const dav = await davServer({ failPut: (key) => breakArchive && key.endsWith(".tar.gz") });
	try {
		const cfg = { url: dav.url };
		await sync.pushSnapshot("webdav", cfg, s1.id);
		assert.equal(dav.files.get("/dav/LATEST").toString().trim(), s1.id);

		// 第二次推送传包传到一半断掉
		breakArchive = true;
		await assert.rejects(sync.pushSnapshot("webdav", cfg, s2.id), /HTTP 500/);
		breakArchive = false;
		assert.equal(dav.files.get("/dav/LATEST").toString().trim(), s1.id, "指针没切");
		const before = new Set(readdirSync(snapsDir));
		const pulled = await sync.pullSnapshot("webdav", cfg, "after-break");
		assert.equal(pulled.remoteId, s1.id);
		assert.ok(localArchive(pulled.id).equals(localArchive(s1.id)), "拉到的是完整的上一版，不是半份包");
		assert.equal(new Set(readdirSync(snapsDir)).size, before.size + 1);

		// 重推成功：切到新版；旧名字也更新给旧版拉取方；远端只留当前 + 上一版
		await sync.pushSnapshot("webdav", cfg, s2.id);
		assert.equal(dav.files.get("/dav/LATEST").toString().trim(), s2.id);
		assert.equal(dav.files.get("/dav/PREVIOUS").toString().trim(), s1.id);
		assert.ok(dav.files.get("/dav/config.tar.gz").equals(localArchive(s2.id)), "旧名字给旧版拉取方");
		assert.ok(![...dav.files.keys()].some((k) => k.endsWith(".part")), "临时名都 MOVE 走了");
		const s3 = await snap.createSnapshot("dav3");
		await sync.pushSnapshot("webdav", cfg, s3.id);
		assert.ok(!dav.files.has(`/dav/config-${s1.id}.tar.gz`) && !dav.files.has(`/dav/manifest-${s1.id}.json`), "再往前那版删掉");
		assert.ok(dav.files.has(`/dav/config-${s2.id}.tar.gz`), "上一版留着");

		// 远端包被改过（或与清单对不上）：拒绝，本地一个快照目录都不多
		const latestKey = `/dav/config-${s3.id}.tar.gz`;
		const good = dav.files.get(latestKey);
		dav.files.set(latestKey, localArchive(s1.id));
		const count = readdirSync(snapsDir).length;
		await assert.rejects(sync.pullSnapshot("webdav", cfg, "tampered"), /校验未通过/);
		assert.equal(readdirSync(snapsDir).length, count, "校验不过不落盘");
		dav.files.set(latestKey, good);
		dav.files.delete(`/dav/manifest-${s3.id}.json`);
		await assert.rejects(sync.pullSnapshot("webdav", cfg, "no-manifest"), /校验未通过.*manifest/);

		// 旧版推上去的远端（只有旧名字）照常能拉，同样校验
		dav.files.clear();
		dav.files.set("/dav/LATEST", Buffer.from(s1.id + "\n"));
		dav.files.set("/dav/config.tar.gz", localArchive(s1.id));
		dav.files.set("/dav/manifest.json", readFileSync(join(snapsDir, s1.id, "manifest.json")));
		const legacy = await sync.pullSnapshot("webdav", cfg, "legacy");
		assert.ok(localArchive(legacy.id).equals(localArchive(s1.id)));
		dav.files.set("/dav/config.tar.gz", localArchive(s2.id));
		await assert.rejects(sync.pullSnapshot("webdav", cfg, "legacy-mismatch"), /校验未通过/, "旧布局里包与清单对不上同样拒绝");
	} finally {
		dav.server.close();
	}
});

test("[A8] 同名技能在四个根里：消歧名互不相同，每一份都找得到", async () => {
	const scanner = await import(modUrl("lib/scanner.js"));
	const project = join(home, "work", "proj");
	mkdirSync(join(project, ".git"), { recursive: true });
	const roots = [join(project, ".dsh", "skills"), join(project, ".agents", "skills"), join(home, ".dsh", "skills"), join(home, ".agents", "skills")];
	for (const [i, root] of roots.entries()) put(join(root, "dup-skill", "SKILL.md"), `---\nname: dup-skill\ndescription: 第 ${i + 1} 份\n---\nbody ${i + 1}\n`);
	scanner.invalidateScanCache?.();
	const found = (await scanner.scanSkills(project)).filter((sk) => sk.declaredName === "dup-skill");
	assert.equal(found.length, 4, "四份都列出来");
	const names = found.map((sk) => sk.name);
	assert.equal(new Set(names).size, 4, "消歧名互不相同：" + names.join(", "));
	const paths = new Set();
	for (const name of names) {
		const hit = await scanner.findSkillByName(name, project);
		assert.ok(hit !== null, "按名字找得到 " + name);
		paths.add(hit.path);
	}
	assert.equal(paths.size, 4, "每个名字指向不同的那一份");
	assert.ok(names.includes("dup-skill") && names.includes("dup-skill/dup-skill"), "前两份的名字与以前一致（已有引用不受影响）");
});

test("[A9] 磁盘被改过之后恢复旧草稿再保存：走 409 冲突，不悄悄覆盖", async () => {
	const unsaved = await import(modUrl("lib/unsaved-escape.js"));
	const { saveSkill } = await import(modUrl("lib/index.js"));
	const fs = await import("node:fs");
	const ctx = { skills: { get: async () => null, list: async () => [] }, logger: quiet };
	const cwd = join(home, "a9");
	mkdirSync(cwd, { recursive: true });
	const file = join(home, ".dsh", "skills", "a9-skill", "SKILL.md");
	const v1 = "---\nname: a9-skill\ndescription: 第一版\n---\n# 正文 v1\n";
	put(file, v1);
	const m1 = fs.statSync(file).mtimeMs;
	const mem = new Map();
	const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };

	// 打开 v1 改了一半，关掉设置层：草稿落盘，带基线 m1
	const edited = v1.replace("正文 v1", "正文 v1 + 我没保存的修改");
	assert.equal(unsaved.persistDirtyDraft(storage, { dirty: true, name: "a9-skill", content: edited, baseMtimeMs: m1 }), true);

	// 期间别处把文件改成 v2
	const v2 = v1.replace("正文 v1", "正文 v2（别处改的）");
	writeFileSync(file, v2);
	fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
	const m2 = fs.statSync(file).mtimeMs;

	// 再打开：草稿与磁盘不同 → 提示恢复，并标出「磁盘在那之后被改过」
	const pending = unsaved.draftToRestore(storage, "a9-skill", v2, m2);
	assert.equal(pending.content, edited);
	assert.equal(pending.stale, true, "草稿基线与磁盘当前版本对不上");
	assert.ok(unsaved.DRAFT_RESTORE_STALE.includes("改过"));
	const expected = unsaved.restoredExpectedMtime(pending, m2);
	assert.equal(expected, m1, "保存时带草稿自己的基线");
	await assert.rejects(saveSkill(ctx, { name: "a9-skill", content: edited, expectedMtime: expected }, cwd), (e) => e?.code === "SKILL_CHANGED" || /已经改过/.test(String(e?.message)));
	assert.equal(readFileSync(file, "utf8"), v2, "磁盘上的新内容没被旧草稿盖掉");

	// 没被改过的草稿照旧：不标 stale，按磁盘当前 mtime 保存
	const fresh = unsaved.draftToRestore(storage, "a9-skill", v2, m1);
	assert.equal(fresh.stale, false);
	assert.equal(unsaved.restoredExpectedMtime(fresh, m1), m1);
	// 旧格式草稿（没记基线）：当作可能过期，保存走比对
	mem.clear();
	storage.setItem(unsaved.draftKey("a9-skill"), JSON.stringify({ name: "a9-skill", content: edited, savedAt: 1 }));
	const legacy = unsaved.draftToRestore(storage, "a9-skill", v2, m2);
	assert.equal(legacy.stale, true);
	assert.equal(unsaved.restoredExpectedMtime(legacy, m2), 0);

	// 面板（src/client 内联同一套规则）：打开时把磁盘 mtime 交给 draftToRestore、过期草稿保存时带草稿基线、落草稿带基线
	const panel = readFileSync(join(pluginRoot, "src", "client", "SkillManagerPanel.js"), "utf8");
	assert.ok(panel.includes("draftToRestore(browserStorage(), skill.name, text, result.skill && result.skill.mtimeMs)"));
	assert.ok(panel.includes("restoredExpectedMtime(pending, result.skill.mtimeMs)"));
	assert.ok(panel.includes("writeUnsavedDraft(browserStorage(), snap.name, snap.content, snap.baseMtimeMs)"));
	assert.ok(panel.includes("baseMtimeMs: selected && selected.mtimeMs"));
});

test("[A10] 导入包里的大小写 / 尾点 / 数据流变体绕不过 sync.json 闸与凭据合并", async () => {
	const snap = await import(modUrl("lib/snapshot.js"));
	const dsh = join(home, ".dsh");
	put(join(dsh, "dsh-studio", "sync.json"), JSON.stringify({ channel: "git", git: { token: "REAL" } }));
	const evil = [
		"dsh-studio/SYNC.JSON",
		"dsh-studio/sync.json.",
		"dsh-studio/sync.json ",
		"dsh-studio/sync.json::$DATA",
		"dsh-studio/MCP.JSON",
		"dsh-studio/Mcp-Credential-Stash.json",
		"dsh-studio/Snapshots/x/config.tar.gz",
		"skills/x/.. /AGENTS.md"
	];
	const entries = [{ rel: "AGENTS.md", data: Buffer.from("# from package\n") }, ...evil.map((rel) => ({ rel, data: Buffer.from(JSON.stringify({ channel: "git", git: { token: "ATTACKER" } })) }))];
	const pkg = join(home, "evil.tar.gz");
	writeFileSync(pkg, snap.packTarGz(entries));
	const imported = await snap.importSnapshot(pkg, "evil");
	// 恢复前后 .dsh 下的完整文件清单（实际目录项名字 + 内容；快照目录本身除外）。
	// 不用 existsSync 逐个查：Windows 文件系统不分大小写、会丢尾点，existsSync("…/SYNC.JSON") 查到的就是 sync.json 本身。
	const tree = () => {
		const out = new Map();
		const walk = (dir, rel) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const r = rel === "" ? e.name : rel + "/" + e.name;
				if (r === "dsh-studio/snapshots") continue;
				if (e.isDirectory()) walk(join(dir, e.name), r);
				else out.set(r, readFileSync(join(dir, e.name), "utf8"));
			}
		};
		walk(dsh, "");
		return out;
	};
	const before = tree();
	const r = await snap.restoreSnapshot(imported.id, { force: true });
	for (const rel of evil) assert.ok(r.skippedPaths.includes(rel), "白名单外跳过：" + JSON.stringify(rel));
	const after = tree();
	const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
	assert.deepEqual(changed, ["AGENTS.md"], "只有正常条目落盘，变体一个都没写（实际变动：" + changed.join(", ") + "）");
	assert.equal(readFileSync(join(dsh, "AGENTS.md"), "utf8"), "# from package\n", "正常条目照常恢复");
	assert.match(readFileSync(join(dsh, "dsh-studio", "sync.json"), "utf8"), /REAL/, "sync.json 原样");
	// 收集侧同一判定：正常大小写的技能文件照收
	assert.equal(snap.isWhitelistedEntry("skills/Foo/SKILL.md"), true);
	assert.equal(snap.isWhitelistedEntry("dsh-studio/mcp.json"), true);
});
