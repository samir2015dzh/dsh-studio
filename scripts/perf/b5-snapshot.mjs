#!/usr/bin/env node
/**
 * B5 量测：一个有技能库、回收站、更新前备份（skill-backups）、导出包、组装残留（skill-tmp）的 ~/.dsh，
 * 打一份快照的耗时、文件数与包大小。
 *   node scripts/perf/b5-snapshot.mjs [--lib <lib 目录>]
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (name, dflt) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : dflt;
};
const here = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(arg("--lib", join(here, "..", "..", "lib")));
const home = await mkdtemp(join(tmpdir(), "b5-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(home, "telemetry");
const put = async (abs, data) => {
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, data);
};
const text = (kb) => ("技能正文：步骤、注意事项、示例命令 git status / pnpm test。\n").repeat(Math.ceil((kb * 1024) / 80));
const dsh = join(home, ".dsh");
for (let i = 0; i < 150; i += 1) {
	await put(join(dsh, "skills", `skill-${i}`, "SKILL.md"), `---\nname: skill-${i}\ndescription: d\n---\n` + text(6));
	await put(join(dsh, "skills", `skill-${i}`, "refs", "notes.md"), text(12));
}
for (let i = 0; i < 40; i += 1) {
	await put(join(dsh, "dsh-studio", "trash", `20261101-0000${i}-x`, `old-${i}`, "SKILL.md"), text(8));
	await put(join(dsh, "dsh-studio", "trash", `20261101-0000${i}-x`, `old-${i}`, "assets", "demo.gif"), randomBytes(i % 10 === 0 ? 6 * 1024 * 1024 : 200 * 1024));
}
for (let i = 0; i < 60; i += 1) {
	await put(join(dsh, "dsh-studio", "skill-backups", `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00-00-00-000Z`, `skill-${i % 12}`, "SKILL.md"), text(10));
	await put(join(dsh, "dsh-studio", "skill-backups", `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00-00-00-000Z`, `skill-${i % 12}`, "bundle.bin"), randomBytes(1024 * 1024));
}
for (let i = 0; i < 15; i += 1) await put(join(dsh, "dsh-studio", "exports", `skill-${i}.tar.gz`), randomBytes(512 * 1024));
await put(join(dsh, "dsh-studio", "skill-tmp", "skill-3-x", "SKILL.md"), text(10));

const snap = await import(pathToFileURL(join(libDir, "snapshot.js")).href);
const s = performance.now();
const r = await snap.createSnapshot("bench");
const ms = performance.now() - s;
console.log(`lib = ${libDir}`);
console.log(`快照：${Math.round(ms)} ms，${r.files.length} 个文件，包 ${(r.archiveBytes / 1024 / 1024).toFixed(1)} MB`);
await rm(home, { recursive: true, force: true });
