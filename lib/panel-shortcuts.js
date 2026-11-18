/**
 * 面板键盘快捷键判定（纯函数，方便测试）。
 * 约定靠近常见工作台：Ctrl/Cmd+S 保存、Esc 返回、列表里按 / 聚焦搜索
 *（GitHub、VS Code 等也是类似用法）。
 *
 * 真正绑事件在 lib/client.js，两边规则需保持一致。
 *
 * @param {{ key?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean }} event
 * @param {{ editing?: boolean, canSave?: boolean, query?: string, targetIsField?: boolean }} ctx
 * @returns {"save" | "block-save" | "back" | "clear-search" | "focus-search" | null}
 */
export function shortcutAction(event, ctx = {}) {
	if (!event) return null;
	if (event.altKey) return null;
	const key = String(event.key ?? "");
	const meta = event.metaKey === true || event.ctrlKey === true;
	const editing = ctx.editing === true;
	const inField = ctx.targetIsField === true;

	if (meta && (key === "s" || key === "S")) {
		if (!editing) return null;
		return ctx.canSave === true ? "save" : "block-save";
	}
	if (key === "Escape") {
		if (editing) return "back";
		if (String(ctx.query ?? "").trim() !== "") return "clear-search";
		return null;
	}
	if (key === "/" && !meta && !editing && !inField) return "focus-search";
	return null;
}
