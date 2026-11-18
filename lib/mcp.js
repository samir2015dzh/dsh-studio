/**
 * dsh-studio — MCP 按需加载（host half）。
 *
 * 目标：MCP 工具不要全量塞进系统提示。会话开头只暴露「server 名 + 每个工具名和
 * 截断描述」，AI 真要用了再 mcp_load 取完整 schema、mcp_call 执行。
 *
 * 三档：
 *   - eager：连接后立刻把工具注册成 mcp__<server>__<tool>，行为和原生 mcp-client 一致。
 *   - on-demand：不注册工具，只在目录里留名字和描述（默认档）。
 *   - disabled：完全不碰。
 *
 * 单例 + 空闲回收：同一 server 全局只保持一条连接（桌面版单用户，按会话隔离的复杂度
 * 换不来实际收益），超过 idleTimeoutMinutes 没有任何工具调用就断开子进程 / 关 HTTP
 * 会话，但注册表和工具缓存留着——下次 mcp_call / eager 调用时透明重连。
 *
 * 存储：~/.dsh/dsh-studio/mcp.json，与 skill 提取的 pending-remember.json 同目录。
 */
import { MAX_JSON_BODY_BYTES, bodyTooLarge } from "./route-util.js";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { atomicWriteFile } from "./fs-atomic.js";
import { UserError } from "./errors.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { McpConnection, SESSION_EXPIRED, transportSpec } from "./mcp-client.js";
import { checkServerUpdates } from "./mcp-upstream.js";
import { REDACTED, isSensitiveField, maskArgs, maskSecret, maskUrlSecrets } from "./redact.js";
import { removeDirForcibly, splitCommandLine } from "./command.js";
import { isLocalRequest } from "./guard.js";
import { CREDENTIAL_FILE_MODE, hardenPermissions } from "./fs-perms.js";
import { effectiveRowDisabled, parseMcpRows, parsedFileCached } from "./profile-mcp.js";
import { errorClassOf, getTelemetry } from "./telemetry.js";
import { REGISTRY_KEY, auditRegistryPresence, lastKeyRecord, versionedRegistryWrite } from "./versions.js";
import { currentWriteContext, runWithWriteContext } from "./write-context.js";
import {
	CircuitBreaker,
	catalogOf,
	classifyTool,
	inTrial,
	normalizeCatalog,
	normalizeToolAccess,
	slimAnnotation,
	verifyOf
} from "./mcp-policy.js";

const TIERS = new Set(["eager", "on-demand", "disabled"]);
/** 注册表 schema：1 = 之前；2 = 带目录条目 / 验证状态 / 试运行（迁移见 lib/mcp-migrate.js）。 */
export const REGISTRY_SCHEMA = 2;
/** 改了这些字段 = 换了一个「端点」，旧的验证结论不再适用，验证状态回到 unverified。 */
const ENDPOINT_KEYS = ["transport", "command", "args", "env", "envPrefix", "cwd", "url", "headers"];
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_IDLE_MINUTES = 5;
const SWEEP_INTERVAL_MS = 30_000;
/** 工具清单「多久没核对过就该主动验一次」。上游加工具不会通知我们，只能自己问。 */
const DEFAULT_REVALIDATE_MS = 24 * 60 * 60 * 1000;
const MAX_TOOL_NAME = 64;
const HASH_LEN = 12;

/** 目录里每条工具描述最多留这么多字，太长就截断（省 token）。 */
export const DEFAULT_TOOL_DESCRIPTION_MAX = 150;

/** 落盘的工具缓存只留名字 + 截断描述。完整 inputSchema 不进注册表：
 *  229 个 REA 工具带 schema 能把 mcp.json 撑到 10 MB，而面板只显示名字和截断描述。 */
const TOOLS_CACHE_DESCRIPTION_MAX = 200;
/** 注册表超过这个大小就在启动时压一次（旧版本写进去过完整 schema）。 */
const SLIM_TRIGGER_BYTES = 2 * 1024 * 1024;

function slimTools(tools, maxLen = TOOLS_CACHE_DESCRIPTION_MAX) {
	if (!Array.isArray(tools)) return [];
	return tools
		.filter((t) => t && typeof t.name === "string")
		.map((t) => ({ name: t.name, description: clampText(t.description, maxLen), ...slimAnnotation(t) }));
}

function storePath() {
	return resolve(homedir(), ".dsh", "dsh-studio", "mcp.json");
}

/** 审计 1：注册表损坏后的写入闸——存在即拒绝 save，直到注册表恢复或所有者确认。 */
function corruptHoldPath() {
	return storePath() + ".corrupt-hold.json";
}

const corruptStamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");

