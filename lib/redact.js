/**
 * 凭据掩码（WO-SEC-1）。
 *
 * 原始凭据值只允许出现在一个地方：单点的 loopback 按需取用路由。
 * 任何会被序列化出去、被日志、被工具返回值带走的结构里，只能放这里的掩码。
 */

/**
 * 看起来像凭据的键名。mcp.js / index.js / snapshot.js 共用同一口径。
 * 首版只认 token / secret / password / api-key 几类，GITHUB_PAT、OPENAI_KEY、SSH_PRIVATE_KEY、DB_PASSWD、
 * X-Auth、passphrase 这些常见写法全漏——面板不打码，快照也不脱敏就推到远端。带分隔符的几条（`_KEY` / `_PAT` /
 * `_PWD` / `auth` / `dsn`）要求整段匹配，免得把 `keyboard`、`author`、`PWD`（工作目录）这类普通键误伤。
 */
export const SENSITIVE_KEY =
	/authorization|api[-_]?key|access[-_]?token|token|secret|passw(?:or)?d|passphrase|cookie|credential|private[-_]?key|bearer|[-_]key$|[-_]pwd$|(?:^|[-_])pat(?:$|[-_])|(?:^|[-_])auth(?:$|[-_])|(?:^|[-_])dsn$/i;

/** 值本身就是凭据的形态：常见厂商 token 前缀、`Bearer xxx`、带口令的 URL（`scheme://user:pass@host`）。 */
const SECRET_VALUE = /^(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+\S{8,})$/;
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

/** 键名看不出来、但值一眼就是凭据（`DATABASE_URL=postgres://u:p@h/db`、`GH=ghp_…`）。 */
export function looksLikeSecretValue(value) {
	if (typeof value !== "string" || value === "") return false;
	return SECRET_VALUE.test(value.trim()) || URL_WITH_PASSWORD.test(value.trim());
}

/** 键名或值任一像凭据。快照脱敏、面板打码、凭据暂存共用。 */
export function isSensitiveField(key, value) {
	return typeof value === "string" && value !== "" && (SENSITIVE_KEY.test(String(key)) || looksLikeSecretValue(value));
}

