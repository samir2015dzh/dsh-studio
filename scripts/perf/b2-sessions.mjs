#!/usr/bin/env node
/**
 * B2 / B3 量测：所有者机器量级的会话目录（默认 945 份 zstd 日志，都在窗口内），
 * 跑「一轮提取的会话收集」（第一轮冷、第二轮无变化、第三轮只有最新一份变了）与逐轮判定的收集。
 *
 *   node scripts/perf/b2-sessions.mjs [--lib <lib 目录>] [--sessions 945] [--msgs 60]
 *
 * 全程在临时目录里跑，需要系统 zstd。
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, dflt) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : dflt;
};
const libDir = resolve(arg("--lib", new URL("../../lib", import.meta.url).pathname));
const N = Number(arg("--sessions", 945));
const MSGS = Number(arg("--msgs", 60));

const home = await mkdtemp(join(tmpdir(), "b2-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, ".dsh");
const root = join(home, ".dsh", "sessions");
process.env.DSH_SKILL_EXTRACTOR_SESSIONS = root;
process.env.DSH_SKILL_EXTRACTOR_CONFIG = join(home, "extractor.json");
process.env.DSH_SKILL_EXTRACTOR_CANDIDATES = join(home, "candidates.json");
process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(home, "telemetry");

const sessionText = (i, extra = "") => {
	const rows = [{ type: "session", id: `sess-${i}`, createdAt: new Date(Date.now() - i * 3600_000).toISOString(), cwd: `/work/p${i % 30}` }];
	for (let m = 0; m < MSGS; m += 1) {
		rows.push({ type: "agent/inbox/spliced", data: { inserted: [{ role: m % 2 ? "assistant" : "user", content: [{ type: "text", text: `第 ${m} 条消息 ${extra} ` + "内容".repeat(300) }] }] } });
		rows.push({ type: "tool/call", time: Date.now(), data: { name: m % 7 === 0 ? "skill" : "bash", arguments: { name: `skill-${m % 5}`, command: "ls" } } });
		rows.push({ type: "tool/result", data: { output: "x".repeat(800) } });
	}
	return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
};
const writeSession = async (i, extra = "") => {
	const dir = join(root, `sess-${i}`);
	await mkdir(dir, { recursive: true });
	const plain = join(dir, "session.v4.jsonl");
	await writeFile(plain, sessionText(i, extra));
	execFileSync("zstd", ["-q", "-f", "--rm", plain, "-o", plain + ".zstd"]);
	const t = new Date(Date.now() - i * 60_000 + (extra ? 120_000 : 0));
	await utimes(plain + ".zstd", t, t);
};
for (let i = 0; i < N; i += 1) await writeSession(i);

const ex = await import(pathToFileURL(join(libDir, "extractor.js")).href);
const t = async (label, fn) => {
	const s = performance.now();
	const r = await fn();
	console.log(`${label.padEnd(40)} ${(performance.now() - s).toFixed(0).padStart(7)} ms`);
	return r;
};
console.log(`lib = ${libDir}\n会话 ${N} 份，每份 ${MSGS * 3} 行`);
const collect = typeof ex.scanSessionsForExtraction === "function" ? () => ex.scanSessionsForExtraction(root, 30, 12) : () => ex.collectSessionLogs(root, 30);
await t("提取收集：第 1 轮（冷）", collect);
await t("提取收集：第 2 轮（无变化）", collect);
await writeSession(0, "续写");
await t("提取收集：第 3 轮（最新一份变了）", collect);
await t("逐轮判定收集（最新 1 份）", () => ex.collectSessionDigests(root, 1, 1));
await t("逐轮判定收集（再来一次）", () => ex.collectSessionDigests(root, 1, 1));
await rm(home, { recursive: true, force: true });
