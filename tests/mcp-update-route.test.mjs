/**
 * /api/dsh-studio/mcp/update-check 路由：只为面板「检查更新」按钮服务。
 *
 * 上游查询注入成 stub，不联网；store 用内存假实现，不读真机注册表。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMcpRoutes } from "../lib/mcp.js";

const fakeStore = {
	async load() {
		return {
			idleTimeoutMinutes: 5,
			toolDescriptionMaxLength: 150,
			servers: [
				{ name: "alpha", transport: "stdio", tier: "on-demand", command: process.execPath, args: [] },
				{ name: "beta", transport: "stdio", tier: "on-demand", command: process.execPath, args: [] }
			]
		};
	}
};

/** 造一个 loopback 请求；host 与 headers 都能按用例改。 */
function fakeRequest({ method = "GET", url = "/", remoteAddress = "127.0.0.1", host = "127.0.0.1:51710" } = {}) {
	return { method, url, socket: { remoteAddress }, headers: { host } };
}

/** 记录 handler 的回应。 */
function fakeResponse() {
	const out = { status: 0, body: null };
	return {
		out,
		writeHead(status) {
			out.status = status;
		},
		end(text) {
			out.body = typeof text === "string" && text !== "" ? JSON.parse(text) : null;
		}
	};
}

const route = (options = {}) => {
	const routes = buildMcpRoutes(fakeStore, {}, {
		checkUpdates: async (targets) =>
			targets.map((t) => ({
				name: t.name,
				via: "npm",
				source: "example-pkg",
				localVersion: "1.0.0",
				remoteVersion: t.name === "alpha" ? "1.1.0" : "1.0.0",
				status: t.name === "alpha" ? "behind" : "latest",
				note: ""
			})),
		...options
	});
	return routes.find((r) => r.path === "/api/dsh-studio/mcp/update-check");
};

const call = async (handler, req) => {
	const res = fakeResponse();
	await handler(req, res);
	return res.out;
};

test("GET 查全部：返回每个服务器的状态与汇总", async () => {
	const out = await call(route().handler, fakeRequest({ url: "/api/dsh-studio/mcp/update-check" }));
	assert.equal(out.status, 200);
	assert.equal(out.body.ok, true);
	assert.equal(out.body.servers.length, 2);
	assert.equal(out.body.servers.find((s) => s.name === "alpha").status, "behind");
	assert.equal(out.body.servers.find((s) => s.name === "alpha").remoteVersion, "1.1.0");
	assert.equal(out.body.totals.total, 2);
	assert.equal(out.body.totals.behind, 1);
	assert.equal(out.body.totals.latest, 1);
	assert.equal(out.body.totals.determinable, 2);
});

test("GET ?name= 只查一个", async () => {
	const out = await call(route().handler, fakeRequest({ url: "/api/dsh-studio/mcp/update-check?name=beta" }));
	assert.equal(out.status, 200);
	assert.equal(out.body.servers.length, 1);
	assert.equal(out.body.servers[0].name, "beta");
	assert.equal(out.body.totals.total, 1);
});

test("未登记的 name → 404", async () => {
	const out = await call(route().handler, fakeRequest({ url: "/api/dsh-studio/mcp/update-check?name=nope" }));
	assert.equal(out.status, 404);
	assert.match(out.body.error, /未登记/);
});

test("非 GET → 405", async () => {
	const out = await call(route().handler, fakeRequest({ method: "POST", url: "/api/dsh-studio/mcp/update-check" }));
	assert.equal(out.status, 405);
});

test("非 loopback 请求一律 403（这条路由也不许跨站触发联网）", async () => {
	const out = await call(route().handler, fakeRequest({ url: "/api/dsh-studio/mcp/update-check", remoteAddress: "10.1.2.3" }));
	assert.equal(out.status, 403);
});
