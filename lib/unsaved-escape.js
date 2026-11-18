/**
 * Escape 捕获阶段拦截，以及宿主关掉设置层时的草稿兜底。
 *
 * 宿主 SettingsPanel 在 document 上用冒泡阶段监听 Escape，然后 onClose()：
 *   document.addEventListener("keydown", onKeyDown)  // 默认冒泡，e.key === "Escape" → 关设置
 * 公开讨论里的实现（只读，不改宿主）：
 *   https://github.com/deepseek-ai/deepseek-harness/discussions/5861
 *   https://github.com/deepseek-ai/deepseek-harness/discussions/799
 *   https://github.com/deepseek-ai/deepseek-harness/discussions/938
 * 面板若只在 window 冒泡阶段监听，事件先到达 document，设置层已卸掉，
 * 面板的 confirm / back 跑不到（真机第 28 项）。必须在捕获阶段拦截，
 * 并 stopPropagation / preventDefault。
 *
 * 草稿兜底：关设置 / 面板卸载时 localStorage 留下未保存正文，下次打开同一
 * 技能若与磁盘不同则提示恢复。flush 用 pagehide + visibilitychange(hidden)，
 * 不只依赖 unmount（整页关闭时 React cleanup 不一定跑到）：
 *   https://github.com/usememos/memos/commit/9ca71229a6c0dfad44b76ed06fced46c5bef49c7
 *   https://github.com/alkem-io/client-web/pull/10089
 */
import { shortcutAction } from "./panel-shortcuts.js";

export const DRAFT_PREFIX = "dsh-studio.unsaved-draft.";
export const DRAFT_RESTORE = "有一份未保存的草稿，要恢复吗？";
/** 草稿记下的基线与磁盘当前版本对不上（文件在别处被改过）时的提示。 */
export const DRAFT_RESTORE_STALE = "有一份未保存的草稿，但磁盘上的文件在那之后被改过。恢复后保存会先和磁盘上的新版本比对（出现冲突提示），不会直接覆盖。要恢复吗？";

/** 本面板会处理这次 Esc 时，必须在捕获阶段拦住，避免宿主关掉设置层。 */
export function shouldCaptureEscape(event, ctx) {
	if (!event || String(event.key ?? "") !== "Escape") return false;
	const action = shortcutAction(event, ctx);
	return action === "back" || action === "clear-search";
}

/**
 * 声称处理这次 Escape：先 stop，再决定下一步。
 * 有未保存修改时仍要 stop（即使用户点了取消确认），否则事件会继续冒泡到宿主。
 * @returns {"back" | "clear-search" | null} 调用方接着做的动作；null 表示已拦住但用户取消离开
 */
export function claimEscape(event, ctx, { dirty, confirmLeave, confirmFn } = {}) {
	if (!shouldCaptureEscape(event, ctx)) return null;
	if (typeof event.stopPropagation === "function") event.stopPropagation();
	if (typeof event.preventDefault === "function") event.preventDefault();
	const action = shortcutAction(event, ctx);
	if (action === "back" && dirty) {
		if (typeof confirmFn === "function") {
			return confirmFn(confirmLeave) === true ? "back" : null;
		}
		return "back";
	}
	return action;
}

/** 模拟捕获再冒泡，用来测「宿主 document 冒泡监听会被拦住」。 */
export function dispatchEscapePhases(event, { capture, bubble }) {
	if (typeof capture === "function") capture(event);
	if (!event.cancelBubble && typeof bubble === "function") bubble(event);
	return event;
}

export function draftKey(name) {
	return `${DRAFT_PREFIX}${encodeURIComponent(String(name ?? ""))}`;
}

/**
 * @param {number} [baseMtimeMs] 这份草稿是基于磁盘上哪个版本改的（打开时的 mtimeMs）。· A9：
 *   旧写法不记，文件在磁盘上被改过之后再恢复旧草稿并保存，带的是新的 expectedMtime，不触发 409，旧草稿直接盖掉新内容。
 */
export function writeUnsavedDraft(storage, name, content, baseMtimeMs) {
	if (!storage || typeof storage.setItem !== "function" || !name) return false;
	try {
		const data = { name, content: String(content ?? ""), savedAt: Date.now() };
		if (Number.isFinite(baseMtimeMs)) data.baseMtimeMs = baseMtimeMs;
		storage.setItem(draftKey(name), JSON.stringify(data));
		return true;
	} catch {
		return false;
	}
}

export function readUnsavedDraft(storage, name) {
	if (!storage || typeof storage.getItem !== "function" || !name) return null;
	try {
		const raw = storage.getItem(draftKey(name));
		if (!raw) return null;
		const data = JSON.parse(raw);
		if (!data || typeof data.content !== "string") return null;
		return data;
	} catch {
		return null;
	}
}

export function clearUnsavedDraft(storage, name) {
	if (!storage || typeof storage.removeItem !== "function" || !name) return;
	try {
		storage.removeItem(draftKey(name));
	} catch {
		/* 存取失败不影响编辑 */
	}
}

/**
 * 草稿与磁盘一致则清掉并返回 null，否则返回草稿。
 * 传了 currentMtimeMs 时标出 `stale`：草稿记的基线与磁盘当前版本不同（或旧草稿没记基线）——
 * 恢复要用 DRAFT_RESTORE_STALE 提示，保存时 expectedMtime 用 restoredExpectedMtime 给的值。
 */
export function draftToRestore(storage, name, baseline, currentMtimeMs) {
	const data = readUnsavedDraft(storage, name);
	if (!data) return null;
	if (String(data.content) === String(baseline ?? "")) {
		clearUnsavedDraft(storage, name);
		return null;
	}
	if (Number.isFinite(currentMtimeMs)) data.stale = !Number.isFinite(data.baseMtimeMs) || data.baseMtimeMs !== currentMtimeMs;
	return data;
}

/**
 * 恢复草稿后保存用的 expectedMtime：草稿基线与磁盘一致就用磁盘当前的；不一致用草稿自己的基线
 * （没记基线的旧草稿用 0）——保存时服务端发现对不上，走 409 冲突比对，而不是悄悄覆盖磁盘上的新内容。
 */
export function restoredExpectedMtime(draft, currentMtimeMs) {
	if (!draft || draft.stale !== true) return currentMtimeMs;
	return Number.isFinite(draft.baseMtimeMs) ? draft.baseMtimeMs : 0;
}

export function persistDirtyDraft(storage, snapshot) {
	if (!snapshot || !snapshot.dirty || !snapshot.name) return false;
	return writeUnsavedDraft(storage, snapshot.name, snapshot.content, snapshot.baseMtimeMs);
}
