/**
 * DSH 内建 MCP 管理让位：「禁用写路径」+「只读镜像」。
 *
 * 宿主里能新增 MCP server 的写路径有两条：
 *   1. 原生 dsh-mcp-client 行（cordis.patch.yml）——由 profile-mcp.js 的对账负责：新出现的活行
 *      自动接管（导入注册表 + 原生行写 disabled），已接管的行漂移了按 autoReassert 补回。
 *   2. dsh-mcp-manager（Settings → MCP，`config.servers`）——本模块负责。manager 自己在
 *      `internal/config` 瀑布钩子里做校验（抛错 = 拒绝这次配置写入），cordis 的瀑布没有按插件过滤，
 *      所以本插件挂同一个钩子，就能在 manager 的配置写入里拦下「新增 / 修改 / 启用」server 的那部分，
 *      提示改用 mcp_register / mcp_unregister；「删除」与「停用（enabled:false）」放行——让位
 *      是不再新增分叉，不是把用户锁在一份删不掉的旧配置里。
 *
 * 只读镜像：读 manager 的 list() 与 `mcp-manager/status` 事件，给 mcp_list / 目录路由报
 * 「内建那边还有哪些 server、哪些和注册表同名（双份注入）」，不替用户删内建条目。
 *
 * 一律 fail-open：认不出 manager 的 fiber、拿不到配置形态、任何异常——放行并记日志。
 * 拦错一次写入的代价（用户在 Settings 里改不动别的设置）远大于漏拦一次的代价（多一个分叉，
 * 镜像里能看见）。
 *
 * 第 0 项（真机失效根因）：`ctx.get("mcpManager")` 拿到的是 cordis 的 traced proxy，
 * proxy 上读 `.ctx` 返回的是**调用方**（dsh-studio 自己）的 context（tracker.property = "ctx"），
 * 于是旧实现的 ownerFiber() 恒等于本插件自己的 fiber，manager 的 fiber 永远对不上、写入一律放行
 * （rejected 恒 0）。现在先经 `Symbol.for("cordis.original")` 取出原对象再读它的 ctx.fiber，
 * 且「等于本插件自己的 fiber」一律不认作 owner；再加按 runtime.callback（manager 类本身）认的一层。
 * 写路径：Settings 保存 → settings.mutate → configEditor.edit → fiber.resolveConfig(next) 跑
 * `internal/config` 瀑布，抛错即整次写入被拒、cordis.patch.yml 不落盘（0.2.2-rc.3 源码核实）。
 *
 * 诚实边界（插件够不着的）：
 *   - fiber 识别与瀑布触发时机按 0.2.2-rc.3 源码写，并用真 cordis 复现了 proxy 行为做回归；
 *   - 本插件晚于 manager 加载、又拿不到 manager 实例时，看到的第一份配置只能当基线放行；
 *   - Settings 页面本身是宿主的 UI，按钮不会变灰，用户点保存后才看到拒绝原因；
 *   - 其它插件经 `ctx.mcpManager.register()` 贡献的 server 不走配置写入，拦不到，只进镜像。
 */

const MANAGER_NAME = /McpServerManager|mcp-?manager/i;
/** cordis 的 traced proxy 用这个全局 symbol 交出原对象（cordis/src/utils.ts symbols.original）。 */
const ORIGINAL = Symbol.for("cordis.original");

/** 剥掉 cordis 的 traced proxy；不是 proxy 就原样返回。 */
export function unwrapService(value) {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value ?? null;
	try {
		return value[ORIGINAL] ?? value;
	} catch {
		return value;
	}
}
const REJECT_HINT = "MCP 由 dsh-studio 统一管理：请用 mcp_register / mcp_unregister（或 dsh-studio 设置页）增删改 MCP server；这里只允许删除或停用内建条目";

const stable = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** servers 字典里取一个可比较的纯对象（manager 的配置可能是带 get() 的活引用）。 */
function plainServers(raw) {
	let servers = raw?.servers;
	if (servers && typeof servers.get === "function") {
		try {
			servers = servers.get();
		} catch {
			return null;
		}
	}
	if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return null;
	return servers;
}

/**
 * 判断一次 manager 配置写入要不要拦。纯函数，便于测试。
 * @returns {{block: false} | {block: true, names: string[]}}
 */
export function judgeManagerWrite(baseline, next) {
	if (next === null) return { block: false };
	const before = baseline ?? {};
	const names = [];
	for (const [name, entry] of Object.entries(next)) {
		const old = before[name];
		if (entry && typeof entry === "object" && entry.enabled === false) continue; // 停用 / 以停用态新增：放行
		if (old !== undefined && stable(old) === stable(entry)) continue; // 没变
		names.push(name);
	}
	return names.length === 0 ? { block: false } : { block: true, names };
}

/**
 * @param {object} ctx 插件上下文（ctx.on / ctx.get / ctx.logger）
 * @param {{lock?: boolean, logger?: object}} [options]
 */
