/**
 * 「记住 X」请求：从原话猜落点，并把待确认的请求挂到下一轮。
 * （从 index.js 拆出，逻辑未改。）
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * 从「记住 X」的原话猜落点（WO-EVO-6）。
 *
 * 用户的既定原则是「优化类不要确认」，所以默认不提问：能判定唯一类别就直接落位并
 * 一句话告知，只有同时像两三类、确实分不清时才发问。返回 null 表示模糊。
 *   agents 偏好 / 规矩（以后都这样）
 *   memory 事实 / 环境（这台机器、这个项目的事实）
 *   skill  可复用的方法 / 流程（带模板、步骤、清单这类可固化产出物）
 */
const PREFERENCE_HINT = /(以后都|以后不|下次都|下次也|每次|一律|总是|永远|先给结论|先说结论|不要|别用|风格|语气|口吻|格式|回答时)/;
const FACT_HINT = /(这台机器|本机|这个项目|这个仓库|仓库是|端口|路径|版本是|jdk|node|python|配置是|地址是|装在)/;
const METHOD_HINT = /(怎么做|怎么写|该如何写|如何做|流程|步骤|方法|写法|模板|清单|套路|检查表)/;
const CRAFT_HINT = /(模板|清单|检查表|步骤|套路|流程)/;

export function guessRememberTarget(text) {
	const raw = String(text ?? "");
	if (raw.trim() === "") return null;
	const pref = PREFERENCE_HINT.test(raw);
	const fact = FACT_HINT.test(raw);
	const method = METHOD_HINT.test(raw);
	const hits = (pref ? 1 : 0) + (fact ? 1 : 0) + (method ? 1 : 0);
	// 0 类（看不出来）或 2 类以上（同时像几种）都算模糊，交给模型问一句
	if (hits !== 1) return null;
	if (pref) return "agents";
	if (fact) return "memory";
	// 只说了「怎么做」但没有可固化的产出物（模板/步骤/清单）→ 仍是模糊
	return CRAFT_HINT.test(raw) ? "skill" : null;
}

/** 用户说「记住」时挂起的确认请求；注入一次 system-prompt 后清空。 */
const PENDING_REMEMBER_FILE = () => resolve(homedir(), ".dsh", "dsh-studio", "pending-remember.json");
/** 已处理过的「记住」原话只留最近这么多条的指纹。 */
const HANDLED_KEEP = 50;

/**
 * 一句「记住」的指纹 = 会话 id + 原话。每轮判定都会回看最新会话的最后 20 条消息，同一句话在被 20 条新消息挤出窗口之前
 * 每一轮都会再命中一次——没有这份指纹，同一个请求会被反复挂起、反复注入「直接落位」，其间正常的逐轮提取也一直被短路。
 * 带上会话 id：换个会话再说同一句话算新的请求。
 */
function rememberKey(sessionId, text) {
	return createHash("sha256").update(String(sessionId ?? "") + "\n" + String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

async function readHandled() {
	try {
		const parsed = JSON.parse(await readFile(PENDING_REMEMBER_FILE(), "utf8"));
		return Array.isArray(parsed?.handled) ? parsed.handled.filter((k) => typeof k === "string") : [];
	} catch {
		return [];
	}
}

/** 已处理过的「记住」指纹集合（读不到就当没有）。 */
async function loadHandledRemember() {
	return new Set(await readHandled());
}

async function savePendingRemember(text, target = null, key = null) {
	try {
		await mkdir(dirname(PENDING_REMEMBER_FILE()), { recursive: true });
		const handled = await readHandled();
		if (typeof key === "string" && key !== "" && !handled.includes(key)) handled.push(key);
		await writeFile(PENDING_REMEMBER_FILE(), JSON.stringify({ text, at: Date.now(), target, handled: handled.slice(-HANDLED_KEEP) }), "utf8");
		return true;
	} catch {
		return false;
	}
}
async function takePendingRemember(logger) {
	let raw;
	try {
		raw = await readFile(PENDING_REMEMBER_FILE(), "utf8");
	} catch {
		return null; // 没有挂起请求
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// 解析失败就不动文件：旧写法先把文件清成 `{}` 再解析，坏内容会被直接吞掉（OPT-08）
		logger?.warn?.("[dsh-studio] pending-remember.json 解析失败，保留原文件：" + (error instanceof Error ? error.message : String(error)));
		return null;
	}
	if (parsed && typeof parsed.text === "string" && parsed.text !== "") {
		// 清掉请求本身，已处理的指纹留着（下一轮判定靠它跳过同一句话）
		const handled = Array.isArray(parsed.handled) ? parsed.handled.filter((k) => typeof k === "string").slice(-HANDLED_KEEP) : [];
		await writeFile(PENDING_REMEMBER_FILE(), JSON.stringify(handled.length > 0 ? { handled } : {}), "utf8").catch((error) => { /* 清空失败不阻断；下次仍可再试 */ void error; });
		return parsed;
	}
	return null;
}

export { loadHandledRemember, rememberKey, savePendingRemember, takePendingRemember };
