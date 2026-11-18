/**
 * PATH 解析：有可执行文件时能找到，没有时返回空（供 verify:quick 跳过 dsh 用）。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { resolveCommand } = await import(pathToFileURL(join(pluginRoot, "scripts/lib/resolve-command.mjs")).href);

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

const root = mkdtempSync(join(tmpdir(), "dsh-resolve-cmd-"));
const binDir = join(root, "bin");
const emptyDir = join(root, "empty");
mkdirSync(binDir);
mkdirSync(emptyDir);

const isWin = process.platform === "win32";
const samePath = (a, b) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
const exeName = isWin ? "dsh.cmd" : "dsh";
const exePath = join(binDir, exeName);
writeFileSync(exePath, isWin ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
if (!isWin) chmodSync(exePath, 0o755);

const pathEnv = {
	...process.env,
	PATH: binDir,
	Path: binDir,
	PATHEXT: process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM",
};
const missingEnv = {
	...process.env,
	PATH: emptyDir,
	Path: emptyDir,
	PATHEXT: process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM",
};

const found = resolveCommand("dsh", pathEnv);
assert(samePath(found, exePath), `PATH 上有 dsh 时应解析到 ${exePath}，实际 ${found}`);
assert(resolveCommand("dsh", missingEnv) === "", `PATH 上没有 dsh 时应为空，实际 ${resolveCommand("dsh", missingEnv)}`);
assert(resolveCommand(join(root, "no-such-dsh"), process.env) === "", "不存在的绝对路径应为空");
assert(samePath(resolveCommand(exePath, missingEnv), exePath), "已有的绝对路径应原样返回");
assert(resolveCommand("", missingEnv) === "", "空命令应为空");

// 集成：portability.mjs 在 --dsh 指向不存在的文件时，应跳过启动且 exit 0
console.log("\n[portability skip when dsh missing]");
const script = join(pluginRoot, "scripts/portability.mjs");
const missingBin = join(root, "definitely-not-dsh");
// 用 --dsh 指向不存在的文件来跳过启动；PATH 保持原样，否则 npm pack 自己也会找不到 npm。
const result = spawnSync(process.execPath, [script, "--skip-audit", "--skip-stability", "--json", "--dsh", missingBin, "--cwd", pluginRoot], {
	encoding: "utf8",
	cwd: pluginRoot,
	// 伪 DSH_HOME：portability 的 cleanup 会动 <DSH_HOME>/profiles，测试绝不能碰真实 ~/.dsh
	env: { ...process.env, DSH_HOME: join(root, "dsh-home") },
	timeout: 120_000,
});
if (result.status !== 0) {
	console.error(result.stdout.slice(-1200));
	console.error(result.stderr.slice(-400));
}
assert(result.status === 0, `verify 在没有 dsh 时应 exit 0，实际 ${result.status}`);
let report = null;
try {
	const start = result.stdout.indexOf("{");
	const end = result.stdout.lastIndexOf("}");
	report = JSON.parse(result.stdout.slice(start, end + 1));
} catch (error) {
	console.error("parse json failed", error.message, result.stdout.slice(-400));
}
assert(report?.skippedLive === true, "json 报告应标记 skippedLive");
assert(report?.failed === 0, "json 报告 failed 应为 0，实际 " + report?.failed);
const titles = (report?.results ?? []).map((row) => row.title + " " + (row.detail ?? ""));
const skippedNote = titles.some((title) => title.includes("PATH 上没有 dsh") && title.includes("已跳过安装、启动与健康检查"));
if (!skippedNote) console.error("results:", JSON.stringify(report?.results ?? [], null, 2).slice(0, 800));
assert(skippedNote, "应有明确跳过说明");

rmSync(root, { recursive: true, force: true });

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (resolve-command) ===");
