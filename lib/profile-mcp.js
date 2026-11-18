/**
 * 从 profile 的 cordis.patch.yml 里认出「DSH 里已经有的 MCP」。
 *
 * 只做文本级解析，不做 YAML 求值：这些条目里有 `!!js` 表达式、行内注释、
 * 跨行字符串，任何通用 YAML 解析器都会把它们丢掉或改写。所以这里按行扫，
 * 只认 `@deepseek-ai/dsh-mcp-client` 的 insert 行，取值时跳过注释。
 *
 * 导入是「只读」的：把条目抄进 studio 注册表并放在停用档，不碰原文件。
 * 真要接管（禁用原生行、改由 studio 按需加载）走 setRowDisabled 的文本级插入，
 * 只加一行 `disabled: true`，config 一个字节都不动。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function stripQuotes(value) {
	const v = String(value ?? "").trim();
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
		return v.slice(1, -1);
	}
	return v;
}

/** `[ "a", "b" ]` → ["a","b"]。 */
function parseFlowSeq(raw) {
	const inner = String(raw ?? "").replace(/^\s*\[/, "").replace(/\]\s*$/, "");
	const out = [];
	const re = /"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g;
	let m;
	while ((m = re.exec(inner)) !== null) {
		const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
		if (value !== "") out.push(value);
	}
	return out;
}