async function readCorruptHold() {
	let raw;
	try {
		raw = await readFile(corruptHoldPath(), "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : { at: null, archivedTo: null, error: "闸文件本身不可解析" };
	} catch {
		return { at: null, archivedTo: null, error: "闸文件本身不可解析" };
	}
}

function clampText(value, max) {
	const s = typeof value === "string" ? value.trim() : "";
	if (s === "") return "";
	return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

/** 深链进去的 server 名可能带空格等字符；统一成 DSH 认识的函数名。 */
export function publicToolName(serverName, toolName) {
	const raw = "mcp__" + serverName + "__" + toolName;
	const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_");
	if (safe === raw && safe.length <= MAX_TOOL_NAME) return safe;
	const digest = createHash("sha256").update(serverName + "\u0000" + toolName).digest("hex").slice(0, HASH_LEN);
	return safe.slice(0, MAX_TOOL_NAME - HASH_LEN - 1) + "_" + digest;
}

function normalizeEntry(input, previous) {
	const entry = { ...(previous ?? {}) };
	const pick = (key) => {
		if (Object.prototype.hasOwnProperty.call(input, key)) entry[key] = input[key];
	};
	for (const key of ["tier", "transport", "command", "args", "env", "envPrefix", "cwd", "url", "headers", "notes", "idleTimeout", "tools", "toolsCheckedAt", "source", "toolCallTimeoutMs", "toolFilter", "desiredNative", "catalog", "verify", "trial", "toolAccess"]) pick(key);
	if (typeof input.name === "string") entry.name = input.name;
	if (entry.transport !== "streamable-http") entry.transport = "stdio";
	if (entry.tier === undefined) entry.tier = previous?.tier ?? "on-demand";
	if (!TIERS.has(entry.tier)) entry.tier = "on-demand";
	if (entry.transport === "stdio") {
		entry.command = typeof entry.command === "string" ? entry.command : "";
		entry.args = Array.isArray(entry.args) ? entry.args.map(String) : [];
		entry.env = entry.env && typeof entry.env === "object" ? { ...entry.env } : {};
		entry.cwd = typeof entry.cwd === "string" ? entry.cwd : "";
		delete entry.url;
		delete entry.headers;
	} else {
		entry.url = typeof entry.url === "string" ? entry.url : "";
		entry.headers = entry.headers && typeof entry.headers === "object" ? { ...entry.headers } : {};
		delete entry.command;
		delete entry.args;
		delete entry.env;
		delete entry.cwd;
	}
	entry.tools = slimTools(entry.tools);
	// ：目录条目 / 读写分级覆盖 / 试运行钉子——只在给了的时候规范化，不凭空补默认值
	// （补默认值会让每个老条目在第一次被改时多出一串「改了 catalog」的假 diff）
	if (Object.prototype.hasOwnProperty.call(entry, "catalog")) {
		const catalog = normalizeCatalog(entry.catalog);
		if (catalog === undefined) delete entry.catalog;
		else entry.catalog = catalog;
	}
	if (Object.prototype.hasOwnProperty.call(entry, "toolAccess")) {
		const access = normalizeToolAccess(entry.toolAccess);
		if (access === undefined || Object.keys(access).length === 0) delete entry.toolAccess;
		else entry.toolAccess = access;
	}
	if (Object.prototype.hasOwnProperty.call(entry, "trial") && typeof entry.trial !== "boolean") delete entry.trial;
	if (Object.prototype.hasOwnProperty.call(entry, "verify") && (entry.verify === null || typeof entry.verify !== "object")) delete entry.verify;
	return entry;
}

/** 两份条目的端点字段是否不同（不同 → 验证状态要重置）。 */
export function endpointChanged(a, b) {
	if (a === undefined || b === undefined) return true;
	return ENDPOINT_KEYS.some((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}

/**
 * 回文件把「现在到底接管没有」算出来，写回 `source.nativeState`。
 *
 * 注册表里的 `nativeDisabled` 只是上次接管时的快照：bundle patch 被 pnpm install
 * 或插件升级整份重写后它还是 true，面板就会谎报「已接管」，而原生已经把全部工具
 * 注册了一遍——两份同时注入，屏幕上却写着一切正常。判断必须回文件读。
 *
 * nativeState: "disabled"（真接管）/ "active"（原生行活着 = 漂移）/ "missing"（行没了）
 */
async function refreshNativeStates(servers) {
	const texts = new Map();
	const overrides = new Map();
	for (const entry of servers) {
		const patchPath = entry.source?.patchPath;
		const rowId = entry.source?.rowId;
		if (typeof patchPath !== "string" || typeof rowId !== "string") continue;
		// B7：patch 文件按 stat 复用解析结果（每次 load 都会走到这里，含缓存命中）
		if (!texts.has(patchPath)) texts.set(patchPath, await parsedFileCached(patchPath, parseMcpRows, () => null));
		const rows = texts.get(patchPath);
		const row = rows === null ? undefined : rows.find((r) => r.rowId === rowId);
		// bundle 行接管时 disabled 写在 profile 层覆盖块里，要叠上它才是实际状态
		const state = row === undefined ? "missing" : (await effectiveRowDisabled(patchPath, rowId, row.disabled, overrides)) ? "disabled" : "active";
		entry.source.nativeState = state;
		entry.source.nativeDisabled = state === "disabled";
	}
	return servers;
}

/**
 * 注册表：一份 JSON，全局共享（所有会话、所有工作区）。
 * 每次读盘不做缓存——写的人可能是 UI、可能是工具、也可能是外部编辑器。
 */
export class McpStore {
	/** @param {{logger?: {warn?: Function, error?: Function, info?: Function}}} [options] */
	constructor(options = {}) {
		this.logger = options.logger ?? null;
		this.busy = false;
		/** 进程内的「读-改-写」串行链：upsert / remove / patchSetting 各自 load→save 不再交错 */
		this.mutating = Promise.resolve();
	}

	/**
	 * 串行执行一次读-改-写。给 save 加了版本记录（写前多读一次文件），
	 * 并发 upsert（后台工具缓存同步 + 前台登记）交错时，后写者会用旧快照覆盖先写者；
	 * 串起来之后每次 upsert 都基于上一次写完的状态。
	 * @template T
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	serial(fn) {
		const run = this.mutating.then(fn, fn);
		this.mutating = run.then(() => undefined, () => undefined);
		return run;
	}

	async load() {
		// 没有文件 = 全新安装：直接按当前 schema 起步（不需要迁移）
		const empty = { version: REGISTRY_SCHEMA, idleTimeoutMinutes: DEFAULT_IDLE_MINUTES, toolDescriptionMaxLength: DEFAULT_TOOL_DESCRIPTION_MAX, servers: [] };
		// 只有「文件不存在」才算全新安装。其它 stat / read 错误（Windows 上被占用的 EBUSY / EPERM）若也回空注册表，
		// 紧跟着的一次 upsert 就会把整份注册表写成只剩一条：有上次解析结果就先用它，没有就抛，绝不回空。
		const unreadable = (error) => {
			if (this.cache !== undefined) return structuredClone(this.cache.value);
			throw error;
		};
		let info;
		try {
			info = await stat(storePath());
		} catch (error) {
			if (error?.code === "ENOENT") return empty;
			return unreadable(error);
		}
		// OPT-05：mtime + size 没变就复用上次解析结果。面板与工具注册都会频繁 load，
		// 每次重读整份 mcp.json 属于白花钱。
		if (this.cache !== undefined && this.cache.mtimeMs === info.mtimeMs && this.cache.size === info.size) {
			await refreshNativeStates(this.cache.value.servers);
			return structuredClone(this.cache.value);
		}
		let raw;
		try {
			raw = await readFile(storePath(), "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return empty;
			return unreadable(error);
		}
		let parsed;
		try {
			parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("顶层不是 JSON 对象");
		} catch (error) {
			// 审计 1：「存在但解析失败」≠「不存在」——留档、大声报、闸住后续 save，不静默按空注册表覆盖
			await this.quarantine(raw, error);
			return empty;
		}
		if ((await readCorruptHold()) !== null) {
			// 文件回来了且可解析（回滚 / studio 恢复 / 手动修好）：自动解闸
			await rm(corruptHoldPath(), { force: true }).catch(() => {});
			this.say("info", "[dsh-studio] MCP 注册表已恢复为可解析状态，损坏写入闸已解除");
		}
		const servers = Array.isArray(parsed?.servers) ? parsed.servers.filter((s) => s && typeof s.name === "string" && NAME_PATTERN.test(s.name)) : [];
		const result = {
			version: Number.isFinite(Number(parsed?.version)) && Number(parsed.version) >= 1 ? Number(parsed.version) : 1,
			idleTimeoutMinutes: Number.isFinite(Number(parsed?.idleTimeoutMinutes)) ? Number(parsed.idleTimeoutMinutes) : DEFAULT_IDLE_MINUTES,
			toolDescriptionMaxLength: Number.isFinite(Number(parsed?.toolDescriptionMaxLength)) ? Number(parsed.toolDescriptionMaxLength) : DEFAULT_TOOL_DESCRIPTION_MAX,
			// 以文件里的条目为底再规范化：认不出的键原样保留（迁移要求「逐项等价」，不许读一遍就丢字段）
			servers: servers.map((s) => normalizeEntry(s, s))
		};
		this.cache = { mtimeMs: info.mtimeMs, size: info.size, value: result };
		await refreshNativeStates(result.servers);
		// · A2：交出去的是副本。调用方「先改对象再 save」，此前改的就是缓存本身——save 失败（目录只读、
		// Windows 改名重试到期）时磁盘没变、缓存已变，下一次成功的 save 会把这份「幽灵」状态落盘；
		// 串行链外的读者也会看到别人还没落盘的半截修改。
		return structuredClone(result);
	}

	say(level, message) {
		try {
			const fn = this.logger?.[level];
			if (typeof fn === "function") fn.call(this.logger, message);
			else (level === "error" ? console.error : console.warn)(message);
		} catch {
			/* 日志失败不影响主流程 */
		}
	}

	/**
	 * 注册表文件存在但解析失败：先落一条 registry-corrupt 缺口记录（只记指纹），再把坏文件改名留档为
	 * mcp.json.corrupt-<时间>，写损坏闸；之后的 save 一律拒绝，直到注册表恢复（rollback / 手动修复后
	 * 下次 load 自动解闸）或所有者确认（acknowledgeCorrupt）。
	 */
	async quarantine(raw, error) {
		const file = storePath();
		const at = new Date();
		await auditRegistryPresence(file).catch(() => null);
		const archivedTo = file + ".corrupt-" + corruptStamp(at);
		let moved = true;
		try {
			await rename(file, archivedTo);
		} catch {
			moved = false;
		}
		const hold = {
			at: at.toISOString(),
			archivedTo: moved ? archivedTo : null,
			size: Buffer.byteLength(raw ?? "", "utf8"),
			error: error instanceof Error ? error.message : String(error)
		};
		try {
			await atomicWriteFile(corruptHoldPath(), JSON.stringify(hold, null, 2) + "\n", { encoding: "utf8", mode: CREDENTIAL_FILE_MODE });
		} catch (e) {
			this.say("error", "[dsh-studio] MCP 注册表损坏闸写不进去：" + (e instanceof Error ? e.message : String(e)));
		}
		this.cache = undefined;
		this.say(
			"error",
			`[dsh-studio] ⚠ MCP 注册表 mcp.json 无法解析（${hold.error}）。${moved ? "坏文件已改名留档：" + archivedTo : "坏文件改名失败，原地保留"}。` +
				"已暂停所有注册表写入；请用 skillmgr_rollback（name=mcp-registry）回到损坏前的版本，或确认后在 dsh-studio 设置页「确认并重新开始」"
		);
		this.corruptHoldMemo = hold;
	}

	/** 当前损坏闸（没有 = null）。 */
	async corruptStatus() {
		return readCorruptHold();
	}

	/** 所有者确认：解除损坏闸（坏文件仍留档），之后的写入从当前状态起算。 */
	async acknowledgeCorrupt() {
		const hold = await readCorruptHold();
		if (hold === null) return { ok: true, cleared: false };
		await rm(corruptHoldPath(), { force: true });
		this.cache = undefined;
		this.say("warn", "[dsh-studio] 所有者已确认 MCP 注册表损坏，写入闸解除（留档：" + (hold.archivedTo ?? "无") + "）");
		return { ok: true, cleared: true, hold };
	}

	async assertWritable() {
		const hold = await readCorruptHold();
		if (hold === null) return;
		throw new UserError(
			"MCP 注册表处于损坏保护中（" + (hold.at ?? "时间未知") + " 检测到 mcp.json 无法解析，留档 " + (hold.archivedTo ?? "无") + "），拒绝写入以免覆盖。" +
				"先用 skillmgr_rollback（name=mcp-registry）恢复到损坏前的版本，或在 dsh-studio 设置页确认后再改",
			409,
			{ code: "MCP_REGISTRY_CORRUPT", payload: { hold } }
		);
	}

	async save(state) {
		try {
			return await this.saveUnchecked(state);
		} catch (error) {
			// 写没成：缓存可能已不代表磁盘（老调用方拿到过缓存本身），作废后下次 load 回文件读（A2）
			this.cache = undefined;
			throw error;
		}
	}

	async saveUnchecked(state) {
		await this.assertWritable();
		const body = {
			version: Number.isFinite(Number(state.version)) && Number(state.version) >= 1 ? Number(state.version) : 1,
			idleTimeoutMinutes: state.idleTimeoutMinutes,
			toolDescriptionMaxLength: state.toolDescriptionMaxLength,
			servers: state.servers
		};
		// · G2：每次落盘都过版本史（只有语义字段变了才出记录；工具缓存刷新不算）
		await versionedRegistryWrite(storePath(), {}, async () => {
			await atomicWriteFile(storePath(), JSON.stringify(body, null, 2) + "\n", { encoding: "utf8", mode: CREDENTIAL_FILE_MODE });
			await hardenPermissions(storePath());
		});
		return body;
	}

	upsert(input) {
		return this.serial(() => this.upsertUnlocked(input));
	}

	async upsertUnlocked(input) {
		const state = await this.load();
		const index = state.servers.findIndex((s) => s.name === input.name);
		const entry = normalizeEntry(input, index >= 0 ? state.servers[index] : undefined);
		if (index >= 0) state.servers[index] = entry;
		else state.servers.push(entry);
		await this.save(state);
		return entry;
	}

	remove(name) {
		return this.serial(() => this.removeUnlocked(name));
	}

	async removeUnlocked(name) {
		const state = await this.load();
		const before = state.servers.length;
		state.servers = state.servers.filter((s) => s.name !== name);
		await this.save(state);
		return before !== state.servers.length;
	}

	patchSetting(key, value) {
		return this.serial(() => this.patchSettingUnlocked(key, value));
	}

	/**
	 * 只改一个条目的若干字段（：验证状态回写走这里）。条目不在了返回 null，不新建。
	 * verify / tools / toolsCheckedAt 属于运行时观测，版本史不为它们出记录。
	 */
	patchServer(name, patch) {
		return this.serial(async () => {
			const state = await this.load();
			const index = state.servers.findIndex((s) => s.name === name);
			if (index < 0) return null;
			const entry = normalizeEntry({ ...state.servers[index], ...patch, name }, state.servers[index]);
			state.servers[index] = entry;
			await this.save(state);
			return entry;
		});
	}

	/**
	 * 一次性 schema 迁移：fn(parsed) 返回迁移后的整份注册表（或 null = 不用迁）。
	 * 迁移本身出一条 registry-migrate 版本记录（即使语义字段碰巧没变也记）。
	 */
	migrate(fn) {
		return this.serial(async () => {
			// 直接读盘上的原文、不经 load()：load 会规范化条目并回文件现算 source.nativeState，
			// 迁移要的是「只加字段、其余逐项原样」，不能顺手把派生字段也写进去
			let parsed;
			try {
				parsed = JSON.parse((await readFile(storePath(), "utf8")).replace(/^\uFEFF/, ""));
			} catch {
				return null; // 没有文件（全新安装）或文件坏了（尾巴①另有记录）：不迁
			}
			const next = fn(parsed);
			if (next === null || next === undefined) return null;
			await runWithWriteContext({ registryAction: "migrate" }, () =>
				versionedRegistryWrite(storePath(), {}, async () => {
					await atomicWriteFile(storePath(), JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: CREDENTIAL_FILE_MODE });
					await hardenPermissions(storePath());
				})
			);
			this.cache = undefined;
			return next;
		});
	}

	async patchSettingUnlocked(key, value) {
		const state = await this.load();
		if (key === "idleTimeoutMinutes") state.idleTimeoutMinutes = Number(value);
		if (key === "toolDescriptionMaxLength") state.toolDescriptionMaxLength = Number(value);
		await this.save(state);
		return state;
	}
}

const BUILTIN_GUARD_LABEL = { armed: "已拦截新增 / 修改 / 启用", off: "未开启（mcp.lockBuiltinManager=false）", unavailable: "未挂上（没认出内建管理器，放行）" };

/**
 * mcp_list 文本里**恒有**的一行：内建 MCP 管理（dsh-mcp-manager）让位守卫的状态。
 * 以前只在有同名冲突时才出一行，守卫没挂上 / 被关掉时文本里看不出来。
 * @param {{available?: boolean, guard?: string, servers?: {state?: string}[], conflicts?: string[], rejected?: number} | undefined} builtin builtin-mcp-guard 的 status()
 */
export function builtinStatusLine(builtin) {
	if (builtin === undefined || builtin === null || typeof builtin !== "object") return "内建 MCP 管理：未接入（插件停用或守卫未安装，无镜像）";
	const guard = BUILTIN_GUARD_LABEL[builtin.guard] ?? String(builtin.guard ?? "未知");
	const servers = Array.isArray(builtin.servers) ? builtin.servers : [];
	const active = servers.filter((s) => s?.state !== "disabled").length;
	const parts = ["守卫" + guard];
	// ：armed 只说明钩子挂上了；manager 是怎么认出来的、真判过几次写入，一并报出来
	if (builtin.guard === "armed" && typeof builtin.identity === "string") {
		parts.push(builtin.identity === "instance" ? "按 manager 实例识别" : builtin.identity === "class" ? "按 manager 类识别（拿不到实例 fiber）" : "仅按名字识别（拿不到 manager 实例，可能漏拦）");
	}
	if (Number.isFinite(Number(builtin.judged)) && builtin.judged !== undefined) parts.push("已判定写入 " + Number(builtin.judged) + " 次");
	parts.push("已拒绝 " + (Number(builtin.rejected) || 0) + " 次");
	parts.push(builtin.available ? "内建条目 " + servers.length + " 个（未停用 " + active + " 个）" : "读不到内建管理器（镜像为空）");
	const conflicts = Array.isArray(builtin.conflicts) ? builtin.conflicts : [];
	parts.push(conflicts.length > 0 ? "同名条目：" + conflicts.join("、") + "（双份注入，建议在 Settings → MCP 停用内建那份）" : "无同名冲突");
	return "内建 MCP 管理：" + parts.join("；");
}

/**
 * 运行时：每个 server 最多一条活连接，附带活跃时间与懒重连。
 */
/** 连接原因（遥测 via）：从写上下文的 actor 推出来，与 mcp.call 的口径对齐。 */
function viaOfContext(fallback = "studio") {
	const actor = currentWriteContext().actor;
	if (typeof actor !== "string" || actor === "") return fallback;
	if (actor === "model:mcp_call") return "call";
	if (actor === "model:mcp_load") return "load";
	if (actor === "model:mcp_register") return "register";
	if (actor === "model:mcp_verify") return "verify";
	if (actor.startsWith("model:mcp__")) return "eager";
	if (actor === "panel") return "panel";
	if (actor === "boot") return "boot";
	return fallback;
}

/** JSON-RPC 错误（对端回了 error）= 对端活着；只有超时 / 断连 / 起不来才记熔断失败。 */
const isProtocolError = (error) => typeof error?.code === "number";
/** 本插件自己的闸门错误（熔断中 / 试运行拒写），不算上游失败。 */
class GateError extends Error {
	constructor(message, code) {
		super(message);
		this.code = code;
		this.name = "GateError";
	}
}

/** 失败原因落盘前截短并抹掉疑似凭据（验证失败原因会写进注册表、出现在目录里）。 */
function shortReason(error) {
	const text = (error instanceof Error ? error.message : String(error ?? "")).replace(/\s+/g, " ").trim();
	// `Bearer <token>` 先整体抹：旧写法只抹关键字后的第一个词，"Authorization: Bearer sk-…" 会剩下真 token
	const masked = maskUrlSecrets(text)
		.replace(/\bbearer\s+\S+/gi, "Bearer ***")
		.replace(/(token|key|secret|password|authorization)([=:\s]+)(?!Bearer \*\*\*)\S+/gi, "$1$2***");
	return clampText(masked, 200);
}

/**
 * 端点字段里还留着凭据占位符的那几项：快照 / studio 备份包 / 版本回滚补不回的内嵌凭据会原样留着占位符，
 * 整字段的则不写——两种都在恢复报告里列出。这里只管前者：带占位符的端点不许去连。
 */
export function placeholderFields(entry) {
	const out = [];
	const has = (v) => typeof v === "string" && v.includes(REDACTED);
	if (has(entry?.command)) out.push("command");
	if (Array.isArray(entry?.args) && entry.args.some(has)) out.push("args");
	if (has(entry?.url)) out.push("url");
	if (has(entry?.cwd)) out.push("cwd");
	for (const field of ["env", "envPrefix", "headers"]) {
		const map = entry?.[field];
		if (map !== null && typeof map === "object") for (const [k, v] of Object.entries(map)) if (has(v)) out.push(`${field}.${k}`);
	}
	return out;
}

export class McpRuntime {
	/**
	 * @param {object} logger
	 * @param {{breaker?: {threshold?: number, cooldownMs?: number}, now?: () => number}} [options]
	 */
	constructor(logger, options = {}) {
		this.logger = logger;
		this.slots = new Map();
		/** 每次观测到真实工具清单（首次连接 / list_changed）都回调一次，供上层把缓存落盘。
		 *  上层可以返回 Promise；写盘失败只记日志，不影响本次调用。 */
		this.onToolsObserved = undefined;
		/** · C：每次真实握手（成功 / 失败）回调一次 (entry, verify)，供上层把验证状态落盘。 */
		this.onVerified = undefined;
		/** 目录里的状态变了（熔断开 / 合、验证结论变化）时回调，供上层重建系统提示里的目录段。 */
		this.onCatalogStale = undefined;
		/** name → 最近一次握手得出的验证状态（内存，先于落盘生效：试运行闸门以它为准）。 */
		this.verifyState = new Map();
		/** name → {lastPingAt, lastOkAt, lastError} */
		this.health = new Map();
		this.breaker = new CircuitBreaker({
			...(options.breaker ?? {}),
			now: options.now,
			onTransition: (name, info) => {
				const label = info.state === "open" ? `熔断（${info.cause}，预计 ${info.until} 恢复）` : info.state === "half-open" ? "冷却到点，半开试探" : `复位（${info.cause}）`;
				this.logger?.info?.(`[dsh-studio] MCP "${name}" ${label}`);
				void getTelemetry().record("mcp.breaker", { server: name, state: info.state, cause: info.cause, until: info.until ?? undefined });
				// 熔断 / 复位会改变「目录里谁是候选」：通知上层重建系统提示里的目录段
				this.fire(this.onCatalogStale, [name, info.state], "MCP 目录刷新通知失败");
			}
		});
	}

	/** 通知上层同步缓存。刻意不 await：工具调用不该等一次写文件。 */
	observe(entry, tools) {
		this.fire(this.onToolsObserved, [entry, tools], "MCP 工具缓存自动同步失败");
	}

	fire(fn, args, label) {
		if (typeof fn !== "function") return;
		const fail = (error) => {
			this.logger?.warn?.(`[dsh-studio] ${label}：` + (error instanceof Error ? error.message : String(error)));
		};
		try {
			const result = fn(...args);
			if (result !== null && typeof result === "object" && typeof result.catch === "function") result.catch(fail);
		} catch (error) {
			fail(error);
		}
	}

	/** 记一次握手结论（内存 + 遥测 + 回调落盘）。 */
	noteVerify(entry, ok, { tools, error, via, ms, persist = true } = {}) {
		const verify = {
			status: ok ? "verified" : "failed",
			checkedAt: new Date().toISOString(),
			...(ok ? { toolCount: Array.isArray(tools) ? tools.length : 0 } : { error: shortReason(error) }),
			via: via ?? "connect"
		};
		this.verifyState.set(entry.name, verify);
		void getTelemetry().record("mcp.verify", { sid: currentWriteContext().sessionId, server: entry.name, state: verify.status, ok, ms, via: verify.via, err: ok ? undefined : errorClassOf(error) });
		if (persist) this.fire(this.onVerified, [entry, verify], "MCP 验证状态落盘失败");
		return verify;
	}

	/** 条目 + 本进程里最新的握手结论（落盘是异步的，闸门不能等它）。 */
	effective(entry) {
		const live = this.verifyState.get(entry?.name);
		return live === undefined ? entry : { ...entry, verify: live };
	}

	slot(name) {
		let slot = this.slots.get(name);
		if (slot === undefined) {
			// gen：每次回收 / 注销 / 卸载加一，用来作废「还在握手途中」的连接；connecting：正在握手的那条
			slot = { conn: undefined, lastUsed: Date.now(), ensureP: undefined, tools: [], error: undefined, gen: 0, connecting: undefined };
			this.slots.set(name, slot);
		}
		return slot;
	}

	status(name) {
		const slot = this.slots.get(name);
		if (slot === undefined) return "idle";
		if (slot.error !== undefined && slot.conn === undefined) return "error";
		return slot.conn === undefined ? "idle" : "connected";
	}

	errorOf(name) {
		return this.slots.get(name)?.error;
	}

	/** 是否持有活连接（测试 / 目录用：未选中的 server 不该有连接）。 */
	connected(name) {
		const conn = this.slots.get(name)?.conn;
		return conn !== undefined && conn.closed !== true;
	}

	/** 熔断闸门：open 时直接拒，不去连上游。 */
	assertBreaker(name) {
		const gate = this.breaker.allow(name);
		if (gate.ok) return;
		throw new GateError(
			`MCP "${name}" 已熔断（连续失败 ${gate.failures} 次，原因 ${gate.cause}），已从目录候选里摘除，预计 ${gate.until} 后自动半开试探；确认恢复后可用 mcp_verify {name:"${name}"} 手动复位`,
			"breaker-open"
		);
	}

	/** 连上就复用；已断开就重连一次（并发调用共享同一次重连）。 */
	async ensure(entry, options = {}) {
		const slot = this.slot(entry.name);
		// WO-FIX-6：只判断 conn 是否存在会让死连接永久占坑（stdio 子进程退出后
		// channel 关掉、failAll 了在途请求，但 slot.conn 还在，状态永远 connected）。
		if (slot.conn !== undefined && slot.conn.closed !== true) return slot.conn;
		if (slot.conn !== undefined) {
			slot.conn = undefined;
			slot.error = slot.error ?? "连接已断开，准备重连";
		}
		// ：从快照 / 备份包 / 版本史恢复回来、凭据没补回的端点里还留着占位符——不许拿它去连
		const leftover = placeholderFields(entry);
		if (leftover.length > 0) {
			throw new Error(`MCP "${entry.name}" 的 ${leftover.join("、")} 里还是凭据占位符（恢复时目标机没有现值，见恢复报告的 missingCredentials）：先补上真实凭据再连，占位符不会被当成凭据发出去`);
		}
		if (slot.ensureP === undefined) {
			const via = options.via ?? viaOfContext();
			const sid = currentWriteContext().sessionId;
			const gen = slot.gen;
			// 握手期间这个 slot 被回收 / 注销 / 卸载（gen 变了，或名字已经换了 slot）→ 这条连接不许装上去
			const cancelled = () => slot.gen !== gen || this.slots.get(entry.name) !== slot;
			const attempt = (async () => {
				const started = Date.now();
				let conn;
				try {
					conn = new McpConnection(transportSpec(entry), {
						timeoutMs: options.timeoutMs ?? entry.toolCallTimeoutMs ?? 120000,
						// 握手/列工具最多等 45s；工具本身的超时仍走 toolCallTimeoutMs
						connectTimeoutMs: Math.min(entry.toolCallTimeoutMs ?? 45000, 45000),
						onToolsChanged: () => {
							void this.refreshTools(entry, conn).catch((error) => { this.logger?.warn?.(`[dsh-studio] MCP 刷新工具失败：${error instanceof Error ? error.message : String(error)}`); });
						},
						// 只有当前 slot 持有的那条连接才清：重连后旧连接关闭不能误伤新连接
						onClose: (error) => {
							if (slot.conn !== conn) return;
							slot.conn = undefined;
							slot.error = error instanceof Error ? error.message : String(error);
							void getTelemetry().record("mcp.unload", { server: entry.name, cause: "closed" });
						}
					});
					slot.connecting = conn;
					await conn.connect();
					const tools = await conn.listTools();
					if (cancelled()) throw new Error("cancelled");
					slot.conn = conn;
					slot.connecting = undefined;
					slot.tools = tools;
					slot.error = undefined;
					slot.lastUsed = Date.now();
					this.observe(entry, tools);
					// · D / C：一次真实加载 = 一次握手 + 工具列表 → 记 load、记 verified、熔断计成功
					void getTelemetry().record("mcp.load", { sid, server: entry.name, via, ok: true, ms: Date.now() - started });
					this.noteVerify(entry, true, { tools, via, ms: Date.now() - started });
					this.breaker.success(entry.name);
					this.markHealthy(entry.name);
					return conn;
				} catch (error) {
					try {
						await conn?.close();
					} catch {
						/* 半截连接关不掉也不影响上报 */
					}
					if (slot.connecting === conn) slot.connecting = undefined;
					if (cancelled()) {
						// 不是上游的错：不计熔断、不记验证失败。旧写法没有这道检查——注销 / 插件卸载 / 改端点发生在慢握手期间时，
						// 握手完成后连接照样装到一个没人管的 slot 上，子进程从此既不被空闲回收、也不被 closeAll 关掉
						throw Object.assign(new Error(`MCP "${entry.name}" 的连接在建立途中被取消（注销 / 改配置 / 卸载）`), { cancelled: true });
					}
					void getTelemetry().record("mcp.load", { sid, server: entry.name, via, ok: false, ms: Date.now() - started, err: errorClassOf(error) });
					this.noteVerify(entry, false, { error, via, ms: Date.now() - started });
					this.breaker.failure(entry.name, `load-${errorClassOf(error)}`);
					this.markUnhealthy(entry.name, error);
					throw error;
				}
			})();
			slot.ensureP = attempt;
			attempt
				.catch((error) => {
					if (error?.cancelled === true) return;
					slot.error = error instanceof Error ? error.message : String(error);
					this.logger?.warn?.("[dsh-studio] MCP 连接失败 " + entry.name + "：" + slot.error);
				})
				.finally(() => {
					// 被取消后 slot 可能已经开始了下一次连接：只清自己的
					if (slot.ensureP === attempt) slot.ensureP = undefined;
				});
		}
		await slot.ensureP;
		const conn = slot.conn;
		if (conn === undefined) throw new Error(`MCP "${entry.name}" 未连接：${slot.error ?? "未知原因"}`);
		return conn;
	}

	/**
	 * 独立一次「握手 + 工具列表」验证。
	 * 不占 slot：验完即关，不算一次加载（不出 mcp.load），只出 mcp.verify。
	 * @returns {Promise<{verify: object, tools: object[]}>} 永不抛
	 */
	/**
	 * @param {{via?: string, timeoutMs?: number, persist?: boolean}} [options] persist=false：调用方自己把结论与清单
	 *   一次落盘（mcp_register），这里就不再经 onToolsObserved / onVerified 各写一次注册表（B7）
	 */
	async verify(entry, { via = "manual", timeoutMs = 30000, persist = true } = {}) {
		const started = Date.now();
		let conn;
		try {
			conn = new McpConnection(transportSpec(entry), { timeoutMs, connectTimeoutMs: Math.min(timeoutMs, 45000) });
			await conn.connect();
			const tools = await conn.listTools();
			const slot = this.slot(entry.name);
			slot.tools = tools;
			slot.error = undefined;
			// · A5：验证用的是另一条连接；slot 上那条若已失效（会话 404 / 子进程退出）一并丢掉，免得状态还挂着它
			if (slot.conn !== undefined && slot.conn.closed === true) slot.conn = undefined;
			if (persist) this.observe(entry, tools);
			this.breaker.success(entry.name);
			this.markHealthy(entry.name);
			return { verify: this.noteVerify(entry, true, { tools, via, ms: Date.now() - started, persist }), tools };
		} catch (error) {
			this.breaker.failure(entry.name, `verify-${errorClassOf(error)}`);
			this.markUnhealthy(entry.name, error);
			return { verify: this.noteVerify(entry, false, { error, via, ms: Date.now() - started, persist }), tools: [] };
		} finally {
			try {
				await conn?.close();
			} catch {
				/* 关闭失败不影响结论 */
			}
		}
	}

	markHealthy(name) {
		const row = this.health.get(name) ?? {};
		this.health.set(name, { ...row, lastOkAt: new Date().toISOString(), lastError: null });
	}

	markUnhealthy(name, error) {
		const row = this.health.get(name) ?? {};
		this.health.set(name, { ...row, lastError: shortReason(error), lastErrorAt: new Date().toISOString() });
	}

	/**
	 * 健康检查：只 ping 已经连着的 server（未选中的不为了体检去起进程）。
	 * @returns {Promise<{name:string, ok:boolean}[]>}
	 */
	async pingConnected() {
		// B7：并行 ping（以前逐台 await，一台卡到超时，后面的全等着），并防重入——上一轮还没 ping 完
		// （某台卡住），下一次定时扫描直接复用这一轮的结果，不叠第二轮
		if (this.pinging !== undefined) return this.pinging;
		const run = (async () => {
			const targets = [];
			for (const [name, slot] of this.slots) {
				const conn = slot.conn;
				if (conn === undefined || conn.closed === true || typeof conn.ping !== "function") continue;
				const row = this.health.get(name) ?? {};
				this.health.set(name, { ...row, lastPingAt: new Date().toISOString() });
				targets.push({ name, conn });
			}
			return Promise.all(
				targets.map(async ({ name, conn }) => {
					try {
						await conn.ping();
						this.breaker.success(name);
						this.markHealthy(name);
						return { name, ok: true };
					} catch (error) {
						this.breaker.failure(name, `ping-${errorClassOf(error)}`);
						this.markUnhealthy(name, error);
						return { name, ok: false };
					}
				})
			);
		})();
		this.pinging = run;
		try {
			return await run;
		} finally {
			this.pinging = undefined;
		}
	}

	/** 健康快照（mcp_list / 目录路由用）。 */
	healthOf(name) {
		return { ...(this.health.get(name) ?? {}), breaker: this.breaker.snapshot(name) };
	}

	async refreshTools(entry, conn) {
		const slot = this.slot(entry.name);
		if (slot.conn !== conn) return;
		slot.tools = await conn.listTools();
		this.observe(entry, slot.tools);
	}

	touch(name) {
		const slot = this.slots.get(name);
		if (slot !== undefined) slot.lastUsed = Date.now();
	}

	/**
	 * 只断开连接，保留 tools 缓存与注册表；下次 ensure 会自动重连。
	 * @param {string} name
	 * @param {string} [cause] 卸载原因（遥测 mcp.unload）：idle / reload / config / tier / unregister / shutdown
	 */
	async reclaim(name, cause = "reload") {
		const slot = this.slots.get(name);
		if (slot === undefined) return false;
		// 断开即作废旧错误：它属于上一条连接，留着会把「已切档位」显示成「连接错误」
		slot.error = undefined;
		this.cancelConnecting(slot);
		if (slot.conn === undefined) return false;
		const conn = slot.conn;
		slot.conn = undefined;
		try {
			await conn.close();
		} catch {
			/* 关闭失败不阻塞回收 */
		}
		void getTelemetry().record("mcp.unload", { server: name, cause });
		return true;
	}

	/** 作废这个 slot 上还在握手途中的连接：立刻关掉它（不等握手超时），并让 ensure 里的后续步骤认出自己已过期。 */
	cancelConnecting(slot) {
		slot.gen = (slot.gen ?? 0) + 1;
		const connecting = slot.connecting;
		slot.connecting = undefined;
		slot.ensureP = undefined;
		if (connecting !== undefined && connecting !== slot.conn) void Promise.resolve(connecting.close()).catch(() => {});
	}

	/** 注销后清掉这个名字的所有内存状态（连接、缓存、验证、熔断、健康）。 */
	async forget(name, cause = "unregister") {
		await this.reclaim(name, cause);
		this.slots.delete(name);
		this.verifyState.delete(name);
		this.health.delete(name);
		this.breaker.forget(name);
	}

	/**
	 * 试运行闸门：试运行中的 server 只放只读工具。
	 * 分级先看完整工具定义（带注解），拿不到再退回注册表瘦缓存，再退回名字。
	 */
	assertAccess(entry, toolName) {
		const eff = this.effective(entry);
		if (!inTrial(eff)) return;
		const def = this.cachedTools(entry.name).find((t) => t?.name === toolName) ?? (entry.tools ?? []).find((t) => t?.name === toolName) ?? toolName;
		const { access, source } = classifyTool(entry, def);
		if (access === "read") return;
		const why = eff.trial === true ? "登记时钉了试运行（trial: true）" : `尚未通过验证（${verifyOf(eff).status}）`;
		throw new GateError(
			`MCP "${entry.name}" 处于试运行：${why}，只放行握手、工具列表与只读工具；"${toolName}" 判定为可写（依据 ${source}）。` +
				`确认可信后用 mcp_verify {name:"${entry.name}", promote:true} 转正，或用 mcp_register 的 toolAccess 把它标成 read`,
			"trial-readonly"
		);
	}

	async call(entry, toolName, args) {
		// · G4：本插件经手的 MCP 调用（mcp_call 与 eager 工具）在这里计时记一条遥测。
		// 旁路：record 永不抛、不 await，统计坏了不影响调用结果。
		const started = Date.now();
		let ok = false;
		let err;
		try {
			this.assertBreaker(entry.name);
			let conn = await this.ensure(entry);
			this.assertAccess(entry, toolName);
			let result;
			try {
				try {
					result = await conn.callTool(toolName, args);
				} catch (error) {
					// · A5：HTTP 会话被服务端丢了（404）——这次请求服务端没受理，重新握手后重试一次，
					// 不把这一次失败甩给模型。只认这一种错误；重试仍失败就照常报。
					if (error?.code !== SESSION_EXPIRED) throw error;
					conn = await this.ensure(entry);
					result = await conn.callTool(toolName, args);
				}
			} catch (error) {
				if (isProtocolError(error)) this.breaker.success(entry.name);
				else this.breaker.failure(entry.name, `call-${errorClassOf(error)}`);
				throw error;
			}
			// 工具自己报错（isError）说明上游活着：熔断按成功计
			this.breaker.success(entry.name);
			// 只有真正跑通的调用才刷新活跃时间（WO-FIX-6）：失败调用不该给死连接续命，
			// 否则空闲回收永远轮不到它。
			this.touch(entry.name);
			ok = result?.isError !== true;
			if (!ok) err = "tool-error";
			return result;
		} catch (error) {
			err = error instanceof GateError ? error.code : errorClassOf(error);
			throw error;
		} finally {
			try {
				const ctx = currentWriteContext();
				void getTelemetry().record("mcp.call", {
					sid: ctx.sessionId,
					server: entry?.name,
					tool: toolName,
					via: ctx.actor === "model:mcp_call" ? "mcp_call" : typeof ctx.actor === "string" && ctx.actor.startsWith("model:mcp__") ? "eager" : "studio",
					ok,
					ms: Date.now() - started,
					err
				});
			} catch {
				/* 旁路 */
			}
		}
	}

	cachedTools(name) {
		return this.slots.get(name)?.tools ?? [];
	}

	/**
	 * 空闲扫描：超过 idleTimeoutMinutes 没被调用就断开。
	 * 返回这次回收掉的 server 名，便于日志与测试断言。
	 */
	async sweep(state) {
		const reclaimed = [];
		// 注册表里已经没有、或已切到 disabled 档的 server 不该还连着（回滚注册表、外部改文件、面板切档都会造成这种情况）。
		// 这一步与空闲时限无关：idleTimeoutMinutes 设成 0（不回收）也照做。
		const byName = new Map(state.servers.map((entry) => [entry.name, entry]));
		for (const [name, slot] of [...this.slots]) {
			if (slot.conn === undefined && slot.connecting === undefined) continue;
			const entry = byName.get(name);
			if (entry !== undefined && entry.tier !== "disabled") continue;
			const cause = entry === undefined ? "unregister" : "tier";
			if (await this.reclaim(name, cause)) {
				reclaimed.push(name);
				this.logger?.info?.(`[dsh-studio] MCP "${name}" ${entry === undefined ? "已不在注册表里" : "已停用"}，断开上游连接`);
			}
		}
		const limit = Number.isFinite(Number(state.idleTimeoutMinutes)) ? Number(state.idleTimeoutMinutes) : DEFAULT_IDLE_MINUTES;
		if (limit <= 0) return reclaimed;
		const now = Date.now();
		for (const entry of state.servers) {
			const perEntry = entry.idleTimeout === undefined ? limit : Number(entry.idleTimeout);
			if (!Number.isFinite(perEntry) || perEntry <= 0) continue;
			const slot = this.slots.get(entry.name);
			if (slot === undefined || slot.conn === undefined) continue;
			if (now - slot.lastUsed < perEntry * 60_000) continue;
			if (await this.reclaim(entry.name, "idle")) {
				reclaimed.push(entry.name);
				this.logger?.info?.(
					`[dsh-studio] MCP "${entry.name}" 空闲 ${perEntry} 分钟，已断开上游连接（工具缓存保留，下次调用自动重连）`
				);
			}
		}
		return reclaimed;
	}

	async closeAll() {
		for (const [name, slot] of this.slots) {
			// 还在握手的也要作废并关掉：否则插件卸载之后握手才完成，子进程就留在后台了
			this.cancelConnecting(slot);
			if (slot.conn === undefined) continue;
			const conn = slot.conn;
			slot.conn = undefined;
			try {
				await conn.close();
			} catch {
				/* 卸载时尽量不抛 */
			}
			void getTelemetry().record("mcp.unload", { server: name, cause: "shutdown" });
			this.slots.delete(name);
		}
	}
}

/** MCP 的 tools/call 结果 → DSH 工具输出。 */
function projectResult(result, toolName) {
	if (result === undefined || result === null) return { content: [{ type: "text", text: `(${toolName} 没有返回内容)` }] };
	if (!Array.isArray(result.content)) {
		const fallback = typeof result.toolResult === "string" ? result.toolResult : JSON.stringify(result.toolResult ?? result);
		return { content: [{ type: "text", text: fallback }], ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) };
	}
	return {
		content: result.content,
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent })
	};
}

