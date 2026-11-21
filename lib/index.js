/**
 * dsh-studio — skill (技能) 可视化与编辑器. Host half.
 *
 * Mounts the skillmgr_* tools, the /api/dsh-studio route family the
 * web settings panel talks to, and a system-prompt announcement.
 *
 * The panel shows TWO merged catalogs:
 *   1. Filesystem skills — scanned directly by ./scanner.js from the standard
 *      roots (project .dsh/skills & .agents/skills, user ~/.dsh/skills &
 *      ~/.agents/skills), including one level of nested bundles such as
 *      ~/.agents/skills/superpowers/<name>. This is necessary because on the
 *      web host plane the registry's filesystem provider is disabled by
 *      design (per-agent presets own local discovery), so `ctx.skills` alone
 *      would show only runtime/bundled skills.
 *   2. Registry skills — everything `ctx.skills.list()` reports that is not
 *      the filesystem provider (runtime contributions, bundled skills, other
 *      providers), so the panel stays consistent with what DSH actually
 *      loads.
 *
 * Editing and toggling write back to the underlying SKILL.md (or <name>.md)
 * file reported by the scanner / registry:
 *   - full-body edit: save the whole file verbatim (frontmatter + body)
 *   - enable/disable: line-level frontmatter surgery on the two invocation
 *     keys (`disable-model-invocation`, `user-invocable`), preserving every
 *     other line of the user's frontmatter untouched.
 *
 * The filesystem provider (where active) watches the skill roots and
 * invalidates itself on file changes, so a save is picked up by DSH without
 * a restart. The scanner itself re-reads the files on every request.
 *
 * Safety: this plugin never accepts an arbitrary file path. All writes are
 * resolved from the scanner / registry's own candidate; only skills that
 * carry a real `path` are editable — runtime / bundled skills are read-only.
 * All routes are loopback-only and same-origin checked.
 *
 * 模块布局（本文件只剩装配：apply() 把下面各模块挂到宿主上）：
 *   - ./remember.js：「记住 X」请求：从原话猜落点，并把待确认的请求挂到下一轮。
 *   - ./plugin-meta.js：插件的静态信息：cordis 名字、依赖的服务、路由前缀、系统提示里的公告文案。
 *   - ./plugin-state.js：模块级的运行时句柄（模型通道、最近活跃的 agent）与依赖它们的小工具。
 *   - ./route-util.js：工具与路由共用的小工具：文本内容块、错误文案、JSON 请求体读写、路由错误包装。
 *   - ./skill-core.js：技能的读写核心：frontmatter 行级改写、文件系统与 registry 两份目录的合并、
 *   - ./skill-tools.js：面向模型的 skillmgr_* 工具：技能的列出 / 读取 / 保存 / 启停 / 导出、回收站、
 *   - ./extractor-api.js：提取功能的对外面：面向模型的提取工具，以及设置面板调用的提取路由。
 *   - ./routes.js：设置面板用的基础路由（/api/dsh-studio/*）：技能、回收站、快照、同步、生命周期、导入导出。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { applyDarwin } from "./darwin.js";
import { UserError } from "./errors.js";
import { extractBackoffMs } from "./extract-backoff.js";
import { ExtractorStore, isExtractRunning, shouldExtract } from "./extractor.js";
import {
	buildEagerTools,
	buildMcpCatalog,
	buildMcpRoutes,
	buildMcpTools,
	catalogCandidateServers,
	McpRuntime,
	McpStore,
	revalidateCatalog,
	storePath as mcpStorePath,
	SWEEP_INTERVAL_MS,
	syncCatalogFromObserved,
	visibleTools,
	warmCatalog
} from "./mcp.js";
import { installEvolutionHooks } from "./evolution-hooks.js";
import { buildEvolutionRoutes, buildEvolutionTools } from "./evolution-tools.js";
import { configureTelemetry, getTelemetry } from "./telemetry.js";
import { buildCatalogEvalRoutes, buildCatalogEvalTools, createCatalogWatch } from "./catalog-watch.js";
import { createGovernance } from "./governance.js";
import { buildGovernanceRoutes, buildGovernanceTools } from "./governance-tools.js";
import { createDistill } from "./distill.js";
import { buildDistillRoutes, buildDistillTools } from "./distill-tools.js";
import { createOptimizer, optimizerSkillRoots } from "./optimizer.js";
import { createStudioBackup } from "./studio-backup.js";
import { buildStudioBackupRoutes, buildStudioBackupTools } from "./studio-backup-tools.js";
import { createHostModel } from "./optimizer-model.js";
import { buildOptimizerRoutes, buildOptimizerTools } from "./optimizer-tools.js";
import { invalidateScanCache as invalidateSkillScanCache } from "./scanner.js";
import { applyVersionRetention, auditRegistryPresence, onSkillVersion, redactRegistryHistory, setVersionLogger } from "./versions.js";
import { installBuiltinMcpGuard } from "./builtin-mcp-guard.js";
import { migrateRegistry } from "./mcp-migrate.js";
import { runWithWriteContext } from "./write-context.js";
import { applyProfileOverride, disableNativeRow, isBundlePatchPath, profilePatchPath, reconcileProfileMcp } from "./profile-mcp.js";
import { runScheduledBackup } from "./snapshot.js";
import { guessRememberTarget, loadHandledRemember, savePendingRemember, takePendingRemember } from "./remember.js";
import { API, GUIDANCE, inject, name, SECTION_ORDER } from "./plugin-meta.js";
import { pluginState, runExtract } from "./plugin-state.js";
import { ErrorMsg } from "./route-util.js";
import {
	applyPolicy,
	assembleFile,
	getSkillDetail,
	listSkills,
	savePolicy,
	saveSkill,
	splitFrontmatter,
	warmRegistry
} from "./skill-core.js";
import {
	skillmgrExportTool,
	skillmgrGetTool,
	skillmgrListTool,
	skillmgrPolicyTool,
	skillmgrPullPendingTool,
	skillmgrPurgeTool,
	skillmgrRestoreTool,
	skillmgrSaveTool,
	skillmgrSnapshotListTool,
	skillmgrSnapshotRestoreTool,
	skillmgrSnapshotTool,
	skillmgrSnapshotTransferTool,
	skillmgrSyncTool,
	skillmgrTrashListTool,
	skillmgrTrashTool,
	skillmgrUpdateApplyTool,
	skillmgrUpdateCheckTool
} from "./skill-tools.js";
import { buildExtractorRoutes, buildExtractorTools } from "./extractor-api.js";
import { makeRoutes } from "./routes.js";
import { createEagerMount } from "./mcp-eager-mount.js";

/**
 * 定期复核工具清单的「看一眼」间隔。真正决定要不要连上游的是 revalidateCatalog 里的
 * 24 小时节流；这里只是多久检查一次要不要去问，挂在既有的 30 秒扫描 tick 上，
 * 不新增定时器（也就没有多一份要 dispose 的东西）。
 */
