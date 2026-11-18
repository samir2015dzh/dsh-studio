import { h } from "./ui-base.js";

/** 回收站视图：按批次列，可整批或单项恢复 / 永久删除。 */
function SkillTrashPanel({ trash, busy, onRestore, onPurge }) {
	if (trash === null) return h("div", { className: "dshs-empty" }, "读取中…");
	if (trash.length === 0) return h("div", { className: "dshs-empty" }, "回收站是空的。删除的技能会先放在这里，可以随时恢复。");
	return h(
		"div",
		{ className: "dshs-list", style: { gap: "12px" } },
		trash.map((batch) =>
			h(
				"div",
				{ key: batch.id, className: "dshs-card", style: { gap: "8px", padding: "10px 12px" } },
				h(
					"div",
					{ className: "dshs-card-h" },
					h("b", { className: "dshs-mono", style: { fontSize: "12px" } }, batch.id),
					h("span", { className: "dshs-tag" }, batch.entries.length + " 项"),
					h("div", { className: "dshs-grow" }),
					h("button", { className: "dshs-btn dshs-btn-sm", disabled: busy, onClick: () => onRestore(batch.id) }, "整批恢复"),
					h("button", { className: "dshs-btn dshs-btn-sm dshs-btn-danger", disabled: busy, onClick: () => onPurge(batch.id) }, "清空")
				),
				batch.entries.map((entry) =>
					h(
						"div",
						{ key: entry.name, className: "dshs-item is-static", style: { padding: "8px 10px" } },
						h(
							"div",
							{ className: "dshs-main" },
							h("div", { className: "dshs-name" }, h("b", {}, entry.name)),
							h("div", { className: "dshs-desc dshs-mono", style: { fontSize: "11px" } }, entry.present === true ? entry.from : "（文件已不在）")
						),
						h(
							"div",
							{ className: "dshs-actions" },
							h("button", { className: "dshs-btn dshs-btn-sm", disabled: busy, onClick: () => onRestore(batch.id, entry.name) }, "恢复"),
							h("button", { className: "dshs-btn dshs-btn-sm dshs-btn-ghost dshs-btn-danger", disabled: busy, onClick: () => onPurge(batch.id, entry.name) }, "删除")
						)
					)
				)
			)
		)
	);
}
/** The settings panel component. */
/** 冲突时展示磁盘正文和本次要写入内容的行差。 */
function ConflictDiff({ rows }) {
	const lines = Array.isArray(rows) ? rows : [];
	if (lines.length === 0) return null;
	return h(
		"pre",
		{
			style: {
				margin: 0,
				maxHeight: "220px",
				overflow: "auto",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: "11px",
				lineHeight: 1.45,
				padding: "8px 10px",
				border: "1px solid var(--ds-line-2)",
				borderRadius: "8px",
				background: "var(--ds-fill)",
				whiteSpace: "pre-wrap",
				wordBreak: "break-all"
			}
		},
		lines.map((row, index) => {
			const kind = row && row.type;
			const color = kind === "del" ? "var(--ds-bad)" : kind === "add" ? "var(--ds-ok)" : "inherit";
			const bg = kind === "del" ? "color-mix(in srgb, var(--ds-bad) 9%, transparent)" : kind === "add" ? "color-mix(in srgb, var(--ds-ok) 10%, transparent)" : "transparent";
			const mark = kind === "del" ? "- " : kind === "add" ? "+ " : "  ";
			return h("div", { key: index, style: { color, background: bg } }, mark + String(row && row.text != null ? row.text : ""));
		})
	);
}

export { ConflictDiff, SkillTrashPanel };
