/**
 * 把两段文本按行对比，标出未改 / 删除 / 新增。无依赖。
 *
 * 算法是最长公共子序列（LCS），和 Python difflib 的思路相同：
 * https://docs.python.org/3/library/difflib.html
 * skill 文件通常不长；任一侧超过 maxLines 时不再做全量 DP，只保留头尾相同的行，中间标成改过。
 */

/**
 * @typedef {{ type: "eq" | "del" | "add", text: string }} DiffLine
 * @param {string} before
 * @param {string} after
 * @param {{ maxLines?: number }} [opts]
 * @returns {DiffLine[]}
 */
export function diffLines(before, after, opts = {}) {
	const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : 800;
	const a = String(before).split("\n");
	const b = String(after).split("\n");
	if (a.length === 1 && a[0] === "" && b.length === 1 && b[0] === "") return [];
	if (a.length > maxLines || b.length > maxLines) return diffLinesClamped(a, b);
	return lcsDiff(a, b);
}

/** @param {string[]} a @param {string[]} b */
function lcsDiff(a, b) {
	const n = a.length;
	const m = b.length;
	const width = m + 1;
	const table = new Int32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		const row = i * width;
		const next = (i + 1) * width;
		for (let j = m - 1; j >= 0; j--) {
			table[row + j] = a[i] === b[j] ? table[next + j + 1] + 1 : Math.max(table[next + j], table[row + j + 1]);
		}
	}
	/** @type {{ type: "eq" | "del" | "add", text: string }[]} */
	const out = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ type: "eq", text: a[i] });
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			out.push({ type: "del", text: a[i] });
			i++;
		} else {
			out.push({ type: "add", text: b[j] });
			j++;
		}
	}
	while (i < n) out.push({ type: "del", text: a[i++] });
	while (j < m) out.push({ type: "add", text: b[j++] });
	return out;
}

/** 超长时只对齐公共前缀和后缀。 */
function diffLinesClamped(a, b) {
	let start = 0;
	const maxStart = Math.min(a.length, b.length);
	while (start < maxStart && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const out = [];
	for (let i = 0; i < start; i++) out.push({ type: "eq", text: a[i] });
	for (let i = start; i < endA; i++) out.push({ type: "del", text: a[i] });
	for (let i = start; i < endB; i++) out.push({ type: "add", text: b[i] });
	for (let i = endA; i < a.length; i++) out.push({ type: "eq", text: a[i] });
	return out;
}

/**
 * 把行 diff 收成短文本，方便日志和测试。
 * @param {DiffLine[]} lines
 */
export function formatDiff(lines) {
	return lines
		.map((line) => (line.type === "eq" ? "  " : line.type === "del" ? "- " : "+ ") + line.text)
		.join("\n");
}