const SENSITIVE_QUERY = /([?&])([^=&#\s]*(?:key|token|secret|passw(?:or)?d|auth|signature|sig)[^=&#\s]*)=([^&#\s]+)/gi;
const URL_USERINFO = /(:\/\/)([^/\s@]+)@/g;
const ARG_FLAG = /^(--?[A-Za-z][\w-]*)(?:=(.*))?$/s;

/**
 * 存储侧的凭据占位符（快照 / studio 备份包 / 版本史共用）：看到它就知道「这里原本有值，但不在这里」。
 * 整个字段是凭据时整值换成它；URL / 命令行参数里内嵌的凭据只把那一段换成它。
 */
export const REDACTED = "__dsh_studio_redacted__";

/**
 * 内嵌凭据的键：同一个字符串 / 参数数组之内唯一。基础键是 `userinfo`、`query:<参数名>`、`flag:<--参数>`、
 * `value`（整个参数就是一枚 token），同一基础键第二次出现起追加 `#2`、`#3`……
 * 存储侧按键记下被换掉的是哪一段，恢复侧对目标机现值用同一套识别取出同键的值补回——两边同一个函数，键不会漂。
 */
export function embeddedKeyer() {
	const seen = new Map();
	return (base) => {
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		return n === 1 ? base : `${base}#${n}`;
	};
}

/**
 * 内嵌凭据识别（一处实现，）：文本里 URL 的 userinfo（`//user:token@`）与像凭据的查询参数（`?exaApiKey=…`）。
 * 每处命中调用 `replace(键, 原值)`，用返回值替换原值。展示侧（maskUrlSecrets）换成 `***`，
 * 存储侧（快照脱敏）换成 REDACTED 并记键，恢复侧按键补回目标机现值。
 * @param {(key: string, value: string) => string} replace
 */
export function rewriteUrlSecrets(text, replace, key = embeddedKeyer()) {
	return String(text ?? "")
		.replace(URL_USERINFO, (_m, scheme, info) => `${scheme}${replace(key("userinfo"), info)}@`)
		.replace(SENSITIVE_QUERY, (_m, lead, name, value) => `${lead}${name}=${replace(key("query:" + name), value)}`);
}

/**
 * 命令行参数里的内嵌凭据识别（一处实现，）：`--api-key xxx`（下一个参数）、`--token=xxx`、
 * 整个参数就是一枚 token（厂商前缀 / Bearer），其余参数（含带口令的 URL）再按 URL 规则过一遍。
 * `isBareSecret` 判「整个参数就是凭据」，默认看形态；恢复侧解析带占位符的模板时把 REDACTED 也算进来。
 * @param {(key: string, value: string) => string} replace
 */
export function rewriteArgSecrets(args, replace, isBareSecret = looksLikeSecretValue) {
	const key = embeddedKeyer();
	const out = [];
	let flagAwaitingValue = null;
	for (const raw of Array.isArray(args) ? args : []) {
		const arg = String(raw);
		if (flagAwaitingValue !== null) {
			const flag = flagAwaitingValue;
			flagAwaitingValue = null;
			if (!arg.startsWith("-")) {
				out.push(replace(key("flag:" + flag), arg));
				continue;
			}
		}
		const flag = arg.match(ARG_FLAG);
		if (flag !== null && SENSITIVE_KEY.test(flag[1].replace(/^-+/, ""))) {
			if (flag[2] === undefined) {
				flagAwaitingValue = flag[1];
				out.push(arg);
			} else out.push(`${flag[1]}=${replace(key("flag:" + flag[1]), flag[2])}`);
			continue;
		}
		// 带口令的 URL 走 URL 规则只换 userinfo（主机、路径照常可见、恢复时也只补那一段），其余像 token 的整个换掉
		out.push(isBareSecret(arg) && !URL_WITH_PASSWORD.test(arg.trim()) ? replace(key("value"), arg) : rewriteUrlSecrets(arg, replace, key));
	}
	return out;
}

/** 文本或参数数组里有没有内嵌凭据（非空原值、不是占位符本身）。凭据暂存判定「这个条目值不值得留」用。 */
export function hasEmbeddedSecret(value) {
	let found = false;
	const spot = (_key, v) => {
		if (v !== "" && v !== REDACTED) found = true;
		return v;
	};
	if (Array.isArray(value)) {
		if (value.every((v) => typeof v === "string")) rewriteArgSecrets(value, spot);
	} else if (typeof value === "string") rewriteUrlSecrets(value, spot);
	return found;
}

/**
 * 把一段文本里 URL 携带的凭据抹掉：userinfo（`//user:token@`）与像凭据的查询参数（`?exaApiKey=…`）。
 * 用于会进模型上下文 / 面板 / 日志的展示串（mcp_list 的 endpoint、同步通道的 remote / url、上游来源）。
 */
export function maskUrlSecrets(text) {
	return rewriteUrlSecrets(text, () => "***");
}

/**
 * 命令行参数的展示串：`--api-key xxx`、`--token=xxx`、裸 token、URL 里的凭据都换成 ***。
 * 只用于展示；真正拉起子进程用的是注册表里的原值。
 * @param {string[]} args
 */
export function maskArgs(args) {
	return rewriteArgSecrets(args, () => "***");
}

/** 掩码：中间打点、尾 4 位（与面板原先的显示格式一致）。长值不会暴露长度以外的信息。 */
export function maskSecret(value) {
	const text = String(value ?? "");
	if (text.length <= 6) return "\u2022".repeat(Math.max(4, text.length));
	return "\u2022".repeat(8) + text.slice(-4);
}

const INLINE_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const INLINE_PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const INLINE_ASSIGNED = /\b((?:api[_-]?key|apikey|passw(?:or)?d|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-./+]{16,}/gi;
const INLINE_BEARER = /\b(Bearer\s+)[A-Za-z0-9_\-./+=]{16,}/g;
const INLINE_URL_PASSWORD = /(:\/\/[^/\s:@]+:)[^/\s@]+@/g;

/** 自由文本里凭据形态片段的占位符。 */
export const SCRUBBED = "[已脱敏]";

/**
 * 把自由文本（会话消息）里凭据形态的片段换成占位符。
 *
 * 会话原文会被做成摘要发给提取模型（可能是另一家供应商），关键回合摘录还会落进草稿的 provenance、
 * 再随 studio 备份包出机。用户在对话里贴过一次 token，这三条路就都带着它走——所以在读会话日志的地方就抹掉。
 * 只认形态明确的几类（厂商前缀 token、PEM 私钥块、`key=值` 赋值、Bearer、URL 口令），宁可漏不乱改正文。
 */
export function scrubSecrets(text) {
	return String(text ?? "")
		.replace(INLINE_PEM, SCRUBBED)
		.replace(INLINE_TOKEN, SCRUBBED)
		.replace(INLINE_BEARER, "$1" + SCRUBBED)
		.replace(INLINE_ASSIGNED, "$1" + SCRUBBED)
		.replace(INLINE_URL_PASSWORD, "$1" + SCRUBBED + "@");
}
