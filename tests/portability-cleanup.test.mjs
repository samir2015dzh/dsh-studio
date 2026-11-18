/**
 * 回归：portability.mjs 提前 finish()（PATH 上没有 dsh）时，cleanup 不能删 profiles。
 *
 * 事故（fe65563）：profile 尚未赋值，path.join(home, 'profiles', '') 退化成 profiles 根，
 * recursive 删除把本机所有 profile 一起清掉。这里全程用伪 home，跑完逐个确认 profile 还在。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const script = join(pluginRoot, "scripts/portability.mjs");
const PROFILES = ["default", "work", "verify-someone-else"];

/** 最小插件目录：npm pack 快，不依赖本仓库的 node_modules。 */
function makePlugin(root) {
	const dir = join(root, "plugin");
	mkdirSync(dir);
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "portability-cleanup-fixture", version: "0.0.1", main: "index.js", files: ["index.js"] }, null, 2),
	);
	writeFileSync(join(dir, "index.js"), "export default {}\n");
	return dir;
}

function seedProfiles(dshHome) {
	for (const name of PROFILES) {
		const dir = join(dshHome, "profiles", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), `{"name":"${name}"}\n`);
	}
}

function assertProfilesIntact(dshHome) {
	assert.ok(existsSync(dshHome), `DSH_HOME 被删了：${dshHome}`);
	for (const name of PROFILES) {
		assert.ok(existsSync(join(dshHome, "profiles", name, "package.json")), `profile 被删了：${name}`);
	}
}

/** 用伪 home 跑一遍「没有 dsh」的验证；envPatch 里值为 undefined 的键会被删掉。 */
function runWithoutDsh(root, plugin, envPatch, cwd = plugin) {
	const env = { ...process.env, ...envPatch };
	for (const [key, value] of Object.entries(envPatch)) if (value === undefined) delete env[key];
	const result = spawnSync(
		process.execPath,
		[script, "--skip-audit", "--skip-stability", "--json", "--dsh", join(root, "definitely-not-dsh"), "--cwd", plugin],
		{ encoding: "utf8", cwd, env, timeout: 120_000 },
	);
	assert.equal(result.status, 0, `应 exit 0，实际 ${result.status}\n${result.stdout.slice(-800)}\n${result.stderr.slice(-400)}`);
	const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"), result.stdout.lastIndexOf("}") + 1));
	assert.equal(report.skippedLive, true, "应标记 skippedLive");
	return report;
}

test("显式 DSH_HOME：提前收尾不删任何 profile，tarball 照常清理", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-portability-cleanup-"));
	try {
		const plugin = makePlugin(root);
		const dshHome = join(root, "dsh-home");
		seedProfiles(dshHome);
		runWithoutDsh(root, plugin, { DSH_HOME: dshHome });
		assertProfilesIntact(dshHome);
		assert.deepEqual(readdirSync(plugin).filter((f) => f.endsWith(".tgz")), [], "tarball 应被清理");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("未设 DSH_HOME：回落到 os.homedir()/.dsh，profile 不受影响", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-portability-cleanup-"));
	try {
		const plugin = makePlugin(root);
		const fakeHome = join(root, "home");
		seedProfiles(join(fakeHome, ".dsh"));
		// os.homedir()：POSIX 认 HOME，Windows 认 USERPROFILE，两个都指向伪 home
		runWithoutDsh(root, plugin, { DSH_HOME: undefined, HOME: fakeHome, USERPROFILE: fakeHome });
		assertProfilesIntact(join(fakeHome, ".dsh"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("隔离模式：脚本自己建的临时 DSH_HOME 收尾时要删掉，真实 DSH_HOME 不动", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-portability-cleanup-"));
	try {
		const plugin = makePlugin(root);
		const realHome = join(root, "real-dsh-home");
		seedProfiles(realHome);
		// 假 dsh：什么都失败、立刻退出，让脚本走完安装/启动段再正常收尾
		const isWin = process.platform === "win32";
		const fakeDsh = join(root, isWin ? "fake-dsh.cmd" : "fake-dsh");
		writeFileSync(fakeDsh, isWin ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		// mkdtemp 落在测试自己的临时目录里，方便确认有没有残留
		const tmp = join(root, "tmp");
		mkdirSync(tmp);
		const result = spawnSync(
			process.execPath,
			[script, "--skip-audit", "--skip-stability", "--json", "--timeout", "5", "--dsh", fakeDsh, "--cwd", plugin],
			{ encoding: "utf8", cwd: plugin, env: { ...process.env, DSH_HOME: realHome, TEMP: tmp, TMP: tmp, TMPDIR: tmp }, timeout: 120_000 },
		);
		assert.equal(result.status, 1, `假 dsh 应判未通过，实际 ${result.status}\n${result.stderr.slice(-400)}`);
		const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"), result.stdout.lastIndexOf("}") + 1));
		assert.deepEqual(report.cleanupLeftovers, [], "不应报告残留");
		assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith("dsh-verify-home-")), [], "临时 DSH_HOME 应被删掉");
		assertProfilesIntact(realHome);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("DSH_HOME 为空串：不会退化成相对路径去删当前目录下的 profiles", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-portability-cleanup-"));
	try {
		const plugin = makePlugin(root);
		const fakeHome = join(root, "home");
		seedProfiles(join(fakeHome, ".dsh"));
		// 当前目录下也放一套：空串 DSH_HOME 旧写法会解析成相对路径 `profiles`
		const cwd = join(root, "cwd");
		seedProfiles(cwd);
		runWithoutDsh(root, plugin, { DSH_HOME: "", HOME: fakeHome, USERPROFILE: fakeHome }, cwd);
		assertProfilesIntact(join(fakeHome, ".dsh"));
		assertProfilesIntact(cwd);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