const CATALOG_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastCatalogCheckAt = 0;

/**
 * MCP 目录段的挂载守卫（N-08）。
 *
 * 目录构建是异步的，而挂载可能被连续触发两次（注册表短时间内变两次）。以前目录段分支
 * 直接在 then 里赋值 disposer：第一次的迟到构建会覆盖第二次已登记的 disposer，
 * 留下一份没人能卸的旧目录段。这里按「代次」判定：
 *   - 每次 mount 领一个新代次并释放上一代；
 *   - 构建回来时代次已过期（被新一代取代 / 被 dispose）就直接丢弃，连 section 都不建；
 *   - 构建返回 null 表示这一代没有目录段；构建失败也不许影响挂载方。
 * @param {{systemPrompt:{section:(spec:object)=>()=>void}}} ctx
 * @param {{name:string, order:number, build:()=>Promise<string|null>}} spec
 */
export function createMcpCatalogMount(ctx, { name, order, build }) {
	let generation = 0;
	let disposeCurrent;
	let active = false;
	const dispose = () => {
		active = false;
		generation += 1;
		if (disposeCurrent !== void 0) {
			disposeCurrent();
			disposeCurrent = void 0;
		}
	};
	const mount = () => {
		dispose();
		active = true;
		const mine = generation;
		build()
			.then((text) => {
				if (mine !== generation) return; // 过期：不登记，也就不会留下无主的段
				// interpolate:false —— 目录里是别人写的文字（备注、摘要、上游工具名、验证失败原因），其中出现 `{{ … }}`
				// 会被宿主当成提示词变量去解析，解析不了就整个系统提示渲染抛错
				disposeCurrent = text === null ? void 0 : ctx.systemPrompt.section({ name, order, text, interpolate: false });
			})
			.catch(() => {});
	};
	/** 只在当前挂着的时候重建（熔断 / 验证状态变了）；没挂（已卸载 / 没开公告）就什么都不做。 */
	const refresh = () => {
		if (active) mount();
	};
	return { mount, refresh, dispose, generation: () => generation };
}
/**
 * Mount the skill-manager tools, routes, and announcement.
 * @param ctx - host plugin context carrying skills/tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
function apply(ctx, config) {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	const extractStore = new ExtractorStore();
	// 进化地基：遥测（G4）与版本史（G2）都是旁路——写失败只丢统计 / 只记日志
	const telemetry = configureTelemetry({
		logger: ctx.logger,
		enabled: enabled && config?.telemetry?.enabled !== false,
		retentionDays: config?.telemetry?.retentionDays
	});
	setVersionLogger(ctx.logger);
	// MCP 按需加载：注册表 + 单例运行时（空闲回收见 lib/mcp.js）
	const mcpStore = new McpStore({ logger: ctx.logger });
	// ：mcp.* 配置——
	//   autoTakeover（默认开）新出现的原生 dsh-mcp-client 活行直接接管进注册表；
	//   lockBuiltinManager（默认开）拦下 Settings → MCP（dsh-mcp-manager）的新增 / 修改 / 启用；
	//   prefetchOnBoot（默认 "missing"）启动时只给「还没有工具缓存」的条目做一次验证握手，"off" 一个都不连；
	//   revalidateIdle（默认关）是否定期去连没被选中的 server 复核清单（开了就会产生「未选中却有连接」）；
	//   breaker {threshold, cooldownMs} 熔断参数。
	const mcpConfig = config?.mcp && typeof config.mcp === "object" ? config.mcp : {};
	const mcpRuntime = new McpRuntime(ctx.logger, { breaker: mcpConfig.breaker });
	const builtinGuard = enabled ? installBuiltinMcpGuard(ctx, { lock: mcpConfig.lockBuiltinManager !== false, logger: ctx.logger }) : null;
	if (builtinGuard !== null) ctx.effect?.(() => () => builtinGuard.dispose(), "dsh-studio: builtin mcp guard");
	const builtinStatus = () => builtinGuard?.status();
	/** 本插件注册的 eager MCP 工具名：遥测里它们由 McpRuntime.call 计时，宿主通知里要跳过。 */
	const studioEagerToolNames = new Set();
	// 任何一次真实连接（调用 / 加载 / eager / 上游 list_changed）都会把清单报上来，
	// 由这里写回注册表——所以缓存刷新不再依赖用户手动点「刷新工具」。
	mcpRuntime.onToolsObserved = (entry, tools) => syncCatalogFromObserved(mcpStore, entry.name, tools, ctx.logger);
	// · C：真实握手的结论回写注册表（verify 是运行时观测，不出版本记录）。
	// 结论没变时一小时内只写一次，免得每次重连都改文件。
	const verifyPersisted = new Map();
	mcpRuntime.onVerified = async (entry, verify) => {
		const last = verifyPersisted.get(entry.name);
		if (last !== undefined && last.status === verify.status && Date.now() - last.at < 60 * 60 * 1000) return;
		verifyPersisted.set(entry.name, { status: verify.status, at: Date.now() });
		await mcpStore.patchServer(entry.name, { verify });
		// 结论变了（未验证 → 已验证 / 失败）才需要重建目录段；同结论的定时补写不动提示词
		if (last === undefined || last.status !== verify.status) refreshCatalogSoon();
	};
	// 目录段是挂载那一刻的静态文本：熔断开合、验证结论变化都不会自己反映进去（熔断中的 server 一直挂在候选里，
	// 或者恢复之后「熔断中，不要调用」还留在提示词里）。状态一变就防抖重建一次。
	let catalogRefreshTimer;
	const refreshCatalogSoon = () => {
		if (catalogRefreshTimer !== void 0) return;
		catalogRefreshTimer = setTimeout(() => {
			catalogRefreshTimer = void 0;
			mcpCatalogMount.refresh();
		}, 1500);
		catalogRefreshTimer.unref?.();
	};
	mcpRuntime.onCatalogStale = () => refreshCatalogSoon();
	ctx.effect?.(() => () => {
		if (catalogRefreshTimer !== void 0) clearTimeout(catalogRefreshTimer);
		catalogRefreshTimer = void 0;
	}, "dsh-studio: mcp catalog refresh");
	let disposeTools;
	let disposeRoutes;
	let disposeSection;
	let disposeTimer;
	let disposeMcpEager;
	// 目录段走代次守卫（N-08）：迟到的构建不许覆盖新一代的 disposer
	const mcpCatalogMount = createMcpCatalogMount(ctx, {
		name: "plugin:dsh-studio:mcp",
		order: SECTION_ORDER + 1,
		build: () => buildMcpCatalog(mcpStore, mcpRuntime)
	});
	let disposeMcpSweep;
	let extractBusy = false;
	// 下面两组定时器都登记成 ctx.effect：插件被停用 / 重载时随 ctx 一起清掉。
	// 以前是裸 setTimeout / setInterval，重载一次就多留一份；总开关关掉时也照跑。
	// 启动后预热 registry 摘要缓存，避免第一次打开面板时等 ctx.skills.list()
	if (enabled) ctx.effect(() => {
		const warmTimer = setTimeout(() => {
			try {
				warmRegistry(ctx, process.cwd());
			} catch {
				/* 预热失败无所谓，请求时还会再试 */
			}
		}, 1500);
		warmTimer.unref?.();
		return () => clearTimeout(warmTimer);
	}, "dsh-studio: registry warm-up");
	// 定时备份：每 30 分钟问一次该不该跑，启动 1 分钟后先查一次
	if (enabled) ctx.effect(() => {
		let snapshotTimer;
		let firstTick;
		try {
			const tickSnapshot = () => {
				// 失败文案由 runScheduledBackup 自己打到 stderr（并转发 logger），
				// 这里不再只靠 ctx.logger?.warn?——那条路径在真机第 9 项里没有落到标准流。
				runScheduledBackup(Date.now(), { logger: ctx.logger })
					.then((result) => {
						if (result?.created !== void 0) ctx.logger?.info?.(`[dsh-studio] 定时备份完成：${result.created}（${result.fileCount} 个文件）`);
					})
					.catch(() => {
						/* 已由 runScheduledBackup 写出「定时备份失败」 */
					});
			};
			snapshotTimer = setInterval(tickSnapshot, 30 * 60 * 1000);
			snapshotTimer.unref?.();
			firstTick = setTimeout(tickSnapshot, 60 * 1000);
			firstTick.unref?.();
		} catch {
			/* 定时器起不来不影响手动备份 */
		}
		return () => {
			if (snapshotTimer !== void 0) clearInterval(snapshotTimer);
			if (firstTick !== void 0) clearTimeout(firstTick);
		};
	}, "dsh-studio: scheduled backup");
	// 卸载时断开所有 MCP 上游：stdio 档是子进程，不关就会在插件停用 / 重载后留着
	ctx.effect(
		// 返回 promise：宿主卸载 effect 时会等它，子进程确实退出后才算卸完
		() => () =>
			mcpRuntime.closeAll().catch(() => {
				/* 卸载路径上不抛 */
			}),
		"dsh-studio: mcp runtime"
	);
	/**
	 * 最近活跃的 agent：提取时用它解析 provider/model，从而直接走用户在 DSH
	 * 里配置的模型，插件不再单独保存 API key。
	 */
	// 下一轮开头主动确认「记住」请求：注入一次即清空，不反复追问
	if (typeof ctx.on === "function") {
		ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
			const out = await next();
			try {
				const pending = await takePendingRemember(ctx.logger);
				if (pending === null) return out;
				const target = typeof pending.target === "string" ? pending.target : null;
				const targetLabel =
					target === "agents" ? "偏好 / 规矩（写进 `~/.dsh/AGENTS.md`）" : target === "memory" ? "事实 / 环境（写进记忆库 retain）" : target === "skill" ? "方法 / 流程（落成 skill）" : null;
				const body = [
					"## 待处理的「记住」请求",
					"",
					"用户上一轮说过：「" + pending.text + "」。",
					"",
					"| 内容类型 | 放哪 | 生效方式 |",
					"|---|---|---|",
					"| 方法 / 流程（怎么做一件事） | skill | 提到相关场景时才加载 |",
					"| 偏好 / 规矩（以后都这样） | `~/.dsh/AGENTS.md` | 每轮常驻 |",
					"| 事实 / 环境（这台机器、这个项目的事实） | 记忆库 retain | 检索时取回 |",
					""
				];
				if (targetLabel !== null) {
					const example =
						target === "agents"
							? "记进 AGENTS.md 了：回答先给结论"
							: target === "memory"
								? "已存进记忆库：这台机器 JDK 是 8"
								: "已落成 skill：<name>，提相关场景时自动加载";
					body.push(
						`**已判定为${targetLabel}，直接落位，不要提问。** 落完用一句话告知用户即可，例如「${example}」。`,
						""
					);
				} else {
					body.push(
						"**这条同时像两类、或者分不出来，才问一句。** 一次只问这一句，例如「这条记成 skill（提专题会时自动加载），还是写进 AGENTS.md（每轮都生效）？」，不要自己替用户选。",
						""
					);
				}
				body.push(
					"落位动作：",
					"- skill → 调 skillmgr_extract_run，或直接写 `~/.agents/skills/<name>/SKILL.md`",
					"- AGENTS.md → 直接编辑 `~/.dsh/AGENTS.md`",
					"- 记忆 → 调当前配置的记忆服务写入工具",
					"- 用户说不用记 → 忽略，不要反复追问"
				);
				return { ...out, sections: [...(out.sections ?? []), { name: "plugin:dsh-studio:remember", text: body.join("\n") }] };
			} catch {
				return out;
			}
		});
	}

	pluginState.llm = ctx.llm ?? null;
	extractStore.dshAvailable = Boolean(pluginState.llm);
	if (typeof ctx.on === "function") {
		ctx.on("agent/created", (agent) => {
			if (agent) {
				pluginState.agent = agent;
			}
		});
	}
	/** 到点就跑一次提取；intervalMinutes 同时充当冷却窗口。force=true 时绕过它（每轮判定已通过）。 */
	// 连续失败次数与下次允许定时重试的时刻（见 lib/extract-backoff.js）
	let extractFailures = 0;
	let extractRetryAt = 0;
	const extractIfDue = async (preferredAgent = null, force = false, extra = {}) => {
		if (extractBusy || isExtractRunning()) return;
		// 上次失败后的等待期内，定时触发不重试；每轮判定通过的那次（force）不受限，它自带 5 分钟间隔
		if (!force && Date.now() < extractRetryAt) return;
		extractBusy = true;
		try {
			const cfg = await extractStore.load();
			if (!cfg.enabled) return;
			const minutes = cfg.intervalMinutes;
			if (minutes <= 0 && !force) return;
			const now = Date.now();
			const last = cfg.lastRunAt !== "" ? new Date(cfg.lastRunAt).getTime() : 0;
			if (!force && last !== 0 && now - last < minutes * 60 * 1000) return;
			const result = await runExtract(cfg, preferredAgent, extra);
			if (result.site) await extractStore.patch(result.site);
			extractFailures = 0;
			extractRetryAt = 0;
			ctx.logger?.info?.("[dsh-studio] extract: " + result.message);
		} catch (error) {
			extractFailures += 1;
			const waitMs = extractBackoffMs(extractFailures);
			extractRetryAt = Date.now() + waitMs;
			ctx.logger?.warn?.(
				"[dsh-studio] extract failed: " + ErrorMsg(error) + `（连续第 ${extractFailures} 次，${Math.round(waitMs / 60000)} 分钟后再试）`
			);
		} finally {
			extractBusy = false;
		}
	};

	/**
	 * 每轮先轻量判定值不值得总结（小 prompt，只要 YES/NO）。
	 * 判定至少间隔 90 秒，判定通过后的提取至少间隔 5 分钟。
	 */
	let lastJudge = 0;
	let lastTurnExtract = 0;
	const judgeThenExtract = async (preferredAgent) => {
		const now = Date.now();
		if (now - lastJudge < 90_000) return;
		lastJudge = now;
		if (extractBusy) return;
		try {
			const cfg = await extractStore.load();
			if (!cfg.enabled || cfg.autoPerTurn === false) return;
			const verdict = await shouldExtract(cfg, { llm: pluginState.llm, agent: preferredAgent, handledRemember: await loadHandledRemember() });
			if (verdict.error) {
				// 以前判定失败被吞成 NO，日志里看不出模型其实没答上来
				ctx.logger?.warn?.("[dsh-studio] turn judge failed: " + verdict.error);
				return;
			}
			ctx.logger?.info?.("[dsh-studio] turn verdict: " + (verdict.worth ? "YES" : "NO") + (verdict.remember ? " (用户要求记住，转人工确认)" : ""));
			if (!verdict.worth) return;
			if (verdict.remember) {
				// 用户点名要求记住：不在这里静默生成，只挂起一条待处理请求；下一轮按
				// guessRememberTarget 的分类结果决定「直接落位」还是「问一句」（EVO-6）
				const rememberText = verdict.rememberText ?? "（未捕获原话）";
				const ok = await savePendingRemember(rememberText, guessRememberTarget(rememberText), verdict.rememberKey ?? null);
				ctx.logger?.info?.("[dsh-studio] remember request pending confirmation: " + String(verdict.rememberText ?? "").slice(0, 60) + (ok ? "" : " (写入失败)"));
				return;
			}
			if (Date.now() - lastTurnExtract < 300_000) return;
			lastTurnExtract = Date.now();
			await extractIfDue(preferredAgent, true);
		} catch (error) {
			ctx.logger?.warn?.("[dsh-studio] turn judge failed: " + ErrorMsg(error));
		}
	};
	/**
	 * MCP 的异步挂载：eager 工具、系统提示目录、空闲扫描。
	 * 注册表变了（UI 或 mcp_register）就整段重挂一次。
	 */
	// B4：eager 工具新的一组就绪后再替换（见 mcp-eager-mount.js）
	const eagerMount = createEagerMount({
		build: () => buildEagerTools(mcpStore, mcpRuntime),
		register: (tool) => ctx.tools.register(tool),
		onNames: (names) => {
			studioEagerToolNames.clear();
			for (const n of names) studioEagerToolNames.add(n);
		},
		logger: ctx.logger
	});
	const mountMcp = () => {
		if (disposeMcpEager === void 0) {
			disposeMcpEager = ctx.effect(() => () => eagerMount.dispose(), "dsh-studio: mcp eager");
		}
		mcpCatalogMount.dispose();
		if (disposeMcpSweep !== void 0) {
			disposeMcpSweep();
			disposeMcpSweep = void 0;
		}
		void eagerMount.mount();
		if (announceToAgent) mcpCatalogMount.mount();
		if (builtinGuard !== null) void mcpStore.load().then((state) => builtinGuard.setStudioNames(state.servers.map((s) => s.name))).catch(() => {});
		disposeMcpSweep = ctx.interval(() => {
			void (async () => {
				try {
					await mcpRuntime.sweep(await mcpStore.load());
				} catch (error) {
					ctx.logger?.warn?.("[dsh-studio] MCP 空闲扫描失败：" + ErrorMsg(error));
				}
				// · F：健康检查只 ping 已经连着的 server（不为体检去起进程），失败计入熔断
				try {
					await mcpRuntime.pingConnected();
				} catch (error) {
					ctx.logger?.warn?.("[dsh-studio] MCP 健康检查失败：" + ErrorMsg(error));
				}
				// D：默认不定期去连没被选中的 server
				if (mcpConfig.revalidateIdle !== true) return;
				// 顺带看看要不要复核上游清单：上游加工具不会主动通知，只能自己定期问。
				// 单条是否真去连由 toolsCheckedAt 的 24 小时节流决定，这里只管节奏。
				if (Date.now() - lastCatalogCheckAt < CATALOG_CHECK_INTERVAL_MS) return;
				lastCatalogCheckAt = Date.now();
				try {
					const results = await revalidateCatalog(mcpStore, mcpRuntime, ctx.logger);
					const changed = results.filter((r) => r.changed);
					if (changed.length > 0) {
						ctx.logger?.info?.(
							"[dsh-studio] MCP 工具清单已定期同步：" + changed.map((r) => `${r.name} ${r.before} → ${r.after}`).join("；")
						);
					}
				} catch (error) {
					ctx.logger?.warn?.("[dsh-studio] MCP 清单定期复核失败：" + ErrorMsg(error));
				}
			})();
		}, SWEEP_INTERVAL_MS);
	};

	/** 当前 profile 名：配置优先，其次 --profile，最后按桌面版默认。 */
	const resolveProfileName = () => {
		if (typeof config?.profile === "string" && config.profile !== "") return config.profile;
		const argv = process.argv;
		const flag = argv.indexOf("--profile");
		if (flag !== -1 && flag + 1 < argv.length) return argv[flag + 1];
		return "desktop";
	};
	let mcpBooted = false;
	/** 原生行被升级冲掉时是否自动补回接管。默认开；关掉只报漂移不动文件。 */
	const autoReassert = config?.autoReassert !== false;
	/**
	 * MCP 启动序列：先把 profile 里已有的 MCP 抄进注册表并对账（三态），
	 * 再挂 eager 工具和目录段，最后预热工具缓存。
	 */
	const bootMcp = async () => {
		if (mcpBooted === false) {
			mcpBooted = true;
			try {
				const dshHome = process.env.DSH_HOME ?? homedir() + "/.dsh";
				const profileDir = `${dshHome}/profiles/${resolveProfileName()}`.replace(/\\/g, "/");
				// 三层 patch：DSH_HOME 根（全局层，REA 这类手工加的 MCP 写在这里）、
				// profile 自己的、每个 bundle 自带的（memory-bank 就在 bundle 里）
				const patchPaths = [
					`${dshHome.replace(/\\/g, "/")}/cordis.patch.yml`,
					`${profileDir}/cordis.patch.yml`,
				];
				try {
					const pkg = JSON.parse(await readFile(`${profileDir}/package.json`, "utf8"));
					for (const bundle of pkg?.dsh?.profile?.bundles ?? []) {
						patchPaths.push(`${profileDir}/node_modules/${bundle}/cordis.patch.yml`);
					}
				} catch {
					/* 没有 package.json 就只扫 profile 自己的 */
				}
				// · G 尾巴①：注册表整份消失 / 损坏先留显式记录；A：一次性 schema 迁移（出 registry-migrate 记录）
				await auditRegistryPresence(mcpStorePath());
				try {
					const migrated = await runWithWriteContext({ actor: "boot:registry-migrate", reason: "MCP 注册表 schema v1 → v2（目录条目 / 试运行字段），其余字段逐项不变" }, () =>
						mcpStore.migrate(migrateRegistry)
					);
					if (migrated !== null) ctx.logger?.info?.(`[dsh-studio] MCP 注册表已迁移到 schema v${migrated.version}（${migrated.servers.length} 个 server，字段逐项保留）`);
				} catch (error) {
					ctx.logger?.warn?.("[dsh-studio] MCP 注册表迁移失败（保持原样）：" + ErrorMsg(error));
				}
				const result = await runWithWriteContext({ actor: "boot:profile-reconcile" }, () =>
					reconcileProfileMcp(mcpStore, patchPaths, {
						overridePath: `${profileDir}/cordis.patch.yml`,
						autoReassert,
						autoTakeover: mcpConfig.autoTakeover !== false,
						logger: ctx.logger
					})
				);
				for (const hit of result.takenOver ?? []) {
					ctx.logger?.info?.(`[dsh-studio] 新的原生 MCP ${hit.name}（${hit.rowId}）已自动接管进注册表（${hit.via}），重启 DSH 后原生行停用`);
				}
				for (const hit of result.nativeOwned ?? []) {
					ctx.logger?.warn?.(`[dsh-studio] ${hit.name} 仍由原生 dsh-mcp-client 行（${hit.rowId}）加载、注册表里是停用档：两份来源并存，建议 mcp_takeover {name:"${hit.name}"}`);
				}
				if (result.imported.length > 0) {
					ctx.logger?.info?.(
						"[dsh-studio] 从 cordis.patch.yml 导入 MCP：" +
							result.imported.join(", ") +
							"（停用档，切到「按需启用」才会接管）"
					);
				}
				for (const skip of result.skipped) {
					ctx.logger?.info?.("[dsh-studio] 跳过 MCP " + skip.name + "：" + skip.reason);
				}
				for (const hit of result.reasserted) {
					ctx.logger?.warn?.(
						`[dsh-studio] ${hit.name} 的原生条目（${hit.rowId}）被重新启用了，已按 ${hit.via} 写回禁用，重启 DSH 后生效`
					);
				}
				for (const hit of result.drifted) {
					ctx.logger?.warn?.(
						`[dsh-studio] ${hit.name} 接管漂移：原生条目 ${hit.rowId} 现在是 ${hit.state}（autoReassert=${autoReassert ? "开" : "关"}）`
					);
				}
			} catch (error) {
				ctx.logger?.warn?.("[dsh-studio] 扫描 profile MCP 失败：" + ErrorMsg(error));
			}
		}
		mountMcp();
		// 预热只补工具缓存，连接用完即断；失败不阻塞插件加载。
		// 补完之后再跑一轮「到期复核」：老条目（没有 toolsCheckedAt）会被验一次，
		// 之后由下面的定时器按 24 小时节流接管，面板数字不再需要人工点刷新。
		void warmCatalog(mcpStore, mcpRuntime, ctx.logger, { mode: mcpConfig.prefetchOnBoot === "off" || mcpConfig.prefetchOnBoot === false ? "off" : "missing" })
			.then(() => (mcpConfig.revalidateIdle === true ? revalidateCatalog(mcpStore, mcpRuntime, ctx.logger) : []))
			.then((results) => {
				const changed = results.filter((r) => r.changed);
				if (changed.length > 0) {
					ctx.logger?.info?.(
						"[dsh-studio] MCP 工具清单已随启动同步：" + changed.map((r) => `${r.name} ${r.before} → ${r.after}`).join("；")
					);
				}
			})
			.catch((error) => { ctx.logger?.warn?.(`[dsh-studio] MCP 目录预热失败：${error instanceof Error ? error.message : String(error)}`); });
	};

	const mcpPatchPath = () =>
		profilePatchPath(process.env.DSH_HOME ?? homedir() + "/.dsh", resolveProfileName()).replace(/\\/g, "/");
	/**
	 * 接管一个从 cordis.patch.yml 导入的 MCP：
	 * 关掉原生条目、条目切到按需启用，并记下 `desiredNative: "disabled"` ——
	 * 启动对账靠这个「意图」判断该不该补回，而不是靠「上次点过没」。
	 *
	 * profile 自己的 patch 原地插 `disabled: true`（可逐字节回滚）；
	 * bundle 里的 patch 改写到 profile 层的按 id 覆盖（那份文件会被 pnpm install /
	 * 插件升级整份重写，写它等于写一次丢一次）。
	 *
	 * 需要重启 DSH 才真正生效——原生行是在 loader 阶段读的。
	 */
	const takeoverMcp = async (name) => {
		const state = await mcpStore.load();
		const entry = state.servers.find((s) => s.name === name);
		if (entry === undefined) throw new UserError("未登记的 MCP：" + name, 404);
		const rowId = entry.source?.rowId;
		if (typeof rowId !== "string" || rowId === "") {
			throw new UserError(`"${name}" 不是从 cordis.patch.yml 导入的，没有原生条目可接管`);
		}
		const patchPath = entry.source?.patchPath;
		const via = isBundlePatchPath(patchPath) ? "override" : "in-place";
		const changed =
			via === "override"
				? await applyProfileOverride(mcpPatchPath(), { rowId, disabled: true }, ctx.logger)
				: await disableNativeRow(patchPath ?? mcpPatchPath(), rowId, ctx.logger);
		entry.tier = "on-demand";
		entry.desiredNative = "disabled";
		entry.source = { ...(entry.source ?? {}), rowId, nativeDisabled: true, nativeState: "disabled" };
		await mcpStore.upsert(entry);
		ctx.logger?.info?.(
			`[dsh-studio] 已接管 ${name}（原生行 ${rowId} 通过 ${via} ${changed ? "已禁用" : "本来就是禁用"}），重启 DSH 后由插件按需连接`
		);
		return { ok: true, name, rowId, via, changed, restartRequired: true };
	};

	/** 回滚注册表要知道 mcp.json 在哪、回滚后要重挂 MCP。 */
	const evolutionOptions = { registryPath: () => mcpStorePath(), onRegistryChange: () => mountMcp() };
	/** 本轮模型看得到的 MCP 目录候选（与 buildMcpCatalog 同口径：非 disabled 的 server）。 */
	const catalogCandidates = async () => {
		if (!announceToAgent) return null;
		const state = await mcpStore.load();
		// 熔断中的 server 已从目录摘除，不算候选
		const { candidates: active } = catalogCandidateServers(state, mcpRuntime);
		return { servers: active.map((entry) => entry.name), toolCount: active.reduce((n, entry) => n + visibleTools(entry, mcpRuntime).length, 0) };
	};
	if (enabled) installEvolutionHooks(ctx, { telemetry, studioToolNames: studioEagerToolNames, catalogCandidates, logger: ctx.logger });

	// ：技能自动优化回路。模型走宿主 ctx.llm（与提取器同一路由口径），自动轮次默认关、只在闲时窗口跑。
	const optimizer = createOptimizer({
		pluginConfig: config?.optimizer,
		model: () =>
			createHostModel({
				llm: pluginState.llm,
				agent: () => pluginState.agent,
				routeConfig: async () => {
					const cfg = await extractStore.load();
					const { config: opt } = await optimizer.effective();
					return opt.provider !== "" && opt.model !== "" ? { ...cfg, provider: opt.provider, model: opt.model } : cfg;
				}
			}),
		telemetry: () => getTelemetry(),
		logger: ctx.logger,
		onSkillsChanged: () => invalidateSkillScanCache()
	});
	const optimizerOptions = { optimizer };
	// ：技能库治理（合并提案 / 冲突检测 / 教训 / 展示未用）。只出提案与报告，批准后才版本化写入；
	// 模型与优化回路同一条路由，门与红线读优化回路的生效配置；自动轮次默认关、只在闲时窗口跑。
	const governance = createGovernance({
		pluginConfig: config?.governance,
		optimizer,
		model: () =>
			createHostModel({
				llm: pluginState.llm,
				agent: () => pluginState.agent,
				routeConfig: async () => {
					const cfg = await extractStore.load();
					const { config: opt } = await optimizer.effective();
					return opt.provider !== "" && opt.model !== "" ? { ...cfg, provider: opt.provider, model: opt.model } : cfg;
				}
			}),
		logger: ctx.logger,
		onSkillsChanged: () => invalidateSkillScanCache()
	});
	const governanceOptions = { governance };
	// ：蒸馏硬化——提取器候选一律先成草稿；查重（#4）→ 合并提案，或过 #3 评估门才入库。
	// 闲时批量默认关；手动 skillmgr_distill_run 可点名会话。
	const distill = createDistill({
		pluginConfig: config?.distill,
		governance,
		optimizer,
		extractConfig: () => extractStore.load(),
		extract: async (opts) => runExtract(await extractStore.load(), null, opts),
		model: () =>
			createHostModel({
				llm: pluginState.llm,
				agent: () => pluginState.agent,
				routeConfig: async () => {
					const cfg = await extractStore.load();
					const { config: opt } = await optimizer.effective();
					return opt.provider !== "" && opt.model !== "" ? { ...cfg, provider: opt.provider, model: opt.model } : cfg;
				}
			}),
		logger: ctx.logger,
		onSkillsChanged: () => invalidateSkillScanCache()
	});
	const distillOptions = { distill };
	if (enabled) pluginState.distillIngest = (cands, info) => distill.ingest(cands, info);
	// B3：草稿队列满了就不再调提取模型
	if (enabled) pluginState.distillAdmit = () => distill.admit();
	// G7 增量：技能新增 / 新版本落地 → 去抖后只查与它相关的冲突（只读技能库，只写冲突报告）
	if (enabled) {
		const offVersion = onSkillVersion((info) => governance.noteSkillVersion(info));
		ctx.effect?.(() => () => offVersion(), "dsh-studio: governance incremental");
	}
	// · 4：MCP 目录评测巡检——真实注册表 × G5 场景集，归档 + 回退报告（只报告）。
	// 配置在 mcp.catalogEval；自动巡检默认关、只在闲时窗口跑（与优化回路同一套「闲」口径）。
	const catalogWatch = createCatalogWatch({ pluginConfig: mcpConfig.catalogEval, loadRegistry: () => mcpStore.load(), logger: ctx.logger });
	const catalogEvalOptions = { watch: catalogWatch };
	// · R7：studio 级备份包（注册表 / 配置 / 技能 / 版本史 / 进化数据）+ 跨机恢复（冲突报告待裁、不静默覆盖）。
	// 技能根跟优化回路的生效根走（与 #3/#4/#5 同一口径）；闲时自动打包默认关。
	const studioBackup = createStudioBackup({
		pluginConfig: config?.studioBackup,
		fullPluginConfig: config,
		skillRoots: async () => optimizerSkillRoots((await optimizer.effective()).config),
		registrySerial: (fn) => mcpStore.serial(fn),
		onRegistryChange: () => mountMcp(),
		onSkillsChanged: () => invalidateSkillScanCache(),
		logger: ctx.logger
	});
	const studioBackupOptions = { backup: studioBackup };
	if (enabled && typeof ctx.on === "function") {
		// 「闲」= 最近一段时间没有回合开始 / 结束
		ctx.on("agent/inbox/claimed", () => {
			optimizer.noteActivity();
			catalogWatch.noteActivity();
			governance.noteActivity();
			distill.noteActivity();
			studioBackup.noteActivity();
		});
		ctx.on("agent/turn-stopping", () => {
			optimizer.noteActivity();
			catalogWatch.noteActivity();
			governance.noteActivity();
			distill.noteActivity();
			studioBackup.noteActivity();
		});
	}
	let disposeOptimizerTimer;
	let disposeCatalogEvalTimer;
	let disposeGovernanceTimer;
	let disposeDistillTimer;
	let disposeStudioBackupTimer;

	const sync = () => {
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		if (disposeRoutes !== void 0) {
			disposeRoutes();
			disposeRoutes = void 0;
		}
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (disposeTimer !== void 0) {
			disposeTimer();
			disposeTimer = void 0;
		}
		if (disposeMcpEager !== void 0) {
			disposeMcpEager();
			disposeMcpEager = void 0;
		}
		if (disposeOptimizerTimer !== void 0) {
			disposeOptimizerTimer();
			disposeOptimizerTimer = void 0;
		}
		if (disposeCatalogEvalTimer !== void 0) {
			disposeCatalogEvalTimer();
			disposeCatalogEvalTimer = void 0;
		}
		if (disposeGovernanceTimer !== void 0) {
			disposeGovernanceTimer();
			disposeGovernanceTimer = void 0;
		}
		if (disposeDistillTimer !== void 0) {
			disposeDistillTimer();
			disposeDistillTimer = void 0;
		}
		if (disposeStudioBackupTimer !== void 0) {
			disposeStudioBackupTimer();
			disposeStudioBackupTimer = void 0;
		}
		mcpCatalogMount.dispose();
		if (disposeMcpSweep !== void 0) {
			disposeMcpSweep();
			disposeMcpSweep = void 0;
		}
		if (!enabled) return;
		const tools = [
			skillmgrListTool(ctx),
			skillmgrGetTool(ctx),
			skillmgrSaveTool(ctx),
			skillmgrPolicyTool(ctx),
			skillmgrExportTool(),
			skillmgrTrashTool(ctx),
			skillmgrTrashListTool(),
			skillmgrRestoreTool(),
			skillmgrPurgeTool(),
			skillmgrSnapshotTool(),
			skillmgrSnapshotListTool(),
			skillmgrSnapshotRestoreTool(),
			skillmgrPullPendingTool(extractStore),
			skillmgrSnapshotTransferTool(),
			skillmgrSyncTool(),
			skillmgrUpdateCheckTool(extractStore, { upstreamTtlMs: config?.darwin?.upstreamTtlMs }),
			skillmgrUpdateApplyTool(extractStore, { upstreamTtlMs: config?.darwin?.upstreamTtlMs }),
			...buildExtractorTools(extractStore),
			...buildMcpTools(mcpStore, mcpRuntime, { onChange: () => mountMcp(), takeover: takeoverMcp, builtinStatus }),
			...buildCatalogEvalTools(catalogEvalOptions),
			...buildEvolutionTools(evolutionOptions),
			...buildOptimizerTools(optimizerOptions),
			...buildGovernanceTools(governanceOptions),
			...buildDistillTools(distillOptions),
			...buildStudioBackupTools(studioBackupOptions)
		];
		disposeTools = ctx.effect(() => {
			const disposers = tools.map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-studio: tools");
		disposeRoutes = ctx.effect(() => {
			const routes = [
				...makeRoutes(ctx, extractStore),
				...buildExtractorRoutes(ctx, extractStore),
				...buildMcpRoutes(mcpStore, mcpRuntime, { onChange: mountMcp, takeover: takeoverMcp, logger: ctx.logger, builtinStatus }),
				...buildCatalogEvalRoutes(ctx, catalogEvalOptions),
				...buildEvolutionRoutes(ctx, evolutionOptions),
				...buildOptimizerRoutes(ctx, optimizerOptions),
				...buildGovernanceRoutes(ctx, governanceOptions),
				...buildDistillRoutes(ctx, distillOptions),
				...buildStudioBackupRoutes(ctx, studioBackupOptions)
			];
			// 面板发起的写入在版本史里记 actor = panel（只包一层上下文，不改 handler 行为）
			const disposers = routes.map((route) =>
				ctx.webServer.register({ ...route, handler: (req, res) => runWithWriteContext({ actor: "panel" }, () => route.handler(req, res)) })
			);
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-studio: routes");
		void bootMcp();
		if (announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-studio",
			order: SECTION_ORDER,
			text: GUIDANCE
		});
		// ：版本史保留（每 key 最近 200 条 + 对象 GC）——启动 2 分钟后跑一次，之后每天至多一次
		// ：保留之前先把注册表旧版本里的内嵌凭据按新口径重新脱敏（幂等；从旧版机器导入的版本史也一并收拾）
		let lastRetentionAt = 0;
		const maintainHistory = (force = false) => {
			const t = Date.now();
			if (!force && t - lastRetentionAt < 24 * 60 * 60 * 1000) return;
			lastRetentionAt = t;
			redactRegistryHistory()
				.catch((error) => ctx.logger?.warn?.("[dsh-studio] 版本史重新脱敏失败（不影响使用，明天再试）：" + ErrorMsg(error)))
				.then(() => applyVersionRetention())
				.catch((error) => ctx.logger?.warn?.("[dsh-studio] 版本史保留失败（不影响使用）：" + ErrorMsg(error)));
		};
		const retentionBoot = setTimeout(() => maintainHistory(true), 2 * 60 * 1000);
		retentionBoot.unref?.();
		ctx.effect?.(() => () => clearTimeout(retentionBoot), "dsh-studio: history retention boot");
		disposeTimer = ctx.interval(() => {
			void extractIfDue();
			if (lastRetentionAt > 0) maintainHistory();
		}, 60 * 1000);
		// · G9：每分钟问一次「该不该跑优化」；tick 自己按 checkEveryMinutes 节流，
		// 自动开关 / 闲时窗口 / 空闲时长 / 两轮间隔任何一项不满足都直接返回（默认 enabled=false）。
		disposeOptimizerTimer = ctx.interval(() => {
			optimizer.tick().catch((error) => ctx.logger?.warn?.("[dsh-studio] 技能优化轮次失败：" + ErrorMsg(error)));
		}, 60 * 1000);
		// · 4：目录评测巡检同样每分钟问一次；tick 按 checkEveryMinutes 节流，默认 enabled=false 直接返回。
		disposeCatalogEvalTimer = ctx.interval(() => {
			catalogWatch.tick().catch((error) => ctx.logger?.warn?.("[dsh-studio] MCP 目录评测巡检失败：" + ErrorMsg(error)));
		}, 60 * 1000);
		// · G9：治理轮次同样每分钟问一次；默认 enabled=false 直接返回
		disposeGovernanceTimer = ctx.interval(() => {
			governance.tick().catch((error) => ctx.logger?.warn?.("[dsh-studio] 技能库治理轮次失败：" + ErrorMsg(error)));
		}, 60 * 1000);
		// · G9：闲时批量过门同样每分钟问一次；默认 enabled=false 直接返回
		disposeDistillTimer = ctx.interval(() => {
			distill.tick().catch((error) => ctx.logger?.warn?.("[dsh-studio] 蒸馏批次失败：" + ErrorMsg(error)));
		}, 60 * 1000);
		// · G9：闲时自动打 studio 备份包同样每分钟问一次；默认 enabled=false 直接返回
		disposeStudioBackupTimer = ctx.interval(() => {
			studioBackup.tick().catch((error) => ctx.logger?.warn?.("[dsh-studio] studio 备份包自动打包失败：" + ErrorMsg(error)));
		}, 60 * 1000);
		// 回合结束也触发一次：交给 intervalMinutes 做冷却，避免每轮都调模型
		if (typeof ctx.on === "function") {
			ctx.on("agent/turn-stopping", (payload) => {
				const agent = payload && payload.agent ? payload.agent : null;
				const t = setTimeout(() => {
					void judgeThenExtract(agent);
				}, 3000);
				t.unref?.();
			});
		}
	};
	sync();
	// darwin 体检调度（原独立插件 dsh-darwin-auto 已并入）：写入 SKILL.md 后把
	// darwin-skill 推到模型面前，并按 families.json 折叠同族重复项。
	// WO-EVO-4：它同样受插件总开关约束 —— enabled:false 时连事件都不该挂，
	// 否则关掉插件却还在注入 darwin 段、跑巡检。darwin 自己的子开关语义不变。
	if (enabled) applyDarwin(ctx, config?.darwin ?? {}, { llm: pluginState.llm });
}

export { API, GUIDANCE, apply, applyPolicy, assembleFile, buildExtractorRoutes, buildExtractorTools, getSkillDetail, inject, listSkills, makeRoutes, name, savePolicy, saveSkill, skillmgrUpdateCheckTool, splitFrontmatter };
export { ExtractorStore, assembleCandidateFile, defaults as extractorDefaults, loadCandidates, runExtraction, saveCandidates, updateCandidate, writeSkill, writeSkillDual } from "./extractor.js";
