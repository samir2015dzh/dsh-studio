/**
 * Windows 上调 .cmd：Node ≥ 20.12.2 直接 spawn 会 EINVAL，必须经 cmd.exe。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { commandInvocation } = await import(pathToFileURL(join(pluginRoot, "scripts/lib/cmd-invocation.mjs")).href);

test("非 Windows / 非 .cmd：原样调用", () => {
	assert.deepEqual(commandInvocation("/usr/bin/dsh", ["--profile", "a"], { platform: "linux" }), {
		command: "/usr/bin/dsh",
		args: ["--profile", "a"],
		options: {},
	});
	assert.equal(commandInvocation("C:\\x\\dsh.exe", [], { platform: "win32" }).command, "C:\\x\\dsh.exe");
});

test("Windows .cmd：经 cmd.exe /d /s /c，每个参数加引号", () => {
	const inv = commandInvocation("C:\\Program Files\\DSH\\dsh.cmd", ["plugin", "add", "file:C:\\a b\\x.tgz"], {
		platform: "win32",
		comspec: "C:\\Windows\\system32\\cmd.exe",
	});
	assert.equal(inv.command, "C:\\Windows\\system32\\cmd.exe");
	assert.deepEqual(inv.args, ["/d", "/s", "/c", '""C:\\Program Files\\DSH\\dsh.cmd" "plugin" "add" "file:C:\\a b\\x.tgz""']);
	assert.equal(inv.options.windowsVerbatimArguments, true);
});

test("参数带引号或换行：拒绝而不是拼出歧义命令", () => {
	assert.throws(() => commandInvocation("x.cmd", ['a"b'], { platform: "win32" }));
	assert.throws(() => commandInvocation("x.cmd", ["a\nb"], { platform: "win32" }));
});

test("真实 .cmd（路径带空格）：参数原样到达", { skip: process.platform !== "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-cmd-inv-"));
	try {
		const dir = join(root, "with space");
		mkdirSync(dir);
		const bin = join(dir, "echo-args.cmd");
		writeFileSync(bin, "@echo off\r\necho [%~1][%~2][%~3]\r\n");
		const inv = commandInvocation(bin, ["--profile", "verify-x", "file:C:\\a b\\x.tgz"]);
		const out = execFileSync(inv.command, inv.args, { encoding: "utf8", ...inv.options }).trim();
		assert.equal(out, "[--profile][verify-x][file:C:\\a b\\x.tgz]");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
