/**
 * mcp_update_check 的来源判定与版本比对（lib/mcp-upstream.js）。
 *
 * 全本地：npm registry 与 git ls-remote 都注入 stub，不联网；唯一真跑的是本地
 * git init/commit 造的临时仓库（那是被测逻辑要读的东西本身）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkServerUpdates, probeServerSource } from "../lib/mcp-upstream.js";

const tmp = (name) => mkdtempSync(path.join(os.tmpdir(), "dsh-studio-" + name + "-"));
const json = (file, value) => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value));
};

/** 造一个装了 npm 包的 node_modules 树 */
function npmFixture(root, pkg, version) {
	json(path.join(root, "node_modules", pkg, "package.json"), { name: pkg, version });
	return path.join(root, "node_modules", pkg, "bin", "cli.mjs");
}

/** 造一个真有 origin 与 HEAD 的本地仓库 */
function gitFixture(root) {
	mkdirSync(root, { recursive: true });
	const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	writeFileSync(path.join(root, "README.md"), "x\n");
	git("add", ".");
	git("commit", "-qm", "init");
	git("remote", "add", "origin", "https://github.com/example/app.git");
	return root;
}

const stubFetch = (version) => async () => new Response(JSON.stringify({ version }), { status: 200, headers: { "content-type": "application/json" } });
const stub404 = async () => new Response("{}", { status: 404 });

test("npm 型：node_modules/<pkg> 定源，比 registry latest", async () => {
	const root = tmp("npm");
	const entry = { name: "pkg-server", transport: "stdio", command: process.execPath, args: [npmFixture(root, "rea-agents", "6.8.0")] };
	const probe = probeServerSource(entry);
	assert.equal(probe.via, "npm");
	assert.equal(probe.pkg, "rea-agents");
	assert.equal(probe.localVersion, "6.8.0");

	const behind = await checkServerUpdates([entry], { fetchImpl: stubFetch("6.9.0"), lsRemote: async () => assert.fail("npm 型不该走 git") });
	assert.equal(behind[0].status, "behind");
	assert.equal(behind[0].remoteVersion, "6.9.0");

	const latest = await checkServerUpdates([entry], { fetchImpl: stubFetch("6.8.0"), lsRemote: async () => "" });
	assert.equal(latest[0].status, "latest");

	const unpublished = await checkServerUpdates([entry], { fetchImpl: stub404, lsRemote: async () => "" });
	assert.equal(unpublished[0].status, "unknown-source");
	assert.match(unpublished[0].note, /npm 上没有这个包/);
	rmSync(root, { recursive: true, force: true });
});

test("npm 型：scoped 包名与 pnpm 布局都能定源", () => {
	const root = tmp("scoped");
	const entry = { name: "s", transport: "stdio", command: process.execPath, args: [npmFixture(root, "@scope/tool", "1.2.3")] };
	const probe = probeServerSource(entry);
	assert.equal(probe.pkg, "@scope/tool");
	assert.equal(probe.localVersion, "1.2.3");
	rmSync(root, { recursive: true, force: true });
});

test("git 型：cwd 的 .git origin 与 HEAD 被读出来，sha 不同即有新版", async () => {
	const root = tmp("git");
	gitFixture(root);
	const entry = { name: "git-server", transport: "stdio", command: process.execPath, args: [path.join(root, "srv.mjs")], cwd: root };
	const probe = probeServerSource(entry);
	assert.equal(probe.via, "git");
	assert.equal(probe.dir, root);

	const remote = "a".repeat(40);
	const behind = await checkServerUpdates([entry], { fetchImpl: async () => assert.fail("git 型不该走 registry"), lsRemote: async (repo, ref) => {
		assert.equal(repo, "https://github.com/example/app");
		assert.equal(ref, "");
		return remote;
	} });
	assert.equal(behind[0].status, "behind");
	assert.equal(behind[0].source, "https://github.com/example/app");
	assert.equal(behind[0].remoteVersion, "aaaaaaa");

	// 本地 HEAD 与远端一致 → 最新
	const local = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const latest = await checkServerUpdates([entry], { fetchImpl: async () => assert.fail(), lsRemote: async () => local });
	assert.equal(latest[0].status, "latest");
	rmSync(root, { recursive: true, force: true });
});

test("notes 型：备注里的 owner/repo@sha 定源，短 sha 用前缀比", async () => {
	const entry = {
		name: "launcher",
		transport: "stdio",
		command: process.execPath,
		args: [path.join(os.tmpdir(), "does-not-exist", "launcher.cjs")],
		notes: "GitHub Fanqi89/dsh-craft-anything@e5abcb2 的启动定义（inline launcher）"
	};
	const probe = probeServerSource(entry);
	assert.equal(probe.via, "notes");
	assert.equal(probe.repo, "https://github.com/Fanqi89/dsh-craft-anything");
	assert.equal(probe.localSha, "e5abcb2");

	const same = await checkServerUpdates([entry], { fetchImpl: async () => assert.fail(), lsRemote: async () => "e5abcb2" + "0".repeat(33) });
	assert.equal(same[0].status, "latest");

	const behind = await checkServerUpdates([entry], { fetchImpl: async () => assert.fail(), lsRemote: async () => "668cb2d" + "0".repeat(33) });
	assert.equal(behind[0].status, "behind");
	assert.equal(behind[0].remoteVersion, "668cb2d");
});

test("备注里没有仓库线索的本地目录落 unknown-source，不当成 repo 误判", () => {
	const root = tmp("local");
	const entry = {
		name: "baimiao",
		transport: "stdio",
		command: process.execPath,
		args: ["mcp/local-mcp.mjs"],
		cwd: root,
		notes: "本地工具箱：PDF/Office/图片/GIF/视频处理 + 云端 OCR"
	};
	assert.equal(probeServerSource(entry), null);
	rmSync(root, { recursive: true, force: true });
});

test("远程 HTTP 端点落 unknown-source 并说明原因", async () => {
	const entries = [{ name: "remote", transport: "streamable-http", url: "https://example.com/mcp" }];
	const results = await checkServerUpdates(entries, { fetchImpl: async () => assert.fail(), lsRemote: async () => assert.fail() });
	assert.equal(results[0].status, "unknown-source");
	assert.match(results[0].note, /远程 HTTP/);
});

test("单个失败不中断全量，失败项带原因", async () => {
	const root = tmp("mixed");
	const gitRoot = gitFixture(root);
	const okEntry = { name: "ok-git", transport: "stdio", command: process.execPath, args: [path.join(gitRoot, "a.mjs")], cwd: gitRoot };
	const badEntry = { name: "bad-git", transport: "stdio", command: process.execPath, args: [path.join(os.tmpdir(), "nope", "b.mjs")], notes: "see example-org/example-repo@1234567" };
	const entries = [okEntry, badEntry, { name: "http", transport: "streamable-http", url: "https://example.com/mcp" }];
	const results = await checkServerUpdates(entries, {
		fetchImpl: async () => assert.fail(),
		lsRemote: async (repo) => {
			if (repo.includes("example-repo")) throw new Error("ls-remote 超时");
			return "b".repeat(40);
		}
	});
	assert.equal(results.length, 3);
	assert.equal(results.find((r) => r.name === "ok-git").status, "behind");
	assert.equal(results.find((r) => r.name === "bad-git").status, "failed");
	assert.match(results.find((r) => r.name === "bad-git").note, /ls-remote 超时/);
	assert.equal(results.find((r) => r.name === "http").status, "unknown-source");
	rmSync(root, { recursive: true, force: true });
});
