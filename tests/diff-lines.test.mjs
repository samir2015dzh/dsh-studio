import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { diffLines, formatDiff } = await import(pathToFileURL(join(pluginRoot, "lib/diff-lines.js")).href);

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

assert(diffLines("", "").length === 0, "两段空文本没有行");
assert(formatDiff(diffLines("a\nb\nc", "a\nb\nc")) === "  a\n  b\n  c", "完全相同");
assert(formatDiff(diffLines("a\nb", "a\nc")) === "  a\n- b\n+ c", "改一行");
assert(formatDiff(diffLines("a", "a\nb")) === "  a\n+ b", "末尾新增");
assert(formatDiff(diffLines("a\nb", "a")) === "  a\n- b", "末尾删除");
assert(formatDiff(diffLines("keep\nold\nkeep", "keep\nnew\nkeep")) === "  keep\n- old\n+ new\n  keep", "中间替换");

const longA = Array.from({ length: 900 }, (_, i) => (i < 3 ? "h" + i : i > 896 ? "t" + i : "m" + i));
const longB = longA.map((line, i) => (i === 50 ? "changed" : line));
const clamped = diffLines(longA.join("\n"), longB.join("\n"), { maxLines: 100 });
assert(clamped[0].type === "eq" && clamped[0].text === "h0", "超长时保留开头");
assert(clamped.some((row) => row.type === "del" && row.text === "m50"), "超长时标出删除的中间行");
assert(clamped.some((row) => row.type === "add" && row.text === "changed"), "超长时标出新增的中间行");
assert(clamped.at(-1).type === "eq" && clamped.at(-1).text === "t899", "超长时保留结尾");

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (diff-lines) ===");
