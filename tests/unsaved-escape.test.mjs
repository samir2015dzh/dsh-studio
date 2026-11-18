/**
 * Esc 必须在捕获阶段拦住，否则宿主设置层会先关掉面板；
 * 宿主关闭时留下的草稿应能提示恢复。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const {
	shouldCaptureEscape,
	claimEscape,
	dispatchEscapePhases,
	writeUnsavedDraft,
	readUnsavedDraft,
	clearUnsavedDraft,
	draftToRestore,
	persistDirtyDraft,
	draftKey,
	DRAFT_RESTORE,
} = await import(pathToFileURL(join(pluginRoot, "lib/unsaved-escape.js")).href);
const { UNSAVED_LEAVE } = await import(pathToFileURL(join(pluginRoot, "lib/unsaved.js")).href);

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

const ev = (extra = {}) => {
	const event = {
		key: "Escape",
		stopped: false,
		prevented: false,
		get cancelBubble() {
			return this.stopped;
		},
		stopPropagation() {
			this.stopped = true;
		},
		preventDefault() {
			this.prevented = true;
		},
		...extra,
	};
	return event;
};

assert(shouldCaptureEscape(ev(), { editing: true }) === true, "编辑页 Esc 要捕获");
assert(shouldCaptureEscape(ev(), { editing: false, query: "foo" }) === true, "列表有搜索词时 Esc 要捕获");
assert(shouldCaptureEscape(ev(), { editing: false, query: "" }) === false, "列表无搜索时把 Esc 交给宿主关设置");
assert(shouldCaptureEscape({ key: "s", ctrlKey: true }, { editing: true, canSave: true }) === false, "非 Esc 不走捕获声明");

const canceled = ev();
let asked = "";
const nextCancel = claimEscape(canceled, { editing: true }, {
	dirty: true,
	confirmLeave: UNSAVED_LEAVE,
	confirmFn: (m) => {
		asked = m;
		return false;
	},
});
assert(nextCancel === null, "脏且取消离开时不返回列表");
assert(canceled.stopped && canceled.prevented, "即使用户取消，也必须 stop/prevent，避免宿主关设置");
assert(asked === UNSAVED_LEAVE, "问的是离开文案");

const okLeave = ev();
assert(
	claimEscape(okLeave, { editing: true }, { dirty: true, confirmLeave: UNSAVED_LEAVE, confirmFn: () => true }) === "back",
	"脏且确认后返回列表",
);
assert(okLeave.stopped, "确认离开时同样已经 stop");

assert(claimEscape(ev(), { editing: true }, { dirty: false }) === "back", "不脏时 Esc 直接返回列表并拦住宿主");
assert(claimEscape(ev(), { editing: false, query: "x" }, { dirty: false }) === "clear-search", "有搜索词时 Esc 清空搜索并拦住宿主");

// 捕获 vs 宿主 document 冒泡
let hostClosed = false;
const captured = ev();
dispatchEscapePhases(captured, {
	capture: (event) =>
		claimEscape(event, { editing: true }, { dirty: true, confirmLeave: UNSAVED_LEAVE, confirmFn: () => false }),
	bubble: () => {
		hostClosed = true;
	},
});
assert(hostClosed === false, "捕获阶段拦住后，宿主 document 冒泡监听不会关设置");

hostClosed = false;
const leaked = ev();
dispatchEscapePhases(leaked, {
	capture: () => {},
	bubble: () => {
		hostClosed = true;
	},
});
assert(hostClosed === true, "没有捕获拦截时，宿主冒泡监听会关设置（对照）");

// 草稿存储
const mem = new Map();
const storage = {
	getItem: (k) => (mem.has(k) ? mem.get(k) : null),
	setItem: (k, v) => mem.set(k, v),
	removeItem: (k) => mem.delete(k),
};
assert(writeUnsavedDraft(storage, "demo", "hello") === true, "能写入草稿");
assert(readUnsavedDraft(storage, "demo").content === "hello", "能读回草稿");
assert(draftToRestore(storage, "demo", "hello") === null, "与磁盘相同时不提示恢复");
assert(mem.has(draftKey("demo")) === false, "相同时清掉草稿");
writeUnsavedDraft(storage, "demo", "edited");
const pending = draftToRestore(storage, "demo", "hello");
assert(pending && pending.content === "edited", "与磁盘不同时提示恢复");
clearUnsavedDraft(storage, "demo");
assert(readUnsavedDraft(storage, "demo") === null, "丢弃后没有草稿");
assert(persistDirtyDraft(storage, { dirty: true, name: "demo", content: "x" }) === true, "脏快照会落草稿");
assert(persistDirtyDraft(storage, { dirty: false, name: "demo", content: "x" }) === false, "不脏不写");
assert(writeUnsavedDraft(null, "demo", "x") === false, "没有 storage 时不抛");
assert(readUnsavedDraft({ getItem: () => "not-json" }, "demo") === null, "坏 JSON 当没有草稿");
assert(typeof DRAFT_RESTORE === "string" && DRAFT_RESTORE.includes("草稿"), "恢复提示文案");

if (failed > 0) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall passed");
