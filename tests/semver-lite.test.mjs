/**
 * check:host 的 peer 范围覆盖判断：与 npm semver 在本仓库用到的写法上保持一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { satisfies } = await import(pathToFileURL(join(pluginRoot, "scripts/lib/semver-lite.mjs")).href);

// 本仓库 peerDependencies 的真实写法
const PEER = "^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1 || ^0.2.0-rc.2 || ^0.2.2-rc.1";

test("已列出的 rc 匹配", () => {
	assert.equal(satisfies("0.2.2-rc.1", PEER), true);
	assert.equal(satisfies("0.2.0-rc.2", PEER), true);
	assert.equal(satisfies("0.2.2-rc.5", PEER), true, "同号段更高的 rc 也算");
});

test("新号段的 rc 不匹配（f16ad7e 的 CI 失败就是这个）", () => {
	assert.equal(satisfies("0.2.3-rc.1", PEER), false);
	assert.equal(satisfies("0.2.2-rc.1", "^0.2.0-rc.2"), false);
});

test("正式版按 caret 匹配，跨 minor 不匹配", () => {
	assert.equal(satisfies("0.2.2", PEER), true);
	assert.equal(satisfies("0.2.9", PEER), true);
	assert.equal(satisfies("0.3.0", PEER), false);
	assert.equal(satisfies("4.1.0", "^4.0.1"), true);
	assert.equal(satisfies("5.0.0", "^4.0.1"), false);
});

test("其他写法", () => {
	assert.equal(satisfies("1.2.3", "1.2.3"), true);
	assert.equal(satisfies("1.2.4", "~1.2.3"), true);
	assert.equal(satisfies("1.3.0", "~1.2.3"), false);
	assert.equal(satisfies("1.5.0", ">=1.2.0 <2.0.0"), true);
	assert.equal(satisfies("2.0.0", ">=1.2.0 <2.0.0"), false);
	assert.equal(satisfies("0.0.3", "^0.0.2"), false);
	assert.equal(satisfies("not-a-version", PEER), false);
});
