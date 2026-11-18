/**
 * 第 0 项：内建 MCP 守卫在真 cordis 上的回归。
 *
 * 真机失效根因：`ctx.get("mcpManager")` 返回 cordis 的 traced proxy，proxy 上的 `.ctx` 是调用方
 * （dsh-studio）的 context，旧实现据此认出的「manager owner fiber」其实是本插件自己，写入一律放行。
 * 这里用真 cordis（devDependency 4.1.0）起一个与 dsh-mcp-manager 0.2.2-rc.3 同形的 Service
 * （provide "mcpManager"、`config.servers` 带 get()、init 里自己挂 internal/config 校验），
 * 再按宿主 configEditor.edit 的写法调 `fiber.resolveConfig(next)`——与 Settings 保存同一层。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context, Service } from "@deepseek-ai/cordis";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { installBuiltinMcpGuard, unwrapService } = await import(pathToFileURL(join(pluginRoot, "lib/builtin-mcp-guard.js")).href);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

class McpServerManager extends Service {
	static inject = [];
	constructor(ctx, raw) {
		super(ctx, "mcpManager");
		this.ownerContext = ctx;
		let current = { ...(raw?.servers ?? {}) };
		this.config = { servers: { get: () => current, set: (v) => (current = v) } };
	}
	*[Service.init]() {
		const owner = this.ctx.fiber;
		this.ctx.on("internal/config", (fiber, next) => {
			const raw = next();
			if (fiber !== owner) return raw;
			for (const name of Object.keys(raw?.servers ?? {})) if (!/^[a-z][\w-]*$/i.test(name)) throw new Error(`servers.${name}: bad name`);
			return raw;
		});
	}
	list() {
		return Object.entries(this.config.servers.get()).map(([name, e]) => ({ name, configured: true, status: { state: e.enabled === false ? "disabled" : "ready" } }));
	}
}

async function boot() {
	const root = new Context();
	const managerFiber = root.plugin(McpServerManager, { servers: { builtinA: { transport: "stdio", command: "node", enabled: true } } });
	await managerFiber.await?.();
	let guard;
	let studioFiber;
	const studio = {
		name: "dsh-studio",
		inject: ["mcpManager"],
		apply(ctx) {
			studioFiber = ctx.fiber;
			guard = installBuiltinMcpGuard(ctx, { logger: quiet });
		}
	};
	const f = root.plugin(studio);
	await f.await?.();
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(guard, "studio 插件起来了");
	return { root, managerFiber, guard, studioFiber };
}

test("[#8-0] 真 cordis：proxy 的 .ctx 是调用方——复现根因", async () => {
	const { root, managerFiber, studioFiber, guard } = await boot();
	assert.ok(guard);
	// 直接复现：经 proxy 读 .ctx.fiber 得到的是 studio 自己
	let seenViaProxy;
	const probe = { inject: ["mcpManager"], apply(ctx) { seenViaProxy = { leaked: ctx.mcpManager.ctx.fiber === ctx.fiber, raw: unwrapService(ctx.mcpManager).ctx.fiber } } };
	const pf = root.plugin(probe);
	await pf.await?.();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(seenViaProxy.leaked, true, "traced proxy 的 .ctx 指向调用方（旧实现据此误认 owner）");
	// （不直接 assert.equal 两个 fiber：断言失败时格式化 cordis 对象会碰到反射守卫）
	assert.equal(seenViaProxy.raw === managerFiber.ctx.fiber, true, "剥掉 proxy 后拿到 manager 自己的 fiber");
	assert.equal(studioFiber === managerFiber.ctx.fiber, false);
});

test("[#8-0] 真 cordis：Settings 写路径（resolveConfig）新增被拒、计数 +1；删除 / 停用放行；非 manager 不管", async () => {
	const { managerFiber, guard, studioFiber } = await boot();
	const before = guard.status();
	assert.equal(before.guard, "armed");
	assert.equal(before.identity, "instance", "按 owner fiber 认出 manager");
	assert.equal(before.baseline, "manager");
	assert.deepEqual(before.servers.map((s) => s.name), ["builtinA"]);

	const base = { builtinA: { transport: "stdio", command: "node", enabled: true } };
	assert.throws(
		() => managerFiber.resolveConfig({ servers: { ...base, "guard-probe": { transport: "stdio", command: "node", enabled: true } } }),
		(err) => err instanceof Error && err.message.startsWith("MCP 由 dsh-studio 统一管理") && err.message.includes("guard-probe"),
		"新增被拒并返回既有提示文案"
	);
	const after = guard.status();
	assert.equal(after.rejected, before.rejected + 1, "rejected +1");
	assert.deepEqual(after.lastRejected.names, ["guard-probe"]);
	assert.equal(after.lastJudged.by, "instance");

	assert.throws(() => managerFiber.resolveConfig({ servers: { builtinA: { ...base.builtinA, command: "evil" } } }), /mcp_register/, "修改被拒");
	assert.doesNotThrow(() => managerFiber.resolveConfig({ servers: { builtinA: { ...base.builtinA, enabled: false } } }), "停用放行");
	assert.doesNotThrow(() => managerFiber.resolveConfig({ servers: {} }), "删除放行");
	assert.doesNotThrow(() => managerFiber.resolveConfig({ servers: { ...base, x: { transport: "stdio", command: "node", enabled: false } } }), "以停用态新增放行");
	assert.equal(guard.status().rejected, before.rejected + 2);
	// 本插件自己的配置解析不受影响
	assert.doesNotThrow(() => studioFiber.resolveConfig({ servers: { anything: { url: "x" } } }));
	// manager 自己的校验仍在链上
	assert.throws(() => managerFiber.resolveConfig({ servers: { "9bad": { transport: "stdio", command: "node", enabled: false } } }), /bad name/);
});