function resultText(result) {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	const parts = [];
	for (const block of blocks) {
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block && typeof block === "object" && block.type === "image") parts.push("[image: " + (block.mimeType ?? "unknown") + "]");
		else if (block && typeof block === "object" && block.type === "resource_link") parts.push("[resource_link: " + (block.name ?? "") + "]");
		else parts.push("[非文本内容]");
	}
	return parts.length === 0 ? "(空返回)" : parts.join("\n");
}

/** 统一的工具输出 schema：MCP 的 content 数组原样带出去。 */
function mcpOutputSchema(render) {
	return {
		schema: {
			type: "object",
			additionalProperties: true,
			properties: {
				content: { type: "array", required: true, items: { type: "json" } },
				structuredContent: { type: "json" }
			}
		},
		render
	};
}

/** DSH 的输出校验要求 lossless JSON：undefined / NaN 会直接判失败，这里统一洗一遍。 */
function clean(value) {
	return JSON.parse(
		JSON.stringify(value, (_key, v) => {
			if (typeof v === "number" && !Number.isFinite(v)) return null;
			return v;
		})
	);
}

/**
 * 某个条目实际暴露给模型的工具集合。
 *
 * 这就是原来 rea-mcp-filter 那层 proxy 干的事，搬进插件后：白名单存在注册表里，
 * 改完不用重启、不用重启上游，下一轮目录重建就生效；上游仍然把全部工具报上来，
 * 过滤只发生在「给模型看」这一层。
 *
 * toolFilter.mode: "all"（默认）| "allow"（只留 names）| "deny"（去掉 names）
 */
