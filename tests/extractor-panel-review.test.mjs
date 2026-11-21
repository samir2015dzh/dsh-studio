// 组件状态/交互的轻量模型：不启动浏览器或宿主；实际 DOM 与可访问性留给 Muse。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function panel(api) {
	const states = [];
	let cursor = 0, initial = true;
	const effects = [];
	const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x !== false && x != null) });
	const React = {
		useState(value) {
			const i = cursor++;
			if (!(i in states)) states[i] = value;
			return [states[i], (next) => { states[i] = typeof next === "function" ? next(states[i]) : next; }];
		},
		useCallback: (fn) => fn,
		useEffect(fn) { if (initial) effects.push(fn); }
	};
	const source = readFileSync(new URL("../src/client/ExtractorPanel.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/^export .*;\n/gm, "");
	const context = vm.createContext({ React, api, h, Note: "note" });
	vm.runInContext(source + "\nthis.Panel = ExtractorPanel;", context);
	return {
		render() { cursor = 0; const tree = context.Panel(); initial = false; return tree; },
		async mount() { this.render(); effects.forEach((fn) => fn()); await tick(); return this.render(); }
	};
}
const text = (node) => typeof node === "object" ? node.children.map(text).join(" ") : String(node);
function button(node, name) {
	if (typeof node !== "object") return null;
	if (node.type === "button" && text(node) === name) return node;
	return node.children.map((child) => button(child, name)).find(Boolean);
}

test("[review U1/U2] 刷新不抹提取错误，新草稿与旧候选同时可操作", async () => {
	let fail = true;
	let decided;
	const view = { queue: [{ id: "q", name: "新草稿", status: "queued" }], drafts: [{ id: "f", name: "失败草稿", status: "failed", failure: { reasons: ["关键项低分"] } }], config: { enabled: false } };
	const api = {
		extractStatus: async () => ({ enabled: true }),
		extractCandidates: async () => ({ candidates: [{ id: "old", name: "旧候选", body: "旧正文" }] }),
		extractRecent: async () => ({ skills: [] }),
		distillStatus: async () => view,
		extractRun: async () => ({ ok: !fail, message: fail ? "无可用模型" : "提取完成" }),
		distillSource: async (id) => ({ draftId: id, name: "新草稿", sessions: [{ id: "sess", readable: true, context: [{ turn: 1, role: "user", text: "来源请求" }] }] }),
		distillDecide: async (...args) => { decided = args; return { ok: true }; },
		distillRun: async () => ({ status: "completed", counts: { published: 1 }, markdown: "批次报告" })
	};
	const p = panel(api);
	let tree = await p.mount();
	assert.match(text(tree), /旧候选/);
	assert.match(text(tree), /新草稿/);
	button(tree, "立即提取草稿").props.onClick();
	await tick();
	tree = p.render();
	assert.match(text(tree), /无可用模型/);
	button(tree, "刷新").props.onClick();
	await tick();
	assert.match(text(p.render()), /无可用模型/, "成功刷新不能清除操作失败");
	fail = false;
	button(p.render(), "立即提取草稿").props.onClick();
	await tick();
	assert.doesNotMatch(text(p.render()), /无可用模型/);
	button(p.render(), "查看来源 · 新草稿").props.onClick();
	await tick();
	assert.match(text(p.render()), /来源请求/);
	button(p.render(), "重新排队 · 失败草稿").props.onClick();
	await tick();
	assert.deepEqual(Array.from(decided), ["f", "requeue", ""]);
	button(p.render(), "处理一批草稿（会调用模型）").props.onClick();
	await tick();
	assert.match(text(p.render()), /批次报告/);
});
