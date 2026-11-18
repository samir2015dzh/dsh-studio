// F-4 fixture：最小的 stdio MCP 服务端，只为在伪 HOME 里把
// mcp_register / mcp_load / mcp_call 真跑起来（换成真实 MCP 对端也行，但没必要联网）。
//
// 协议面：initialize / tools/list / tools/call，按行收发 JSON-RPC，与 lib/mcp-client.js 的 framing 一致。
//
// N-14（纯测试侧）：把产品代码里两条真实存在、却一直没被常驻测试行使的路径打开
//   - cursor 分页（listTools 的跨页循环）：MOCK_MCP_PAGED=1 时 tools/list 第一页带 nextCursor
//   - notifications/tools/list_changed（dispatch → onToolsChanged → 目录重挂）：
//     调 `grow` 工具后工具集扩张并发通知；MOCK_MCP_NO_NOTIFY=1 时故意不发（供「断言非空转」自证）
//
// （纯测试侧）：
//   - MOCK_MCP_SPAWN_LOG=<文件>：每次进程启动往文件追加一行（断言「未选中的 server 没有连接」）
//   - MOCK_MCP_EXTRA=1：多报三个带读写语义的工具（write_note 无注解 / zap 注解只读 / danger 注解破坏性）
//   - ping：回空结果（健康检查）；MOCK_MCP_NO_PING=1 时按未知方法回错
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.MOCK_MCP_SPAWN_LOG) appendFileSync(process.env.MOCK_MCP_SPAWN_LOG, `${process.env.MOCK_MCP_TAG ?? "mock"} ${process.pid}\n`);

const write = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const PAGED = process.env.MOCK_MCP_PAGED === "1";
const NO_NOTIFY = process.env.MOCK_MCP_NO_NOTIFY === "1";

const tool = (name, description, properties = {}) => ({
	name,
	description,
	inputSchema: { type: "object", properties }
});

const ECHO = tool("echo", "原样回显 text 参数", { text: { type: "string" } });
const GROW = tool("grow", "扩张工具集；默认同时发出 notifications/tools/list_changed");
const PAGE_A = tool("page-a", "第一页收尾（分页模式下第一页到此为止）");
const PAGE_B = tool("page-b", "第二页第一个");
const PAGE_C = tool("page-c", "第二页第二个");
const GROWN = tool("grown", "grow 之后才出现的工具");
const EXTRA = process.env.MOCK_MCP_EXTRA === "1"
	? [
		tool("write_note", "写一条笔记（无注解，按名字判可写）", { text: { type: "string" } }),
		{ ...tool("zap", "查一下（名字看不出读写，注解声明只读）"), annotations: { readOnlyHint: true } },
		{ ...tool("danger", "删库（注解声明破坏性）"), annotations: { destructiveHint: true } }
	]
	: [];

let grown = false;
const firstPage = () => (PAGED ? [ECHO, GROW, PAGE_A] : [ECHO, ...EXTRA, ...(grown ? [GROWN] : [])]);
const secondPage = () => [PAGE_B, PAGE_C, ...(grown ? [GROWN] : [])];

createInterface({ input: process.stdin }).on("line", async (line) => {
	if (line.trim() === "") return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	// 通知（没有 id）不回包
	if (message.id === undefined) return;
	if (message.method === "initialize") {
		// B4（纯测试侧）：MOCK_MCP_INIT_DELAY_MS=<毫秒>，握手慢一点，量 eager 是否并行连
		const delay = Number(process.env.MOCK_MCP_INIT_DELAY_MS ?? 0);
		if (delay > 0) await new Promise((r) => setTimeout(r, delay));
		write({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: "mock-mcp", version: "1.1.0" }
			}
		});
		return;
	}
	if (message.method === "ping" && process.env.MOCK_MCP_NO_PING !== "1") {
		write({ jsonrpc: "2.0", id: message.id, result: {} });
		return;
	}
	if (message.method === "tools/list") {
		// B7（纯测试侧）：MOCK_MCP_LIST_LOG=<文件>，每次 tools/list 追加一行（断言冷加载只列一次）
		if (process.env.MOCK_MCP_LIST_LOG) appendFileSync(process.env.MOCK_MCP_LIST_LOG, "list\n");
		if (!PAGED) {
			write({ jsonrpc: "2.0", id: message.id, result: { tools: firstPage() } });
			return;
		}
		const cursor = typeof message.params?.cursor === "string" ? message.params.cursor : "";
		if (cursor === "") {
			write({ jsonrpc: "2.0", id: message.id, result: { tools: firstPage(), nextCursor: "page-2" } });
			return;
		}
		write({ jsonrpc: "2.0", id: message.id, result: { tools: secondPage() } });
		return;
	}
	if (message.method === "tools/call") {
		const name = message.params?.name;
		const args = message.params?.arguments ?? {};
		if (name === "grow") {
			grown = true;
			write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "grown" }] } });
			if (!NO_NOTIFY) write({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
			return;
		}
		if (name === "page-a" || name === "page-b" || name === "page-c" || name === "grown") {
			write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "called:" + name }] } });
			return;
		}
		write({
			jsonrpc: "2.0",
			id: message.id,
			result: { content: [{ type: "text", text: "echo:" + String(args.text ?? "") }] }
		});
		return;
	}
	write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found: " + message.method } });
});
