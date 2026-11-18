#!/usr/bin/env node
/**
 * G5 目录选择评测：跑场景集，打印命中率与逐条结果。只读。
 *
 *   node scripts/catalog-eval.mjs [场景文件]     默认 lib/catalog-scenarios.json（随包；闲时巡检 lib/catalog-watch.js 用同一份）
 *   node scripts/catalog-eval.mjs --registry [mcp.json] [--scenarios 文件]
 *       用真实注册表里的目录条目（catalog / notes + 工具名）当候选，跑同一组场景
 *
 * 评测器是词面代理（lib/catalog-select.js），衡量「目录条目写得够不够区分」，不是模型准确率。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateScenarios } from "../lib/catalog-select.js";
import { registryCandidates } from "../lib/catalog-watch.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const flag = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

const scenarioFile = flag("--scenarios") ?? (argv.includes("--registry") ? undefined : argv.find((a) => !a.startsWith("--"))) ?? resolve(root, "lib/catalog-scenarios.json");
const fixture = readJson(scenarioFile);
let candidates = fixture.candidates;
let source = scenarioFile;
if (argv.includes("--registry")) {
	const next = argv[argv.indexOf("--registry") + 1];
	const file = next !== undefined && !next.startsWith("--") ? next : resolve(homedir(), ".dsh", "dsh-studio", "mcp.json");
	const registry = readJson(file);
	candidates = registryCandidates(registry.servers);
	source = `${file}（真实注册表的目录条目）× ${scenarioFile}`;
}

const report = evaluateScenarios(fixture.scenarios, candidates);
const pct = (x) => (x * 100).toFixed(1) + "%";
const lines = [
	`# MCP 目录选择评测（词面代理）`,
	"",
	`来源：${source}`,
	`总命中 ${report.hits}/${report.total} = ${pct(report.hitRate)}；正例 ${pct(report.positive.hitRate)}（${report.positive.total} 条）；反例 ${pct(report.negative.hitRate)}（${report.negative.total} 条）`,
	"",
	"| id | 期望 | 选中 | 命中 | 前三（分数） |",
	"| --- | --- | --- | --- | --- |",
	...report.results.map((r) => `| ${r.id} | ${r.expect ?? "（不用 MCP）"} | ${r.pick ?? "（不用 MCP）"} | ${r.hit ? "✓" : "✗"} | ${r.top.map((t) => `${t.name} ${t.score}`).join("，")} |`)
];
process.stdout.write(lines.join("\n") + "\n");
