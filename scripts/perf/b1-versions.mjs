#!/usr/bin/env node
/**
 * B1 量测：版本日志到保留上限量级（200 个技能 × 200 条 ≈ 66 MB）时，
 * readVersionRecords 冷读 / 热读，以及「改一行」（versionedSkillWrite）的耗时。
 *
 *   node scripts/perf/b1-versions.mjs [--lib <lib 目录>] [--keys 200] [--per 200]
 *
 * --lib 指向另一份 lib/（例如 `git archive <基线> lib | tar -x -C /tmp/base` 解出来的），用来做改前改后对照。
 * 全程在临时目录里跑（HOME 与 DSH_STUDIO_HISTORY_DIR 都指向临时目录），不碰真实数据。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWriteStream } from "node:fs";

const arg = (name, dflt) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : dflt;
};
const libDir = resolve(arg("--lib", new URL("../../lib", import.meta.url).pathname));
const KEYS = Number(arg("--keys", 200));
const PER = Number(arg("--per", 200));

const home = await mkdtemp(join(tmpdir(), "b1-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
await mkdir(process.env.DSH_STUDIO_HISTORY_DIR, { recursive: true });

// 造日志：每条记录带一个十来个文件的 state 与 diff 摘要，单条约 1.6 KB
const out = createWriteStream(join(process.env.DSH_STUDIO_HISTORY_DIR, "versions.jsonl"));
const hex = (n) => n.toString(16).padStart(64, "0");
let seq = 0;
for (let r = 0; r < PER; r += 1) {
	for (let k = 0; k < KEYS; k += 1) {
		seq += 1;
		const files = {};
		for (let f = 0; f < 8; f += 1) files[`refs/file-${f}.md`] = { sha: hex(seq * 16 + f), size: 1000 + f, stored: true };
		files["SKILL.md"] = { sha: hex(seq * 16 + 9), size: 4000, stored: true };
		const rec = {
			v: 1,
			id: `v2026${String(seq).padStart(10, "0")}-abcdef`,
			at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
			kind: "skill",
			key: `skill:~/.dsh/skills/skill-${k}`,
			target: join(home, ".dsh", "skills", `skill-${k}`),
			name: `skill-${k}`,
			action: "update",
			actor: "optimizer",
			trigger: "optimize",
			sessionId: null,
			sessionIds: [],
			reason: "措辞润色",
			parent: null,
			state: { exists: true, kind: "dir", files },
			diff: { summary: "改了 SKILL.md（+3 −2 行）", files: [{ path: "SKILL.md", change: "modified", added: 3, removed: 2 }], frontmatter: [] },
			eval: null
		};
		if (!out.write(JSON.stringify(rec) + "\n")) await new Promise((r2) => out.once("drain", r2));
	}
}
await new Promise((r2) => out.end(r2));

const v = await import(pathToFileURL(join(libDir, "versions.js")).href);
const t = async (label, fn, n = 1) => {
	const times = [];
	for (let i = 0; i < n; i += 1) {
		const s = performance.now();
		await fn();
		times.push(performance.now() - s);
	}
	times.sort((a, b) => a - b);
	console.log(`${label.padEnd(36)} ${times[Math.floor(times.length / 2)].toFixed(1).padStart(8)} ms  (n=${n}, min ${times[0].toFixed(1)})`);
};

const { size } = await import("node:fs").then((m) => m.statSync(join(process.env.DSH_STUDIO_HISTORY_DIR, "versions.jsonl")));
console.log(`lib = ${libDir}`);
console.log(`versions.jsonl = ${(size / 1024 / 1024).toFixed(1)} MB, ${KEYS * PER} 条`);
await t("readVersionRecords 全量读（冷）", () => v.readVersionRecords());
if (typeof v.lastKeyRecord === "function") await t("建索引（进程内首次，之后增量）", () => v.lastKeyRecord("skill:~/.dsh/skills/skill-1"));
await t("readVersionRecords 全量读（再读）", () => v.readVersionRecords(), 3);
const target = join(home, ".dsh", "skills", "skill-0");
await mkdir(target, { recursive: true });
await writeFile(join(target, "SKILL.md"), "---\nname: skill-0\ndescription: x\n---\nbody\n");
let i = 0;
await t("versionedSkillWrite 改一行", () => v.versionedSkillWrite(target, { action: "update", actor: "user" }, () => writeFile(join(target, "SKILL.md"), `---\nname: skill-0\ndescription: x\n---\nbody ${(i += 1)}\n`)), 5);
await t("listVersions(单技能)", () => v.listVersions({ key: "skill:~/.dsh/skills/skill-7" }), 5);
if (!process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.log(home);
