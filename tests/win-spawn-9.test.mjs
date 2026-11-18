/**
 * ：win-spawn 候选顺序——PATHEXT 扩展名优先，无扩展名同名文件只作最后兜底。
 * 真机实录：C:\Program Files\nodejs 下 npx（npm 自带 sh 脚本）/ npx.cmd / npx.ps1 三者并存，旧码先命中无扩展名的 npx，
 * planSpawn 判它非 .cmd 直接 spawn → ENOENT。下列用例在旧码上失败、新码上通过（第 3 条兜底用例新旧皆过，防既有行为回归）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { planSpawn, resolveWindowsCommand } = await import(pathToFileURL(join(pluginRoot, "lib/win-spawn.js")).href);

const NODEJS = "C:\\Program Files\\nodejs";
const env = { Path: `C:\\Windows\\system32;${NODEJS}`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
// 假文件系统：与 NTFS 一样大小写不敏感（PATHEXT 给的是 .CMD，磁盘上是 npx.cmd；解析结果的扩展名大小写取自 PATHEXT）
const fsOf = (list) => {
	const set = new Set(list.map((p) => p.toLowerCase()));
	return (p) => set.has(p.toLowerCase());
};

test("[#9] 同目录 npx（无扩展名）与 npx.cmd / npx.ps1 并存：命中 npx.cmd，planSpawn 走 shim", () => {
	const isFile = fsOf([`${NODEJS}\\npx`, `${NODEJS}\\npx.cmd`, `${NODEJS}\\npx.ps1`]);
	assert.equal(resolveWindowsCommand("npx", { env, cwd: "C:\\work", isFile }), `${NODEJS}\\npx.CMD`);
	const p = planSpawn("npx", ["-y", "@modelcontextprotocol/server-everything"], { platform: "win32", env, cwd: "C:\\work", isFile });
	assert.equal(p.shim, true);
	assert.equal(p.resolved, `${NODEJS}\\npx.CMD`);
	assert.equal(p.command, "C:\\Windows\\system32\\cmd.exe");
	assert.deepEqual(p.args.slice(0, 3), ["/d", "/s", "/c"]);
	assert.equal(p.args[3], '"C:\\Program^ Files\\nodejs\\npx.CMD ^"-y^" ^"@modelcontextprotocol/server-everything^""');
	// 环境里没有 PATHEXT：按缺省 .COM;.EXE;.BAT;.CMD，同样扩展名优先
	assert.equal(resolveWindowsCommand("npx", { env: { Path: NODEJS }, cwd: "C:\\work", isFile: fsOf([`${NODEJS}\\npx`, `${NODEJS}\\npx.CMD`]) }), `${NODEJS}\\npx.CMD`);
});

test("[#9] 无扩展名兜底排在所有 PATHEXT 候选之后：靠前目录（含 cwd）的无扩展名文件不抢靠后目录的 .cmd / .exe", () => {
	const isFile = fsOf(["C:\\work\\uvx", "C:\\Git\\usr\\bin\\pnpm", `${NODEJS}\\pnpm.cmd`, "C:\\uv\\uvx.exe"]);
	const e = { ...env, Path: `C:\\Git\\usr\\bin;${NODEJS};C:\\uv` };
	assert.equal(resolveWindowsCommand("pnpm", { env: e, cwd: "C:\\work", isFile }), `${NODEJS}\\pnpm.CMD`);
	assert.equal(resolveWindowsCommand("uvx", { env: e, cwd: "C:\\work", isFile }), "C:\\uv\\uvx.EXE");
	// 带路径的命令同口径：先补扩展名，原样只作兜底
	const rel = fsOf(["C:\\work\\node_modules\\.bin\\mcp-x", "C:\\work\\node_modules\\.bin\\mcp-x.cmd"]);
	assert.equal(resolveWindowsCommand("node_modules\\.bin\\mcp-x", { env, cwd: "C:\\work", isFile: rel }), "C:\\work\\node_modules\\.bin\\mcp-x.CMD");
});

test("[#9] 只有无扩展名文件时仍兜底命中（既有行为不回归）", () => {
	const isFile = fsOf([`${NODEJS}\\npx`, "C:\\tools\\runner"]);
	assert.equal(resolveWindowsCommand("npx", { env, cwd: "C:\\work", isFile }), `${NODEJS}\\npx`);
	assert.equal(resolveWindowsCommand("C:\\tools\\runner", { env, isFile }), "C:\\tools\\runner");
	const p = planSpawn("npx", ["a"], { platform: "win32", env, cwd: "C:\\work", isFile });
	assert.deepEqual(p, { command: `${NODEJS}\\npx`, args: ["a"], extra: {}, resolved: `${NODEJS}\\npx`, shim: false });
});