export function visibleTools(entry, runtime) {
	const cached = runtime.cachedTools(entry.name);
	const all = cached.length > 0 ? cached : entry.tools ?? [];
	const filter = entry.toolFilter;
	if (filter === undefined || filter === null) return all;
	if (filter.mode !== "allow" && filter.mode !== "deny") return all;
	if (!Array.isArray(filter.names) || filter.names.length === 0) return all;
	const set = new Set(filter.names);
	return filter.mode === "allow" ? all.filter((t) => set.has(t.name)) : all.filter((t) => !set.has(t.name));
}

/** 把一个 server 的 headers / env / envPrefix 里的凭据摊平。
 *  只收看起来像凭据的键——GHIDRA_INSTALL_DIR 这类路径塞进面板只会把行卡撑长。
 *  值在**这里**就换成掩码（WO-SEC-1）：describeEntry 的结果会进 HTTP JSON、面板 state、
 *  工具返回值，原值一旦放进去就等于到处都是。明文只走 /mcp/credential 单点路由。 */
function credentialList(entry) {
	const out = [];
	const push = (kind, source) => {
		for (const [key, value] of Object.entries(source ?? {})) {
			if (!isSensitiveField(key, value)) continue;
			out.push({ kind, key, value: maskSecret(value), sensitive: true });
		}
	};
	push("header", entry.headers);
	push("env", entry.env);
	push("envPrefix", entry.envPrefix);
	return out;
}

/** 取一条凭据的原始值：只给 loopback 的按需取用路由，不经过 describeEntry。 */
export function credentialValue(entry, kind, key) {
	const source = kind === "header" ? entry.headers : kind === "env" ? entry.env : kind === "envPrefix" ? entry.envPrefix : null;
	const value = source?.[key];
	return typeof value === "string" && value !== "" ? value : null;
}

