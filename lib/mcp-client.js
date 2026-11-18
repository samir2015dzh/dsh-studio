/**
 * dsh-studio — 最小 MCP 客户端（零外部依赖）。
 *
 * 只做按需加载需要的四件事：握手、列工具、调工具、断开。不桥接 resources /
 * prompts / sampling，和 DSH 自带的 mcp-client 口径一致。
 *
 * 两种传输：
 *   - stdio：spawn 子进程，stdout 按行切 JSON-RPC，stderr 留最近若干行做报错上下文。
 *   - streamable-http：POST 单条 JSON-RPC，响应可能是 application/json，也可能是
 *     text/event-stream（逐条 data: 行）；服务端给的 Mcp-Session-Id 会带回后续请求。
 *
 * 协议版本固定在 PROTOCOL_VERSION：老服务端会回它自己的版本，握手照样成立。
 */
import { spawn } from "node:child_process";
import dns from "node:dns";
import { DEFAULT_HTTP_TIMEOUT_MS, fetchWithTimeout } from "./http.js";
import { planSpawn } from "./win-spawn.js";

// 某些网络下 Node 的 happy-eyeballs 会先去试不通的 IPv6，fetch 直接报
// UND_ERR_CONNECT_TIMEOUT（同一个地址 PowerShell 却连得上）。钉成 IPv4 优先。
dns.setDefaultResultOrder("ipv4first");

export const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "dsh-studio", version: "0.6.0" };
const STDERR_TAIL = 20;
const MAX_BUFFER = 16 * 1024 * 1024;

/** JSON-RPC 错误 → Error，保留 code / data 便于排查。 */
class McpError extends Error {
	constructor(message, code, data) {
		super(message);
		this.name = "McpError";
		this.code = code;
		this.data = data;
	}
}

function toError(payload) {
	const message = typeof payload?.message === "string" ? payload.message : "MCP 请求失败";
	return new McpError(message, payload?.code, payload?.data);
}

/**
 * 一行一条 JSON-RPC 的读写通道。stdio 与 HTTP 都归一到同一组回调上，
 * 上层（McpConnection）不关心底下是管道还是 HTTP。
 */
class Channel {
	constructor() {
		this.onMessage = () => {};
		this.onClose = () => {};
		this.closed = false;
	}
	markClosed(reason) {
		if (this.closed) return;
		this.closed = true;
		this.onClose(reason instanceof Error ? reason : new Error(String(reason ?? "连接已关闭")));
	}
}

