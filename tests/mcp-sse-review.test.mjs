import { test } from "node:test";
import assert from "node:assert/strict";
import { McpConnection } from "../lib/mcp-client.js";

test("[review B6] SSE 多行 data、CRLF/CR 和逐字节 UTF8 分块按事件解析", async () => {
	const original = globalThis.fetch;
	const connection = new McpConnection({ transport: "http", url: "http://fixture.invalid/mcp" }, { timeoutMs: 1000 });
	globalThis.fetch = async (_url, options) => {
		const { id } = JSON.parse(options.body);
		const bytes = Buffer.from(`: heartbeat\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":${id},"result":{"text":"中文"}}\r\n\r\n: next\r\r`);
		let at = 0;
		return new Response(new ReadableStream({ pull(controller) {
			if (at === bytes.length) controller.close();
			else controller.enqueue(bytes.subarray(at, ++at));
		} }), { headers: { "content-type": "text/event-stream" } });
	};
	try {
		assert.deepEqual(await connection.request("fixture", {}), { text: "中文" });
	} finally {
		await connection.close();
		globalThis.fetch = original;
	}
});