function describeEntry(entry, runtime, state) {
	const tools = visibleTools(entry, runtime);
	const raw = runtime.cachedTools(entry.name).length > 0 ? runtime.cachedTools(entry.name) : entry.tools ?? [];
	return clean({
		name: entry.name,
		tier: entry.tier,
		transport: entry.transport,
		// 展示串：args 里的 `--api-key xxx`、URL 里的 userinfo / `?apiKey=` 都抹掉——这一项会进 mcp_list（模型上下文）与面板 JSON
		endpoint: entry.transport === "stdio" ? [entry.command, ...maskArgs(entry.args ?? [])].join(" ") : maskUrlSecrets(entry.url),
		status: entry.tier === "disabled" ? "disabled" : runtime.status(entry.name),
		error: runtime.errorOf(entry.name),
		toolCount: tools.length,
		rawToolCount: raw.length,
		toolFilter: entry.toolFilter ?? { mode: "all", names: [] },
		// 接管状态：来自 cordis.patch.yml 且原生行已禁用 = 已接管，由本插件按需加载
		// nativeState 是回文件现算的（"disabled" / "active" / "missing"），nativeDisabled 只是兼容别名
		nativeDisabled: entry.source?.nativeDisabled === true,
		nativeState: entry.source?.nativeState ?? null,
		desiredNative: entry.desiredNative ?? null,
		sourceRowId: entry.source?.rowId ?? null,
		tools: tools.map((t) => ({ name: t.name, description: clampText(t.description, state.toolDescriptionMaxLength) })),
		allTools: raw.map((t) => ({ name: t.name, description: clampText(t.description, 80) })),
		notes: entry.notes ?? "",
		credentials: credentialList(entry),
		idleTimeout: entry.idleTimeout,
		// 上次核对上游工具清单的时间（null = 从没核对过，面板可据此提示「该刷了」）
		toolsCheckedAt: entry.toolsCheckedAt ?? null,
		...governanceOf(entry, runtime)
	});
}

/**
 * ：验证状态 / 试运行 / 读写分级 / 目录条目 / 健康与熔断——mcp_list、面板、目录路由同一份口径。
 */
export function governanceOf(entry, runtime) {
	const eff = runtime.effective(entry);
	const raw = runtime.cachedTools(entry.name).length > 0 ? runtime.cachedTools(entry.name) : entry.tools ?? [];
	const visible = new Set(visibleTools(entry, runtime).map((t) => t.name));
	const access = { read: 0, write: 0, writeTools: [] };
	for (const tool of raw) {
		if (!visible.has(tool.name)) continue;
		if (classifyTool(entry, tool).access === "read") access.read += 1;
		else {
			access.write += 1;
			access.writeTools.push(tool.name);
		}
	}
	const { authored, ...catalog } = catalogOf(entry);
	return {
		verify: verifyOf(eff),
		trial: inTrial(eff),
		trialPinned: entry.trial === true,
		writeAllowed: !inTrial(eff),
		access,
		catalog: { ...catalog, authored },
		health: runtime.healthOf(entry.name)
	};
}

/** 拿条目回写注册表时去掉验证状态：它由握手异步回写，拿旧快照覆盖会把新结论冲掉。 */
function withoutVerify(entry) {
	const { verify: _verify, ...rest } = entry;
	return rest;
}

/**
 * 注销一个 server：断连接、清内存状态、移出注册表（出 registry-remove 版本记录，
 * 凭据原值进本机暂存，回滚时补回）。工具与面板路由共用。
 * @returns {Promise<{removed: boolean, versionId: string|null, restoreVersionId: string|null}>}
 */
export async function unregisterServer(store, runtime, name, reason) {
	const state = await store.load();
	if (!state.servers.some((s) => s.name === name)) return { removed: false, versionId: null, restoreVersionId: null };
	await runtime.forget(name, "unregister");
	const removed = await runWithWriteContext(typeof reason === "string" && reason.trim() !== "" ? { reason: reason.trim() } : {}, () => store.remove(name));
	let versionId = null;
	let restoreVersionId = null;
	try {
		const last = await lastKeyRecord(REGISTRY_KEY);
		if (last !== null && last.action === "registry-remove" && (last.diff?.removed ?? []).includes(name)) {
			versionId = last.id;
			restoreVersionId = last.parent ?? null;
		}
	} catch {
		/* 查不到版本号不影响注销本身 */
	}
	return { removed, versionId, restoreVersionId };
}


/**
 * 手动重验：真实握手 + 工具列表 → 刷新验证状态；成功顺带复位熔断，
 * reset 无条件复位，promote 在验证通过时结束试运行。工具与路由共用。
 */
export async function verifyServer(store, runtime, name, args = {}) {
	const entry = (await store.load()).servers.find((s) => s.name === name);
	if (entry === undefined) throw new Error("未登记的 MCP：" + name);
	const { verify, tools } = await runtime.verify(entry, { via: "manual" });
	let saved = (await store.patchServer(name, { verify, ...(tools.length > 0 ? { tools: slimTools(tools), toolsCheckedAt: new Date().toISOString() } : {}) })) ?? entry;
	const ok = verify.status === "verified";
	let reset = false;
	if (ok) reset = runtime.breaker.reset(name, "manual-verify");
	if (args.reset === true) reset = runtime.breaker.reset(name, "manual") || reset;
	let promoted = false;
	if (args.promote === true && ok && saved.trial !== false) {
		saved = await store.upsert({ ...withoutVerify(saved), trial: false });
		promoted = true;
	}
	const trial = inTrial(runtime.effective(saved));
	const parts = [
		ok ? `MCP ${name} 验证通过：${tools.length} 个工具` : `MCP ${name} 验证失败：${verify.error ?? "未知原因"}`,
		reset ? "熔断已复位" : "",
		promoted ? "已转正（放开可写工具）" : args.promote === true && !ok ? "未转正：验证没通过" : "",
		trial ? "仍在试运行（只放只读工具）" : ""
	].filter((x) => x !== "");
	return clean({ ok, name, verify, breaker: runtime.breaker.snapshot(name), trial, promoted, toolCount: tools.length, message: parts.join("；") });
}

/**
 * 四个模型工具：list / register / load / call。
 * 故意保持极小——它们本身每轮都在系统提示里，绝不能再胖。
 */