/** 一行里没转义的双引号是不是奇数个（= 这一行结束时还停在一个没闭合的双引号标量里）。 */
const openDoubleQuote = (line) => (line.match(/(?<!\\)"/g) ?? []).length % 2 === 1;

/** 与 mcp.js 的 NAME_PATTERN 同一口径（那边 load 时会把不合规的名字静默丢掉）。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 去掉值后面的行内注释（` # …`），引号里的 # 不算。`command: "npx" # launcher` 此前会把整串连注释当成命令。
 */
function stripInlineComment(raw) {
	let quote = "";
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (quote !== "") {
			if (ch === "\\" && quote === '"') i += 1;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "#" && i > 0 && /\s/.test(raw[i - 1])) return raw.slice(0, i).trimEnd();
	}
	return raw;
}

/**
 * YAML 的行尾反斜杠续行先折叠成一行，否则 `!!js` 那种跨行表达式读不完整。
 * 续行只在**没闭合的双引号标量**里才成立。此前任何以 `\` 结尾的行都折——Windows 路径 `cwd: D:\tools\alpha\`
 * 会把下一行吞进来：这一行的 cwd 变成 `D:\tools\alpha- id: mcp-b`，下一个 server 整行消失。
 */
function foldContinuations(lines) {
	const out = [];
	for (let i = 0; i < lines.length; i += 1) {
		let line = lines[i];
		while (line.endsWith("\\") && openDoubleQuote(line) && i + 1 < lines.length) {
			line = line.slice(0, -1) + lines[i + 1].trim();
			i += 1;
		}
		out.push(line);
	}
	return out;
}

/**
 * 扫出一份 patch 文本里所有 dsh-mcp-client 行。
 * @returns {{rowId:string,line:number,disabled:boolean,config:object,dynamic:string[]}[]}
 */
export function parseMcpRows(text) {
	const lines = foldContinuations(String(text ?? "").split(/\r?\n/));
	const rows = [];
	let cur = null;
	let inEnv = false;
	let inHeaders = false;
	let inArgs = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const idMatch = /^(\s*)- id:\s*(\S+)\s*$/.exec(line);
		if (idMatch !== null) {
			if (cur !== null) rows.push(cur);
			cur = {
				rowId: stripQuotes(idMatch[2]),
				line: i,
				indent: idMatch[1].length,
				isMcp: false,
				disabled: false,
				config: {},
				dynamic: []
			};
			inEnv = false;
			continue;
		}
		if (cur === null) continue;
		if (/^\s*name:\s*["']?@deepseek-ai\/dsh-mcp-client["']?\s*$/.test(line)) {
			cur.isMcp = true;
			continue;
		}
		if (/^\s*disabled:\s*true\s*$/.test(line)) {
			cur.disabled = true;
			continue;
		}
		// 块式 args 的子项（`- 值`）不匹配 key: value，要在 kv 解析之前接住，
		// 否则整段 args 丢失，按需加载时会用空参数起进程
		if (inArgs === true) {
			const item = /^\s*-\s+(.*)$/.exec(line);
			if (item !== null) {
				const value = stripQuotes(item[1].trim());
				if (value !== "") cur.config.args.push(value);
				continue;
			}
			inArgs = false;
		}
		const kv = /^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
		if (kv === null) continue;
		const indent = kv[1].length;
		const key = kv[2];
		const raw = stripInlineComment(kv[3].trim());
		if (raw.startsWith("#")) continue;
		const configIndent = cur.indent + 4;
		if (key === "args" && raw === "") {
			inArgs = true;
			inEnv = false;
			inHeaders = false;
			cur.config.args = [];
			continue;
		}
		if (key === "env" && raw === "") {
			inEnv = true;
			inHeaders = false;
			inArgs = false;
			continue;
		}
		if (key === "headers" && raw === "") {
			inHeaders = true;
			inEnv = false;
			inArgs = false;
			cur.config.headers = cur.config.headers ?? {};
			continue;
		}
		// headers 是块式的，子项（Authorization 之类）要收进对象，否则连接时没鉴权
		if (inHeaders && indent > configIndent) {
			cur.config.headers = cur.config.headers ?? {};
			cur.config.headers[key] = stripQuotes(raw);
			continue;
		}
		if (inEnv && indent > configIndent) {
			cur.config.env = cur.config.env ?? {};
			if (raw.startsWith("!!js")) {
				// 典型写法：'D:/tools/x/bin;...' + process.env.PATH
				// 前缀是字面量，直接拿出来，运行时拼到父进程的同名变量前面。
				// `+` 后面常常换行，所以把下一行的 process.env.X 接上再匹配。
				let expr = raw;
				if (!/process\.env\./.test(expr) && i + 1 < lines.length && /^\s*process\.env\./.test(lines[i + 1])) {
					expr = `${expr} ${lines[i + 1].trim()}`;
				}
				const m = /^!!js\s*['"]([\s\S]*?)['"]\s*\+\s*process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*"?\s*$/.exec(expr);
				if (m !== null) {
					cur.config.envPrefix = cur.config.envPrefix ?? {};
					// 外层双引号里还套着 JS 的单引号，两端都剥掉
					cur.config.envPrefix[m[2]] = m[1].replace(/^['"]/, "").replace(/['"]$/, "");
				} else {
					// 别的动态表达式拿不到值，记下来让上层决定
					cur.dynamic.push(key);
					cur.config.env[key] = null;
				}
			} else {
				cur.config.env[key] = stripQuotes(raw);
			}
			continue;
		}
		inEnv = false;
		if (indent !== configIndent) continue;
		if (key === "args") {
			cur.config.args = parseFlowSeq(raw);
		} else if (key === "headers") {
			// 块式 headers 已在上面的分支收完；这里只剩少见的一行式写法，留给上层手填
		} else {
			cur.config[key] = stripQuotes(raw);
		}
	}
	if (cur !== null) rows.push(cur);
	return rows.filter((row) => row.isMcp && typeof row.config.serverName === "string" && row.config.serverName !== "");
}

export function profilePatchPath(dshHome, profile) {
	return `${dshHome}/profiles/${profile}/cordis.patch.yml`;
}

/** 这条 patch 是不是 bundle 自带的（在 node_modules 里）：升级 / pnpm install 会整份重写。 */
export function isBundlePatchPath(patchPath) {
	return /[\\/]node_modules[\\/]/.test(String(patchPath ?? ""));
}

/**
 * bundle patch 的覆盖层：profile 自己的 cordis.patch.yml（`<profileDir>/node_modules/<bundle>/cordis.patch.yml`
 * → `<profileDir>/cordis.patch.yml`，与 index.js 传给 reconcileProfileMcp 的 overridePath 同一处）。
 * 不是 bundle patch 返回 null。
 */
export function overridePathOf(patchPath) {
	const m = /^(.*?)([\\/])node_modules[\\/]/.exec(String(patchPath ?? ""));
	return m === null ? null : `${m[1]}${m[2]}cordis.patch.yml`;
}

/**
 * profile 层覆盖文本里，顶层 `- id: <rowId>` 块直属的 `disabled:` 标记 → Map<rowId, boolean>。
 * 块里没写 disabled 的不收（loader 按键覆盖：没写的键沿用 bundle 行自己的值）。
 */
export function parseOverrideFlags(text) {
	const out = new Map();
	let cur = null;
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const id = /^- id:\s*(\S+)\s*$/.exec(line);
		if (id !== null) {
			cur = stripQuotes(id[1]);
			continue;
		}
		if (/^\S/.test(line)) {
			cur = null;
			continue;
		}
		if (cur === null) continue;
		const flag = /^ {2}disabled:\s*(true|false)\s*(#.*)?$/.exec(line);
		if (flag !== null) out.set(cur, flag[1] === "true");
	}
	return out;
}

/**
 * B7：按 (mtimeMs, size) 缓存某个 patch 文件的解析结果。McpStore.load 每次（含缓存命中）都要把
 * 原生状态重算一遍，以前每次都把 patch 文件读一遍、整份重新解析。文件没变就只 stat 一次。
 * 解析结果按调用方给的 parse 函数分开存；返回值调用方只读不改。
 * @template T
 * @param {string} file
 * @param {(text: string) => T} parse
 * @param {() => T} missing 文件读不到时的结果（不缓存）
 * @returns {Promise<T>}
 */
const parsedFileMemo = new Map();
export async function parsedFileCached(file, parse, missing) {
	let st;
	try {
		st = await stat(file);
	} catch {
		parsedFileMemo.delete(file);
		return missing();
	}
	let byParser = parsedFileMemo.get(file);
	if (byParser === undefined || byParser.mtimeMs !== st.mtimeMs || byParser.size !== st.size) {
		byParser = { mtimeMs: st.mtimeMs, size: st.size, values: new Map() };
		parsedFileMemo.set(file, byParser);
	}
	if (!byParser.values.has(parse)) {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			return missing();
		}
		byParser.values.set(parse, parse(text));
	}
	return byParser.values.get(parse);
}

/**
 * 一条原生行「实际」是否禁用：bundle 行先看 profile 层覆盖块（接管 bundle MCP 时写在那里，loader 后应用、按 id 覆盖），
 * 覆盖块没写 disabled 才看行本身。只看 bundle 行本身会把每一条已接管的 bundle MCP 读成 active——面板红点常亮、
 * 每次启动都报漂移，真漂移和假漂移分不开。
 * @param {Map<string, Map<string, boolean>>} [cache] 覆盖文件路径 → 标记表（一批行共用，免得重复读）
 */
export async function effectiveRowDisabled(patchPath, rowId, rowDisabled, cache = new Map()) {
	const overridePath = overridePathOf(patchPath);
	if (overridePath === null) return rowDisabled === true;
	if (!cache.has(overridePath)) cache.set(overridePath, await parsedFileCached(overridePath, parseOverrideFlags, () => new Map()));
	const flags = cache.get(overridePath);
	return flags.has(rowId) ? flags.get(rowId) : rowDisabled === true;
}

/**
 * 实时读某份 patch 里某行的 `disabled` 状态。
 *
 * 注册表里缓存的 `source.nativeDisabled` 只是上一次接管时的快照：原生行后来被
 * 升级重写成没有 disabled、或者整条被删掉，缓存都不会知道。判断「现在到底接管没有」
 * 必须回文件读。
 * @returns {Promise<boolean|undefined>} true=已禁用；false=存在但未禁用；undefined=找不到这一行
 */
export async function readRowDisabled(patchPath, rowId) {
	let text;
	try {
		text = await readFile(patchPath, "utf8");
	} catch {
		return undefined;
	}
	const row = parseMcpRows(text).find((r) => r.rowId === rowId);
	if (row === undefined) return undefined;
	return effectiveRowDisabled(patchPath, rowId, row.disabled);
}

/** 扫一批 patch 文件，收集所有 dsh-mcp-client 行。 */
async function collectRows(patchPaths, logger) {
	const paths = Array.isArray(patchPaths) ? patchPaths : [patchPaths];
	const rows = [];
	const overrides = new Map();
	for (const patchPath of paths) {
		let text;
		try {
			text = await readFile(patchPath, "utf8");
		} catch {
			continue;
		}
		if (!text.includes("@deepseek-ai/dsh-mcp-client")) continue;
		try {
			for (const row of parseMcpRows(text)) {
				row.patchPath = patchPath;
				// bundle 行的实际状态要叠上 profile 层覆盖块（A1）
				row.disabled = await effectiveRowDisabled(patchPath, row.rowId, row.disabled, overrides);
				rows.push(row);
			}
		} catch (error) {
			logger?.warn?.(`[dsh-studio] 解析 ${patchPath} 失败：${String(error)}`);
		}
	}
	return rows;
}

/** 从一行 patch 记录造一条注册表条目。 */
function entryFromRow(row) {
	return {
		name: row.config.serverName,
		tier: "disabled",
		transport: row.config.transport === "streamable-http" ? "streamable-http" : "stdio",
		command: row.config.command ?? "",
		args: row.config.args ?? [],
		env: row.config.env ?? {},
		envPrefix: row.config.envPrefix,
		cwd: row.config.cwd ?? "",
		url: row.config.url,
		headers: row.config.headers,
		toolCallTimeoutMs: Number(row.config.toolCallTimeoutMs) || undefined,
		notes: `来自 ${isBundlePatchPath(row.patchPath) ? "bundle" : "cordis.patch.yml"}（${row.rowId}）${row.disabled ? "，原生已禁用" : ""}`,
		source: { kind: "profile", rowId: row.rowId, patchPath: row.patchPath, nativeDisabled: row.disabled === true }
	};
}

/**
 * 三态对账：每次启动都跑，不再「登记过就跳过」。
 *
 * 旧实现只补缺失条目（`if (servers.some(name)) continue`），于是原生行被升级
 * 重写成没有 `disabled: true`、或整个 bundle patch 被 pnpm install 换掉时，注册表
 * 里的 `nativeDisabled` 还停在旧的 true——面板显示「已接管」，实际原生又把全部
 * 工具注册了一遍，两份同时注入，而且屏幕上写着一切正常。
 *
 * 现在每次启动回文件验一遍：
 *   - 没登记 → 导入（停用档）
 *   - 已登记且 `desiredNative === "disabled"` → 验原生行是否真的还禁用着；
 *     漂了就按 autoReassert 补回（bundle 型写 profile 层按 id 覆盖，profile 型原地插入）
 *   - 已登记但没接管意图 → 只刷新 source 元数据，不动 tier
 *
 * @returns {{imported:string[],skipped:object[],reasserted:object[],drifted:object[]}}
 */
export async function reconcileProfileMcp(store, patchPaths, options = {}) {
	// 整轮读-改-写走注册表的串行链：启动对账与面板 / 工具的 upsert、remove 交错时不再互相覆盖。
	// 只实现 load / save 的简易 store（测试替身）没有串行链，直接跑。
	return typeof store.serial === "function" ? store.serial(() => reconcileUnlocked(store, patchPaths, options)) : reconcileUnlocked(store, patchPaths, options);
}

async function reconcileUnlocked(store, patchPaths, options) {
	// autoTakeover：新出现的活原生行不再只「抄进停用档」，
	// 而是直接接管——导入成 on-demand、原生行写 disabled——注册表是唯一真相，不留双写分叉。
	const { overridePath, autoReassert = true, autoTakeover = false, logger } = options;
	const rows = await collectRows(patchPaths, logger);
	const state = await store.load();
	const imported = [];
	const skipped = [];
	const reasserted = [];
	const drifted = [];
	const takenOver = [];
	const nativeOwned = [];
	let dirty = false;

	for (const row of rows) {
		const name = row.config.serverName;
		const entry = state.servers.find((s) => s.name === name);
		const nativeDisabled = row.disabled === true;

		if (entry === undefined) {
			if (row.dynamic.length > 0) {
				skipped.push({ name, rowId: row.rowId, reason: `env 里有动态表达式：${row.dynamic.join(", ")}` });
				continue;
			}
			// 先验再接管：名字不合规（带点、超过 32 位）或既没有 command 也没有 url 的行，注册表下一次 load 会把它静默丢掉。
			// 旧写法先把原生行禁用、再把这条写进注册表——重启后两边都没有这台 server。验不过就原样留给原生管理，并报出来。
			const invalid = !SERVER_NAME_RE.test(String(name ?? ""))
				? `serverName 需为 1-32 位 [A-Za-z0-9_-]：${String(name ?? "")}`
				: String(row.config.command ?? "").trim() === "" && String(row.config.url ?? "").trim() === ""
					? "既没有 command 也没有 url"
					: null;
			if (invalid !== null) {
				skipped.push({ name, rowId: row.rowId, reason: `无法接管（${invalid}），保留由原生管理` });
				continue;
			}
			const fresh = entryFromRow(row);
			if (autoTakeover === true && nativeDisabled === false) {
				const via = isBundlePatchPath(row.patchPath) ? "override" : "in-place";
				let ok = false;
				if (via === "override" && typeof overridePath === "string" && overridePath !== "") {
					ok = await applyProfileOverride(overridePath, { rowId: row.rowId, disabled: true }, logger);
				} else if (via === "in-place") {
					ok = await disableNativeRow(row.patchPath, row.rowId, logger);
				}
				if (ok === true) {
					fresh.tier = "on-demand";
					fresh.desiredNative = "disabled";
					// 原生一直在跑、本来就被信任：不按「新登记」进试运行
					fresh.trial = false;
					fresh.source = { ...fresh.source, nativeDisabled: true, reassertPendingRestart: true };
					takenOver.push({ name, rowId: row.rowId, via });
				}
			}
			state.servers.push(fresh);
			imported.push(name);
			dirty = true;
			continue;
		}

		// 升级后 rowId / patchPath 可能变，元数据跟着走
		const moved = entry.source?.patchPath !== row.patchPath || entry.source?.rowId !== row.rowId;
		entry.source = { ...(entry.source ?? {}), kind: "profile", rowId: row.rowId, patchPath: row.patchPath, nativeDisabled };
		if (moved) dirty = true;

		// 旧版本接管过的条目没有 desiredNative（那时接管是一次性动作）：旧版 takeover
		// 只做两件事——把 source 条目切到 on-demand、给原生行插 disabled。所以
		// 「从 patch 导入 + on-demand」就等于当初点过接管，按有意图迁移；否则历史接管
		// 会在升级后全部失效。没切档（仍是 disabled 或用户手动改的 eager）不迁移。
		if (entry.desiredNative === undefined && entry.tier === "on-demand") {
			entry.desiredNative = "disabled";
			dirty = true;
		}

		const wantDisabled = entry.desiredNative === "disabled";
		if (wantDisabled === false) {
			// 原生行还活着、注册表又没接管意图：这是一条仍由原生加载的 server（双份来源），只报告不动
			if (nativeDisabled === false) nativeOwned.push({ name, rowId: row.rowId });
			continue;
		}

		if (nativeDisabled === true) {
			// 已接管且仍然生效：清掉上一轮的待重启标记
			if (entry.source.reassertPendingRestart === true) {
				delete entry.source.reassertPendingRestart;
				dirty = true;
			}
			continue;
		}

		// 漂移：有接管意图，原生行却是活的
		if (autoReassert === true) {
			const via = isBundlePatchPath(row.patchPath) ? "override" : "in-place";
			let ok = false;
			if (via === "override" && typeof overridePath === "string" && overridePath !== "") {
				ok = await applyProfileOverride(overridePath, { rowId: row.rowId, disabled: true }, logger);
			} else {
				ok = await disableNativeRow(row.patchPath, row.rowId, logger);
			}
			if (ok === true) {
				entry.source.nativeDisabled = true;
				// loader 在插件启动前就读完 patch 了，这一轮原生仍在跑，改回文件只对下次启动生效
				entry.source.reassertPendingRestart = true;
				reasserted.push({ name, rowId: row.rowId, via });
				dirty = true;
				continue;
			}
		}
		drifted.push({ name, rowId: row.rowId, state: "active" });
	}

	// 反向检查：接管过、但这次扫描压根没扫到它的行（整条被删 / 文件被换）
	for (const entry of state.servers) {
		if (entry.desiredNative !== "disabled") continue;
		const rowId = entry.source?.rowId;
		const patchPath = entry.source?.patchPath;
		if (typeof rowId !== "string" || rowId === "" || typeof patchPath !== "string") continue;
		if (rows.some((row) => row.rowId === rowId && row.patchPath === patchPath)) continue;
		const stillThere = await readRowDisabled(patchPath, rowId);
		if (stillThere === true) continue;
		entry.source = { ...entry.source, nativeDisabled: false };
		dirty = true;
		drifted.push({ name: entry.name, rowId, state: stillThere === false ? "active" : "missing" });
	}

	if (dirty) await store.save(state);
	return { imported, skipped, reasserted, drifted, takenOver, nativeOwned, readonly: false };
}

/** 兼容旧调用点：只导入、不对账。 */
export async function importProfileMcp(store, patchPaths, logger) {
	const result = await reconcileProfileMcp(store, patchPaths, { autoReassert: false, logger });
	return { imported: result.imported, skipped: result.skipped, readonly: false };
}

/** 按文件实际的 EOL 切行：每行带上自己的起始偏移与换行串，写回时其余部分逐字节不动（N-09）。 */
function splitLinesKeepEol(text) {
	const lines = [];
	let start = 0;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch !== "\n" && ch !== "\r") continue;
		const eol = ch === "\r" && text[i + 1] === "\n" ? "\r\n" : ch;
		lines.push({ text: text.slice(start, i), eol, start });
		i += eol.length - 1;
		start = i + 1;
	}
	if (start < text.length) lines.push({ text: text.slice(start), eol: "", start });
	return lines;
}

/** 文件惯用的换行串（第一处出现的那种）；一行都没有才退回 LF。 */
function preferredEol(lines) {
	return lines.find((line) => line.eol !== "")?.eol ?? "\n";
}

/**
 * 给某一行加/去 `disabled: true`。文本级：只插一行，不动 config 内容，
 * 注释和 !!js 都原样留着。
 *
 * N-09：按文件自己的换行符写回（以前 split(/\r?\n/) + join("\n") 会把 CRLF 文件整篇翻成 LF），
 * 且 rowId 走字面匹配（转义正则元字符），含 `.` `+` 这类字符的 rowId 不会误命中别的行。
 */
export function setRowDisabled(text, rowId, disabled) {
	const src = String(text ?? "");
	const lines = splitLinesKeepEol(src);
	const literal = String(rowId ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const idx = lines.findIndex((line) => new RegExp(`^(\\s*)- id:\\s*"?${literal}"?\\s*$`).test(line.text));
	if (idx < 0) return { text: src, changed: false };
	const head = lines[idx];
	const indent = /^(\s*)/.exec(head.text)[1].length;
	const childIndent = " ".repeat(indent + 2);
	// 在这一行的整个块里找既有的 `disabled:`（不只看紧跟 id 的那一行）。此前行里已经写着 `disabled: false` 时
	// 会在前面再插一条 `disabled: true`，同一个映射里两个同名键——YAML 解析器要么报错要么后者生效，原生行其实没被禁用。
	const flagRe = new RegExp(`^${childIndent}disabled:\\s*(true|false)\\s*(#.*)?$`);
	let flagAt = -1;
	for (let i = idx + 1; i < lines.length; i += 1) {
		const text = lines[i].text;
		if (text.trim() === "") continue;
		if (/^(\s*)/.exec(text)[1].length <= indent) break; // 缩进回到行首级别 = 下一行 / 块结束
		if (flagRe.test(text)) {
			flagAt = i;
			break;
		}
	}
	const flag = flagAt >= 0 ? lines[flagAt] : undefined;
	const has = flag !== undefined && flagRe.exec(flag.text)[1] === "true";
	if (disabled === true && has === false) {
		if (flag !== undefined) {
			const fixed = flag.text.replace(/disabled:\s*false/, "disabled: true");
			return { text: src.slice(0, flag.start) + fixed + src.slice(flag.start + flag.text.length), changed: true };
		}
		const eol = head.eol !== "" ? head.eol : preferredEol(lines);
		const at = head.start + head.text.length;
		return { text: src.slice(0, at) + eol + childIndent + "disabled: true" + src.slice(at), changed: true };
	}
	if (disabled === false && has === true) {
		const cut = flag.start;
		return { text: src.slice(0, cut) + src.slice(cut + flag.text.length + flag.eol.length), changed: true };
	}
	return { text: src, changed: false };
}

/** 接管：把原生行禁用掉（让 studio 成为唯一入口）。返回是否真的改了文件。 */
export async function disableNativeRow(patchPath, rowId, logger) {
	let text;
	try {
		text = await readFile(patchPath, "utf8");
	} catch {
		return false;
	}
	const result = setRowDisabled(text, rowId, true);
	if (result.changed === false) return false;
	try {
		await writeFile(patchPath, result.text, "utf8");
		return true;
	} catch (error) {
		logger?.warn?.(`[dsh-studio] 写 ${patchPath} 失败：${String(error)}`);
		return false;
	}
}

/** 覆盖块的表头注释，用来认出这一段是本插件写的。 */
const OVERRIDE_MARK = "# dsh-studio: native mcp overrides (auto-managed)";

/**
 * 把「按 id 覆盖」写进 profile 自己的 cordis.patch.yml。
 *
 * DSH 的 loader 先应用 bundle patch、后应用 profile patch，非 insert 的 patch 按 id
 * 覆盖已存在条目（dsh-app-boot: `target[key] = value`）。所以对 bundle 里的 MCP
 * 不该去改 node_modules —— 那份文件 pnpm install / 插件升级会整份重写，改一次丢一次。
 * 写在 profile 层就活在升级之外。
 *
 * 幂等：同 id 的顶层覆盖块会被整块替换，不会越写越长。
 */
export function setProfileOverride(text, { rowId, disabled, config }) {
	const src = String(text ?? "");
	const lines = splitLinesKeepEol(src);
	const literal = String(rowId ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const head = new RegExp(`^- id:\\s*"?${literal}"?\\s*$`);
	const startIdx = lines.findIndex((line) => head.test(line.text));
	const body = [`- id: ${rowId}`];
	if (disabled === true) body.push("  disabled: true");
	const configKeys = Object.entries(config ?? {});
	if (configKeys.length > 0) {
		// 嵌套写：loader 按 id 覆盖时是 `target[key] = value` 整键替换，
		// config 必须是一整块，不能摊到顶层当成孤立键
		body.push("  config:");
		for (const [key, value] of configKeys) {
			body.push(`    ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
		}
	}
	const eol = preferredEol(lines);
	const block = body.join(eol);
	if (startIdx < 0) {
		const needsMark = !src.includes(OVERRIDE_MARK);
		const prefix = src === "" ? "" : src.endsWith("\n") ? "" : eol;
		const tail = `${needsMark ? (src === "" ? "" : eol) + OVERRIDE_MARK + eol : ""}${block}${eol}`;
		return { text: src + prefix + tail, changed: true };
	}
	// 块的终点：下一个顶层 `- ` 开头或文件结束
	let endIdx = startIdx + 1;
	while (endIdx < lines.length) {
		const line = lines[endIdx];
		if (/^- /.test(line.text)) break;
		if (line.text.trim() !== "" && !/^\s/.test(line.text)) break;
		endIdx += 1;
	}
	const from = lines[startIdx].start;
	const lastLine = lines[endIdx - 1];
	const to = lastLine.start + lastLine.text.length + lastLine.eol.length;
	const replacement = block + (lastLine.eol === "" ? "" : eol);
	const next = src.slice(0, from) + replacement + src.slice(to);
	return { text: next, changed: next !== src };
}

/** 写 profile 层覆盖块。返回是否改动了文件。 */
export async function applyProfileOverride(patchPath, spec, logger) {
	let text = "";
	try {
		text = await readFile(patchPath, "utf8");
	} catch {
		text = "";
	}
	const result = setProfileOverride(text, spec);
	if (result.changed === false) return false;
	try {
		await mkdir(dirname(patchPath), { recursive: true });
		await writeFile(patchPath, result.text, "utf8");
		return true;
	} catch (error) {
		logger?.warn?.(`[dsh-studio] 写 ${patchPath} 失败：${String(error)}`);
		return false;
	}
}
