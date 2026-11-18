/**
 * 工具与路由共用的小工具：文本内容块、错误文案、JSON 请求体读写、路由错误包装。
 * （从 index.js 拆出，逻辑未改。）
 */
import { UserError } from "./errors.js";

/** Cap on JSON request bodies (skill bodies can be long). */
const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** One text content block (the only render shape these tools emit). */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Normalize a thrown value to a printable string. */
function ErrorMsg(error) {
	return error instanceof Error ? error.message : String(error);
}
/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/**
 * 请求体超过上限（C6）：以前和「解析不了」一样返回 undefined，调用方一律报「invalid JSON body (name required)」，
 * 一份 1 MB 以上的技能正文保存失败，看到的却是「缺 name」。现在单独报 413 与真实原因（handle 把 UserError 映射成对应状态码）。
 */
function bodyTooLarge(limit = MAX_JSON_BODY_BYTES) {
	return new UserError(`请求体超过 ${Math.round(limit / 1024 / 1024)} MB 上限，没有处理（技能正文过大？把大段素材拆到技能目录里的单独文件）`, 413, { code: "BODY_TOO_LARGE" });
}
/** Read a JSON request body (undefined when unparseable; throws 413 when too large). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) throw bodyTooLarge();
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Read a query value from a request URL. */
function queryValue(req, key) {
	try {
		const url = new URL(req.url ?? "", "http://127.0.0.1");
		return url.searchParams.get(key) ?? void 0;
	} catch {
		return void 0;
	}
}
/** Wrap an async route handler with uniform error → JSON mapping. */
function handle(ctx, fn) {
	return async (req, res) => {
		try {
			await fn(req, res);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof UserError) {
				const body = { error: message };
				if (typeof error.code === "string") body.code = error.code;
				if (error.payload && typeof error.payload === "object") Object.assign(body, error.payload);
				writeJson(res, error.statusCode || 400, body);
				return;
			}
			const status = typeof error?.statusCode === "number" ? error.statusCode : 500;
			if (status >= 500) ctx.logger?.error?.(`[dsh-studio] route error: ${message}`);
			writeJson(res, status, { error: message });
		}
	};
}

export { ErrorMsg, MAX_JSON_BODY_BYTES, bodyTooLarge, handle, queryValue, readJsonBody, text, writeJson };
