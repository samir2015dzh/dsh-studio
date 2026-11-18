/**
 * 审计 7：快照恢复 / 导入流式解包——与整包解包（unpackTarGz）逐条对拍；
 * 用现有快照（createSnapshot 真打出来的包）验恢复计划与落盘结果；从 pre-restore 快照恢复不会把自己修剪掉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-snap-stream-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(fakeHome, "history");
const snap = await import(pathToFileURL(join(pluginRoot, "lib/snapshot.js")).href);
const { createSnapshot, restoreSnapshot, exportSnapshot, importSnapshot, packTarGz, unpackTarGz, forEachTarGzEntry, listSnapshots } = snap;
test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

const dsh = join(fakeHome, ".dsh");
const put = (rel, text) => {
	mkdirSync(dirname(join(dsh, rel)), { recursive: true });
	writeFileSync(join(dsh, rel), text);
};
const longDir = "skills/" + "a-very-long-skill-directory-name-".repeat(4) + "x";
put("AGENTS.md", "# rules\n");
put("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: a\n---\nbody\n");
put(longDir + "/SKILL.md", "---\nname: long\ndescription: l\n---\n" + "长".repeat(3000) + "\n");
put("skills/bin/blob.bin", Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251)));
put("dsh-studio/mcp.json", JSON.stringify({ version: 2, servers: [{ name: "s", env: { API_TOKEN: "secret-1" } }] }, null, 2));

const collect = async (file) => {
	const out = [];
	await forEachTarGzEntry(file, (e) => void out.push({ rel: e.rel, data: e.data }));
	return out;
};

test("[#8 审计 7] 流式解包与整包解包逐条对拍（longname / 多块 / 0 字节 / 中文）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tar-parity-"));
	const entries = [
		{ rel: "empty.txt", data: Buffer.alloc(0) },
		{ rel: "x/" + "长路径".repeat(40) + ".md", data: Buffer.from("hello") },
		{ rel: "exact-512", data: Buffer.alloc(512, 7) },
		{ rel: "big.bin", data: Buffer.from(Array.from({ length: 300_001 }, (_, i) => (i * 31) % 256)) }
	];
	const file = join(dir, "t.tar.gz");
	writeFileSync(file, packTarGz(entries));
	const whole = unpackTarGz(readFileSync(file));
	const streamed = await collect(file);
	assert.deepEqual(streamed.map((e) => e.rel), whole.map((e) => e.rel));
	for (let i = 0; i < whole.length; i += 1) assert.ok(streamed[i].data.equals(whole[i].data), whole[i].rel);
	assert.ok(streamed[3].data.equals(entries[3].data));
	// 提前停止
	let n = 0;
	assert.equal(await forEachTarGzEntry(file, () => (++n === 2 ? false : undefined)), 2);
	// 不是 gzip：抛错，不挂死
	writeFileSync(join(dir, "bad.tar.gz"), "not gzip at all");
	await assert.rejects(() => forEachTarGzEntry(join(dir, "bad.tar.gz"), () => {}));
	rmSync(dir, { recursive: true, force: true });
});

test("[#8 审计 7] 用现有快照新旧对拍：条目一致；dry-run 计划、真恢复落盘、导入导出", async () => {
	const s1 = await createSnapshot("stream-parity");
	const archive = join(dsh, "dsh-studio", "snapshots", s1.id, "config.tar.gz");
	const whole = unpackTarGz(readFileSync(archive));
	const streamed = await collect(archive);
	assert.deepEqual(streamed.map((e) => [e.rel, e.data.toString("base64")]), whole.map((e) => [e.rel, e.data.toString("base64")]), "现有快照逐条一致");
	assert.ok(whole.some((e) => e.rel === longDir + "/SKILL.md"), "longname 条目在");

	const dry0 = await restoreSnapshot(s1.id, { dryRun: true });
	// 凭据文件恢复时按「包内脱敏版 + 本机现值」重新序列化（带结尾换行），字节不同于手写原文——
	// 这是 #8 之前就有的口径（旧的整包实现给出同一条 overwrite、同一个 sha），不是流式解包引入的
	assert.deepEqual(dry0.plan.filter((p) => p.action !== "same").map((p) => p.rel), ["dsh-studio/mcp.json"], "没改动：除凭据文件重新序列化外全是 same");
	put("skills/alpha/SKILL.md", "changed\n");
	rmSync(join(dsh, "AGENTS.md"));
	const dry = await restoreSnapshot(s1.id, { dryRun: true });
	assert.deepEqual(dry.plan.filter((p) => p.action !== "same").map((p) => [p.rel, p.action]).sort(), [["AGENTS.md", "create"], ["dsh-studio/mcp.json", "overwrite"], ["skills/alpha/SKILL.md", "overwrite"]]);
	const real = await restoreSnapshot(s1.id);
	assert.equal(real.failed.length, 0);
	assert.equal(real.written, dry.total);
	assert.equal(readFileSync(join(dsh, "skills/alpha/SKILL.md"), "utf8"), "---\nname: alpha\ndescription: a\n---\nbody\n");
	assert.equal(readFileSync(join(dsh, "AGENTS.md"), "utf8"), "# rules\n");
	assert.ok(readFileSync(join(dsh, "dsh-studio/mcp.json"), "utf8").includes("secret-1"), "凭据按本机现值补回，占位符不落盘");
	assert.ok(readFileSync(join(dsh, "skills/bin/blob.bin")).equals(Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251))));

	// 导出 → 导入：manifest 的 rel / bytes / sha 与整包口径一致
	const out = join(fakeHome, "export.tar.gz");
	const ex = await exportSnapshot(s1.id, out);
	assert.equal(ex.bytes, readFileSync(archive).length);
	const im = await importSnapshot(out, "imp");
	assert.equal(im.files.length, whole.length);
	assert.equal(im.archiveBytes, ex.bytes);
	assert.deepEqual(im.files.map((f) => f.rel), whole.map((e) => e.rel));
});

test("[#8 审计 7] 从 pre-restore 快照恢复：修剪挪到写完之后，不会删掉正在读的包", async () => {
	// 攒满 pre-restore 快照，再从最老的那份恢复
	const s = (await listSnapshots()).find((x) => x.label === "stream-parity");
	for (let i = 0; i < 6; i += 1) await restoreSnapshot(s.id);
	const pres = (await listSnapshots()).filter((x) => x.label === "pre-restore");
	const oldest = pres.at(-1);
	put("skills/alpha/SKILL.md", "drift\n");
	const r = await restoreSnapshot(oldest.id);
	assert.equal(r.failed.length, 0);
	assert.ok(r.written > 0, "第二遍照样读得到包");
});