export function buildMcpTools(store, runtime, options = {}) {
	return [
		defineTool({
			name: "mcp_list",
			description: "列出全部 MCP 服务器：档位（eager/on-demand/disabled）、传输方式、连接状态、缓存的工具名与截断描述。要看完整参数用 mcp_load。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						idleTimeoutMinutes: { type: "number" },
						// · A：DSH 内建 MCP 管理（Settings → MCP）那边看到的 server 与冲突（只读镜像）
						builtin: { type: "object", additionalProperties: true },
						// 审计 1：注册表损坏闸（有 = 写入暂停）
						registryCorrupt: { type: "object", additionalProperties: true },
						servers: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: true,
								properties: {
									name: { type: "string" },
									tier: { type: "string" },
									transport: { type: "string" },
									endpoint: { type: "string" },
									status: { type: "string" },
									toolCount: { type: "number" },
									notes: { type: "string" }
								}
							}
						}
					}
				},
				render: (_args, value) => {
					const lines = (value.servers ?? []).map(
						(s) =>
							"- " + s.name + " [" + s.tier + "/" + s.status + "/" + (s.verify?.status ?? "unverified") + (s.trial ? "/试运行" : "") +
							(s.health?.breaker?.state === "open" ? "/熔断至 " + s.health.breaker.until : "") + "] " +
							s.toolCount + " 个工具 · " + s.transport + " · " + s.endpoint
					);
					return [{ type: "text", text: "MCP 服务器 " + lines.length + " 个（空闲回收 " + value.idleTimeoutMinutes + " 分钟）：\n" + lines.join("\n") + "\n" + builtinStatusLine(value.builtin) +
						(value.registryCorrupt ? "\n⚠ 注册表损坏保护中（" + (value.registryCorrupt.at ?? "?") + "，留档 " + (value.registryCorrupt.archivedTo ?? "无") + "）：写入已暂停，先 skillmgr_rollback name=mcp-registry 恢复" : "") }];
				}
			},
			async execute() {
				const state = await store.load();
				const builtin = typeof options.builtinStatus === "function" ? options.builtinStatus() : undefined;
				const registryCorrupt = typeof store.corruptStatus === "function" ? await store.corruptStatus() : null;
				return clean({
					ok: true,
					idleTimeoutMinutes: state.idleTimeoutMinutes,
					...(builtin ? { builtin } : {}),
					...(registryCorrupt ? { registryCorrupt } : {}),
					servers: state.servers.map((entry) => describeEntry(entry, runtime, state))
				});
			}
		}),
		defineTool({
			name: "mcp_register",
			description:
				"新增或修改一个 MCP 服务器（唯一注册入口，写入即出版本记录）。先入册、再试连验证：验证失败也照样登记（状态 failed，可稍后 mcp_verify 重试）。" +
				"新 server 默认试运行（只放握手、工具列表与只读工具），确认可信后 mcp_verify {promote:true} 转正。tier: eager / on-demand（默认）/ disabled。",
			parameters: {
				name: { type: "string", description: "服务器名，1-32 位 [A-Za-z0-9_-]", required: true },
				tier: { type: "string", description: "eager | on-demand | disabled，默认 on-demand" },
				transport: { type: "string", description: "stdio 或 streamable-http，默认 stdio" },
				command: { type: "string", description: "stdio：启动命令" },
				args: { type: "array", items: { type: "string" }, description: "stdio：参数数组" },
				env: { type: "object", additionalProperties: true, description: "stdio：额外环境变量" },
				cwd: { type: "string", description: "stdio：工作目录" },
				url: { type: "string", description: "streamable-http：端点 URL" },
				headers: { type: "object", additionalProperties: true, description: "streamable-http：请求头" },
				notes: { type: "string", description: "给这个 MCP 写备注（目录条目没写「是什么」时用它兜底）" },
				catalog: {
					type: "object",
					additionalProperties: true,
					description: "目录条目：{summary: 是什么/干什么, useWhen: [什么时候用], avoidWhen: [什么时候不要用], tools: {工具名: {use, avoid}}}"
				},
				toolAccess: { type: "object", additionalProperties: true, description: "读写分级手工覆盖：{工具名: \"read\" | \"write\"}" },
				trial: { type: "boolean", description: "试运行钉子：true = 只放只读工具；新 server 默认 true" },
				verify: { type: "boolean", description: "false = 只登记不试连（默认登记后立刻试连一次）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						name: { type: "string" },
						toolCount: { type: "number" },
						tools: { type: "array", items: { type: "string" } },
						verify: { type: "object", additionalProperties: true },
						trial: { type: "boolean" },
						message: { type: "string" }
					}
				},
				render: (_args, value) => [
					{ type: "text", text: String(value.message ?? "") + ((value.tools ?? []).length > 0 ? "\n- " + value.tools.join("\n- ") : "") }
				]
			},
			async execute(args) {
				const name = String(args.name ?? "").trim();
				if (!NAME_PATTERN.test(name)) throw new Error("服务器名需为 1-32 位 [A-Za-z0-9_-]：" + name);
				// WO-BORROW-5：command 允许直接粘整行（含引号参数），没给 args 时自动切分
				const { verify: verifyFlag, ...rest } = args;
				let given = rest;
				if (rest.transport !== "streamable-http" && typeof rest.command === "string" && rest.command.trim() !== "" && (!Array.isArray(rest.args) || rest.args.length === 0)) {
					const parts = splitCommandLine(rest.command);
					if (parts.length > 1) given = { ...rest, command: parts[0], args: parts.slice(1) };
				}
				const previous = (await store.load()).servers.find((s) => s.name === name);
				// 改已有条目可以只给要改的字段（如只改 notes / catalog）：校验看合并后的结果
				const merged = previous === undefined ? normalizeEntry({ ...given, name }, undefined) : normalizeEntry({ ...previous, ...given, name }, previous);
				if (merged.transport === "stdio" && merged.command === "") throw new Error("stdio 传输必须给 command");
				if (merged.transport === "streamable-http" && merged.url === "") throw new Error("streamable-http 传输必须给 url");
				// 新 server 先以试运行入册（F）；老条目改配置不动它的试运行状态，除非显式给了 trial
				if (previous === undefined && typeof given.trial !== "boolean") merged.trial = true;
				const changed = endpointChanged(previous, merged);
				if (changed) {
					// 换了端点：旧连接与旧验证结论都不再可信
					await runtime.reclaim(name, "config");
					runtime.verifyState.delete(name);
					merged.verify = { status: "unverified", checkedAt: null, via: "register" };
				}
				// C：先入册（unverified），不以试连成败为前提
				let saved = await store.upsert(merged);
				options.onChange?.();
				let verify = verifyOf(runtime.effective(saved));
				let tools = [];
				if (verifyFlag !== false && (changed || verify.status !== "verified")) {
					// B7：结论与清单由下面这一次 patchServer 落盘，不再经运行时回调各写一次（以前一次登记最多四次整份 save）
					const probe = await runtime.verify(saved, { via: "register", persist: false });
					verify = probe.verify;
					tools = probe.tools;
					saved = (await store.patchServer(name, { verify, ...(tools.length > 0 ? { tools: slimTools(tools), toolsCheckedAt: new Date().toISOString() } : {}) })) ?? saved;
					options.onChange?.();
				} else {
					tools = visibleTools(saved, runtime);
				}
				const trial = inTrial({ ...saved, verify });
				const head =
					verify.status === "verified"
						? `MCP ${name} 已登记并通过验证（握手 + 工具列表），${tools.length} 个工具`
						: verify.status === "failed"
							? `MCP ${name} 已登记，但验证失败：${verify.error ?? "未知原因"}。条目已入册（状态 failed），排查后用 mcp_verify {name:"${name}"} 重试`
							: `MCP ${name} 已登记（未验证：verify=false 跳过了试连）；需要时用 mcp_verify {name:"${name}"} 验证`;
				const tail = trial ? "。试运行中：只放行只读工具，确认可信后 mcp_verify {name:\"" + name + "\", promote:true} 转正" : "";
				return clean({ ok: true, name: saved.name, toolCount: tools.length, tools: tools.map((t) => t.name), verify, trial, message: head + tail });
			}
		}),
		defineTool({
			name: "mcp_unregister",
			description: "注销一个 MCP 服务器：断开连接、移出注册表并出一条版本记录。可恢复：skillmgr_rollback {target:\"mcp-registry\", versionId:<返回的 restoreVersionId>}，凭据会按本机暂存补回。",
			parameters: {
				name: { type: "string", description: "服务器名", required: true },
				reason: { type: "string", description: "可选：注销原因（写进版本记录）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						name: { type: "string" },
						versionId: { type: "string" },
						restoreVersionId: { type: "string" },
						message: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.message ?? "") }]
			},
			async execute(args) {
				const name = String(args.name ?? "").trim();
				const result = await unregisterServer(store, runtime, name, args.reason);
				if (!result.removed) throw new Error("未登记的 MCP：" + name);
				options.onChange?.();
				return clean({
					ok: true,
					name,
					...(result.versionId ? { versionId: result.versionId } : {}),
					...(result.restoreVersionId ? { restoreVersionId: result.restoreVersionId } : {}),
					message:
						`已注销 MCP ${name}` +
						(result.versionId ? `（版本 ${result.versionId}）` : "") +
						(result.restoreVersionId ? `。要恢复：skillmgr_rollback {target:"mcp-registry", versionId:"${result.restoreVersionId}"}` : "")
				});
			}
		}),
		defineTool({
			name: "mcp_verify",
			description: "重新验证一个 MCP（真实握手 + 工具列表），刷新验证状态；成功会顺带复位熔断。reset: true 无论成败都复位熔断；promote: true 在验证通过时结束试运行（放开可写工具）。",
			parameters: {
				name: { type: "string", description: "服务器名", required: true },
				reset: { type: "boolean", description: "true = 手动复位熔断（即使这次验证失败）" },
				promote: { type: "boolean", description: "true = 验证通过后转正（trial → false，放开可写工具）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						name: { type: "string" },
						verify: { type: "object", additionalProperties: true },
						breaker: { type: "object", additionalProperties: true },
						trial: { type: "boolean" },
						promoted: { type: "boolean" },
						toolCount: { type: "number" },
						message: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.message ?? "") }]
			},
			async execute(args) {
				const result = await verifyServer(store, runtime, String(args.name ?? "").trim(), args);
				options.onChange?.();
				return result;
			}
		}),
		defineTool({
			name: "mcp_load",
			description: "加载（或热重载）一个 on-demand MCP：返回完整工具定义（含 inputSchema）。默认用内存缓存，换 filter / limit 不会重连；传 refresh: true 才重连重拉。",
			parameters: {
				name: { type: "string", description: "服务器名", required: true },
				peek: { type: "boolean", description: "true 时只返回已缓存的工具定义，不建立连接" },
				filter: {
					type: "string",
					description: "只返回名字或描述包含这个子串的工具（大小写不敏感）。工具多的服务器（上百个）先过滤再取"
				},
				limit: { type: "number", description: "最多返回多少个工具，默认 30，上限 100" },
				refresh: { type: "boolean", description: "true 时忽略内存缓存，重连上游重拉一遍工具清单。默认用缓存——只换 filter / limit 不会重连" }
			},
			output: mcpOutputSchema((_args, value) => [
				{ type: "text", text: value.summary }
			]),
			async execute(args) {
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === String(args.name ?? ""));
				if (entry === undefined) throw new Error("未登记的 MCP：" + String(args.name ?? ""));
				if (entry.tier === "disabled") throw new Error("MCP \"" + entry.name + "\" 已禁用，先改档位再加载");
				if (args.peek !== true) runtime.assertBreaker(entry.name);
				let tools;
				if (args.peek === true) {
					if (runtime.cachedTools(entry.name).length === 0) {
						throw new Error("MCP \"" + entry.name + "\" 还没有缓存工具，先不带 peek 调一次 mcp_load");
					}
					tools = visibleTools(entry, runtime);
				} else {
					// 缓存优先：同一个 server 反复 load（换 filter / 换 limit）不该每次都重连。
					// 缓存为空时自动连；上游加了工具、或怀疑清单过期时传 refresh: true。
					if (args.refresh === true || runtime.cachedTools(entry.name).length === 0) {
						// B7：ensure 建连时已经列过一次工具（slot.tools），不再紧跟着 refreshTools 再拉一遍
						await runtime.reclaim(entry.name);
						await runtime.ensure(entry);
						// 上游工具集可能变了（换档位、服务器自己加了工具），把新清单落盘，
						// 否则重启后又读回旧缓存，面板数字和实际对不上。
						const fresh = runtime.cachedTools(entry.name);
						if (fresh.length > 0 && fresh.length !== (entry.tools ?? []).length) {
							await store.upsert({ ...withoutVerify(entry), tools: slimTools(fresh) });
						}
					}
					tools = visibleTools(entry, runtime);
				}
				const needle = String(args.filter ?? "").trim().toLowerCase();
				const cap = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
				const matched =
					needle === ""
						? tools
						: tools.filter((t) => (t.name + " " + (t.description ?? "")).toLowerCase().includes(needle));
				const shown = matched.slice(0, cap);
				const trialNow = inTrial(runtime.effective(entry));
				const lines = shown.map((t) => {
					const write = classifyTool(entry, t).access === "write";
					const mark = write ? (trialNow ? " [可写·试运行中不可调]" : " [可写]") : " [只读]";
					return "- " + t.name + mark + ": " + (t.description ?? "") + "\n  inputSchema: " + JSON.stringify(t.inputSchema ?? {});
				});
				const head =
					"MCP \"" +
					entry.name +
					"\"（" +
					entry.tier +
					"，" +
					entry.transport +
					"）" +
					(needle === "" ? "" : " · 过滤「" + needle + "」") +
					" · 共 " +
					tools.length +
					" 个工具" +
					(matched.length !== tools.length ? "，命中 " + matched.length : "") +
					(shown.length < matched.length ? "，只列前 " + shown.length + " 个（加 limit / 缩小 filter）" : "");
				const summary = [head, entry.notes ? "备注：" + entry.notes : "", ...lines].filter((l) => l !== "").join("\n");
				return clean({ content: [{ type: "text", text: summary }], summary });
			}
		}),
		defineTool({
			name: "mcp_call",
			description: "调用某个 MCP 的工具。单个用 tool+args；一批用 calls: [{tool, args}, ...]，按顺序执行、某个失败不中断。on-demand 服务器按需连接，空闲被回收过的会先自动重连。",
			parameters: {
				name: { type: "string", description: "服务器名", required: true },
				tool: { type: "string", description: "该服务器上的工具名（不带 mcp__ 前缀）。只调一个时用；调多个用 calls" },
				args: { type: "object", additionalProperties: true, description: "工具参数对象（配 tool 用）" },
				calls: {
					type: "array",
					description: "一次调多个工具：每项 {tool, args}，按顺序执行，某个失败不中断后面的。工具之间没有依赖时用它省往返",
					items: { type: "object", additionalProperties: true }
				}
			},
			output: mcpOutputSchema((_args, value) => [{ type: "text", text: resultText(value) }]),
			async execute(args) {
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === String(args.name ?? ""));
				if (entry === undefined) throw new Error("未登记的 MCP：" + String(args.name ?? ""));
				if (entry.tier === "disabled") throw new Error("MCP \"" + entry.name + "\" 已禁用");
				// 一次一个（tool）或一次一组（calls）。一组按顺序跑，某个失败不影响后面的。
				const batch = [];
				if (Array.isArray(args.calls)) {
					for (const item of args.calls) {
						if (item && typeof item.tool === "string" && item.tool !== "") batch.push({ tool: item.tool, args: item.args });
					}
				}
				const viaCalls = batch.length > 0;
				if (viaCalls === false) {
					const toolName = String(args.tool ?? "");
					if (toolName === "") throw new Error("tool 不能为空（一次调多个用 calls 传 [{tool, args}, ...]）");
					batch.push({ tool: toolName, args: args.args });
				}
				// 白名单只影响「看不看得见」是不够的：模型知道名字就能直接调，
				// 所以调用入口也按同一份可见集合拦一次。
				// S-08：冷缓存时 visible 为空，旧判断 `visible.length > 0 && …` 会让 allow
				// 模式形同虚设 —— 配了过滤器就先 ensure 把工具集拉起来，拉不到就拒绝。
				const filterMode = entry.toolFilter?.mode;
				const filtered = filterMode === "allow" || filterMode === "deny";
				let visible = visibleTools(entry, runtime);
				let filterLoadError = null;
				if (filtered && visible.length === 0) {
					try {
						await runtime.ensure(entry);
						visible = visibleTools(entry, runtime);
					} catch (error) {
						filterLoadError = error instanceof Error ? error.message : String(error);
					}
				}
				const visibleNames = new Set(visible.map((t) => t.name));
				const single = viaCalls === false || batch.length === 1;
				const parts = [];
				let only = null;
				for (const item of batch) {
					const label = single ? "" : "### " + item.tool + "\n";
					if (filtered && filterLoadError !== null) {
						parts.push(label + "工具集加载失败，白名单无法判定，已拒绝调用：" + filterLoadError);
						continue;
					}
					if (filtered && visibleNames.has(item.tool) === false) {
						parts.push(label + "已被过滤规则排除，不在 \"" + entry.name + "\" 的可见集合里");
						continue;
					}
					try {
						const result = await runtime.call(entry, item.tool, typeof item.args === "object" && item.args !== null ? item.args : {});
						if (result?.isError === true) throw new Error(resultText(result));
						const projected = clean(projectResult(result, item.tool));
						if (single) only = projected;
						parts.push(label + resultText(result));
					} catch (error) {
						parts.push(label + "失败：" + (error instanceof Error ? error.message : String(error)));
					}
				}
				if (single && only !== null) return only;
				return { content: [{ type: "text", text: parts.join("\n\n") }] };
			}
		}),
		defineTool({
			name: "mcp_takeover",
			description: "接管 profile 里已有的原生 MCP：禁用 cordis.patch.yml 里那条 dsh-mcp-client 行，改由本插件的按需加载接管。需要重启 DSH 才生效。",
			parameters: {
				name: { type: "string", description: "服务器名（mcp_list 里带「来自 cordis.patch.yml」的那些）", required: true }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						name: { type: "string" },
						rowId: { type: "string" },
						// override = bundle 型，写到 profile 层按 id 覆盖；in-place = profile 自己的行原地插
						via: { type: "string" },
						changed: { type: "boolean" },
						restartRequired: { type: "boolean" }
					}
				},
				render: (_args, value) => [
					{
						type: "text",
						text:
							"已接管 " +
							value.name +
							"（原生行 " +
							value.rowId +
							(value.changed ? " 已禁用" : " 本来就是禁用") +
							"）。重启 DSH 后由本插件按需连接。"
					}
				]
			},
			async execute(args) {
				if (typeof options.takeover !== "function") throw new Error("接管不可用：这个 profile 没有可写的 cordis.patch.yml");
				return clean(await options.takeover(String(args.name ?? "")));
			}
		}),
		defineTool({
			name: "mcp_update_check",
			description:
				"只读检查已登记的 MCP server 有没有新版。按来源自动判定：npm 包比 registry 的 latest、本地 .git 比 origin HEAD、备注里写明的 owner/repo@sha。远程 HTTP 端点与纯本地目录落「无法判定」并说明原因。不下载、不更新、不改注册表；版本只报「相同/不同」并把两端版本号一起给出。",
			parameters: {
				name: { type: "string", description: "可选：只查这一个 server（默认查全部已登记的）" },
				timeoutMs: { type: "number", description: "可选：单个上游查询的超时毫秒数，默认 8000" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						totals: {
							type: "object",
							required: true,
							additionalProperties: false,
							properties: {
								total: { type: "number", required: true },
								determinable: { type: "number", required: true },
								behind: { type: "number", required: true },
								latest: { type: "number", required: true },
								unknownSource: { type: "number", required: true },
								failed: { type: "number", required: true }
							}
						},
						servers: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									name: { type: "string", required: true },
									via: { type: "string" },
									source: { type: "string" },
									localVersion: { type: "string" },
									remoteVersion: { type: "string" },
									status: { type: "string", required: true },
									note: { type: "string" }
								}
							}
						}
					}
				},
				render: (_args, value) => {
					const MARK = { behind: "[有新版]", latest: "[最新]", "unknown-source": "[无法判定]", failed: "[失败]" };
					const lines = [String(value.message ?? "")];
					for (const s of value.servers ?? []) {
						const ver =
							s.status === "behind"
								? String(s.localVersion || "?") + "→" + String(s.remoteVersion || "?")
								: String(s.localVersion || s.remoteVersion || "");
						lines.push(
							`- ${MARK[s.status] ?? "[?]"} ${s.name}` +
								(s.via ? `（${s.via}${s.source ? " " + s.source : ""}）` : "") +
								(ver ? " " + ver : "") +
								(s.note ? " · " + s.note : "")
						);
					}
					return [{ type: "text", text: lines.join("\n") }];
				}
			},
			async execute(args) {
				const state = await store.load();
				const only = typeof args?.name === "string" && args.name.trim() !== "" ? args.name.trim() : "";
				const targets = only === "" ? state.servers : state.servers.filter((s) => s.name === only);
				if (only !== "" && targets.length === 0) throw new Error("未登记的 MCP：" + only);
				const timeoutMs = typeof args?.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 8000;
				const servers = await checkServerUpdates(targets, { timeoutMs });
				const count = (status) => servers.filter((s) => s.status === status).length;
				const determinable = servers.filter((s) => s.via !== "" && s.status !== "unknown-source").length;
				return {
					ok: true,
					message:
						`已查 ${servers.length} 个 MCP（可判定 ${determinable}）` +
						` · 有新版 ${count("behind")} · 最新 ${count("latest")}` +
						` · 无法判定 ${count("unknown-source")} · 检查失败 ${count("failed")}`,
					totals: {
						total: servers.length,
						determinable,
						behind: count("behind"),
						latest: count("latest"),
						unknownSource: count("unknown-source"),
						failed: count("failed")
					},
					servers
				};
			}
		})
	];
}

