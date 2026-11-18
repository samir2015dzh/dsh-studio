/**
 * 原生 MCP 条目的接管对账（lib/profile-mcp.js）。
 *
 * 覆盖三件事：
 *   1. setProfileOverride 幂等、且不动文件其余部分（含 CRLF）
 *   2. reconcileProfileMcp 能发现「注册表说已接管、文件里原生行却活着」的漂移
 *   3. bundle 型的接管写 profile 层覆盖，不写 node_modules
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBundlePatchPath, reconcileProfileMcp, setProfileOverride } from "../lib/profile-mcp.js";

const tmp = (name) => mkdtempSync(path.join(os.tmpdir(), "dsh-studio-" + name + "-"));

/** 最小注册表：只实现 reconcileProfileMcp 用到的那两个方法。 */
function fakeStore(servers) {
	const state = { version: 1, idleTimeoutMinutes: 5, toolDescriptionMaxLength: 150, servers: [...servers] };
	return {
		state,
		async load() {
			return state;
		},
		async save() {}
	};
}

const PROFILE_PATCH = `- insert:
    - id: mcp-demo
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: demo
        transport: stdio
        command: "node"
`;

const BUNDLE_PATCH = `- insert:
    - id: mcp-bundled
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: bundled
        transport: stdio
        command: "node"
`;

test("setProfileOverride 追加覆盖块并保留原有 insert 块", () => {
	const dir = tmp("ov-add");
	const file = path.join(dir, "cordis.patch.yml");
	writeFileSync(file, PROFILE_PATCH);

	const result = setProfileOverride(PROFILE_PATCH, { rowId: "mcp-bundled", disabled: true });
	assert.equal(result.changed, true);
	assert.ok(result.text.includes('- id: mcp-demo'), "原有 insert 块必须逐字保留");
	assert.ok(result.text.includes("- id: mcp-bundled\n  disabled: true"), "新覆盖块要写在顶层");

	rmSync(dir, { recursive: true, force: true });
});

test("setProfileOverride 幂等：写两次正文一模一样", () => {
	const first = setProfileOverride(PROFILE_PATCH, { rowId: "mcp-bundled", disabled: true });
	const second = setProfileOverride(first.text, { rowId: "mcp-bundled", disabled: true });
	assert.equal(second.changed, false);
	assert.equal(second.text, first.text, "重复写不该让文件越长越长");
});

test("setProfileOverride 保留 CRLF 换行", () => {
	const crlf = PROFILE_PATCH.replace(/\n/g, "\r\n");
	const result = setProfileOverride(crlf, { rowId: "mcp-bundled", disabled: true });
	assert.ok(result.text.includes("\r\n- id: mcp-bundled\r\n  disabled: true"));
	assert.equal(result.text.replace(/\r\n/g, "").includes("\n"), false, "不该混入裸 LF");
});

test("setProfileOverride 的 config 必须嵌套写，不能摊到顶层", () => {
	const result = setProfileOverride("", {
		rowId: "mcp-wincu",
		disabled: false,
		config: { mode: "full", toolPreset: "lite" }
	});
	// loader 按 id 覆盖时是 target[key] = value 整键替换，config 摊平到顶层会变成
	// 三个孤立键（mode / toolPreset 根本不在 entry 上），什么都覆盖不到
	assert.ok(result.text.includes("- id: mcp-wincu\n  config:\n    mode: full\n    toolPreset: lite"), result.text);
	assert.equal(/^- {2}(mode|toolPreset):/m.test(result.text), false, "不许把 config 子键写到顶层");
});

test("isBundlePatchPath 认出 node_modules", () => {
	assert.equal(isBundlePatchPath("C:/Users/x/.dsh/profiles/desktop/node_modules/foo/cordis.patch.yml"), true);
	assert.equal(isBundlePatchPath("C:\\Users\\x\\node_modules\\foo\\cordis.patch.yml"), true);
	assert.equal(isBundlePatchPath("C:/Users/x/.dsh/profiles/desktop/cordis.patch.yml"), false);
});

test("对账发现漂移：注册表说已接管，文件里原生行却活着", async () => {
	const dir = tmp("drift");
	const profilePatch = path.join(dir, "cordis.patch.yml");
	writeFileSync(profilePatch, PROFILE_PATCH);

	const store = fakeStore([
		{
			name: "demo",
			tier: "on-demand",
			transport: "stdio",
			command: "node",
			args: [],
			env: {},
			desiredNative: "disabled",
			source: { kind: "profile", rowId: "mcp-demo", patchPath: profilePatch, nativeDisabled: true }
		}
	]);

	const result = await reconcileProfileMcp(store, [profilePatch], {
		overridePath: profilePatch,
		autoReassert: false
	});

	assert.equal(result.drifted.length, 1, "缓存说已接管、文件里没有 disabled，必须报漂移");
	assert.equal(result.drifted[0].name, "demo");
	assert.equal(result.drifted[0].state, "active");
	assert.equal(store.state.servers[0].source.nativeDisabled, false, "缓存值要被纠正，不能继续谎报");

	rmSync(dir, { recursive: true, force: true });
});

