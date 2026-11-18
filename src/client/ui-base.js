import * as React from "react";
import { Api } from "./api.js";

/**
 * Skill 管理器 settings panel — rendered inside the web settings page
 * (settings.section entry). Lists every discovered skill with its
 * invocation state, lets the user view/edit the full SKILL.md body, and
 * toggle enable/disable (model / user invocation). Plain React with
 * inline styles — no external UI package.
 */
/** Module-level API client (stateless; the component closes over it). */
const api = new Api();
/** Shortcut for React.createElement. */
const h = React.createElement;

/**
 * 一次注入的样式表：系统字体、设计变量（强调色 / 线 / 面）、卡片、分段控件、开关、徽标。
 * 只用 currentColor 混色，所以宿主亮色 / 暗色主题下都成立。
 * 无动画库、无持续动画（只有 hover / 开关的 120ms 过渡，减少动态偏好下关闭）、无模糊阴影、无外链字体 / CDN。
 */
const STUDIO_CSS = [
	".dshs-root{--ds-a:#3b82f6;--ds-a-text:color-mix(in srgb,#3b82f6 72%,currentColor);--ds-a-soft:color-mix(in srgb,#3b82f6 14%,transparent);--ds-a-line:color-mix(in srgb,#3b82f6 50%,transparent);--ds-line:color-mix(in srgb,currentColor 11%,transparent);--ds-line-2:color-mix(in srgb,currentColor 19%,transparent);--ds-fill:color-mix(in srgb,currentColor 3%,transparent);--ds-fill-2:color-mix(in srgb,currentColor 7%,transparent);--ds-ok:#3f9a5c;--ds-warn:#c27c2c;--ds-bad:#c4553f;",
	"font-family:system-ui,-apple-system,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif;max-width:860px;font-size:13px;line-height:1.5;display:flex;flex-direction:column;gap:14px;color:inherit}",
	".dshs-root *{box-sizing:border-box}",
	".dshs-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
	".dshs-title{font-weight:650;font-size:15px;margin:0;display:inline-flex;align-items:center;gap:9px;letter-spacing:.01em}",
	".dshs-mark{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:8px;background:var(--ds-a-soft);color:var(--ds-a-text);flex:0 0 auto}",
	".dshs-sub{font-size:12px;opacity:.6;margin:0}",
	".dshs-path{font-size:11.5px;opacity:.5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
	".dshs-grow{flex:1 1 auto;min-width:0}",
	".dshs-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px}",
	".dshs-stat{display:flex;flex-direction:column;gap:2px;padding:10px 13px;border-radius:10px;border:1px solid var(--ds-line);background:var(--ds-fill);min-width:0}",
	".dshs-stat b{font-size:20px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums}",
	".dshs-stat span{font-size:11.5px;opacity:.58}",
	".dshs-stat.is-accent b{color:var(--ds-a-text)}.dshs-stat.is-warn b{color:var(--ds-warn)}",
	".dshs-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:12px;border:1px solid var(--ds-line);background:var(--ds-fill)}",
	".dshs-card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:24px}",
	".dshs-label{font-size:11px;font-weight:600;letter-spacing:.05em;opacity:.55;white-space:nowrap}",
	".dshs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
	".dshs-field{display:grid;grid-template-columns:84px 1fr;align-items:center;gap:6px 10px;font-size:12px}",
	".dshs-field>span{opacity:.68}",
	".dshs-track{display:flex;align-items:center;gap:5px;flex-wrap:wrap}",
	".dshs-track>.dshs-label{min-width:34px}",
	".dshs-chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:2px 10px;border-radius:999px;cursor:pointer;user-select:none;border:1px solid var(--ds-line);background:transparent;opacity:.8;line-height:1.5;white-space:nowrap}",
	".dshs-chip:hover{opacity:1;background:var(--ds-fill-2)}",
	".dshs-chip.is-on{opacity:1;border-color:var(--ds-a-line);background:var(--ds-a-soft);color:var(--ds-a-text);font-weight:600}",
	".dshs-chip.is-empty{opacity:.38}",
	".dshs-chip i{font-style:normal;font-size:11px;opacity:.6;font-weight:400;font-variant-numeric:tabular-nums}",
	".dshs-tabs{display:inline-flex;align-items:center;padding:2px;gap:2px;border-radius:9px;background:var(--ds-fill-2);border:1px solid var(--ds-line)}",
	".dshs-tabs>.dshs-chip{border:0;border-radius:7px;padding:3px 14px;opacity:.65}",
	".dshs-tabs>.dshs-chip.is-on{opacity:1}",
	".dshs-seg{display:inline-flex;align-items:center;padding:2px;gap:2px;border-radius:8px;background:var(--ds-fill-2);border:1px solid var(--ds-line);flex:0 0 auto}",
	".dshs-seg>span{font-size:12px;padding:2px 10px;border-radius:6px;cursor:pointer;user-select:none;opacity:.62;white-space:nowrap;line-height:1.5}",
	".dshs-seg>span:hover{opacity:1}",
	".dshs-seg>span.is-on{opacity:1;background:var(--ds-a-soft);color:var(--ds-a-text);font-weight:600}",
	".dshs-seg.is-sm>span{font-size:11px;padding:0 8px}",
	".dshs-seg.is-busy>span{cursor:default}",
	".dshs-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 11px;border-radius:7px;cursor:pointer;border:1px solid var(--ds-line-2);background:var(--ds-fill);color:inherit;font-size:12px;font-family:inherit;white-space:nowrap;line-height:1}",
	".dshs-btn:hover{background:var(--ds-fill-2);border-color:color-mix(in srgb,currentColor 30%,transparent)}",
	".dshs-btn:disabled{opacity:.4;cursor:not-allowed}",
	".dshs-btn-pri{background:var(--ds-a);border-color:var(--ds-a);color:#fff;font-weight:600}",
	".dshs-btn-pri:hover{background:color-mix(in srgb,var(--ds-a) 86%,#000);border-color:color-mix(in srgb,var(--ds-a) 86%,#000)}",
	".dshs-btn-ghost{background:transparent;border-color:transparent}",
	".dshs-btn-sm{height:24px;padding:0 8px;font-size:11.5px}",
	".dshs-btn-danger:hover,.dshs-btn.is-danger{border-color:color-mix(in srgb,var(--ds-bad) 55%,transparent);color:var(--ds-bad);background:color-mix(in srgb,var(--ds-bad) 8%,transparent)}",
	".dshs-search,.dshs-input{height:28px;padding:0 9px;border-radius:7px;border:1px solid var(--ds-line-2);background:var(--ds-fill);color:inherit;font-size:12px;font-family:inherit;min-width:0}",
	".dshs-search{padding-left:29px;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' stroke='%23888' stroke-width='1.6' stroke-linecap='round'%3E%3Ccircle cx='6' cy='6' r='4.3'/%3E%3Cpath d='M9.3 9.3 12.6 12.6'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:9px 50%}",
	".dshs-search:hover,.dshs-input:hover{border-color:color-mix(in srgb,currentColor 30%,transparent)}",
	".dshs-search:focus,.dshs-input:focus{outline:none;border-color:var(--ds-a-line)}",
	".dshs-input:disabled{opacity:.5}",
	".dshs-num{width:58px;text-align:center}",
	"select.dshs-input{padding-right:4px}",
	".dshs-chip:focus-visible,.dshs-seg>span:focus-visible,.dshs-btn:focus-visible,.dshs-search:focus-visible,.dshs-input:focus-visible,.dshs-switch:focus-visible,.dshs-item:focus-visible,.dshs-fold>summary:focus-visible{outline:2px solid var(--ds-a-line);outline-offset:1px}",
	".dshs-code{width:100%;min-height:300px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;padding:10px 12px;border-radius:10px;border:1px solid var(--ds-line-2);background:var(--ds-fill);color:inherit;tab-size:2}",
	".dshs-code:focus{outline:none;border-color:var(--ds-a-line)}",
	".dshs-list{display:flex;flex-direction:column;gap:6px}",
	".dshs-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--ds-line);background:var(--ds-fill);cursor:pointer;min-width:0}",
	".dshs-item:hover{border-color:var(--ds-line-2);background:var(--ds-fill-2)}",
	".dshs-item.is-static{cursor:default}",
	".dshs-item.is-sel{border-color:var(--ds-a-line);background:var(--ds-a-soft)}",
	".dshs-main{flex:1 1 auto;min-width:0}",
	".dshs-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}",
	".dshs-name>b{font-weight:600;font-size:13px;word-break:break-all}",
	".dshs-desc{font-size:12px;opacity:.62;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dshs-meta{font-size:11.5px;opacity:.55;margin-top:2px;word-break:break-all}",
	".dshs-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}",
	"@media (hover:hover){.dshs-item .dshs-reveal{opacity:0}.dshs-item:hover .dshs-reveal,.dshs-item:focus-within .dshs-reveal{opacity:1}}",
	".dshs-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:color-mix(in srgb,currentColor 32%,transparent)}",
	".dshs-dot.is-on{background:var(--ds-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ds-ok) 18%,transparent)}",
	".dshs-dot.is-bad{background:var(--ds-bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--ds-bad) 18%,transparent)}",
	".dshs-tag{display:inline-flex;align-items:center;font-size:10.5px;line-height:1.6;padding:0 7px;border-radius:999px;background:var(--ds-fill-2);white-space:nowrap;font-weight:500}",
	".dshs-tag.is-ok{background:color-mix(in srgb,var(--ds-ok) 15%,transparent);color:var(--ds-ok)}",
	".dshs-tag.is-warn{background:color-mix(in srgb,var(--ds-warn) 16%,transparent);color:var(--ds-warn)}",
	".dshs-tag.is-bad{background:color-mix(in srgb,var(--ds-bad) 14%,transparent);color:var(--ds-bad)}",
	".dshs-tag.is-accent{background:var(--ds-a-soft);color:var(--ds-a-text)}",
	".dshs-tag.is-line{background:transparent;border:1px solid var(--ds-line-2)}",
	".dshs-switch{appearance:none;-webkit-appearance:none;margin:0;position:relative;width:30px;height:17px;border-radius:999px;background:color-mix(in srgb,currentColor 24%,transparent);cursor:pointer;flex:0 0 auto;transition:background-color .12s}",
	".dshs-switch::before{content:\"\";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .12s}",
	".dshs-switch:checked{background:var(--ds-a)}.dshs-switch:checked::before{transform:translateX(13px)}",
	".dshs-switch:disabled{opacity:.4;cursor:not-allowed}",
	".dshs-toggle{display:inline-flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;user-select:none;white-space:nowrap}",
	".dshs-check{margin:0;accent-color:var(--ds-a)}",
	".dshs-note{font-size:12px;padding:7px 11px;border-radius:8px;background:var(--ds-fill-2);white-space:pre-wrap;word-break:break-all;border-left:3px solid var(--ds-line-2)}",
	".dshs-note.is-err{background:color-mix(in srgb,var(--ds-bad) 9%,transparent);border-left-color:var(--ds-bad);color:color-mix(in srgb,var(--ds-bad) 78%,currentColor)}",
	".dshs-note.is-warn{background:color-mix(in srgb,var(--ds-warn) 10%,transparent);border-left-color:var(--ds-warn)}",
	".dshs-note.is-info{border-left-color:var(--ds-a)}",
	".dshs-empty{padding:22px 16px;border-radius:10px;border:1px dashed var(--ds-line-2);text-align:center;font-size:12px;opacity:.72;display:flex;flex-direction:column;align-items:center;gap:8px}",
	".dshs-fold{border:1px solid var(--ds-line);border-radius:12px;background:var(--ds-fill)}",
	".dshs-fold{padding:0 14px}.dshs-fold[open]{padding-bottom:14px}",
	".dshs-fold>summary{list-style:none;display:flex;align-items:center;gap:9px;margin:0 -14px;padding:10px 14px;cursor:pointer;user-select:none;font-size:12.5px;font-weight:600;border-radius:12px}",
	".dshs-fold[open]>summary{border-bottom:1px solid var(--ds-line);border-radius:12px 12px 0 0}",
	".dshs-fold>summary::-webkit-details-marker{display:none}",
	".dshs-fold>summary:hover{background:var(--ds-fill-2)}",
	".dshs-fold .dshs-chev{transition:transform .12s;opacity:.6}",
	".dshs-fold[open]>summary .dshs-chev{transform:rotate(90deg)}",
	".dshs-pager{display:flex;align-items:center;justify-content:center;gap:8px;padding-top:4px;font-size:12px}",
	".dshs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
	".dshs-sep{width:1px;height:16px;background:var(--ds-line-2);margin:0 4px;flex:0 0 auto}",
	".dshs-link{cursor:pointer;opacity:.6;user-select:none;white-space:nowrap;flex:0 0 auto}.dshs-link:hover{opacity:1;color:var(--ds-a-text)}",
	"@media (prefers-reduced-motion:reduce){.dshs-root *{transition:none!important}}"
].join("");
function ensureStudioStyles() {
	if (typeof document === "undefined" || !document.head) return;
	// 按内容版本区分：升级后旧标签（同 id、旧样式）留在页面里时也换成新的
	const prev = document.getElementById("dsh-studio-css");
	if (prev && prev.textContent === STUDIO_CSS) return;
	const el = prev || document.createElement("style");
	el.id = "dsh-studio-css";
	el.textContent = STUDIO_CSS;
	if (!prev) document.head.appendChild(el);
}
ensureStudioStyles();
/** 标题旁的内联 SVG 标记（无外链图标），放在强调色小方块里。 */
function StudioMark({ kind }) {
	const paths = {
		skill: "M4.5 5.2h7M4.5 8h7M4.5 10.8h4.5",
		mcp: "M5.5 3.5v3M10.5 3.5v3M4 6.5h8v2.2a4 4 0 0 1-8 0zM8 12.7v1.6",
		snapshot: "M3 5.5h2.2l1-1.6h3.6l1 1.6H13v6.8H3zM8 10.8a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z"
	};
	return h(
		"span",
		{ className: "dshs-mark", "aria-hidden": "true" },
		h(
			"svg",
			{ width: 16, height: 16, viewBox: "0 0 16 16" },
			h("path", { d: paths[kind] || paths.skill, fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" })
		)
	);
}
/** 面板标题：图标 + 名字 + 一句说明，右侧可放页签等。 */
function PanelHeader({ kind, title, sub, children }) {
	return h(
		"div",
		{ className: "dshs-head" },
		h(StudioMark, { kind }),
		h(
			"div",
			{ className: "dshs-grow" },
			h("div", { className: "dshs-title" }, title),
			sub ? h("div", { className: "dshs-sub" }, sub) : null
		),
		children
	);
}
/** 统计卡：数字 + 标签。tone = accent / warn。 */
function StatCard({ value, label, tone }) {
	return h("div", { className: tone ? "dshs-stat is-" + tone : "dshs-stat" }, h("b", {}, String(value)), h("span", {}, label));
}
/** 一组互斥选项（分段控件）。options = [[value, label, title?]]；busy 时不响应点击。 */
function Seg({ value, options, onChange, small, busy }) {
	return h(
		"div",
		{ className: "dshs-seg" + (small ? " is-sm" : "") + (busy ? " is-busy" : ""), role: "radiogroup" },
		options.map(([key, label, title]) =>
			h(
				"span",
				{
					key,
					role: "radio",
					tabIndex: 0,
					title,
					"aria-checked": value === key,
					className: value === key ? "is-on" : "",
					onClick: busy ? undefined : () => onChange(key),
					onKeyDown: (event) => {
						if (busy || (event.key !== "Enter" && event.key !== " ")) return;
						event.preventDefault();
						onChange(key);
					}
				},
				label
			)
		)
	);
}
/** 状态 / 错误提示条。 */
function Note({ tone, children }) {
	return h("div", { className: tone ? "dshs-note is-" + tone : "dshs-note", role: tone === "err" ? "alert" : "status" }, children);
}
/** 分组标题行仍在用的几条内联样式（其余元素都改用上面的类名）。 */
const s = {
	badge: { fontSize: "10.5px", padding: "0 7px", borderRadius: "999px", background: "var(--ds-fill-2)", whiteSpace: "nowrap" },
	groupRow: {
		display: "flex",
		alignItems: "center",
		gap: "6px",
		padding: "5px 9px",
		marginTop: "4px",
		borderRadius: "7px",
		background: "var(--ds-fill-2)",
		borderLeft: "3px solid var(--ds-a-line)",
		cursor: "pointer",
		userSelect: "none"
	},
	groupName: { fontWeight: 600, fontSize: "12.5px", opacity: 0.95 },
	groupCount: { fontSize: "10.5px", opacity: 0.55, marginLeft: "2px" }
};

export { api, h, Note, PanelHeader, s, Seg, StatCard, StudioMark };