/** 宿主 defineTool 的 parameters 只认这些属性字段，其余（$ref / pattern / format）丢掉。 */
const PARAM_PASSTHROUGH = ["description", "enum", "default", "items", "properties", "additionalProperties"];

/**
 * 把 MCP 工具的 inputSchema 映射成宿主 defineTool 的 parameters 形态（WO-FIX-3）。
 *
 * 旧实现只取 `inputSchema.properties`，`required` 整条丢掉，模型眼里所有参数都可选。
 * 这里把 required 数组还原成逐属性的 `required: true`，并只透传宿主认识的字段，
 * 保证注册出的约束与 mcp_load 返回的 schema 口径一致。
 */
export function toParameterSpec(inputSchema) {
	const properties = inputSchema?.properties;
	if (properties === null || typeof properties !== "object") return {};
	const required = new Set(Array.isArray(inputSchema?.required) ? inputSchema.required : []);
	const spec = {};
	for (const [key, raw] of Object.entries(properties)) {
		if (raw === null || typeof raw !== "object") continue;
		const param = {};
		const type = raw.type;
		if (typeof type === "string") param.type = type === "integer" ? "number" : type;
		else if (Array.isArray(type)) {
			const first = type.find((t) => typeof t === "string" && t !== "null");
			if (first !== undefined) param.type = first === "integer" ? "number" : first;
		}
		for (const field of PARAM_PASSTHROUGH) {
			if (raw[field] !== undefined) param[field] = raw[field];
		}
		if (required.has(key)) param.required = true;
		spec[key] = param;
	}
	return spec;
}

/** eager 档：把每个工具注册成 mcp__<server>__<tool>，execute 里懒重连。 */export async function buildEagerTools(store, runtime) {
	const state = await store.load();
	const tools = [];
	const eager = state.servers.filter((entry) => entry.tier === "eager");
	// B4：还没连上的 eager server 并行握手（以前逐台 await，启动时间是各台冷启动之和，
	// 一台握手超时 45 秒就把后面的全拖住）。结果仍按注册表顺序拼，失败的那台跳过。
	const settled = await Promise.allSettled(
		eager.map(async (entry) => {
			// 注册 eager 工具要完整 inputSchema，只能来自活连接；注册表里只有瘦缓存，不能当数据源
			if (runtime.cachedTools(entry.name).length === 0) await runtime.ensure(entry);
			return visibleTools(entry, runtime);
		})
	);
	for (let i = 0; i < eager.length; i += 1) {
		const entry = eager[i];
		const outcome = settled[i];
		if (outcome.status === "rejected") {
			runtime.logger?.warn?.("[dsh-studio] eager MCP 连接失败 " + entry.name + "：" + String(outcome.reason));
			continue;
		}
		const cached = outcome.value;
		for (const tool of cached) {
			tools.push(
				defineTool({
					name: publicToolName(entry.name, tool.name),
					description: tool.description ?? "",
					parameters: toParameterSpec(tool.inputSchema),
					output: mcpOutputSchema((_args, value) => [{ type: "text", text: resultText(value) }]),
					async execute(args) {
						const latest = (await store.load()).servers.find((s) => s.name === entry.name);
						if (latest === undefined) throw new Error("MCP 已被删除：" + entry.name);
						const result = await runtime.call(latest, tool.name, typeof args === "object" && args !== null ? args : {});
						if (result?.isError === true) throw new Error(resultText(result));
						return clean(projectResult(result, tool.name));
					}
				})
			);
		}
	}
	return tools;
}

/**
 * 本轮目录的候选：非 disabled、且没在熔断中。
 * buildMcpCatalog 与遥测的 catalog.inject 共用这一份口径。
 */
export function catalogCandidateServers(state, runtime) {
	const active = state.servers.filter((entry) => entry.tier !== "disabled");
	const candidates = [];
	const tripped = [];
	for (const entry of active) {
		if (runtime.breaker?.state(entry.name) === "open") tripped.push(entry);
		else candidates.push(entry);
	}
	return { candidates, tripped };
}

const VERIFY_LABEL = { verified: "已验证", unverified: "未验证", failed: "验证失败" };

/** 一个 server 的目录条目（是什么 / 何时用 / 何时别用 / 读写 / 验证状态 + 工具名）。 */
export function renderCatalogEntry(entry, runtime) {
	const tools = visibleTools(entry, runtime);
	const gov = governanceOf(entry, runtime);
	const v = gov.verify;
	const verifyText = v.status === "failed" && v.error ? `${VERIFY_LABEL.failed}：${clampText(v.error, 80)}` : VERIFY_LABEL[v.status];
	const flags = [
		entry.tier,
		`${tools.length} 个工具`,
		`只读 ${gov.access.read} / 可写 ${gov.access.write}`,
		verifyText,
		...(gov.trial ? ["试运行：只放只读"] : [])
	];
	const lines = ["- `" + entry.name + "`（" + flags.join("，") + "）"];
	const c = gov.catalog;
	if (c.summary) lines.push("  是什么：" + c.summary);
	if (c.useWhen.length > 0) lines.push("  何时用：" + c.useWhen.join("；"));
	if (c.avoidWhen.length > 0) lines.push("  何时别用：" + c.avoidWhen.join("；"));
	// 只给名字不给描述：名字足够判断该不该 load，描述等 mcp_load 再取。
	// 列全描述时 craft-anything 一个就占 49K 字符，等于抵消掉 on-demand 的意义。
	const writeSet = new Set(gov.access.writeTools);
	const names = tools.map((t) => {
		const hint = c.tools[t.name];
		const parts = [hint?.use ? clampText(hint.use, 40) : "", hint?.avoid ? "别用：" + clampText(hint.avoid, 40) : ""].filter((x) => x !== "");
		return t.name + (parts.length > 0 ? `（${parts.join("；")}）` : "");
	});
	lines.push("  工具：" + (names.length === 0 ? "（没有可用工具）" : names.join("、")));
	if (writeSet.size > 0 && writeSet.size < tools.length) lines.push("  其中可写：" + [...writeSet].join("、"));
	return lines.join("\n");
}

/** 系统提示里那段目录：只有名字 + 目录条目，绝不放 schema。 */
export async function buildMcpCatalog(store, runtime) {
	const state = await store.load();
	const { candidates, tripped } = catalogCandidateServers(state, runtime);
	if (candidates.length === 0 && tripped.length === 0) return null;
	const out = [
		"## MCP 服务器（按需加载）",
		"",
		"下列 MCP 服务器由 dsh-studio 统一管理，只给目录、不预先连接（选中后第一次调用才连）。每条给出：是什么、何时用、何时别用、读写分级、验证状态；没有参数定义：",
		"",
		candidates.length > 0 ? candidates.map((entry) => renderCatalogEntry(entry, runtime)).join("\n") : "（当前没有可用的 MCP 服务器）"
	];
	if (tripped.length > 0) {
		out.push("", "暂时摘除（熔断中，不要调用；到点会自动半开试探）：");
		for (const entry of tripped) {
			const b = runtime.breaker.snapshot(entry.name);
			out.push("- `" + entry.name + "`：连续失败 " + b.failures + " 次（" + b.cause + "），预计 " + b.until + " 恢复；确认恢复可 `mcp_verify {name}` 手动复位");
		}
	}
	out.push(
		"",
		"用法：`mcp_call {name, tool, args}` 直接执行即可，**不需要先 load**——它自己会连接。参数拿不准时用 `mcp_load {name, filter: \"关键词\"}` 取回 inputSchema；多个工具之间没有依赖时用 `mcp_call {name, calls: [{tool, args}, ...]}` 一次跑完。`mcp_list` 看档位、连接与验证状态。试运行中的 server 只能调只读工具。eager 档的工具已直接注册成 `mcp__<server>__<tool>`，可以直接调。"
	);
	return out.join("\n");
}

/**
 * 试连一次、把工具清单抄进缓存，然后断开。
 * 给 disabled 档用：不接管、不常驻，但你得能看到它有哪些工具（否则白名单没法勾）。
 */
export async function prefetchTools(store, runtime, name, logger) {
	const state = await store.load();
	const entry = state.servers.find((s) => s.name === name);
	if (entry === undefined) throw new Error("未登记的 MCP：" + name);
	const conn = new McpConnection(transportSpec(entry), { timeoutMs: 30000 });
	try {
		await conn.connect();
		const tools = await conn.listTools();
		runtime.slot(entry.name).tools = tools;
		runtime.slot(entry.name).error = undefined;
		await store.upsert({ ...withoutVerify(entry), tools: slimTools(tools) });
		return tools;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.slot(entry.name).error = message;
		logger?.warn?.(`[dsh-studio] 拉取 ${name} 的工具失败：${message}`);
		throw error;
	} finally {
		await conn.close().catch(() => {});
	}
}

