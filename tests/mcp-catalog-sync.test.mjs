/**
 * 工具缓存自动刷新：任何一次真实连接观测到的清单都要写回注册表，
 * 以及「多久没核对就主动验一次」的节流逻辑。
 *
 * 全部用内存 store + 不存在的上游地址，不联网、不读真机注册表、不拉起真 MCP 进程。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { revalidateCatalog, syncCatalogFromObserved } from "../lib/mcp.js";

/** 内存注册表：load 返回深拷贝，upsert 记录每次写入。 */
function memStore(servers) {
	const state = { version: 1, idleTimeoutMinutes: 5, toolDescriptionMaxLength: 150, servers };
	return {
		state,
		writes: [],
		async load() {
			return { ...state, servers: state.servers.map((s) => ({ ...s })) };
		},
		async save() {},
		async upsert(input) {
			this.writes.push(input);
			const index = state.servers.findIndex((s) => s.name === input.name);
			if (index >= 0) state.servers[index] = { ...state.servers[index], ...input };
			else state.servers.push(input);
		}
	};
}

const tools = (...names) => names.map((name) => ({ name, description: "d" }));
const entryOf = (store, name) => store.state.servers.find((s) => s.name === name);

test("清单变了：写入新清单并打上校验时间", async () => {
	const store = memStore([{ name: "alpha", tier: "on-demand", transport: "stdio", command: "x", tools: tools("a", "b") }]);
	const result = await syncCatalogFromObserved(store, "alpha", tools("a", "b", "c"));
	assert.equal(result.changed, true);
	assert.equal(result.before, 2);
	assert.equal(result.after, 3);
	const entry = entryOf(store, "alpha");
	assert.deepEqual(entry.tools.map((t) => t.name), ["a", "b", "c"]);
	assert.match(entry.toolsCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("清单没变但没时间戳：只补时间戳，不重写旧描述", async () => {
	const store = memStore([
		{ name: "alpha", tier: "on-demand", transport: "stdio", command: "x", tools: [{ name: "a", description: "老描述" }] }
	]);
	const result = await syncCatalogFromObserved(store, "alpha", tools("a"));
	assert.equal(result.changed, false);
	assert.equal(result.reason, "stamped");
	assert.equal(entryOf(store, "alpha").tools[0].description, "老描述");
	assert.match(entryOf(store, "alpha").toolsCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("清单没变且已有时间戳：一次都不写盘（避免每轮调用都改文件）", async () => {
	const stamp = "2026-01-01T00:00:00.000Z";
	const store = memStore([
		{ name: "alpha", tier: "on-demand", transport: "stdio", command: "x", tools: tools("a"), toolsCheckedAt: stamp }
	]);
	const result = await syncCatalogFromObserved(store, "alpha", tools("a"));
	assert.equal(result.changed, false);
	assert.equal(store.writes.length, 0);
	assert.equal(entryOf(store, "alpha").toolsCheckedAt, stamp);
});

test("空清单 / 未登记：都不动注册表", async () => {
	const store = memStore([{ name: "alpha", tier: "on-demand", transport: "stdio", command: "x", tools: tools("a") }]);
	assert.equal((await syncCatalogFromObserved(store, "alpha", [])).reason, "empty");
	assert.equal((await syncCatalogFromObserved(store, "ghost", tools("a"))).reason, "unregistered");
	assert.equal(store.writes.length, 0);
});

test("复核节流：刚核对过的条目不会被再连一次", async () => {
	const store = memStore([
		{
			name: "alpha",
			tier: "on-demand",
			transport: "streamable-http",
			url: "http://127.0.0.1:1/mcp",
			tools: tools("a"),
			toolsCheckedAt: new Date().toISOString()
		}
	]);
	const results = await revalidateCatalog(store, { slot: () => ({}) }, { warn() {} });
	assert.deepEqual(results, []);
	assert.equal(store.writes.length, 0);
});

test("复核：从没核对过的 entry 会去问一次，连不上只记结果不抛", async () => {
	const store = memStore([
		{ name: "alpha", tier: "on-demand", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", tools: tools("a") }
	]);
	const warns = [];
	const results = await revalidateCatalog(store, { slot: () => ({}) }, { warn: (m) => warns.push(m) });
	assert.equal(results.length, 1);
	assert.equal(results[0].name, "alpha");
	assert.equal(results[0].reason, "error");
	assert.equal(warns.length, 1);
});

test("复核：超过节流窗口的条目同样会被问一次", async () => {
	const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
	const store = memStore([
		{
			name: "alpha",
			tier: "on-demand",
			transport: "streamable-http",
			url: "http://127.0.0.1:1/mcp",
			tools: tools("a"),
			toolsCheckedAt: old
		}
	]);
	const results = await revalidateCatalog(store, { slot: () => ({}) }, { warn() {} });
	assert.equal(results.length, 1);
	assert.equal(results[0].reason, "error");
});

test("复核：disabled 档一条都不碰", async () => {
	const store = memStore([
		{ name: "off", tier: "disabled", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", tools: tools("a") }
	]);
	const results = await revalidateCatalog(store, { slot: () => ({}) }, { warn() {} });
	assert.deepEqual(results, []);
});

test("同数重名顶替也算变化：[a,b,c] 对 [a,b,b] 必须判变并写盘", async () => {
	const store = memStore([
		{
			name: "alpha",
			tier: "on-demand",
			transport: "stdio",
			command: "x",
			tools: tools("a", "b", "c"),
			toolsCheckedAt: "2026-01-01T00:00:00.000Z"
		}
	]);
	const result = await syncCatalogFromObserved(store, "alpha", tools("a", "b", "b"));
	assert.equal(result.changed, true);
	assert.equal(store.writes.length, 1);
});

test("复核成功路径：试连拿到新清单即同步落盘并回填运行时槽位", async () => {
	const store = memStore([
		{ name: "alpha", tier: "on-demand", transport: "streamable-http", url: "http://127.0.0.1:9/mcp", tools: tools("x") }
	]);
	const slot = {};
	let closed = false;
	const fakeConn = {
		async connect() {},
		async listTools() {
			return tools("x", "y");
		},
		async close() {
			closed = true;
		}
	};
	const results = await revalidateCatalog(store, { slot: () => slot }, { warn() {} }, { connect: async () => fakeConn });
	assert.equal(results.length, 1);
	assert.equal(results[0].changed, true);
	assert.deepEqual(slot.tools.map((t) => t.name), ["x", "y"]);
	assert.equal(closed, true);
	const entry = entryOf(store, "alpha");
	assert.deepEqual(entry.tools.map((t) => t.name), ["x", "y"]);
	assert.match(entry.toolsCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("复核失败也节流：刚失败过的条目不会被立刻再连一次", async () => {
	const store = memStore([
		{ name: "down", tier: "on-demand", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", tools: tools("a") }
	]);
	const runtime = { slot: () => ({}) };
	const logger = { warn() {} };
	const first = await revalidateCatalog(store, runtime, logger);
	assert.equal(first.length, 1);
	assert.equal(first[0].reason, "error");
	assert.match(entryOf(store, "down").toolsCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
	const second = await revalidateCatalog(store, runtime, logger);
	assert.deepEqual(second, []);
});
