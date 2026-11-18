/**
 * 插件卸载时的清理：
 *   - 预热与定时备份的定时器登记成 ctx.effect，卸载时清掉；总开关关闭时根本不起
 *   - 卸载时断开所有 MCP 上游（stdio 档是子进程）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-apply-teardown-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");

const load = (file) => import(pathToFileURL(join(pluginRoot, file)).href);
const { apply } = await load("lib/index.js");
const { McpRuntime } = await load("lib/mcp.js");

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

/** 记录每个 effect 的标签与卸载函数的假 ctx。 */
const makeCtx = () => {
	const effects = [];
	const ctx = {
		effects,
		skills: { list: async () => [], get: async () => undefined },
		tools: { register: () => () => {} },
		webServer: { register: () => () => {} },
		systemPrompt: { section: () => () => {} },
		effect: (fn, label) => {
			const d = fn();
			const dispose = () => (typeof d === "function" ? d() : undefined);
			effects.push({ label, dispose });
			return dispose;
		},
		get: () => null,
		logger: { info: () => {}, warn: () => {} },
		interval: () => () => {},
		on: () => () => {}
	};
	return ctx;
};
const labels = (ctx) => ctx.effects.map((e) => e.label);

// 统计 closeAll 被调了几次
let closeAllCalls = 0;
const originalCloseAll = McpRuntime.prototype.closeAll;
McpRuntime.prototype.closeAll = async function (...args) {
	closeAllCalls += 1;
	return originalCloseAll.apply(this, args);
};

// 统计还活着的定时器：只数本测试期间由 apply 起的那几个
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const liveIntervals = new Set();
globalThis.setInterval = (...a) => {
	const t = realSetInterval(...a);
	liveIntervals.add(t);
	return t;
};
globalThis.clearInterval = (t) => {
	liveIntervals.delete(t);
	return realClearInterval(t);
};

try {
	console.log("\n[1] 正常启用");
	{
		const ctx = makeCtx();
		apply(ctx, {});
		const got = labels(ctx);
		for (const label of ["dsh-studio: registry warm-up", "dsh-studio: scheduled backup", "dsh-studio: mcp runtime"]) {
			assert(got.includes(label), `登记了 effect「${label}」`);
		}
		assert(liveIntervals.size === 1, "定时备份起了 1 个 interval");
		const before = closeAllCalls;
		// 宿主卸载：按登记的逆序跑所有 disposer
		const results = ctx.effects.slice().reverse().map((e) => e.dispose());
		await Promise.all(results);
		assert(liveIntervals.size === 0, "卸载后定时备份的 interval 已清掉");
		assert(closeAllCalls === before + 1, "卸载时调用了一次 McpRuntime.closeAll");
		const runtimeDispose = ctx.effects.find((e) => e.label === "dsh-studio: mcp runtime").dispose;
		assert(typeof runtimeDispose()?.then === "function", "MCP 的卸载函数返回 promise，宿主可以等它");
	}

	console.log("\n[2] 总开关关闭");
	{
		const ctx = makeCtx();
		apply(ctx, { enabled: false });
		const got = labels(ctx);
		assert(!got.includes("dsh-studio: scheduled backup"), "enabled:false 时不起定时备份");
		assert(!got.includes("dsh-studio: registry warm-up"), "enabled:false 时不做 registry 预热");
		assert(liveIntervals.size === 0, "enabled:false 时没有遗留 interval");
		await Promise.all(ctx.effects.map((e) => e.dispose()));
	}
} finally {
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
	McpRuntime.prototype.closeAll = originalCloseAll;
	rmSync(fakeHome, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`\n${failed} 项失败`);
	process.exit(1);
}
console.log("\n全部通过");
// apply 还挂着 unref 过的定时器与后台预热，显式退出
process.exit(0);
