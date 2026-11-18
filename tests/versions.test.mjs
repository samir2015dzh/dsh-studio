/**
 * · G2 版本溯源：技能库 / MCP 注册表每次写入出版本记录，回滚到任意版本且回滚本身留痕，
 * 版本史在 .dsh 之外、随快照走、凭据不进版本史；版本史写不进去时写入主流程照常。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;

const fakeHome = mkdtempSync(join(tmpdir(), "dsh-versions-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
delete process.env.DSH_STUDIO_HISTORY_DIR;
process.env.DSH_STUDIO_TELEMETRY_DIR = join(fakeHome, "telemetry");

const { historyRoot, historyLogPath, mergeVersionLogText } = await import(modUrl("lib/history-paths.js"));
const versions = await import(modUrl("lib/versions.js"));
const { listVersions, rollbackSkill, rollbackRegistry, versionedSkillWrite, readVersionRecords, REGISTRY_KEY, setVersionLogger } = versions;
const { writeSkill } = await import(modUrl("lib/extractor.js"));
const { saveSkill } = await import(modUrl("lib/index.js"));
const { trashSkill, restoreTrash, listTrash } = await import(modUrl("lib/trash.js"));
const { McpStore } = await import(modUrl("lib/mcp.js"));
const { runWithWriteContext } = await import(modUrl("lib/write-context.js"));
const { collectFiles, HISTORY_PREFIX, createSnapshot, restoreSnapshot } = await import(modUrl("lib/snapshot.js"));
const { buildEvolutionTools } = await import(modUrl("lib/evolution-tools.js"));

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};
const ctx = { skills: { get: async () => null, list: async () => [] }, logger: { warn() {}, error() {}, info() {} } };
const chainOk = (recs) => recs.every((r, i) => (i === 0 ? r.parent === null : r.parent === recs[i - 1].id));
const skillRecs = async (key) => (await readVersionRecords()).filter((r) => r.key === key);

const userRoot = join(fakeHome, ".dsh", "skills");
mkdirSync(userRoot, { recursive: true });
const skillDir = join(userRoot, "demo-skill");
const skillFile = join(skillDir, "SKILL.md");

try {
	console.log("\n[1] 版本史位置：.dsh 之外");
	{
		assert(historyRoot() === join(fakeHome, ".dsh-studio", "history"), "默认 ~/.dsh-studio/history（不在 .dsh 里）");
		assert(!historyRoot().startsWith(join(fakeHome, ".dsh") + "/"), "不在 DSH_HOME 下");
	}

	console.log("\n[2] 三类写入各出一条记录：蒸馏新建 / 面板改写 / 分组变更 / 语义合并");
	let key;
	{
		const created = await runWithWriteContext({ actor: "extractor:auto-accept", sessionIds: ["sess-1", "sess-2"] }, () =>
			writeSkill(userRoot, { name: "demo-skill", description: "演示", body: "# v1\n第一版\n" })
		);
		assert(created.ok === true && existsSync(skillFile), "writeSkill 照常写盘");
		let recs = (await readVersionRecords()).filter((r) => r.name === "demo-skill");
		assert(recs.length === 1 && recs[0].action === "create", "新建 → action=create");
		key = recs[0].key;
		assert(key === "skill:~/.dsh/skills/demo-skill", "key 用 ~ 相对路径：" + key);
		assert(recs[0].actor === "extractor:auto-accept" && recs[0].sessionIds.join(",") === "sess-1,sess-2", "actor 与来源会话 id");
		assert(recs[0].eval === null && Object.hasOwn(recs[0], "eval"), "评测结果空位 eval=null");
		assert(recs[0].diff.files.some((f) => f.path === "SKILL.md" && f.change === "added"), "diff 摘要列出新增文件");
		assert(typeof recs[0].at === "string" && /^v\d{8}T\d{9}Z-/.test(recs[0].id), "时间 + 可排序 id");

		await runWithWriteContext({ actor: "panel", sessionId: "sess-9" }, () =>
			saveSkill(ctx, { name: "demo-skill", content: "---\nname: demo-skill\ndescription: 演示\n---\n# v2\n第二版正文\n" }, fakeHome)
		);
		recs = await skillRecs(key);
		const edit = recs.at(-1);
		assert(recs.length === 2 && edit.action === "edit" && edit.actor === "panel" && edit.sessionId === "sess-9", "面板改写 → edit，带 actor / sessionId");
		assert(edit.diff.files[0].added > 0 && edit.diff.files[0].removed > 0, "diff 带增删行数");

		await saveSkill(ctx, { name: "demo-skill", content: "---\nname: demo-skill\ndescription: 演示\nmetadata:\n  group: 写作\n---\n# v2\n第二版正文\n" }, fakeHome);
		recs = await skillRecs(key);
		assert(recs.at(-1).action === "group-change", "只改 metadata.group → group-change（自动细化）");
		assert(recs.at(-1).actor === "unknown", "没有上下文时 actor=unknown，不报错");

		await runWithWriteContext({ actor: "extractor:merge", sessionIds: ["sess-3"] }, () =>
			writeSkill(userRoot, { name: "demo-skill", description: "演示", body: "# v3\n合并后\n" }, { force: true })
		);
		recs = await skillRecs(key);
		assert(recs.at(-1).action === "merge" && recs.at(-1).actor === "extractor:merge", "覆盖已有 → merge");
		assert(chainOk(recs), "parent 链连续");
	}

	console.log("\n[3] 回收站：删除 / 恢复也记");
	{
		const moved = await trashSkill({ name: "demo-skill", dir: skillDir, path: skillFile }, { cwd: fakeHome });
		let recs = await skillRecs(key);
		assert(recs.at(-1).action === "delete" && recs.at(-1).state.exists === false, "移入回收站 → delete，state.exists=false");
		await restoreTrash(moved.id, "demo-skill", { cwd: fakeHome });
		recs = await skillRecs(key);
		assert(recs.at(-1).action === "restore" && recs.at(-1).state.exists === true, "恢复 → restore");
	}

	console.log("\n[4] 插件外改动：下次写入前补一条 baseline");
	{
		writeFileSync(join(skillDir, "notes.md"), "手工加的文件\n");
		await saveSkill(ctx, { name: "demo-skill", content: readFileSync(skillFile, "utf8") + "\n补一行\n" }, fakeHome);
		const recs = await skillRecs(key);
		const [baseline, edit] = recs.slice(-2);
		assert(baseline.action === "baseline" && baseline.actor === "external" && baseline.diff.files.some((f) => f.path === "notes.md"), "外部改动补记 baseline（actor=external）");
		assert(edit.action === "edit" && edit.parent === baseline.id, "随后的 edit 挂在 baseline 后面");
		assert(chainOk(recs), "链仍连续");
	}

	console.log("\n[5] 回滚单个 skill 到任意版本，回滚本身留痕，历史不断");
	{
		const before = await skillRecs(key);
		const target = before.find((r) => r.action === "create");
		const res = await runWithWriteContext({ actor: "model:skillmgr_rollback", sessionId: "sess-r" }, () => rollbackSkill({ name: "demo-skill", versionId: target.id, reason: "合并改坏了" }));
		assert(res.ok && res.restoredTo === target.id, "回滚返回 ok");
		assert(readFileSync(skillFile, "utf8").includes("第一版") && !existsSync(join(skillDir, "notes.md")), "文件内容回到 v1（后加的 notes.md 被移除）");
		const after = await skillRecs(key);
		const rb = after.at(-1);
		assert(after.length === before.length + 1, "只追加一条，不删旧记录");
		assert(rb.action === "rollback" && rb.rollbackOf === target.id && rb.parent === before.at(-1).id, "rollback 记录带 rollbackOf，parent 指向回滚前最新");
		assert(rb.actor === "model:skillmgr_rollback" && rb.sessionId === "sess-r" && /合并改坏了/.test(rb.reason), "回滚的 actor / 会话 / 原因");
		assert(before.every((r, i) => after[i].id === r.id), "回滚前的每条记录原样保留");
		assert(chainOk(after), "回滚后链仍连续");

		const again = await rollbackSkill({ key, versionId: target.id });
		assert(again.version.action === "rollback" && /未改动文件/.test(again.version.reason), "回滚到与现状一致的版本也留一条记录");

		const mergeRec = after.find((r) => r.action === "merge");
		await rollbackSkill({ name: "demo-skill", versionId: mergeRec.id });
		assert(readFileSync(skillFile, "utf8").includes("合并后"), "可以再滚回较新的版本（回滚可撤回）");

		const delRec = after.find((r) => r.action === "delete");
		const toNothing = await rollbackSkill({ name: "demo-skill", versionId: delRec.id });
		assert(!existsSync(skillDir) && toNothing.trashed?.trashId, "回到「不存在」版本：目录进回收站而不是硬删");
		assert((await listTrash()).some((b) => b.id === toNothing.trashed.trashId), "回收站能看到这批");
		let msg = "";
		try {
			await rollbackSkill({ name: "demo-skill", versionId: "v-nope" });
		} catch (error) {
			msg = String(error?.message);
		}
		assert(/找不到版本/.test(msg), "不存在的版本号报错");
		await rollbackSkill({ name: "demo-skill", versionId: target.id });
		assert(existsSync(skillFile), "从「不存在」再回滚回来");
	}

	console.log("\n[6] MCP 注册表：增 / 改 / 删出记录，凭据不进版本史，工具缓存刷新不算改动");
	const store = new McpStore();
	const regRecs = async () => (await readVersionRecords()).filter((r) => r.key === REGISTRY_KEY);
	{
		await runWithWriteContext({ actor: "panel" }, () => store.upsert({ name: "gh", command: "npx", args: ["gh-mcp"], env: { GITHUB_TOKEN: "ghp_SUPERSECRET123" } }));
		let recs = await regRecs();
		assert(recs.length === 1 && recs[0].action === "registry-add" && recs[0].actor === "panel" && recs[0].diff.added.join() === "gh", "新增 server → registry-add");
		const blob = gunzipSync(readFileSync(join(historyRoot(), "objects", recs[0].state.sha.slice(0, 2), recs[0].state.sha + ".gz"))).toString("utf8");
		assert(!blob.includes("ghp_SUPERSECRET123") && blob.includes("gh-mcp"), "版本对象里凭据已脱敏");
		assert(!readFileSync(historyLogPath(), "utf8").includes("ghp_SUPERSECRET123"), "版本日志里也没有凭据");

		await store.upsert({ name: "gh", tools: [{ name: "search", description: "x" }], toolsCheckedAt: Date.now() });
		assert((await regRecs()).length === 1, "只刷新工具清单缓存：不出记录");

		await store.upsert({ name: "gh", args: ["gh-mcp", "--readonly"] });
		recs = await regRecs();
		assert(recs.at(-1).action === "registry-edit" && recs.at(-1).diff.changed[0].fields.includes("args"), "改 args → registry-edit，diff 列出字段");
		await store.patchSetting("idleTimeoutMinutes", 42);
		recs = await regRecs();
		assert(recs.at(-1).action === "registry-setting", "改全局设置 → registry-setting");
		await store.upsert({ name: "fs", command: "node", args: ["fs.js"] });
		await store.remove("fs");
		recs = await regRecs();
		assert(recs.at(-1).action === "registry-remove" && recs.at(-1).diff.removed.join() === "fs", "删除 server → registry-remove");
		assert(chainOk(recs), "注册表 parent 链连续");

		await Promise.all(Array.from({ length: 8 }, (_, i) => store.upsert({ name: "par" + i, command: "node", args: [String(i)] })));
		const parallel = JSON.parse(readFileSync(join(fakeHome, ".dsh", "dsh-studio", "mcp.json"), "utf8")).servers.filter((x) => x.name.startsWith("par"));
		assert(parallel.length === 8, "并发 8 路 upsert 全部落盘（读-改-写串行，不互相覆盖）：" + parallel.length);
		await Promise.all(Array.from({ length: 8 }, (_, i) => store.remove("par" + i)));
		assert(chainOk(await regRecs()), "并发写入后注册表链仍连续");
		recs = await regRecs();
		const addRec = recs[0];
		const res = await rollbackRegistry({ versionId: addRec.id, file: join(fakeHome, ".dsh", "dsh-studio", "mcp.json"), reason: "撤回 readonly" });
		const now = JSON.parse(readFileSync(join(fakeHome, ".dsh", "dsh-studio", "mcp.json"), "utf8"));
		const gh = now.servers.find((s) => s.name === "gh");
		assert(res.ok && gh.args.join(" ") === "gh-mcp", "整份注册表回到第一版");
		assert(gh.env.GITHUB_TOKEN === "ghp_SUPERSECRET123", "回滚不动凭据：按本机现值补回，不写占位符");
		assert(now.idleTimeoutMinutes !== 42, "全局设置也一起回去");
		const after = await regRecs();
		assert(after.at(-1).action === "rollback" && after.at(-1).rollbackOf === addRec.id && after.length === recs.length + 1, "注册表回滚记一条 rollback");
		assert(chainOk(after), "回滚后链仍连续");
	}

	console.log("\n[7] 工具层：skillmgr_history / skillmgr_rollback");
	{
		const tools = new Map(buildEvolutionTools({ registryPath: () => join(fakeHome, ".dsh", "dsh-studio", "mcp.json") }).map((t) => [t.name, t]));
		const h = await tools.get("skillmgr_history").execute({ name: "demo-skill", limit: 3 });
		assert(h.ok && h.records.length === 3 && h.total >= 10 && h.records[0].action === "rollback", "按名查、新的在前、limit 生效");
		assert(h.records.every((r) => typeof r.state.files === "number" || r.state.exists === false), "返回体里 state 只给文件数，不带大清单");
		const reg = await tools.get("skillmgr_history").execute({ name: "mcp-registry" });
		assert(reg.ok && reg.records.every((r) => r.kind === "mcp-registry"), "mcp-registry 只看注册表");
		const bad = await tools.get("skillmgr_rollback").execute({ target: "demo-skill", versionId: reg.records[0].id });
		assert(bad.ok === false && /不属于/.test(bad.message), "拿注册表版本号回滚 skill 被拒");
	}

	console.log("\n[8] 版本史随快照走（只白名单内的两种文件），恢复时按 id 合并");
	{
		const files = await collectFiles();
		const hist = files.filter((f) => f.rel.startsWith(HISTORY_PREFIX));
		assert(hist.some((f) => f.rel === HISTORY_PREFIX + "versions.jsonl"), "快照收集到 versions.jsonl");
		assert(hist.some((f) => /^dsh-studio-history\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}\.gz$/.test(f.rel)), "快照收集到对象文件");
		writeFileSync(join(historyRoot(), "stray.txt"), "不该进快照");
		assert(!(await collectFiles()).some((f) => f.rel.endsWith("stray.txt")), "历史目录里的杂文件不进快照");
		assert(!files.some((f) => f.rel.includes("telemetry")), "遥测不进快照");
		const logBefore = readFileSync(historyLogPath(), "utf8");
		const snap = await createSnapshot("history-roundtrip");
		const extra = JSON.stringify({ id: "vZZZ-local-only", at: "2099-01-01T00:00:00.000Z", key: "skill:~/x", kind: "skill" });
		writeFileSync(historyLogPath(), logBefore + extra + "\n");
		await restoreSnapshot(snap.id);
		const logAfter = readFileSync(historyLogPath(), "utf8");
		assert(logAfter.includes("vZZZ-local-only") && logBefore.trim().split("\n").every((l) => logAfter.includes(JSON.parse(l).id)), "真快照恢复：本机新记录保留，快照里的记录都在");
		rmSync(historyRoot(), { recursive: true, force: true });
		await restoreSnapshot(snap.id);
		assert(existsSync(historyLogPath()) && readFileSync(historyLogPath(), "utf8").trim().split("\n").length === logBefore.trim().split("\n").length, "历史目录被清空后可从快照补回");
		const a = JSON.stringify({ id: "v1", at: "2026-01-01T00:00:00Z" });
		const b = JSON.stringify({ id: "v2", at: "2026-01-02T00:00:00Z" });
		const c = JSON.stringify({ id: "v3", at: "2026-01-03T00:00:00Z" });
		const merged = mergeVersionLogText([a, b].join("\n"), [b, c].join("\n"));
		assert(merged.trim().split("\n").map((l) => JSON.parse(l).id).join(",") === "v1,v2,v3", "快照旧日志与本机日志取并集，不冲掉本机更新的记录");
	}

	console.log("\n[9] 版本史写不进去：写入主流程照常，只记日志");
	{
		const warns = [];
		setVersionLogger({ warn: (m) => warns.push(m), info() {}, error() {} });
		const blocker = join(fakeHome, "hist-blocked");
		writeFileSync(blocker, "x");
		process.env.DSH_STUDIO_HISTORY_DIR = join(blocker, "history");
		const out = await versionedSkillWrite(join(userRoot, "other-skill"), { action: "create" }, async () => {
			mkdirSync(join(userRoot, "other-skill"), { recursive: true });
			writeFileSync(join(userRoot, "other-skill", "SKILL.md"), "---\nname: other-skill\ndescription: x\n---\nbody\n");
			return "written";
		});
		assert(out === "written" && existsSync(join(userRoot, "other-skill", "SKILL.md")), "写入结果原样返回、文件已落盘");
		await store.upsert({ name: "while-broken", command: "x" });
		assert(JSON.parse(readFileSync(join(fakeHome, ".dsh", "dsh-studio", "mcp.json"), "utf8")).servers.some((s) => s.name === "while-broken"), "注册表照常落盘");
		assert(warns.length >= 1, "版本史失败进日志");
		let threw = false;
		try {
			await versionedSkillWrite(join(userRoot, "other-skill"), {}, async () => {
				throw new Error("业务自己的错误");
			});
		} catch (error) {
			threw = String(error?.message) === "业务自己的错误";
		}
		assert(threw, "业务写入自己的异常原样抛出");
		delete process.env.DSH_STUDIO_HISTORY_DIR;
	}
} finally {
	rmSync(fakeHome, { recursive: true, force: true });
}

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (versions) ===");
