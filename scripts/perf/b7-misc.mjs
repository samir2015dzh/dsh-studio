#!/usr/bin/env node
/**
 * B7 量测（零散项里能量的两条）：
 *   - 带版本的写入：一个 60 个文件的技能目录，改一个文件（写前写后各捕获一次状态）；
 *   - 快照恢复：150 个技能、恢复一份只有 1 个文件不同的快照。
 *   node scripts/perf/b7-misc.mjs [--lib <lib 目录>]
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (name, dflt) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : dflt;
};
const here = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(arg("--lib", join(here, "..", "..", "lib")));
const home = await mkdtemp(join(tmpdir(), "b7-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(home, "telemetry");
const put = async (abs, data) => {
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, data);
};
const v = await import(pathToFileURL(join(libDir, "versions.js")).href);
const snap = await import(pathToFileURL(join(libDir, "snapshot.js")).href);
const t = async (label, fn, n = 1) => {
	const times = [];
	for (let i = 0; i < n; i += 1) {
		const s = performance.now();
		await fn(i);
		times.push(performance.now() - s);
	}
	times.sort((a, b) => a - b);
	console.log(`${label.padEnd(36)} ${times[Math.floor(n / 2)].toFixed(1).padStart(8)} ms (n=${n})`);
};
console.log(`lib = ${libDir}`);
const sk = join(home, ".dsh", "skills", "big");
for (let i = 0; i < 60; i += 1) await put(join(sk, "refs", `f${i}.md`), "参考资料\n".repeat(4000));
await put(join(sk, "SKILL.md"), "---\nname: big\ndescription: d\n---\nv0\n");
await v.versionedSkillWrite(sk, { action: "update" }, async () => {});
await t("带版本写入（60 文件的技能改 1 个）", (i) => v.versionedSkillWrite(sk, { action: "update" }, () => writeFile(join(sk, "SKILL.md"), `---\nname: big\ndescription: d\n---\nv${i + 1}\n`)), 5);
for (let i = 0; i < 150; i += 1) await put(join(home, ".dsh", "skills", `s${i}`, "SKILL.md"), `---\nname: s${i}\ndescription: d\n---\n` + "正文\n".repeat(3000));
const made = await snap.createSnapshot("bench");
await put(join(home, ".dsh", "skills", "s1", "SKILL.md"), "---\nname: s1\ndescription: d\n---\n改过\n");
await t("快照恢复（只有 1 个文件不同）", () => snap.restoreSnapshot(made.id));
await rm(home, { recursive: true, force: true });
