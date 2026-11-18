#!/usr/bin/env node
/**
 * B6 量测：所有者机器量级的技能库（~/.dsh/skills 30 个 + ~/.agents/skills 180 个），
 * 治理 / 蒸馏用的 loadLibrary、面板列表、按名查找、保存一次后再列表的耗时，以及 ctx.skills.list 被调了几次。
 *   node scripts/perf/b6-library.mjs [--lib <lib 目录>]
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
const home = await mkdtemp(join(tmpdir(), "b6-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(home, "telemetry");
const body = (i) => `# 技能 ${i}\n\n## 何时用\n处理第 ${i} 类任务。\n\n## 步骤\n` + Array.from({ length: 12 }, (_, k) => `${k + 1}. 运行 \`tool-${k % 5}\` 处理第 ${k} 步，注意不要跳过校验\n`).join("") + "\n## 常见错误\n- 不要忘了备份\n".repeat(20);
const roots = [join(home, ".dsh", "skills"), join(home, ".agents", "skills")];
for (const [r, n] of [[roots[0], 30], [roots[1], 180]]) {
	for (let i = 0; i < n; i += 1) {
		const dir = join(r, `skill-${r === roots[0] ? "d" : "a"}${i}`);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "SKILL.md"), `---\nname: ${dir.split(/[\\/]/).pop()}\ndescription: 处理第 ${i} 类任务的流程与注意事项\n---\n${body(i)}`);
	}
}
const gs = await import(pathToFileURL(join(libDir, "governance-scan.js")).href);
const scanner = await import(pathToFileURL(join(libDir, "scanner.js")).href);
const core = await import(pathToFileURL(join(libDir, "skill-core.js")).href);
let listCalls = 0;
const ctx = { skills: { list: async () => { listCalls += 1; return []; }, get: async () => null }, logger: null };
const t = async (label, fn, n = 1) => {
	const times = [];
	for (let i = 0; i < n; i += 1) {
		const s = performance.now();
		await fn();
		times.push(performance.now() - s);
	}
	times.sort((a, b) => a - b);
	console.log(`${label.padEnd(34)} ${times[Math.floor(n / 2)].toFixed(1).padStart(8)} ms (n=${n})`);
};
console.log(`lib = ${libDir}\n技能 210 个`);
await t("loadLibrary 第一次", () => gs.loadLibrary(roots));
await t("loadLibrary 之后", () => gs.loadLibrary(roots), 5);
await t("listSkills 第一次", () => core.listSkills(ctx, home));
await t("listSkills 之后", () => core.listSkills(ctx, home), 5);
await t("findSkillByName 之后", () => scanner.findSkillByName("skill-a120", home), 5);
const target = join(roots[1], "skill-a5", "SKILL.md");
let k = 0;
await t("保存一次 + 列表", async () => {
	await core.saveSkill(ctx, { name: "skill-a5", content: `---\nname: skill-a5\ndescription: 改 ${(k += 1)}\n---\n${body(5)}`, overwrite: true }, home);
	await core.listSkills(ctx, home);
}, 5);
await new Promise((r) => setTimeout(r, 50));
console.log(`ctx.skills.list 被调用 ${listCalls} 次（12 次列表请求）`);
void target;
await rm(home, { recursive: true, force: true });
