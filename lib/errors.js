/**
 * HTTP 层可区分的用户错误 vs 内部错误。
 * handle() 用 statusCode：UserError → 4xx；其它 → 500 + logger.error。
 */
export class UserError extends Error {
	/**
	 * @param {string} message
	 * @param {number} [statusCode=400]
	 * @param {{ code?: string, payload?: Record<string, unknown> }} [extras]
	 */
	constructor(message, statusCode = 400, extras = undefined) {
		super(message);
		this.name = "UserError";
		this.statusCode = statusCode;
		if (extras && typeof extras === "object") {
			if (typeof extras.code === "string") this.code = extras.code;
			if (extras.payload && typeof extras.payload === "object") this.payload = extras.payload;
		}
	}
}

/** @param {string} message */
export function notFound(message) {
	return new UserError(message, 404);
}