class StdioChannel extends Channel {
	constructor(spec) {
		super();
		this.stderrTail = [];
		const env = { ...process.env, ...(spec.env ?? {}) };
		const cwd = spec.cwd && spec.cwd !== "" ? spec.cwd : undefined;
		// 审计 6：Windows 上按 PATHEXT 解析命令，命中 .cmd/.bat 时经 cmd.exe /d /s /c 起并转义参数
		const plan = planSpawn(spec.command, Array.isArray(spec.args) ? spec.args : [], { env, cwd });
		this.spawnPlan = plan;
		try {
			this.child = spawn(plan.command, plan.args, {
				cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				...plan.extra
			});
		} catch (error) {
			// 同步抛（EINVAL 等）：变成一次「连接关闭」，原文带出去
			this.child = null;
			this.startError = this.spawnError(error);
			queueMicrotask(() => this.markClosed(this.startError));
			return;
		}
		this.child.on("error", (error) => this.markClosed(this.spawnError(error)));
		this.child.on("exit", (code, signal) => this.markClosed(`子进程退出（code=${code}, signal=${signal}）`));
		// 管道自己的 error 必须有人接：子进程不再读 stdin（卡死 / 刚退出但 exit 事件还没派发）时写入会报 EPIPE，
		// 流上没有 error 监听的话它就是宿主进程里的一个 uncaughtException。stdin 出错 = 这条连接废了。
		this.child.stdin.on("error", (error) => this.markClosed(`写入子进程失败：${error instanceof Error ? error.message : String(error)}`));
		this.child.stdout.on("error", () => {});
		this.child.stderr.on("error", () => {});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => {
			for (const line of String(chunk).split("\n")) {
				if (line.trim() === "") continue;
				this.stderrTail.push(line.trim());
				if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
			}
		});
		let buffer = "";
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => {
			// 换行只在新到的这一块里找：整段重扫的话，一条 10 MB 的单行消息（大的 tools/list、base64 结果）
			// 每来一块都把已有内容从头扫一遍，事件循环要被占住几百毫秒到几秒
			let scanFrom = buffer.length;
			buffer += chunk;
			if (buffer.length > MAX_BUFFER) {
				buffer = "";
				this.markClosed("stdout 超过缓冲上限，判定为异常输出");
				// 只标记关闭不够：close() 见到 closed 就直接返回，这个还在往外喷数据的子进程会一直活着
				void this.terminate();
				return;
			}
			let nl;
			while ((nl = buffer.indexOf("\n", scanFrom)) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				scanFrom = 0;
				if (line === "") continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue; // 非 JSON 的噪声行不影响协议
				}
				this.onMessage(message);
			}
		});
	}

	/** spawn 阶段的错误：原文 + 错误码 + 实际起的命令（verify 失败信息里要看得到）。 */
	spawnError(error) {
		const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
		const plan = this.spawnPlan;
		const how = plan?.shim ? `经 ${plan.command} 起 ${plan.resolved}` : plan?.resolved ? `解析为 ${plan.resolved}` : `命令 ${plan?.command ?? "?"}`;
		const err = new Error(`无法启动子进程（${how}）：${error instanceof Error ? error.message : String(error)}${code !== "" && !(error?.message ?? "").includes(code) ? "（" + code + "）" : ""}`);
		err.code = code || undefined;
		err.cause = error;
		return err;
	}

	stderrHint() {
		return this.stderrTail.length === 0 ? "" : "；stderr: " + this.stderrTail.slice(-3).join(" | ");
	}

	send(payload) {
		if (this.startError) throw this.startError;
		if (this.closed || this.child === null) throw new Error("MCP 子进程已退出");
		this.child.stdin.write(JSON.stringify(payload) + "\n");
	}

	async close() {
		// 「逻辑上已关闭」与「进程已回收」是两回事：通道可能早就被标记关闭（stdout 超限、stdin 出错），进程却还活着
		this.closed = true;
		await this.terminate();
	}

	/** 回收子进程（幂等）：关 stdin → 终止 → 3 秒后仍不退则强杀。 */
	terminate() {
		if (this.child === null) return Promise.resolve();
		if (this.terminating === undefined) this.terminating = this.reap();
		return this.terminating;
	}

	async reap() {
		// 已经退出，或者根本没起来（spawn 失败时没有 pid，也永远等不到 exit）
		if (this.child.exitCode !== null || this.child.signalCode !== null || this.child.pid === undefined) return;
		try {
			this.child.stdin.end();
		} catch {
			/* 管道可能已经断了 */
		}
		const exited = new Promise((resolveExit) => {
			this.child.once("exit", resolveExit);
		});
		// Windows 上经 cmd.exe 起的 .cmd / .bat 垫片：直接子进程是 cmd.exe，杀它不会带走真正的 server 进程（npx → node），
		// 不认 stdin EOF 的 server 每次回收都会留下一个孤儿。按进程树杀。
		if (process.platform === "win32" && this.spawnPlan?.shim === true && typeof this.child.pid === "number") {
			try {
				spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
			} catch {
				/* 没有 taskkill 就退回下面的普通终止 */
			}
		}
		// SIGTERM 之后仍不退的子进程要强杀：只 race 一个超时会让它挂在后台（S-03）
		const killTimer = setTimeout(() => {
			if (this.child.exitCode === null && this.child.signalCode === null) {
				try {
					this.child.kill("SIGKILL");
				} catch {
					/* 已经退出 */
				}
			}
		}, 3000);
		killTimer.unref?.();
		try {
			this.child.kill();
		} catch {
			/* 已经退出 */
		}
		await Promise.race([exited, new Promise((r) => setTimeout(r, 3500).unref?.())]);
		clearTimeout(killTimer);
	}
}

/**
 * HTTP 会话失效的错误码：带着 mcp-session-id 的请求被答 404，服务端不认这个会话、也没受理这次请求。
 * McpRuntime.call 见到它就重连并重试一次——只此一种，别的失败不重试（工具调用结果不做重试判断）。
 */
