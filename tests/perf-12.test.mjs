/**
 * ：全库审查遗留性能项 B1–B7。
 * 量测脚本在 scripts/perf/；这里断言的是「省掉的那部分工作确实不再发生」，并且结果与改前口径一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const home = mkdtempSync(join(tmpdir(), "dsh-wo12-"));
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

const put = (abs, data) => {
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, data);
};

test("[B1] 版本日志：带版本的写入只读新增的尾巴，查询结果与全量读一致", async () => {
	const v = await import(modUrl("lib/versions.js"));
	const { historyLogPath } = await import(modUrl("lib/history-paths.js"));
	assert.equal(typeof v.indexCounters, "object", "有索引计数（改前每次都整份读）");

	// 先灌一份 2 MB 级的日志（别的技能的历史），模拟版本史已经很长
	const filler = [];
	for (let i = 0; i < 1500; i += 1) {
		filler.push(JSON.stringify({ v: 1, id: `vfill-${String(i).padStart(6, "0")}`, at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), kind: "skill", key: `skill:~/.dsh/skills/other-${i % 50}`, target: "/x", name: `other-${i % 50}`, action: "update", actor: "user", parent: null, state: { exists: true, kind: "dir", files: { "SKILL.md": { sha: "a".repeat(64), size: 1, stored: true } } }, diff: { summary: "x".repeat(1200) }, eval: null }));
	}
	put(historyLogPath(), filler.join("\n") + "\n");
	const target = join(home, ".dsh", "skills", "demo");
	put(join(target, "SKILL.md"), "---\nname: demo\ndescription: d\n---\nv0\n");
	const write = (n) => v.versionedSkillWrite(target, { action: "update", actor: "user" }, () => writeFileSync(join(target, "SKILL.md"), `---\nname: demo\ndescription: d\n---\nv${n}\n`));

	await write(1); // 冷：建一次索引
	const size = statSync(historyLogPath()).size;
	assert.ok(size > 1_500_000, "日志足够大，整份重读能看出来");
	const before = { ...v.indexCounters };
	for (let n = 2; n <= 6; n += 1) await write(n);
	const read = v.indexCounters.tailBytes - before.tailBytes;
	assert.equal(v.indexCounters.rebuilds, before.rebuilds, "热路径不整份重建");
	assert.ok(read < 64 * 1024, `5 次写入只读了新增的尾巴（${read} 字节，日志 ${size} 字节）`);

	const key = v.skillKeyOf(target);
	const full = (await v.readVersionRecords()).filter((r) => r.key === key);
	const listed = await v.listVersions({ key, limit: 1000 });
	assert.equal(listed.total, full.length);
	assert.deepEqual(listed.records.map((r) => r.id), full.map((r) => r.id).reverse(), "与全量读同序同内容（新的在前）");
	assert.deepEqual(await v.lastKeyRecord(key), full.at(-1));
	assert.equal(await v.resolveSkillKey("demo"), key);
	assert.deepEqual((await v.findVersionRecord(full[0].id))?.id, full[0].id);

	// 别的进程追加（快照恢复 / 脚本）：不需要通知，下次查询看得见
	const foreign = { v: 1, id: "vforeign-1", at: new Date().toISOString(), kind: "skill", key, target, name: "demo", action: "update", actor: "external", parent: full.at(-1).id, state: full.at(-1).state, diff: { summary: "外部" }, eval: null };
	appendFileSync(historyLogPath(), JSON.stringify(foreign) + "\n");
	assert.equal((await v.lastKeyRecord(key))?.id, "vforeign-1", "外部追加的记录被增量读到");

	// 写到一半的半行：先不算；补完后算上
	const half = JSON.stringify({ ...foreign, id: "vhalf-1" });
	appendFileSync(historyLogPath(), half.slice(0, 40));
	assert.equal((await v.lastKeyRecord(key))?.id, "vforeign-1", "半行不当记录");
	appendFileSync(historyLogPath(), half.slice(40) + "\n");
	assert.equal((await v.lastKeyRecord(key))?.id, "vhalf-1", "补完的那一行被读到");

	// 保留原子改写日志（换 inode / 变短）：索引整份重建，结果仍与全量读一致
	const rebuilds = v.indexCounters.rebuilds;
	await v.applyVersionRetention({ keep: 2, graceMs: 0 });
	const after = (await v.readVersionRecords()).filter((r) => r.key === key);
	const listedAfter = await v.listVersions({ key, limit: 1000 });
	assert.equal(after.length, 2);
	assert.deepEqual(listedAfter.records.map((r) => r.id), after.map((r) => r.id).reverse());
	assert.ok(v.indexCounters.rebuilds > rebuilds, "改写后重建了索引");
	assert.equal(listedAfter.total, 2);
});

const sessionRows = (id, n, extra = "") => {
	const rows = [{ type: "session", id, createdAt: "2026-11-17T08:00:00", cwd: `/work/${id}` }];
	for (let m = 0; m < n; m += 1) {
		rows.push({ type: "agent/inbox/spliced", data: { inserted: [{ role: m % 2 ? "assistant" : "user", content: [{ type: "text", text: `${id} 消息 ${m} ${extra}` }] }] } });
		rows.push({ type: "tool/call", time: 1_700_000_000_000 + m, data: { name: "skill", arguments: { name: `sk-${m % 3}` } } });
	}
	return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
};

test("[B2] 提取收集：没变的会话不再解析，变了的只解析那一份；结果与全量收集同口径", async () => {
	const ex = await import(modUrl("lib/extractor.js"));
	const { utimesSync } = await import("node:fs");
	const root = join(home, "sessions-b2");
	const writeSession = (i, n, extra = "") => {
		const file = join(root, `s${String(i).padStart(2, "0")}`, "session.v4.jsonl");
		put(file, sessionRows(`id-${i}`, n, extra));
		const t = new Date(Date.now() - i * 60_000 + (extra ? 30_000 : 0));
		utimesSync(file, t, t);
	};
	for (let i = 0; i < 20; i += 1) writeSession(i, i % 5 === 4 ? 0 : 3); // 每 5 份有 1 份空消息
	put(join(root, "bad", "session.v4.jsonl.zstd"), "不是 zstd");
	ex.resetSessionScanCache?.();
	assert.equal(typeof ex.scanSessionsForExtraction, "function");

	const expect = async () => {
		const full = await ex.collectSessionLogs(root, 30);
		return { logs: full.map((e) => [e.file, e.log.session.id, e.log.skillLoads.length]), digs: full.filter((e) => e.log.msgs.length > 0).slice(0, 12).map((e) => [e.file, e.log.msgs.length]) };
	};
	const view = (scan) => ({ logs: scan.logs.map((e) => [e.file, e.log.session.id, e.log.skillLoads.length]), digs: scan.digs.map((e) => [e.file, e.log.msgs.length]) });

	const c0 = { ...ex.sessionScanCounters };
	const first = await ex.scanSessionsForExtraction(root, 30, 12);
	assert.equal(ex.sessionScanCounters.parsed - c0.parsed, 21, "冷：每份（含坏文件）解析一次");
	assert.deepEqual(view(first), await expect(), "与全量收集同口径");
	assert.equal(first.digs.length, 12);
	assert.ok(first.logs.every((e) => e.log.msgs === undefined), "非摘要用途只留轻量结果，不常驻完整消息");

	const c1 = { ...ex.sessionScanCounters };
	await ex.scanSessionsForExtraction(root, 30, 12);
	assert.equal(ex.sessionScanCounters.parsed - c1.parsed, 0, "无变化：一份都不解析（坏文件也不再重试）");
	assert.equal(ex.sessionScanCounters.readdirs - c1.readdirs, 0, "无变化：目录不重列");

	writeSession(0, 5, "续写");
	const c2 = { ...ex.sessionScanCounters };
	const third = await ex.scanSessionsForExtraction(root, 30, 12);
	assert.equal(ex.sessionScanCounters.parsed - c2.parsed, 1, "只解析变了的那一份");
	assert.equal(third.digs[0].log.msgs.length, 5);
	assert.match(third.digs[0].log.msgs[4].text, /续写/);

	writeSession(30, 2, "新会话"); // 新目录：根目录 mtime 变 → 重列
	const fourth = await ex.scanSessionsForExtraction(root, 30, 12);
	assert.ok(fourth.logs.some((e) => e.log.session.id === "id-30"), "新会话目录被发现");
	assert.deepEqual(view(fourth), await expect());
});

test("[B3] 摘要没变 / 草稿队列已满时不调提取模型；队列满不再逐份落 failed 草稿", async () => {
	const ex = await import(modUrl("lib/extractor.js"));
	const { createDistill } = await import(modUrl("lib/distill.js"));
	const { readdirSync, readFileSync, existsSync } = await import("node:fs");
	const root = join(home, "sessions-b3");
	put(join(root, "a", "session.v4.jsonl"), sessionRows("b3-a", 4));
	process.env.DSH_STUDIO_DISTILL_DIR = join(home, "distill-b3");
	process.env.DSH_STUDIO_GOVERNANCE_DIR = join(home, "gov-b3");
	process.env.DSH_STUDIO_OPTIMIZER_DIR = join(home, "opt-b3");
	ex.resetSessionScanCache?.();
	let calls = 0;
	let batch = 0;
	const llm = {
		listProviders: () => [{ id: "fixture" }],
		listModels: async () => ["fixture-model"],
		prepareCall: async (config) => ({
			config,
			stream: async function* () {
				calls += 1;
				batch += 1;
				const cands = [1, 2, 3].map((k) => ({ name: `b3-skill-${batch}-${k}`, description: "d", group: "数据检索", rationale: "r", body: `1. 第 ${batch}-${k} 步\n2. 再做一步` }));
				yield { type: "text-delta", text: JSON.stringify({ candidates: cands }) };
				yield { type: "finish", reason: { kind: "ok" } };
			}
		})
	};
	const distill = createDistill({ pluginConfig: { maxQueued: 7 }, logger: { info() {}, warn() {}, error() {} } });
	let cfg = { ...ex.defaults(), enabled: true, windowDays: 7, agentSkillDir: join(home, ".agents", "skills"), mirrorDir: "" };
	const run = async (opts = {}) => {
		const r = await ex.runExtraction(cfg, root, { llm, onCandidates: (c, info) => distill.ingest(c, info), admit: () => distill.admit(), ...opts });
		cfg = ex.parse({ ...cfg, ...(r.site ?? {}) }); // 与 store.patch(result.site) 同口径
		return r;
	};

	await run();
	assert.equal(calls, 1);
	const again = await run();
	assert.equal(calls, 1, "会话没变：第二轮不调模型");
	assert.equal(again.skipped, true);
	assert.match(again.message, /摘要与上一轮相同/);
	await run({ sessionIds: ["b3-a"] });
	assert.equal(calls, 2, "点名蒸馏不受摘要相同的限制");

	// 新会话 → 摘要变了 → 调模型；这一轮把队列（上限 7，已有 6）塞满：溢出的 2 份不落草稿文件，只记一行 discards
	put(join(root, "b", "session.v4.jsonl"), sessionRows("b3-b", 2));
	const third = await run();
	assert.equal(calls, 3);
	const draftsDir = join(process.env.DSH_STUDIO_DISTILL_DIR, "drafts");
	const drafts = readdirSync(draftsDir).map((n) => JSON.parse(readFileSync(join(draftsDir, n), "utf8")));
	assert.equal(drafts.filter((d) => d.status === "queued").length, 7);
	assert.equal(drafts.filter((d) => d.failure?.kind === "queue-full").length, 0, "队列满的候选不再各落一份 failed 草稿");
	const discards = readFileSync(join(process.env.DSH_STUDIO_DISTILL_DIR, "discards.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(discards.filter((d) => d.kind === "queue-full").length, 1, "整批只记一行");
	assert.ok(third.message.includes("跳过"));

	// 队列已满 + 会话又变了：不调模型
	put(join(root, "c", "session.v4.jsonl"), sessionRows("b3-c", 2));
	const fourth = await run();
	assert.equal(calls, 3, "队列已满：不调模型");
	assert.match(fourth.message, /草稿队列已满（7\/7）/);
	assert.ok(existsSync(draftsDir));
});

test("[B4] eager MCP：多台并行握手；注册表变更时旧工具留到新的一组就绪再换，过时的一轮丢弃", async () => {
	const mcp = await import(modUrl("lib/mcp.js"));
	const { createEagerMount } = await import(modUrl("lib/mcp-eager-mount.js"));
	const quiet = { info() {}, warn() {}, error() {} };
	const mockServer = join(pluginRoot, "tests", "fixtures", "mock-mcp-server.mjs");
	const DELAY = 600;
	put(mcp.storePath(), JSON.stringify({ version: 2, servers: ["e1", "e2", "e3"].map((name) => ({ name, command: process.execPath, args: [mockServer], env: { MOCK_MCP_INIT_DELAY_MS: String(DELAY) }, tier: "eager" })) }, null, 2));
	const store = new mcp.McpStore({ logger: quiet });
	const runtime = new mcp.McpRuntime(quiet);
	try {
		const t0 = performance.now();
		const tools = await mcp.buildEagerTools(store, runtime);
		const took = performance.now() - t0;
		assert.deepEqual(tools.map((t) => t.name), ["mcp__e1__echo", "mcp__e2__echo", "mcp__e3__echo"], "仍按注册表顺序");
		assert.ok(took < DELAY * 2.5, `三台各慢 ${DELAY} ms 的握手并行完成（${Math.round(took)} ms；串行至少 ${DELAY * 3} ms）`);
	} finally {
		await runtime.closeAll?.();
	}

	// 挂载器：旧的一组在新的一组就绪前一直在
	const registered = new Set();
	const log = [];
	const register = (tool) => {
		registered.add(tool.name);
		log.push("+" + tool.name);
		return () => {
			registered.delete(tool.name);
			log.push("-" + tool.name);
		};
	};
	const pending = [];
	const build = () => new Promise((resolve) => pending.push(resolve));
	const m = createEagerMount({ build, register, logger: quiet });
	const first = m.mount();
	await new Promise((r) => setImmediate(r));
	pending.shift()([{ name: "mcp__a__x" }]);
	assert.equal(await first, true);
	assert.deepEqual([...registered], ["mcp__a__x"]);

	const slow = m.mount();
	const fast = m.mount();
	await new Promise((r) => setImmediate(r));
	assert.deepEqual([...registered], ["mcp__a__x"], "重建进行中：旧工具还在（以前此刻已全部注销）");
	const [resolveSlow, resolveFast] = pending.splice(0);
	resolveFast([{ name: "mcp__a__x" }, { name: "mcp__b__y" }]);
	assert.equal(await fast, true);
	assert.deepEqual([...registered].sort(), ["mcp__a__x", "mcp__b__y"]);
	resolveSlow([{ name: "mcp__stale__z" }]);
	assert.equal(await slow, false, "早发起、晚完成的一轮被丢弃");
	assert.ok(!registered.has("mcp__stale__z"));
	assert.deepEqual(log, ["+mcp__a__x", "-mcp__a__x", "+mcp__a__x", "+mcp__b__y"], "先卸旧再注册新，同步完成，没有同名重复注册");

	const failing = createEagerMount({ build: async () => { throw new Error("坏了"); }, register, logger: quiet });
	assert.equal(await failing.mount(), false, "构建失败不抛");
	m.dispose();
	assert.equal(registered.size, 0, "卸载清空");
});

test("[B5] 快照：组装残留 / 导出包 / 更新前备份不进包，回收站套单文件上限，gzip 6 级；更新前备份每技能只留 3 份", async () => {
	const snap = await import(modUrl("lib/snapshot.js"));
	const upd = await import(modUrl("lib/update-apply.js"));
	const { existsSync, readdirSync } = await import("node:fs");
	const dsh = join(home, ".dsh");
	put(join(dsh, "skills", "keep", "SKILL.md"), "---\nname: keep\ndescription: d\n---\n正文\n");
	put(join(dsh, "dsh-studio", "skill-tmp", "x-1", "SKILL.md"), "组装残留");
	put(join(dsh, "dsh-studio", "exports", "keep.tar.gz"), "导出包");
	put(join(dsh, "dsh-studio", "skill-backups", "2026-11-01T00-00-00-000Z", "keep", "SKILL.md"), "旧备份");
	put(join(dsh, "dsh-studio", "trash", "20261101-000000-x", "old", "SKILL.md"), "删掉的技能");
	put(join(dsh, "dsh-studio", "trash", "20261101-000000-x", "old", "huge.bin"), Buffer.alloc(6 * 1024 * 1024, 1));

	const rels = (await snap.collectFiles({ skipped: [], maxSkillFileBytes: 5 * 1024 * 1024 })).map((f) => f.rel);
	assert.ok(rels.includes("skills/keep/SKILL.md"));
	assert.ok(rels.includes("dsh-studio/trash/20261101-000000-x/old/SKILL.md"), "回收站照常进包");
	for (const bad of ["dsh-studio/skill-tmp/", "dsh-studio/exports/", "dsh-studio/skill-backups/"]) assert.ok(!rels.some((r) => r.startsWith(bad)), bad + " 不进包");
	assert.ok(!rels.includes("dsh-studio/trash/20261101-000000-x/old/huge.bin"), "回收站里超单文件上限的不进包");
	// 收集与恢复同一份判定：恢复侧同样不收这些路径（含 Windows 大小写变体）
	for (const bad of ["dsh-studio/skill-tmp/x/SKILL.md", "dsh-studio/exports/a.tar.gz", "dsh-studio/skill-backups/t/a/SKILL.md", "dsh-studio/Skill-Backups/t/a/SKILL.md"]) assert.equal(snap.isWhitelistedEntry(bad), false, bad);
	assert.equal(snap.isWhitelistedEntry("dsh-studio/trash/b/x/SKILL.md"), true);
	assert.equal(snap.GZIP_LEVEL, 6);
	const count = await snap.countFiles({ maxSkillFileBytes: 5 * 1024 * 1024 });
	assert.equal(count, rels.length, "countFiles 与 collectFiles 同口径");

	const root = join(home, "backups-b5");
	for (let d = 1; d <= 5; d += 1) {
		put(join(root, `2026-11-0${d}T00-00-00-000Z`, "keep", "SKILL.md"), String(d));
		put(join(root, `2026-11-0${d}T00-00-00-000Z`, "other", "SKILL.md"), String(d));
	}
	assert.equal(upd.pruneSkillBackups(root, "keep"), 2);
	assert.deepEqual(readdirSync(root).filter((s) => existsSync(join(root, s, "keep"))).sort(), ["2026-11-03T00-00-00-000Z", "2026-11-04T00-00-00-000Z", "2026-11-05T00-00-00-000Z"], "只留最近 3 份");
	assert.equal(readdirSync(root).filter((s) => existsSync(join(root, s, "other"))).length, 5, "别的技能的备份不动");
});

test("[B6] 技能库：loadLibrary 按 stat 复用解析结果；registry 摘要有 TTL；写入只作废那一条；按名查找不必每次全扫", async () => {
	const gs = await import(modUrl("lib/governance-scan.js"));
	const scanner = await import(modUrl("lib/scanner.js"));
	const core = await import(modUrl("lib/skill-core.js"));
	const { statSync, utimesSync, rmSync: rm } = await import("node:fs");
	const root = join(home, ".agents", "skills");
	const skillText = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n\n1. 运行 \`git status\`\n`;
	for (let i = 0; i < 12; i += 1) put(join(root, `lib-${i}`, "SKILL.md"), skillText(`lib-${i}`, `第 ${i} 类`));

	assert.equal(typeof gs.libraryCounters, "object");
	const first = await gs.loadLibrary([root]);
	const c1 = { ...gs.libraryCounters };
	const second = await gs.loadLibrary([root]);
	assert.equal(gs.libraryCounters.parsed - c1.parsed, 0, "没变的技能不再读 / 解析");
	assert.deepEqual(second, first, "结果与第一次相同");
	second[0].steps.push("被调用方改了");
	assert.notDeepEqual((await gs.loadLibrary([root]))[0].steps, second[0].steps, "返回的是拷贝，改了不串到缓存");
	put(join(root, "lib-3", "SKILL.md"), skillText("lib-3", "第 3 类（改过）"));
	const c2 = { ...gs.libraryCounters };
	const third = await gs.loadLibrary([root]);
	assert.equal(gs.libraryCounters.parsed - c2.parsed, 1, "只重读改了的那一份");
	assert.equal(third.find((s) => s.dirName === "lib-3").description, "第 3 类（改过）");

	// registry 摘要：连着 5 次列表只触发一次 ctx.skills.list
	let listCalls = 0;
	const ctx = { skills: { list: async () => ((listCalls += 1), []), get: async () => null }, logger: null };
	for (let i = 0; i < 5; i += 1) await core.listSkills(ctx, home);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(listCalls, 1, "TTL 内不重复刷新 registry 摘要");

	// 精准作废：等长改写 + 时间戳回拨（stat 看不出变化），带路径作废后列表立即看到新内容
	const file = join(root, "lib-5", "SKILL.md");
	await core.listSkills(ctx, home);
	const before = statSync(file);
	put(file, skillText("lib-5", "第 X 类"));
	utimesSync(file, before.atime, before.mtime);
	scanner.invalidateScanCache(file);
	assert.equal((await core.listSkills(ctx, home)).find((s) => s.name === "lib-5").description, "第 X 类");

	// 按名查找：刚扫过时复用名字 → 路径映射；文件被删了不返回陈旧结果
	await core.listSkills(ctx, home);
	const hit = await scanner.findSkillByName("lib-7", home);
	assert.equal(hit?.path, join(root, "lib-7", "SKILL.md"));
	rm(join(root, "lib-7"), { recursive: true, force: true });
	assert.equal(await scanner.findSkillByName("lib-7", home), null, "删掉之后不返回陈旧结果");
});

test("[B7] 零散：patch 解析复用 / mcp_load 冷加载只列一次工具 / 登记只写两次注册表 / ping 并行防重入 / ls-remote 在途去重 / 版本捕获复用 sha / 恢复不重写相同文件 / 提取面板展开才挂 / POST /snapshot 只回摘要", async () => {
	const { readFileSync, existsSync, statSync, utimesSync } = await import("node:fs");
	const { execFileSync } = await import("node:child_process");
	const quiet = { info() {}, warn() {}, error() {} };

	// ① patch 文件解析按 stat 复用
	const pm = await import(modUrl("lib/profile-mcp.js"));
	const patch = join(home, "b7", "cordis.patch.yml");
	put(patch, "- insert:\n    - id: mcp-x\n      name: \"@deepseek-ai/dsh-mcp-client\"\n      config:\n        serverName: x\n");
	const a = await pm.parsedFileCached(patch, pm.parseMcpRows, () => null);
	assert.equal(await pm.parsedFileCached(patch, pm.parseMcpRows, () => null), a, "没变：复用同一份解析结果");
	put(patch, readFileSync(patch, "utf8") + "      disabled: true\n");
	assert.notEqual(await pm.parsedFileCached(patch, pm.parseMcpRows, () => null), a, "变了：重新解析");

	// ②③ mcp_load 冷加载 tools/list 只走一次；mcp_register 只写两次注册表
	const mcp = await import(modUrl("lib/mcp.js"));
	const mockServer = join(pluginRoot, "tests", "fixtures", "mock-mcp-server.mjs");
	const listLog = join(home, "b7", "list.log");
	put(mcp.storePath(), JSON.stringify({ version: 2, servers: [] }));
	const store = new mcp.McpStore({ logger: quiet });
	const runtime = new mcp.McpRuntime(quiet);
	// 与 index.js 同样挂上两个落盘回调
	runtime.onToolsObserved = (entry, tools) => mcp.syncCatalogFromObserved(store, entry.name, tools, quiet);
	runtime.onVerified = (entry, verify) => store.patchServer(entry.name, { verify });
	let saves = 0;
	const realSave = store.save.bind(store);
	store.save = async (state) => ((saves += 1), realSave(state));
	const tools = Object.fromEntries(mcp.buildMcpTools(store, runtime, {}).map((t) => [t.name, t]));
	try {
		await tools.mcp_register.execute({ name: "b7", command: process.execPath, args: [mockServer], env: { MOCK_MCP_LIST_LOG: listLog }, tier: "on-demand" });
		await new Promise((r) => setTimeout(r, 200));
		assert.ok(saves <= 2, `一次登记写注册表 ${saves} 次（以前最多 4 次）`);
		await runtime.reclaim("b7");
		runtime.slot("b7").tools = [];
		put(listLog, "");
		await tools.mcp_load.execute({ name: "b7" });
		assert.equal(readFileSync(listLog, "utf8").trim().split("\n").filter(Boolean).length, 1, "冷加载只列一次工具");

		// ④ ping：并行、防重入
		let inflight = 0;
		let peak = 0;
		let pings = 0;
		const fake = () => ({ closed: false, ping: async () => { pings += 1; inflight += 1; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 60)); inflight -= 1; } });
		const rt2 = new mcp.McpRuntime(quiet);
		for (const n of ["p1", "p2", "p3"]) rt2.slot(n).conn = fake();
		const [r1, r2] = await Promise.all([rt2.pingConnected(), rt2.pingConnected()]);
		assert.deepEqual(r2, r1, "上一轮没 ping 完：复用同一轮的结果");
		assert.equal(pings, 3, "没有叠第二轮");
		assert.equal(r1.length, 3);
		assert.equal(peak, 3, "三台同时 ping");
	} finally {
		await runtime.closeAll();
	}

	// ⑤ ls-remote 在途去重：同一 (repo, ref) 并发两次只占一次预算
	const up = await import(modUrl("lib/upstream.js"));
	const repo = join(home, "b7", "upstream.git");
	const work = join(home, "b7", "work");
	execFileSync("git", ["init", "-q", "--bare", repo]);
	execFileSync("git", ["init", "-q", work]);
	put(join(work, "f.txt"), "x");
	execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
	execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);
	execFileSync("git", ["-C", work, "push", "-q", repo, "HEAD:refs/heads/main"]);
	const budget = { used: 0, max: 1 };
	const both = await Promise.all([up.lsRemoteSha(repo, "main", { budget }), up.lsRemoteSha(repo, "main", { budget })]);
	assert.equal(both[0], both[1]);
	assert.equal(budget.used, 1, "第二个跟着在途的那次，不另占预算、不另起子进程");

	// ⑥ 版本捕获：没变的小文件复用 sha，不再读
	const v = await import(modUrl("lib/versions.js"));
	const sk = join(home, ".dsh", "skills", "b7cap");
	for (let i = 0; i < 6; i += 1) put(join(sk, `f${i}.md`), "内容" + i);
	put(join(sk, "SKILL.md"), "---\nname: b7cap\ndescription: d\n---\nx\n");
	const s1 = await v.captureSkillState(sk);
	const c0 = { ...v.captureCounters };
	const s2 = await v.captureSkillState(sk);
	assert.deepEqual(s2, s1);
	assert.equal(v.captureCounters.smallRead - c0.smallRead, 0, "第二次捕获一个文件都不读");
	assert.equal(v.captureCounters.smallReused - c0.smallReused, 7);

	// ⑦ 快照恢复：与包里逐字节相同的文件不重写（mtime 不变），只写真正变了的
	const snap = await import(modUrl("lib/snapshot.js"));
	const keep = join(home, ".dsh", "skills", "b7keep", "SKILL.md");
	const change = join(home, ".dsh", "skills", "b7change", "SKILL.md");
	put(keep, "---\nname: b7keep\ndescription: d\n---\n不变\n");
	put(change, "---\nname: b7change\ndescription: d\n---\n原文\n");
	const made = await snap.createSnapshot("b7");
	put(change, "---\nname: b7change\ndescription: d\n---\n改过\n");
	const old = new Date(Date.now() - 3600_000);
	utimesSync(keep, old, old);
	const r = await snap.restoreSnapshot(made.id);
	assert.equal(readFileSync(change, "utf8").includes("原文"), true, "变了的恢复回去");
	assert.equal(Math.round(statSync(keep).mtimeMs / 1000), Math.round(old.getTime() / 1000), "相同的不重写");
	assert.ok(r.unchanged > 0);
	assert.equal(r.written, r.total, "written 仍按「恢复到位」计");

	// ⑧ 提取面板展开才挂；⑨ POST /snapshot 只回摘要
	const panel = readFileSync(join(pluginRoot, "src", "client", "SkillManagerPanel.js"), "utf8");
	assert.match(panel, /extractOpened \? h\("div", \{ style: \{ marginTop: "10px" \} \}, h\(ExtractorPanel, \{\}\)\) : null/);
	const routes = await import(modUrl("lib/routes.js"));
	const sum = routes.snapshotSummary(made);
	assert.equal(sum.fileCount, made.files.length);
	assert.equal(sum.files, undefined);
	assert.ok(existsSync(snap.snapshotsDir?.() ?? home));
});
