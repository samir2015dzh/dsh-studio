import { h, s } from "./ui-base.js";

/** Source label map (fall back to the raw source). */
function sourceLabel(source) {
	const map = {
		"user-agents": "我的技能",
		"user-dsh": "DSH 技能",
		"project-dsh": "本项目 DSH 技能",
		"project-agents": "本项目技能",
		custom: "自定义目录",
		runtime: "运行时提供",
		bundled: "内置"
	};
	return map[source] ?? source;
}
/** Invocation badge. */
function InvBadge({ ok, children }) {
	return h("span", { className: ok ? "dshs-tag is-ok" : "dshs-tag is-bad" }, children);
}
/** Monochrome chevron (inline SVG, no emoji) used by the group fold rows. */
function Chevron({ open }) {
	return h(
		"svg",
		{
			width: 10,
			height: 10,
			viewBox: "0 0 10 10",
			"aria-hidden": "true",
			style: { flex: "0 0 auto", transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms ease" }
		},
		h("path", {
			d: "M3 1.5 L7 5 L3 8.5",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.4,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		})
	);
}
/** One collapsible group header row (group view). */
function GroupHeader({ label, count, open, hint, onToggle }) {
	return h(
		"div",
		{ style: s.groupRow, onClick: onToggle },
		h(Chevron, { key: "c", open }),
		h("span", { style: s.groupName, key: "n" }, label),
		h("span", { style: s.groupCount, key: "k" }, String(count)),
		hint ? h("span", { style: s.badge, key: "h" }, hint) : null
	);
}
/** Master + per-interface switches for one skill. */
function PolicyRow({ skill, disabled, onToggle }) {
	const item = (label, checked, patchKey, hint) =>
		h(
			"label",
			{ className: "dshs-toggle", title: hint, key: patchKey },
			h("input", {
				type: "checkbox",
				className: "dshs-switch",
				checked,
				disabled,
				onChange: (event) => onToggle({ [patchKey]: event.target.checked })
			}),
			label
		);
	return h(
		"div",
		{ className: "dshs-row", style: { gap: "18px" } },
		item("启用", skill.modelInvocable && skill.userInvocable, "enabled", "模型和你都可以用"),
		item("模型可用", skill.modelInvocable, "modelInvocable", "模型能自动选用"),
		item("自己可用", skill.userInvocable, "userInvocable", "你能用斜杠命令调用")
	);
}
/** One skill row in the list view——和 MCP 面板同一套行卡语言。 */
function SkillRow({ skill, selected, onSelect, onToggle, onDelete, showGroup }) {
	const editable = skill.editable === true;
	const active = skill.modelInvocable === true && skill.userInvocable === true;
	const badges = [];
	if (showGroup && typeof skill.group === "string" && skill.group !== "") {
		badges.push(h("span", { className: "dshs-tag is-accent", key: "grp" }, skill.group));
	}
	badges.push(h("span", { className: "dshs-tag", key: "src" }, sourceLabel(skill.source)));
	if (skill.nested) badges.push(h("span", { className: "dshs-tag is-warn", key: "nest" }, "嵌套"));
	if (!editable) badges.push(h("span", { className: "dshs-tag is-line", key: "ro" }, "只读"));
	// 宿主只认 kebab-case 的 frontmatter name，中文名会让它默默加载不了
	if (skill.nameValid === false) {
		badges.push(
			h(
				"span",
				{ className: "dshs-tag is-bad", key: "nv", title: "frontmatter name 是「" + (skill.declaredName || "") + "」，名称要用小写字母、数字和连字符（例如 my-skill）" },
				"名称不规范"
			)
		);
	}
	if (typeof skill.shadowedBy === "string" && skill.shadowedBy !== "") {
		badges.push(
			h("span", { className: "dshs-tag is-warn", key: "sb", title: "同名时实际使用的是 " + skill.shadowedBy }, "被 " + skill.shadowedBy + " 盖住")
		);
	}
	if (Array.isArray(skill.shadows) && skill.shadows.length > 0) {
		badges.push(h("span", { className: "dshs-tag", key: "sw", title: "盖住了 " + skill.shadows.join(", ") }, "盖住 " + skill.shadows.length + " 个"));
	}
	return h(
		"div",
		{
			className: selected ? "dshs-item is-sel" : "dshs-item",
			role: "button",
			tabIndex: 0,
			onClick: onSelect,
			onKeyDown: (event) => {
				if (event.target !== event.currentTarget || event.key !== "Enter") return;
				event.preventDefault();
				onSelect();
			}
		},
		h("span", { className: active ? "dshs-dot is-on" : "dshs-dot", title: active ? "已启用" : "未完全启用" }),
		h(
			"div",
			{ className: "dshs-main" },
			h("div", { className: "dshs-name" }, h("b", {}, skill.name), ...badges),
			h("div", { className: "dshs-desc", title: skill.description || "" }, skill.description || "（暂无说明）")
		),
		h(
			"div",
			{ className: "dshs-actions", onClick: (event) => event.stopPropagation() },
			typeof onDelete === "function" && typeof skill.dir === "string" && skill.dir !== ""
				? h(
						"button",
						{
							className: "dshs-btn dshs-btn-ghost dshs-btn-sm dshs-btn-danger dshs-reveal",
							title: "移到回收站",
							onClick: (event) => {
								event.stopPropagation();
								onDelete(skill);
							}
						},
						"删除"
					)
				: null,
			h(
				"label",
				{ className: "dshs-toggle", style: { opacity: editable ? 1 : 0.5 }, title: editable ? "启用 / 停用" : "只读，不能切换" },
				h("input", {
					type: "checkbox",
					className: "dshs-switch",
					checked: active,
					disabled: !editable,
					onChange: (event) => onToggle({ enabled: event.target.checked })
				}),
				"启用"
			)
		)
	);
}

export { GroupHeader, InvBadge, PolicyRow, SkillRow, sourceLabel };