export const SESSION_EXPIRED = "MCP_SESSION_EXPIRED";

class HttpChannel extends Channel {
	constructor(spec) {
		super();
		this.url = spec.url;
		this.headers = { ...(spec.headers ?? {}) };
		this.sessionId = undefined;
		this.abort = new AbortController();
	}

	/**
	 * @param {object} payload JSON-RPC 报文
	 * @param {{timeoutMs?:number}} [options] N-05：本次请求的超时预算。HTTP 通道的 fetch 与
	 *   SSE 响应体消费都活在它之内 —— 以前这里是 fetchWithTimeout 的 30 秒写死值，
	 *   tools/call 的 120 秒预算被底层 abort 提前砍掉。握手/列工具仍传短预算。
	 */
	async send(payload, options = {}) {
		const limit = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_HTTP_TIMEOUT_MS;
		const headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...this.headers
		};
		if (this.sessionId !== undefined) headers["mcp-session-id"] = this.sessionId;
		try {
			const response = await fetchWithTimeout(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: this.abort.signal
			}, limit);
			const session = response.headers.get("mcp-session-id");
			if (session !== null && session !== "") this.sessionId = session;
			if (response.status === 202 || response.status === 204) return;
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				const failure = new Error(`HTTP ${response.status} ${response.statusText}${body === "" ? "" : "：" + body.slice(0, 300)}`);
				// 带着会话 id 被答 404 = 服务端已经不认这个会话了（重启 / 过期）。按规范要重新 initialize：
				// 把通道标成已关闭，上层下一次 ensure 就会重连。旧写法状态一直是 connected，每次调用都 404，直到熔断。
				if (response.status === 404 && this.sessionId !== undefined) {
					this.sessionId = undefined;
					// 带上 code：上层据此判定「这次请求服务端根本没受理」，可以重连后重试一次
					const expired = Object.assign(new Error("服务端会话已失效（HTTP 404），已重新握手"), { code: SESSION_EXPIRED });
					failure.code = SESSION_EXPIRED;
					this.markClosed(expired);
				}
				throw failure;
			}
			const type = response.headers.get("content-type") ?? "";
			if (type.includes("text/event-stream")) {
				await this.consumeSse(response);
				return;
			}
			const body = await response.text();
			if (body.trim() === "") return;
			for (const line of body.split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				try {
					this.onMessage(JSON.parse(trimmed));
				} catch {
					/* 一行一条，坏行跳过 */
				}
			}
		} catch (error) {
			// 连接自己关掉（close）时原样抛；超时才是「请求级超时」，文案要能看出预算
			if (this.abort.signal.aborted) throw error;
			if (error?.name === "TimeoutError" || error?.name === "AbortError") {
				throw new Error(`HTTP 请求超时（${Math.round(limit / 100) / 10} 秒）：${payload?.method ?? "请求"}`);
			}
			throw error;
		}
	}

	async consumeSse(response) {
		const reader = response.body?.getReader();
		if (reader === undefined) return;
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "") continue;
				try {
					this.onMessage(JSON.parse(data));
				} catch {
					/* 非 JSON 事件（心跳等）忽略 */
				}
			}
		}
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		this.abort.abort();
	}
}

/**
 * 一条 MCP 连接：握手 + 工具调用。一个实例只对应一个上游服务器。
 */
export class McpConnection {
	constructor(spec, options = {}) {
		this.spec = spec;
		this.timeoutMs = options.timeoutMs ?? 120000;
		// 握手与 tools/list 用独立短超时：toolCallTimeoutMs 是「一个工具能跑多久」，
		// 拿它当连接超时会让面板在服务器起不来时冻住十几分钟。
		this.connectTimeoutMs = options.connectTimeoutMs ?? 30000;
		this.callback = {
			onToolsChanged: options.onToolsChanged,
			onClose: options.onClose
		};
		this.nextId = 1;
		this.pending = new Map();
		this.serverInfo = undefined;
		this.capabilities = undefined;
		this.instructions = undefined;
		/** 连接是否已结束（对端关闭 / 本地 close）。runtime 靠它识别死连接。 */
		this.closed = false;
		this.channel = spec.transport === "stdio" ? new StdioChannel(spec) : new HttpChannel(spec);
		this.channel.onMessage = (message) => this.dispatch(message);
		this.channel.onClose = (error) => {
			this.closed = true;
			this.failAll(error);
			// 连接生命周期结束必须通知上层：否则 slot 会一直抱着死连接、状态永远 connected（WO-FIX-6）
			try {
				this.callback.onClose?.(error);
			} catch {
				/* 通知失败不影响关闭流程 */
			}
		};
	}

