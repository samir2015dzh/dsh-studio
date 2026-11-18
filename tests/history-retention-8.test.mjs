/**
 * ：版本史保留口径（所有者 2026-11-16 拍板：每 key 最近 200 条）+ objects/ 按引用 GC；
 * 审计 5：版本捕获大文件流式哈希（sha 与整读一致，(size, mtimeMs) 不变复用）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-retention-8-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(fakeHome, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(fakeHome, "telemetry");
const v = await import(modUrl("lib/versions.js"));
const { versionedSkillWrite, readVersionRecords, applyVersionRetention, verifyVersionRetention, splitByRetention, rollbackSkill, captureSkillState, captureCounters, sha256File, MAX_STORED_FILE_BYTES } = v;
test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

const skills = join(fakeHome, ".dsh", "skills");
const skillFile = (name) => join(skills, name, "SKILL.md");
const writeVersion = async (name, body) => {
	mkdirSync(dirname(skillFile(name)), { recursive: true });
	await versionedSkillWrite(skillFile(name), { action: "edit", reason: "t" }, async () => writeFileSync(skillFile(name), `---\nname: ${name}\ndescription: d\n---\n${body}\n`));
};
const objectCount = () => {
	const root = join(fakeHome, "history", "objects");
	if (!existsSync(root)) return 0;
	return readdirSync(root).reduce((n, b) => n + readdirSync(join(root, b)).length, 0);
};

test("[#8 保留] splitByRetention：每 key 留最近 N 条、保持日志顺序", () => {
	const recs = [];
	for (let i = 0; i < 7; i += 1) recs.push({ id: "a" + i, key: "A" }, { id: "b" + i, key: i % 2 ? "B" : "C" });
	const { kept, pruned } = splitByRetention(recs, 3);
	assert.deepEqual(kept.filter((r) => r.key === "A").map((r) => r.id), ["a4", "a5", "a6"]);
	assert.equal(kept.length + pruned.length, recs.length);
	assert.deepEqual(kept.map((r) => r.id), recs.filter((r) => kept.includes(r)).map((r) => r.id), "顺序不变");
});

test("[#8 保留] 每 key 最近 200 条：归档 + 对象 GC；保留窗口内任一版本可回滚；自检口径一致", async () => {
	for (let i = 0; i < 230; i += 1) await writeVersion("busy", "v" + i);
	for (let i = 0; i < 5; i += 1) await writeVersion("calm", "c" + i);
	const before = await readVersionRecords();
	const busyKey = before.find((r) => r.name === "busy").key;
	assert.ok(before.filter((r) => r.key === busyKey).length > 200);
	const objsBefore = objectCount();

	const dry = await applyVersionRetention({ graceMs: 0, dryRun: true });
	assert.equal(dry.archived, before.length - dry.kept);
	assert.equal(objectCount(), objsBefore, "预演零写入");
	assert.equal((await readVersionRecords()).length, before.length);

	const r = await applyVersionRetention({ graceMs: 0 });
	const after = await readVersionRecords();
	assert.equal(after.filter((x) => x.key === busyKey).length, 200, "busy 只留 200 条");
	assert.equal(after.filter((x) => x.name === "calm").length, before.filter((x) => x.name === "calm").length, "calm 不动");
	assert.deepEqual(after.filter((x) => x.key === busyKey).map((x) => x.id), before.filter((x) => x.key === busyKey).slice(-200).map((x) => x.id), "留的是最近 200 条");
	assert.ok(r.deletedObjects > 0 && objectCount() < objsBefore, "未被引用的对象被 GC");
	assert.equal(objectCount(), r.referencedObjects, "对象数 = 被保留记录引用的对象数");
	// 归档段：被移出的记录原样在，但 readVersionRecords 不读它
	const archived = gunzipSync(readFileSync(r.archiveFile)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(archived.length, r.archived);
	assert.ok(!after.some((x) => archived.some((a) => a.id === x.id)));

	const check = await verifyVersionRetention();
	assert.equal(check.ok, true);
	assert.equal(check.maxPerKey, 200);
	assert.deepEqual(check.missingObjects, []);
	assert.equal(check.unreferencedObjects, 0);
	assert.equal(check.records, after.length);

	// 回滚能力：保留窗口里最老的那一版仍可回滚，内容逐字回来
	const oldestKept = after.find((x) => x.key === busyKey && x.state?.exists);
	const sha = oldestKept.state.files["SKILL.md"].sha;
	await rollbackSkill({ key: busyKey, versionId: oldestKept.id });
	assert.equal(createHash("sha256").update(readFileSync(skillFile("busy"))).digest("hex"), sha);
	// 被归档的版本不在主日志里：回滚给出「找不到」而不是半截恢复
	await assert.rejects(() => rollbackSkill({ key: busyKey, versionId: archived.find((a) => a.key === busyKey).id }), /找不到版本/);

	// 幂等：再跑一次没有可归档 / 可删的（回滚本身多了 1 条 → 又超 1 条，正好归档 1 条）
	const again = await applyVersionRetention({ graceMs: 0 });
	assert.ok(again.archived <= 1);
	assert.equal((await verifyVersionRetention()).ok, true);
});

test("[#8 保留] 宽限期内的孤儿对象不删（对象先落、记录后追加的写入窗口）", async () => {
	const root = join(fakeHome, "history", "objects");
	const fake = "f".repeat(64);
	mkdirSync(join(root, "ff"), { recursive: true });
	writeFileSync(join(root, "ff", fake + ".gz"), "x");
	const r1 = await applyVersionRetention();
	assert.ok(existsSync(join(root, "ff", fake + ".gz")), "新对象在宽限期内保留");
	const old = (Date.now() - 2 * 3600_000) / 1000;
	utimesSync(join(root, "ff", fake + ".gz"), old, old);
	await applyVersionRetention();
	assert.equal(existsSync(join(root, "ff", fake + ".gz")), false, "过了宽限期才 GC");
	assert.ok(r1.orphanObjects >= 0);
});

test("[#8 保留] 对拍脚本：在历史副本上预演 / 执行 / 自检 + 回滚抽验", () => {
	const copy = mkdtempSync(join(tmpdir(), "history-copy-"));
	spawnSync(process.execPath, ["-e", `require("node:fs").cpSync(${JSON.stringify(join(fakeHome, "history"))}, ${JSON.stringify(copy)}, {recursive:true})`]);
	const dry = spawnSync(process.execPath, [join(pluginRoot, "scripts/history-retention.mjs"), "--dir", copy, "--keep", "50"], { encoding: "utf8" });
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /未加 --apply/);
	const run = spawnSync(process.execPath, [join(pluginRoot, "scripts/history-retention.mjs"), "--dir", copy, "--keep", "50", "--apply", "--grace-ms", "0"], { encoding: "utf8" });
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /保留口径与回滚能力一致/);
	const bad = spawnSync(process.execPath, [join(pluginRoot, "scripts/history-retention.mjs")], { encoding: "utf8" });
	assert.equal(bad.status, 2, "不给 --dir 拒跑（防误跑真机）");
	rmSync(copy, { recursive: true, force: true });
});

test("[#8 审计 5] 大文件流式哈希：sha 与整读一致；(size, mtimeMs) 不变复用", async () => {
	const dir = join(skills, "huge");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "---\nname: huge\ndescription: d\n---\n");
	const big = Buffer.alloc(MAX_STORED_FILE_BYTES + 12345, 0x61);
	big.write("tail-marker", big.length - 20);
	writeFileSync(join(dir, "data.bin"), big);
	const whole = createHash("sha256").update(readFileSync(join(dir, "data.bin"))).digest("hex");
	assert.equal(await sha256File(join(dir, "data.bin")), whole);
	const s0 = { ...captureCounters };
	const st1 = await captureSkillState(dir);
	assert.deepEqual(st1.files["data.bin"], { sha: whole, size: big.length, stored: false });
	const st2 = await captureSkillState(dir);
	assert.equal(st2.files["data.bin"].sha, whole);
	assert.equal(captureCounters.largeStreamed - s0.largeStreamed, 1, "只流式读一次");
	assert.equal(captureCounters.largeReused - s0.largeReused, 1, "第二次复用");
	big.write("CHANGED", 0);
	writeFileSync(join(dir, "data.bin"), big);
	const future = Date.now() / 1000 + 5;
	utimesSync(join(dir, "data.bin"), future, future);
	const st3 = await captureSkillState(dir);
	assert.equal(st3.files["data.bin"].sha, createHash("sha256").update(big).digest("hex"), "内容变了重算");
});