/** 设置页与外部脚本用的 HTTP 面。onChange 在注册表变动后回调，供上层重挂 eager 工具与目录段。 */
export function buildMcpRoutes(store, runtime, options = {}) {
	const json = (res, status, body) => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	};
	const readBody = async (req) => {
		const chunks = [];
		let size = 0;
		// C6：与其它路由同一个上限，超了明说（以前这组路由没有上限）
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_JSON_BODY_BYTES) throw bodyTooLarge();
			chunks.push(chunk);
		}
		const raw = Buffer.concat(chunks).toString("utf8");
		if (raw.trim() === "") return {};
		return JSON.parse(raw);
	};
	// 全部 MCP 路由都只服务本机面板（WO-SEC-2）：注册/预取/重载能 spawn 任意
	// stdio 命令，凭据路由能吐明文，跨站请求必须在进 handler 之前就挡掉。
	const wrap = (fn) => async (req, res) => {
		if (!isLocalRequest(req)) {
			json(res, 403, { error: "forbidden: loopback-only" });
			return;
		}
		try {
			await fn(req, res);
		} catch (error) {
			json(res, error?.statusCode === 413 ? 413 : 400, { error: error instanceof Error ? error.message : String(error) });
		}
	};
	return [
		{
			// 审计 1：注册表损坏闸——GET 看状态，POST {confirm:true} = 所有者确认并解闸（坏文件仍留档）
			kind: "exact",
			path: "/api/dsh-studio/mcp/registry-corrupt",
			handler: wrap(async (req, res) => {
				if (req.method === "GET") {
					json(res, 200, { ok: true, hold: (await store.corruptStatus()) ?? null });
					return;
				}
				if (req.method === "POST") {
					const body = await readBody(req);
					if (body?.confirm !== true) {
						json(res, 400, { error: "需要 {confirm: true}：确认后写入将从当前（空）注册表起算，坏文件留档不删" });
						return;
					}
					json(res, 200, await store.acknowledgeCorrupt());
					return;
				}
				json(res, 405, { error: "method not allowed" });
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp",
			handler: wrap(async (req, res) => {
				const state = await store.load();
				if (req.method === "GET") {
					const registryCorrupt = await store.corruptStatus?.();
					json(res, 200, {
						ok: true,
						...(registryCorrupt ? { registryCorrupt } : {}),
						// 审计 9：面板徽标用的守卫状态
						...(typeof options.builtinStatus === "function" ? { builtin: options.builtinStatus() } : {}),
						idleTimeoutMinutes: state.idleTimeoutMinutes,
						toolDescriptionMaxLength: state.toolDescriptionMaxLength,
						servers: state.servers.map((entry) => describeEntry(entry, runtime, state))
					});
					return;
				}
				if (req.method === "POST") {
					const body = await readBody(req);
					if (typeof body.name !== "string") {
						json(res, 400, { error: "name is required" });
						return;
					}
					const previous = state.servers.find((s) => s.name === body.name);
					const { verify: _ignored, ...input } = body;
					const next = previous === undefined ? normalizeEntry({ ...input }, undefined) : normalizeEntry({ ...previous, ...input }, previous);
					// 面板新增同样以试运行入册；换了端点验证状态回到 unverified
					if (previous === undefined && typeof input.trial !== "boolean") input.trial = true;
					if (endpointChanged(previous, next)) {
						input.verify = { status: "unverified", checkedAt: null, via: "panel" };
						runtime.verifyState.delete(body.name);
						await runtime.reclaim(body.name, "config");
					}
					const entry = await store.upsert(input);
					options.onChange?.();
					json(res, 200, { ok: true, server: describeEntry(entry, runtime, state) });
					return;
				}
				if (req.method === "DELETE") {
					const url = new URL(req.url ?? "/", "http://127.0.0.1");
					const name = url.searchParams.get("name") ?? "";
					// 与 mcp_unregister 同一条路径：出版本记录、凭据暂存、可回滚
					const result = await unregisterServer(store, runtime, name, url.searchParams.get("reason") ?? undefined);
					if (result.removed) options.onChange?.();
					json(res, 200, { ok: result.removed, versionId: result.versionId, restoreVersionId: result.restoreVersionId });
					return;
				}
				json(res, 405, { error: "method not allowed" });
			})
		},
		{
			// · B：注销（POST 形态，脚本 / 面板都好用；DELETE /mcp 走的是同一个函数）
			kind: "exact",
			path: "/api/dsh-studio/mcp/unregister",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				const result = await unregisterServer(store, runtime, name, body.reason);
				if (!result.removed) {
					json(res, 404, { error: "未登记的 MCP：" + name });
					return;
				}
				options.onChange?.();
				json(res, 200, { ok: true, name, versionId: result.versionId, restoreVersionId: result.restoreVersionId });
			})
		},
		{
			// · C / F：手动重验 / 复位熔断 / 转正
			kind: "exact",
			path: "/api/dsh-studio/mcp/verify",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				const result = await verifyServer(store, runtime, typeof body.name === "string" ? body.name : "", body);
				options.onChange?.();
				json(res, 200, result);
			})
		},
		{
			// · E：目录（可查询形态）——每个 server 的目录条目、验证状态、读写分级、健康与熔断，
			// 外加本轮注入给模型的目录原文与内建 MCP 管理的只读镜像。
			kind: "exact",
			path: "/api/dsh-studio/mcp/catalog",
			handler: wrap(async (req, res) => {
				if (req.method !== "GET") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const state = await store.load();
				const { candidates, tripped } = catalogCandidateServers(state, runtime);
				const row = (entry) => ({ name: entry.name, tier: entry.tier, toolCount: visibleTools(entry, runtime).length, connected: runtime.connected(entry.name), ...governanceOf(entry, runtime) });
				json(res, 200, clean({
					ok: true,
					schema: state.version,
					candidates: candidates.map(row),
					tripped: tripped.map(row),
					disabled: state.servers.filter((s) => s.tier === "disabled").map((s) => s.name),
					text: await buildMcpCatalog(store, runtime),
					...(typeof options.builtinStatus === "function" ? { builtin: options.builtinStatus() } : {})
				}));
			})
		},
		{
			// 凭据明文的唯一出口：面板点「显示 / 复制」时才按需取一条。
			// 这个路由必须留在 loopback 内，且不进 describeEntry 的序列化结果。
			kind: "exact",
			path: "/api/dsh-studio/mcp/credential",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === body.name);
				if (entry === undefined) {
					json(res, 404, { error: "没有这个 MCP 条目" });
					return;
				}
				const value = credentialValue(entry, String(body.kind ?? ""), String(body.key ?? ""));
				if (value === null) {
					json(res, 404, { error: "没有这条凭据" });
					return;
				}
				json(res, 200, { ok: true, value });
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/settings",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				if (body.idleTimeoutMinutes !== undefined) await store.patchSetting("idleTimeoutMinutes", body.idleTimeoutMinutes);
				if (body.toolDescriptionMaxLength !== undefined) await store.patchSetting("toolDescriptionMaxLength", body.toolDescriptionMaxLength);
				const state = await store.load();
				json(res, 200, { ok: true, idleTimeoutMinutes: state.idleTimeoutMinutes, toolDescriptionMaxLength: state.toolDescriptionMaxLength });
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/update-check",
			handler: wrap(async (req, res) => {
				// 会联网查 npm registry / git ls-remote，所以只在面板点按钮或工具调用时跑
				if (req.method !== "GET") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const only = url.searchParams.get("name") ?? "";
				const state = await store.load();
				const targets = only === "" ? state.servers : state.servers.filter((s) => s.name === only);
				if (only !== "" && targets.length === 0) {
					json(res, 404, { error: "未登记的 MCP：" + only });
					return;
				}
				const servers = await (options.checkUpdates ?? checkServerUpdates)(targets);
				const count = (status) => servers.filter((s) => s.status === status).length;
				json(res, 200, {
					ok: true,
					servers,
					totals: {
						total: servers.length,
						determinable: servers.filter((s) => s.via !== "" && s.status !== "unknown-source").length,
						behind: count("behind"),
						latest: count("latest"),
						unknownSource: count("unknown-source"),
						failed: count("failed")
					}
				});
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/takeover",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				if (typeof options.takeover !== "function") {
					json(res, 400, { error: "接管不可用：这个 profile 没有可写的 cordis.patch.yml" });
					return;
				}
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				json(res, 200, await options.takeover(name));
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/prefetch",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				const tools = await prefetchTools(store, runtime, name, options.logger);
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === name);
				json(res, 200, { ok: true, toolCount: tools.length, server: entry ? describeEntry(entry, runtime, state) : null });
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/tools",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				const mode = typeof body.mode === "string" ? body.mode : "all";
				if (mode !== "all" && mode !== "allow" && mode !== "deny") {
					json(res, 400, { error: "mode 必须是 all / allow / deny" });
					return;
				}
				const names = Array.isArray(body.names) ? body.names.filter((x) => typeof x === "string") : [];
				// 读-改-写走串行链（A2）：与 upsert / remove 交错时不再互相覆盖
				const done = await store.serial(async () => {
					const state = await store.load();
					const entry = state.servers.find((s) => s.name === name);
					if (entry === undefined) return null;
					entry.toolFilter = { mode, names };
					await store.save(state);
					return { entry, state };
				});
				if (done === null) {
					json(res, 404, { error: "not found: " + name });
					return;
				}
				options.onChange?.();
				json(res, 200, { ok: true, server: describeEntry(done.entry, runtime, done.state) });
			})
		},
		{
			kind: "exact",
			path: "/api/dsh-studio/mcp/reload",
			handler: wrap(async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				await runtime.reclaim(name);
				const state = await store.load();
				const entry = state.servers.find((s) => s.name === name);
				if (entry === undefined) {
					json(res, 404, { error: "not found: " + name });
					return;
				}
				await runtime.ensure(entry);
				json(res, 200, { ok: true, server: describeEntry(entry, runtime, state) });
			})
		}
	];
}

/**
 * 只比名字集合、不比描述：上游改一句描述就重写一次文件没有意义，
 * 而「加了一个工具」「删了一个工具」正是面板会骗人的那种变化。
 */
function sameToolNames(a, b) {
	const names = (list) => new Set((Array.isArray(list) ? list : []).map((t) => t?.name).filter((n) => typeof n === "string"));
	const left = names(a);
	const right = names(b);
	if (left.size !== right.size) return false;
	for (const name of left) if (!right.has(name)) return false;
	return true;
}

/**
 * 把一次真实观测到的工具清单写回注册表。
 *
 * 这是「缓存自己刷新」的落点：任何一次连接（mcp_call / mcp_load / eager / 上游
 * list_changed 通知 / 定期复核）拿到的清单都会经过这里，所以用户不必记得点刷新。
 * 名字集合没变时只补一个 toolsCheckedAt 时间戳，避免每轮调用都改文件。
 */
export async function syncCatalogFromObserved(store, entryName, tools, logger) {
	const fresh = slimTools(tools);
	if (fresh.length === 0) return { changed: false, reason: "empty" };
	const state = await store.load();
	const current = state.servers.find((s) => s.name === entryName);
	if (current === undefined) return { changed: false, reason: "unregistered" };
	const before = Array.isArray(current.tools) ? current.tools.length : 0;
	const changed = !sameToolNames(current.tools, fresh);
	if (!changed && typeof current.toolsCheckedAt === "string") return { changed: false, reason: "unchanged", before, after: fresh.length };
	// 名字集合没变时不传 tools：让 upsert 沿用它自己手上的那份，别用本轮观测覆盖掉
	// 已经写好的描述（上游描述变化由名字变化带过来，不值得为它每次调用都改文件）。
	const base = withoutVerify(current);
	await store.upsert(changed ? { ...base, tools: fresh, toolsCheckedAt: new Date().toISOString() } : { ...base, toolsCheckedAt: new Date().toISOString() });
	if (changed) {
		logger?.info?.(`[dsh-studio] MCP ${entryName} 工具清单已自动同步：${before} → ${fresh.length}`);
	}
	return { changed, reason: changed ? "synced" : "stamped", before, after: fresh.length };
}

/**
 * 定期复核：对「从没核对过」或「上次核对早于 maxAgeMs」的条目试连一次、
 * 比对清单、立刻断开。让面板数字在没人调用的情况下也能自己跟上上游。
 *
 * 代价就是一轮冷启动（stdio 档会临时拉起子进程）；默认 24 小时一次，
 * 与「按需加载」的初衷不冲突：它只是偶尔问一句「你变了没」，问完就断。
 */
export async function revalidateCatalog(store, runtime, logger, options = {}) {
	const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_REVALIDATE_MS;
	const state = await store.load();
	const now = Date.now();
	const results = [];
	for (const entry of state.servers) {
		if (entry.tier === "disabled") continue;
		const stamp = Date.parse(typeof entry.toolsCheckedAt === "string" ? entry.toolsCheckedAt : "");
		if (Number.isFinite(stamp) && now - stamp < maxAgeMs) continue;
		const conn = typeof options.connect === "function" ? await options.connect(entry) : new McpConnection(transportSpec(entry), { timeoutMs: 30000 });
		try {
			await conn.connect();
			const tools = await conn.listTools();
			runtime.slot(entry.name).tools = tools;
			results.push({ name: entry.name, ...(await syncCatalogFromObserved(store, entry.name, tools, logger)) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger?.warn?.("[dsh-studio] MCP 清单复核失败 " + entry.name + "：" + message);
			results.push({ name: entry.name, changed: false, reason: "error", error: message });
			// 失败也打时间戳：节流按「尝试」算，否则坏掉的上游会被 6 小时一轮的
			// 定期复核反复冷启、各留一条警告，永远退不了场。条目已被删则跳过。
			try {
				const fresh = await store.load();
				const current = fresh.servers.find((s) => s.name === entry.name);
				if (current !== undefined) await store.upsert({ ...withoutVerify(current), toolsCheckedAt: new Date().toISOString() });
			} catch {
				// 打戳失败不掩盖原始错误，下一轮照常重试
			}
		} finally {
			await conn.close().catch(() => {});
		}
	}
	return results;
}

/**
 * 启动后用一次试连把每个 on-demand/eager 条目的工具缓存补齐（不留连接）。
 * · D：只补「还没有工具缓存」的条目（mode "missing"，默认）；mode "off" 一个都不连。
 * 这一次试连就是一次验证握手，出 mcp.verify（via boot），不算加载。
 */
export async function warmCatalog(store, runtime, logger, options = {}) {
	const mode = options.mode === "off" ? "off" : "missing";
	const state = await store.load();
	// 旧版本把完整 inputSchema 写进过注册表（能到 10 MB）；先压一次，之后每次 upsert 只存瘦缓存
	try {
		const info = await stat(storePath());
		if (info.size > SLIM_TRIGGER_BYTES) {
			// 串行链里重读再写（A2）：别拿进函数时的旧快照覆盖期间别人的改动
			await store.serial(async () => store.save(await store.load()));
			logger?.info?.(
				"[dsh-studio] MCP 注册表已瘦身：" + Math.round(info.size / 1024 / 1024) + " MB → 只保留工具名与截断描述"
			);
		}
	} catch {
		/* 文件还没建，不用压 */
	}
	for (const entry of state.servers) {
		if (entry.tier === "disabled") continue;
		if (Array.isArray(entry.tools) && entry.tools.length > 0) {
			// 注册表里只有名字 + 截断描述，不能当完整定义塞进 runtime
			// （eager 档要用 inputSchema 注册参数）。面板计数靠 visibleTools 回退到 entry.tools。
			continue;
		}
		if (mode === "off") continue;
		// 验证握手：拿到清单经 onToolsObserved 写回（顺手写 toolsCheckedAt），结论经 onVerified 写回
		const { verify, tools } = await runtime.verify(entry, { via: "boot" });
		if (verify.status === "verified") await syncCatalogFromObserved(store, entry.name, tools, logger);
		else logger?.warn?.("[dsh-studio] MCP 预热失败 " + entry.name + "：" + (verify.error ?? "未知原因"));
	}
}

export { SWEEP_INTERVAL_MS, storePath };