	async connect() {
		const result = await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO
		}, this.connectTimeoutMs);
		this.serverInfo = result?.serverInfo;
		this.capabilities = result?.capabilities;
		this.instructions = typeof result?.instructions === "string" ? result.instructions : undefined;
		this.notify("notifications/initialized", {});
		return result;
	}

	dispatch(message) {
		if (message && typeof message.id !== "undefined" && ("result" in message || "error" in message)) {
			const waiter = this.pending.get(message.id);
			if (waiter === undefined) return;
			this.pending.delete(message.id);
			clearTimeout(waiter.timer);
			if (message.error !== undefined) waiter.reject(toError(message.error));
			else waiter.resolve(message.result);
			return;
		}
		if (message?.method === "notifications/tools/list_changed") {
			this.callback.onToolsChanged?.();
		}
	}

	failAll(error) {
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}

	request(method, params, timeoutMs = this.timeoutMs) {
		const id = this.nextId++;
		const payload = { jsonrpc: "2.0", id, method, params };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP 请求超时（${Math.round(timeoutMs / 1000)} 秒）：${method}`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			// N-05：把本次请求的预算透到通道层（HTTP 用同寿命的 abort；stdio 忽略）
			const send = this.channel.send(payload, { timeoutMs });
			if (send instanceof Promise) send.catch((error) => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	notify(method, params) {
		const payload = { jsonrpc: "2.0", method, params };
		// 通知是短操作，跟握手同一档预算（不占工具调用那份长预算）
		const send = this.channel.send(payload, { timeoutMs: this.connectTimeoutMs });
		if (send instanceof Promise) send.catch(() => {});
	}

	async listTools() {
		const tools = [];
		let cursor;
		do {
			const page = await this.request("tools/list", cursor === undefined ? {} : { cursor }, this.connectTimeoutMs);
			for (const tool of page?.tools ?? []) tools.push(tool);
			cursor = page?.nextCursor;
		} while (typeof cursor === "string" && cursor !== "");
		return tools;
	}

	async callTool(name, args) {
		return await this.request("tools/call", { name, arguments: args ?? {} });
	}

	/**
	 * 健康探测：MCP `ping`，用握手那档短超时。对端回了 JSON-RPC 错误
	 * （老实现不认 ping → method not found）也说明它活着，按成功算；只有超时 / 断连才算失败。
	 */
	async ping() {
		try {
			await this.request("ping", {}, this.connectTimeoutMs);
			return { ok: true };
		} catch (error) {
			if (error instanceof McpError) return { ok: true, note: "ping-unsupported" };
			throw error;
		}
	}

	async close() {
		this.failAll(new Error("连接已关闭"));
		await this.channel.close();
	}
}

/** transport 由 registry 条目推导；只有 streamable-http 需要 url。 */
export function transportSpec(entry) {
	if (entry.transport === "streamable-http") {
		return { transport: "streamable-http", url: entry.url, headers: entry.headers ?? {} };
	}
	const env = { ...(entry.env ?? {}) };
	// envPrefix 来自 cordis.patch.yml 里的 `!!js "'路径;...' + process.env.PATH"`：
	// 把字面量前缀拼到父进程同名变量前面，效果和原生 loader 求值一致。
	if (entry.envPrefix && typeof entry.envPrefix === "object") {
		// PATH 类变量的分隔符跟平台走：Windows 用 `;`，POSIX 用 `:`
		const sep = process.platform === "win32" ? ";" : ":";
		for (const [key, prefix] of Object.entries(entry.envPrefix)) {
			if (typeof prefix !== "string") continue;
			const inherited = env[key] ?? process.env[key] ?? "";
			env[key] = inherited === "" ? prefix : `${prefix}${sep}${inherited}`;
		}
	}
	return {
		transport: "stdio",
		command: entry.command,
		args: entry.args ?? [],
		env,
		cwd: entry.cwd ?? ""
	};
}
