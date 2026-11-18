/**
 * 编辑页「有没有没保存的修改」。
 * 思路借鉴 react-admin useWarnWhenUnsavedChanges 与 payload-puck useUnsavedChanges：
 *   https://github.com/marmelab/react-admin/blob/master/packages/ra-core/src/form/useWarnWhenUnsavedChanges.tsx
 *   https://github.com/delmaredigital/payload-puck/blob/d2293744/src/editor/hooks/useUnsavedChanges.ts
 * 站内离开（返回 / Esc / 重新加载）用 window.confirm；关页或刷新用 beforeunload。
 */
export const UNSAVED_LEAVE = "还有没保存的修改，确定离开吗？";
export const UNSAVED_RELOAD = "重新加载会丢掉没保存的修改，继续吗？";

/** @param {{ editable?: boolean } | null} selected @param {string} draft @param {string} baseline */
export function isDirty(selected, draft, baseline) {
	return Boolean(selected && selected.editable) && String(draft ?? "") !== String(baseline ?? "");
}

/** 不脏直接放行；脏时问一句。没有 confirm（非浏览器）时放行。 */
export function confirmDiscard(dirty, message, confirmFn) {
	if (!dirty) return true;
	if (typeof confirmFn !== "function") return true;
	return confirmFn(message) === true;
}