export function installBuiltinMcpGuard(ctx, options = {}) {
	const logger = options.logger ?? ctx?.logger;
	const lock = options.lock !== false;
	const state = {
		hooked: false,
		baseline: null,
		baselineFrom: null,
		rejected: 0,
		lastRejected: null,
		statuses: new Map(),
		studioNames: new Set(),
		judged: 0,
		lastJudged: null
	};
	const manager = () => {
		try {
			return typeof ctx?.get === "function" ? ctx.get("mcpManager") ?? null : null;
		} catch {
			return null;
		}
	};
	const selfFiber = () => {
		try {
			return ctx?.fiber ?? null;
		} catch {
			return null;
		}
	};
	/** manager 的 owner fiber；认不出或只认出本插件自己（proxy 泄漏）时为 null。 */
	const ownerFiber = () => {
		const raw = unwrapService(manager());
		if (raw === null) return null;
		const self = selfFiber();
		for (const candidate of [raw.ctx?.fiber, raw.ownerContext?.fiber]) {
			if (candidate && typeof candidate === "object" && candidate !== self) return candidate;
		}
		return null;
	};
	const managerClass = () => {
		const raw = unwrapService(manager());
		const ctor = raw?.constructor;
		return typeof ctor === "function" && ctor !== Object ? ctor : null;
	};
	/** 这次判定靠什么认出 manager：instance（owner fiber）/ class（runtime.callback）/ name（名字兜底）。 */
	const identify = (fiber) => {
		if (fiber === null || fiber === undefined || fiber === selfFiber()) return null;
		const owner = ownerFiber();
		if (owner !== null) return fiber === owner ? "instance" : null;
		const ctor = managerClass();
		if (ctor !== null && fiber?.runtime?.callback === ctor) return "class";
		const name = fiber?.name ?? fiber?.runtime?.name ?? fiber?.runtime?.callback?.name ?? "";
		return typeof name === "string" && MANAGER_NAME.test(name) ? "name" : null;
	};
	const identityMode = () => (ownerFiber() !== null ? "instance" : managerClass() !== null ? "class" : "name");
	const currentBaseline = () => {
		const live = plainServers(manager()?.config);
		if (live !== null) return { servers: live, from: "manager" };
		return state.baseline === null ? null : { servers: state.baseline, from: state.baselineFrom };
	};

	const disposers = [];
	if (lock && typeof ctx?.on === "function") {
		try {
			disposers.push(
				ctx.on("internal/config", (fiber, next) => {
					const raw = typeof next === "function" ? next() : next;
					try {
						const how = identify(fiber);
						if (how === null) return raw;
						const servers = plainServers(raw);
						if (servers === null) return raw;
						state.judged += 1;
						state.lastJudged = { at: new Date().toISOString(), by: how };
						const base = currentBaseline();
						if (base === null) {
							// 第一次见、又拿不到 manager 实例：只能当基线（诚实边界之一）
							state.baseline = servers;
							state.baselineFrom = "first-seen";
							return raw;
						}
						const verdict = judgeManagerWrite(base.servers, servers);
						if (!verdict.block) {
							state.baseline = servers;
							state.baselineFrom = "accepted";
							return raw;
						}
						state.rejected += 1;
						state.lastRejected = { at: new Date().toISOString(), names: verdict.names };
						logger?.warn?.(`[dsh-studio] 已拦下内建 MCP 管理的写入（${verdict.names.join("、")}）：${REJECT_HINT}`);
						throw new Error(`${REJECT_HINT}（被拦：${verdict.names.join("、")}）`);
					} catch (error) {
						if (error instanceof Error && error.message.startsWith(REJECT_HINT)) throw error;
						logger?.warn?.("[dsh-studio] 内建 MCP 守卫出错，已放行：" + (error instanceof Error ? error.message : String(error)));
						return raw;
					}
				})
			);
			state.hooked = true;
		} catch (error) {
			logger?.warn?.("[dsh-studio] 内建 MCP 守卫挂不上（宿主没有 internal/config 钩子？），只做镜像：" + String(error));
		}
	}
	if (typeof ctx?.on === "function") {
		try {
			disposers.push(
				ctx.on("mcp-manager/status", (name, status) => {
					if (typeof name === "string") state.statuses.set(name, typeof status?.state === "string" ? status.state : "unknown");
				})
			);
		} catch {
			/* 没有这个事件就只靠 list() */
		}
	}

	return {
		/** 注册表里现有的 server 名（index 每次重挂 MCP 时更新），用来报同名冲突。 */
		setStudioNames(names) {
			state.studioNames = new Set(names);
		},
		/** 只读镜像。 */
		status() {
			const m = manager();
			let servers = [];
			try {
				if (m && typeof m.list === "function") servers = m.list().map((s) => ({ name: s.name, configured: s.configured === true, state: s.status?.state ?? "unknown" }));
			} catch {
				servers = [];
			}
			if (servers.length === 0 && state.statuses.size > 0) servers = [...state.statuses].map(([name, st]) => ({ name, configured: null, state: st }));
			const active = servers.filter((s) => s.state !== "disabled");
			return {
				available: m !== null || state.statuses.size > 0,
				guard: !lock ? "off" : state.hooked ? "armed" : "unavailable",
				identity: identityMode(),
				judged: state.judged,
				lastJudged: state.lastJudged,
				baseline: currentBaseline()?.from ?? null,
				servers,
				conflicts: active.filter((s) => state.studioNames.has(s.name)).map((s) => s.name),
				rejected: state.rejected,
				lastRejected: state.lastRejected
			};
		},
		dispose() {
			for (const d of disposers.splice(0)) {
				try {
					d?.();
				} catch {
					/* ignore */
				}
			}
		}
	};
}