test("对账自动补回：profile 型原地插 disabled", async () => {
	const dir = tmp("reassert-inplace");
	const profilePatch = path.join(dir, "cordis.patch.yml");
	writeFileSync(profilePatch, PROFILE_PATCH);

	const store = fakeStore([
		{
			name: "demo",
			tier: "on-demand",
			transport: "stdio",
			command: "node",
			args: [],
			env: {},
			desiredNative: "disabled",
			source: { kind: "profile", rowId: "mcp-demo", patchPath: profilePatch, nativeDisabled: true }
		}
	]);

	const result = await reconcileProfileMcp(store, [profilePatch], {
		overridePath: profilePatch,
		autoReassert: true
	});

	assert.equal(result.reasserted.length, 1);
	assert.equal(result.reasserted[0].via, "in-place");
	assert.match(readFileSync(profilePatch, "utf8"), /disabled: true/);
	assert.equal(store.state.servers[0].source.reassertPendingRestart, true, "改回文件要等重启才生效");

	rmSync(dir, { recursive: true, force: true });
});

test("对账自动补回：bundle 型写 profile 覆盖，不改 node_modules", async () => {
	const dir = tmp("reassert-bundle");
	const profilePatch = path.join(dir, "cordis.patch.yml");
	const bundlePatch = path.join(dir, "node_modules", "some-bundle", "cordis.patch.yml");
	mkdirSync(path.dirname(bundlePatch), { recursive: true });
	writeFileSync(profilePatch, "");
	writeFileSync(bundlePatch, BUNDLE_PATCH);
	const bundleBefore = readFileSync(bundlePatch, "utf8");

	const store = fakeStore([
		{
			name: "bundled",
			tier: "on-demand",
			transport: "stdio",
			command: "node",
			args: [],
			env: {},
			desiredNative: "disabled",
			source: { kind: "profile", rowId: "mcp-bundled", patchPath: bundlePatch, nativeDisabled: true }
		}
	]);

	const result = await reconcileProfileMcp(store, [bundlePatch], {
		overridePath: profilePatch,
		autoReassert: true
	});

	assert.equal(result.reasserted.length, 1);
	assert.equal(result.reasserted[0].via, "override");
	assert.match(readFileSync(profilePatch, "utf8"), /- id: mcp-bundled\n {2}disabled: true/);
	assert.equal(readFileSync(bundlePatch, "utf8"), bundleBefore, "node_modules 里的文件一个字节都不该动");

	rmSync(dir, { recursive: true, force: true });
});

test("对账反向检查：整条原生行被删也要报出来", async () => {
	const dir = tmp("missing");
	const profilePatch = path.join(dir, "cordis.patch.yml");
	writeFileSync(profilePatch, "# 什么都没有\n");

	const store = fakeStore([
		{
			name: "gone",
			tier: "on-demand",
			transport: "stdio",
			command: "node",
			args: [],
			env: {},
			desiredNative: "disabled",
			source: { kind: "profile", rowId: "mcp-gone", patchPath: profilePatch, nativeDisabled: true }
		}
	]);

	const result = await reconcileProfileMcp(store, [profilePatch], {
		overridePath: profilePatch,
		autoReassert: true
	});

	assert.equal(result.drifted.length, 1);
	assert.equal(result.drifted[0].state, "missing");

	rmSync(dir, { recursive: true, force: true });
});

test("历史接管迁移：从 patch 导入且已切 on-demand 的条目补上接管意图", async () => {
	const dir = tmp("migrate");
	const profilePatch = path.join(dir, "cordis.patch.yml");
	writeFileSync(profilePatch, PROFILE_PATCH);

	// 旧版本接管留下的样子：tier 切了 on-demand，但没有 desiredNative
	const store = fakeStore([
		{
			name: "demo",
			tier: "on-demand",
			transport: "stdio",
			command: "node",
			args: [],
			env: {},
			source: { kind: "profile", rowId: "mcp-demo", patchPath: profilePatch, nativeDisabled: false }
		}
	]);

	await reconcileProfileMcp(store, [profilePatch], { overridePath: profilePatch, autoReassert: false });

	assert.equal(store.state.servers[0].desiredNative, "disabled", "老条目要能继续享受接管对账");
	rmSync(dir, { recursive: true, force: true });
});

test("没接管意图的条目只刷新来源，不动档位", async () => {
	const dir = tmp("no-intent");
	const profilePatch = path.join(dir, "cordis.patch.yml");
	writeFileSync(profilePatch, PROFILE_PATCH);

	const store = fakeStore([
		{
			name: "demo",
			tier: "eager",
			transport: "stdio",
			command: "node",
			args: [],
			env: {},
			source: { kind: "profile", rowId: "mcp-demo", patchPath: "/somewhere/else.yml", nativeDisabled: false }
		}
	]);

	const result = await reconcileProfileMcp(store, [profilePatch], {
		overridePath: profilePatch,
		autoReassert: true
	});

	assert.equal(store.state.servers[0].tier, "eager", "没有接管意图就不该碰档位");
	assert.equal(store.state.servers[0].source.patchPath, profilePatch, "来源路径要跟着 patch 走");
	assert.equal(result.imported.length, 0, "已登记的不该重复导入");
	assert.equal(result.drifted.length, 0, "没意图就不是漂移");

	rmSync(dir, { recursive: true, force: true });
});
