import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { shortcutAction } = await import(pathToFileURL(join(pluginRoot, "lib/panel-shortcuts.js")).href);

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

const ev = (key, extra = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...extra });

assert(shortcutAction(ev("s", { ctrlKey: true }), { editing: true, canSave: true }) === "save", "Ctrl+S 保存");
assert(shortcutAction(ev("s", { metaKey: true }), { editing: true, canSave: true }) === "save", "Cmd+S 保存");
assert(shortcutAction(ev("S", { ctrlKey: true }), { editing: true, canSave: true }) === "save", "Ctrl+Shift+S 也视为保存（key 为 S）");
assert(shortcutAction(ev("s", { ctrlKey: true }), { editing: true, canSave: false }) === "block-save", "不能保存时仍拦住浏览器另存为");
assert(shortcutAction(ev("s", { ctrlKey: true }), { editing: false, canSave: true }) === null, "列表页 Ctrl+S 不处理");
assert(shortcutAction(ev("s", { ctrlKey: true, altKey: true }), { editing: true, canSave: true }) === null, "Ctrl+Alt+S 不抢");

assert(shortcutAction(ev("Escape"), { editing: true }) === "back", "编辑时 Esc 返回列表");
assert(shortcutAction(ev("Escape"), { editing: false, query: "foo" }) === "clear-search", "列表有搜索词时 Esc 清空");
assert(shortcutAction(ev("Escape"), { editing: false, query: "  " }) === null, "搜索词为空时 Esc 不处理");

assert(shortcutAction(ev("/"), { editing: false, targetIsField: false }) === "focus-search", "列表里 / 聚焦搜索");
assert(shortcutAction(ev("/"), { editing: false, targetIsField: true }) === null, "输入框里的 / 不抢");
assert(shortcutAction(ev("/"), { editing: true, targetIsField: false }) === null, "编辑页 / 不抢（正文里会用到）");
assert(shortcutAction(ev("/", { ctrlKey: true }), { editing: false }) === null, "Ctrl+/ 不处理");
assert(shortcutAction(null, {}) === null, "空事件");

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (panel-shortcuts) ===");
