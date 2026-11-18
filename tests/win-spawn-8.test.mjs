/**
 * 审计 6：Windows .cmd 垫片 spawn——PATHEXT 解析、cmd.exe /d /s /c 包裹、参数转义（含空格 / 引号）。
 * 转义向量已与 cross-spawn（lib/util/escape.js）逐条对拍过（14 个参数 × 单 / 双重转义，0 差异），这里固化下来。
 * 非 Windows 上测的是纯函数（平台 / 环境 / 文件存在判断注入）；真机 Windows 上还要过一轮真实 npx / uvx 的 verify。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { escapeArgument, escapeCommand, planSpawn, resolveWindowsCommand } = await import(pathToFileURL(join(pluginRoot, "lib/win-spawn.js")).href);
const { McpConnection } = await import(pathToFileURL(join(pluginRoot, "lib/mcp-client.js")).href);

const VECTORS = [
	["plain", false, '^"plain^"'],
	["plain", true, '^^^"plain^^^"'],
	["with space", false, '^"with^ space^"'],
	['he said "hi"', false, '^"he^ said^ \\^"hi\\^"^"'],
	['he said "hi"', true, '^^^"he^^^ said^^^ \\^^^"hi\\^^^"^^^"'],
	["a&b|c", false, '^"a^&b^|c^"'],
	["trail\\", false, '^"trail\\\\^"'],
	["C:\\Program Files\\x\\", false, '^"C:\\Program^ Files\\x\\\\^"'],
	['back\\"slash', false, '^"back\\\\\\^"slash^"'],
	["%PATH%", false, '^"^%PATH^%^"'],
	["!bang!", false, '^"^!bang^!^"'],
	["", false, '^"^"'],
	["中文 参数", false, '^"中文^ 参数^"'],
	["^caret", true, '^^^"^^^^caret^^^"']
];

test("[#8 审计 6] 参数 / 命令转义与 cross-spawn 一致", () => {
	for (const [arg, dbl, want] of VECTORS) assert.equal(escapeArgument(arg, dbl), want, JSON.stringify([arg, dbl]));
	assert.equal(escapeCommand("C:\\Program Files\\nodejs\\npx.cmd"), "C:\\Program^ Files\\nodejs\\npx.cmd");
});

const winEnv = { Path: "C:\\nodejs;\"C:\\Program Files\\uv\"", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
const files = new Set(["C:\\nodejs\\npx.CMD", "C:\\Program Files\\uv\\uvx.EXE", "C:\\work\\node_modules\\.bin\\mcp-x.CMD", "C:\\tools\\run.bat"]);
const isFile = (p) => files.has(p);

test("[#8 审计 6] PATHEXT 解析：PATH 大小写不敏感、带引号目录、cwd 优先、显式扩展名 / 路径", () => {
	assert.equal(resolveWindowsCommand("npx", { env: winEnv, cwd: "C:\\work", isFile }), "C:\\nodejs\\npx.CMD");
	assert.equal(resolveWindowsCommand("uvx", { env: winEnv, cwd: "C:\\work", isFile }), "C:\\Program Files\\uv\\uvx.EXE");
	assert.equal(resolveWindowsCommand("node_modules\\.bin\\mcp-x", { env: winEnv, cwd: "C:\\work", isFile }), "C:\\work\\node_modules\\.bin\\mcp-x.CMD");
	assert.equal(resolveWindowsCommand("C:\\tools\\run.bat", { env: winEnv, isFile }), "C:\\tools\\run.bat");
	assert.equal(resolveWindowsCommand("nope", { env: winEnv, cwd: "C:\\work", isFile }), null);
});

test("[#8 审计 6] spawn 计划：.cmd 走 cmd.exe /d /s /c + 逐参转义 + verbatim；.exe 直起；非 Windows 原样", () => {
	const p = planSpawn("npx", ["-y", "@scope/server", "C:\\My Docs\\a b.txt", 'q"uote'], { platform: "win32", env: winEnv, cwd: "C:\\work", isFile });
	assert.equal(p.shim, true);
	assert.equal(p.command, "C:\\Windows\\system32\\cmd.exe");
	assert.deepEqual(p.args.slice(0, 3), ["/d", "/s", "/c"]);
	assert.equal(p.args[3], '"C:\\nodejs\\npx.CMD ^"-y^" ^"@scope/server^" ^"C:\\My^ Docs\\a^ b.txt^" ^"q\\^"uote^""');
	assert.deepEqual(p.extra, { windowsVerbatimArguments: true });
	const shim = planSpawn("node_modules\\.bin\\mcp-x", ["a b"], { platform: "win32", env: winEnv, cwd: "C:\\work", isFile });
	assert.match(shim.args[3], /\^\^\^"a\^\^\^ b\^\^\^"/, "node_modules/.bin 垫片双重转义");
	const exe = planSpawn("uvx", ["mcp-server-x", "--dir", "C:\\a b"], { platform: "win32", env: winEnv, cwd: "C:\\work", isFile });
	assert.deepEqual(exe, { command: "C:\\Program Files\\uv\\uvx.EXE", args: ["mcp-server-x", "--dir", "C:\\a b"], extra: {}, resolved: "C:\\Program Files\\uv\\uvx.EXE", shim: false });
	const miss = planSpawn("nope", ["x"], { platform: "win32", env: winEnv, cwd: "C:\\work", isFile });
	assert.equal(miss.command, "nope", "解析不出：原样交给 spawn，让它报原始错误");
	assert.deepEqual(planSpawn("npx", ["a b"], { platform: "linux" }), { command: "npx", args: ["a b"], extra: {}, resolved: null, shim: false });
});

test("[#8 审计 6] spawn 阶段错误原文带进连接失败信息（verify 看得到）", async () => {
	const c = new McpConnection({ transport: "stdio", command: "definitely-not-a-command-8", args: [], env: {}, cwd: "" }, { connectTimeoutMs: 3000 });
	await assert.rejects(() => c.connect(), (e) => /无法启动子进程/.test(e.message) && /ENOENT/.test(e.message));
	await c.close();
});

test("[#8 审计 6] 真机 Windows：真实 .cmd（路径带空格）+ 空格 / 引号 / 元字符参数原样到达", { skip: process.platform !== "win32" }, async () => {
	const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { spawnSync } = await import("node:child_process");
	const dir = mkdtempSync(join(tmpdir(), "win spawn "));
	mkdirSync(join(dir, "bin dir"), { recursive: true });
	const echo = join(dir, "echo-args.js");
	writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
	writeFileSync(join(dir, "bin dir", "echo-args.cmd"), `@"${process.execPath}" "${echo}" %*\r\n`);
	const args = ["plain", "with space", 'he said "hi"', "a&b|c", "100%", "trail\\", "中文"];
	const plan = planSpawn("echo-args", args, { env: { ...process.env, PATH: join(dir, "bin dir") + ";" + process.env.PATH } });
	assert.equal(plan.shim, true);
	const r = spawnSync(plan.command, plan.args, { encoding: "utf8", windowsHide: true, ...plan.extra });
	assert.deepEqual(JSON.parse(r.stdout), args, r.stderr);
	rmSync(dir, { recursive: true, force: true });
});
