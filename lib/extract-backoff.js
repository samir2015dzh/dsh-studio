/**
 * 定时提取的失败退避。
 *
 * 以前提取抛错（模型超时、报错、返回解析不了）时不记运行时间，60 秒的定时器下一轮
 * 又会判定「到点了」再跑一遍：重新解压窗口内全部会话、再发一次大请求，模型一直不可用
 * 就一直每分钟重试。这里按连续失败次数给出下次允许重试前要等多久。
 */

/** 第一次失败后等多久。 */
export const BACKOFF_BASE_MS = 5 * 60 * 1000;
/** 等待时间的上限。 */
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * 连续失败 failures 次之后，下次重试前要等的毫秒数：5 分钟起，每次翻倍，封顶 6 小时。
 * @param {number} failures 连续失败次数（成功一次即清零）
 * @returns {number}
 */
export function extractBackoffMs(failures) {
	const n = Number.isFinite(failures) ? Math.floor(failures) : 0;
	if (n <= 0) return 0;
	// 指数先封顶再乘，避免次数很大时溢出
	return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 16));
}
