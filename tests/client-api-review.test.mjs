import { test } from "node:test";
import assert from "node:assert/strict";
import { Api } from "../src/client/api.js";

test("[review S3] JSON POST 精简保留已有路径、参数与精确 body", async () => {
	const cases = [
		["save", ["n", "text", { expectedMtime: 0, overwrite: true }], "skill", { name: "n", content: "text", expectedMtime: 0, overwrite: true }],
		["save", ["n", "text"], "skill", { name: "n", content: "text" }],
		["setPolicy", ["n", { enabled: false }], "policy", { name: "n", enabled: false }],
		["trashSkill", ["n"], "trash", { name: "n" }],
		["restoreTrash", ["i"], "restore", { id: "i" }],
		["purgeTrash", ["i", "n"], "purge", { id: "i", name: "n" }],
		["snapshotCreate", ["l"], "snapshot", { label: "l" }],
		["snapshotRestore", ["i", true, []], "snapshot/restore", { id: "i", dryRun: true, pathMap: [] }],
		["snapshotPrune", [3], "snapshot/prune", { keep: 3 }],
		["snapshotDelete", ["i"], "snapshot/delete", { id: "i" }],
		["syncConfig", [{}], "sync", {}],
		["syncPush", ["i", "webdav"], "sync/push", { snapshotId: "i", channel: "webdav" }],
		["syncPull", ["webdav", "l"], "sync/pull", { channel: "webdav", label: "l" }],
		["snapshotSchedule", [{ enabled: false }], "snapshot/schedule", { enabled: false }],
		["skillImport", ["file"], "skill-import", { source: "file" }],
		["skillExport", ["n", ""], "skill-export", { name: "n" }],
		["snapshotTransfer", [{ action: "export" }], "snapshot/transfer", { action: "export" }],
		["extractConfig", [{ enabled: false }], "extract-config", { enabled: false }],
		["extractCandidate", ["i", { body: "b" }], "extract-candidate", { id: "i", body: "b" }],
		["extractAccept", [["i"]], "extract-accept", { ids: ["i"] }],
		["extractReject", [["i"]], "extract-reject", { ids: ["i"] }],
		["mcpCorruptAck", [], "mcp/registry-corrupt", { confirm: true }],
		["mcpUpsert", [{ name: "n" }], "mcp", { name: "n" }],
		["mcpReload", ["n"], "mcp/reload", { name: "n" }],
		["mcpPrefetch", ["n"], "mcp/prefetch", { name: "n" }],
		["mcpTools", ["n", "include", []], "mcp/tools", { name: "n", mode: "include", names: [] }],
		["mcpTakeover", ["n"], "mcp/takeover", { name: "n" }],
		["mcpSettings", [{}], "mcp/settings", {}],
		["mcpCredential", ["n", "env", "K"], "mcp/credential", { name: "n", kind: "env", key: "K" }],
		["distillRun", [], "distill/run", {}],
		["distillDecide", ["i", "requeue", "why"], "distill/decide", { id: "i", decision: "requeue", reason: "why" }]
	];
	const original = globalThis.fetch;
	let last;
	globalThis.fetch = async (path, init) => { last = { path, init }; return { ok: true, json: async () => ({ ok: true }) }; };
	try {
		const api = new Api();
		for (const [method, args, path, body] of cases) {
			await api[method](...args);
			assert.deepEqual(last, { path: "/api/dsh-studio/" + path, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } }, method);
		}
		await api.extractRun();
		assert.deepEqual(last.init, { method: "POST" }, "原无 body 请求不能变成 JSON 空对象");
		await api.syncConfig();
		assert.equal(last.init, undefined, "无 patch 仍 GET");
		await api.distillSource("a/b");
		assert.equal(last.path, "/api/dsh-studio/distill/source?id=a%2Fb");
		globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: "冲突", code: "SKILL_CHANGED" }) });
		await assert.rejects(api.save("n", "text"), (error) => error.status === 409 && error.code === "SKILL_CHANGED" && error.message === "冲突");
	} finally {
		globalThis.fetch = original;
	}
});
