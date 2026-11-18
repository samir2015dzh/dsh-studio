import * as React from "react";
import { api, h, Note, PanelHeader, StatCard } from "./ui-base.js";
import { GroupHeader, InvBadge, PolicyRow, SkillRow, sourceLabel } from "./skill-widgets.js";
import { ExtractorPanel } from "./ExtractorPanel.js";
import { ConflictDiff, SkillTrashPanel } from "./skill-dialogs.js";

function SkillManagerPanel() {
	const [skills, setSkills] = React.useState(null);
	const [cwd, setCwd] = React.useState("");
	const [selected, setSelected] = React.useState(null);
	const [draft, setDraft] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [msg, setMsg] = React.useState("");
	const [err, setErr] = React.useState("");
	// Grouping view: filter text, grouped vs flat layout, collapsed groups.
	const [page, setPage] = React.useState(0);
	const [pageInput, setPageInput] = React.useState("1");
	const [view, setView] = React.useState("skills");
	// 来源筛选：全部 / 用户自己装的 / 插件自带（只读）
	const [sourceFilter, setSourceFilter] = React.useState("all");
	// 启用状态筛选：全部 / 已启用 / 已停用（与行里那个勾选框同义）
	const [activeFilter, setActiveFilter] = React.useState("all");
	const [trash, setTrash] = React.useState(null);
	const [query, setQuery] = React.useState("");
	// 分类改成筛选维度后，列表固定平铺，不再有分组标题
	const groupView = false;
	const [groupFilter, setGroupFilter] = React.useState("all");
	const [collapsed, setCollapsed] = React.useState({});
	const [conflict, setConflict] = React.useState(null);
	// B7：提取面板第一次展开才挂（放在既有状态之后，不改动前面各个 hook 的顺序）
	const [extractOpened, setExtractOpened] = React.useState(false);
	const refresh = React.useCallback(async () => {
		try {
			const result = await api.list();
			setSkills(result.skills ?? []);
			setCwd(result.cwd ?? "");
			setErr("");
		} catch (error) {
			setErr("没法读取技能列表：" + String(error instanceof Error ? error.message : error));
			setSkills((prev) => prev ?? []);
		}
	}, []);
	const refreshTrash = React.useCallback(async () => {
		try {
			const result = await api.trashList();
			setTrash(result.batches ?? []);
		} catch (error) {
			setErr("没法读取回收站：" + String(error instanceof Error ? error.message : error));
		}
	}, []);
	React.useEffect(() => {
		refresh();
	}, [refresh]);
	React.useEffect(() => {
		if (view === "trash") refreshTrash();
	}, [view, refreshTrash]);
	/** Run one async action with busy/message bookkeeping. */
	const run = async (action) => {
		setBusy(true);
		setMsg("");
		setErr("");
		try {
			return await action();
		} catch (error) {
			setErr("操作失败：" + String(error instanceof Error ? error.message : error));
			return null;
		} finally {
			setBusy(false);
		}
	};
	const open = (skill) => {
		run(async () => {
			setConflict(null);
			const result = await api.get(skill.name);
			let text = result.skill ? result.skill.content : "";
			const pending = draftToRestore(browserStorage(), skill.name, text, result.skill && result.skill.mtimeMs);
			let restored = false;
			if (pending) {
				if (confirmDiscard(true, pending.stale ? DRAFT_RESTORE_STALE : DRAFT_RESTORE)) {
					text = pending.content;
					restored = true;
				} else clearUnsavedDraft(browserStorage(), skill.name);
			}
			// 恢复的是磁盘被改之前的草稿：保存时带草稿自己的基线，服务端对不上就 409，走冲突比对而不是直接覆盖
			setSelected(restored && pending.stale && result.skill ? Object.assign({}, result.skill, { mtimeMs: restoredExpectedMtime(pending, result.skill.mtimeMs) }) : result.skill);
			setDraft(text);
			setMsg(restored ? (pending.stale ? "已恢复未保存的草稿（磁盘上的文件在那之后改过，保存时会先比对）" : "已恢复未保存的草稿") : "已加载 " + skill.name);
		});
	};
	const back = (opts) => {
		const dirtyNow = isDirty(selected, draft, selected && selected.content);
		if (!(opts && opts.skipConfirm) && !confirmDiscard(dirtyNow, UNSAVED_LEAVE)) return;
		if (selected && selected.name) clearUnsavedDraft(browserStorage(), selected.name);
		setSelected(null);
		setDraft("");
		setConflict(null);
		setMsg("");
	};
	const reload = () => {
		if (!selected) return;
		if (!confirmDiscard(isDirty(selected, draft, selected.content), UNSAVED_RELOAD)) return;
		clearUnsavedDraft(browserStorage(), selected.name);
		run(async () => {
			const result = await api.get(selected.name);
			setSelected(result.skill);
			setDraft(result.skill ? result.skill.content : "");
			setConflict(null);
			setMsg("已从磁盘重新加载");
		});
	};
	const exportOne = () => {
		if (!selected) return;
		run(async () => {
			const result = await api.skillExport(selected.name);
			setMsg("已导出到 " + (result.path ?? ""));
		});
	};
	const save = (overwrite) => {
		if (!selected) return;
		run(async () => {
			try {
				const result = await api.save(selected.name, draft, {
					expectedMtime: selected.mtimeMs,
					overwrite: overwrite === true
				});
				setConflict(null);
				if (result && result.ok) {
					const next = Object.assign({}, selected, { content: draft });
					if (result.mtimeMs) next.mtimeMs = result.mtimeMs;
					setSelected(next);
					clearUnsavedDraft(browserStorage(), selected.name);
				} else if (result && result.mtimeMs) {
					setSelected(Object.assign({}, selected, { mtimeMs: result.mtimeMs }));
				}
				setMsg((result.ok ? (result.message ?? "已保存。") : ("保存失败：" + (result.message ?? ""))));
				refresh();
			} catch (error) {
				if (error && error.code === "SKILL_CHANGED") {
					setConflict({
						message: error.message,
						current: error.body && typeof error.body.current === "string" ? error.body.current : "",
						mtimeMs: error.body && error.body.mtimeMs,
						diff: Array.isArray(error.body && error.body.diff) ? error.body.diff : []
					});
					return;
				}
				throw error;
			}
		});
	};
	const toggle = (patch) => {
		if (!selected) return;
		// 开关改写的是文件里的 frontmatter。草稿有改动时不许切：草稿还带着旧 frontmatter，
		// 切完再保存就把开关原样写回去了（mtime 是新的，不会报冲突，用户看不出来）。
		if (isDirty(selected, draft, selected.content)) {
			setMsg("有未保存的改动：先保存或放弃，再切换启用状态");
			return;
		}
		run(async () => {
			const result = await api.setPolicy(selected.name, Object.assign({ expectedMtime: selected.mtimeMs }, patch));
			if (!result.ok) return;
			// 把磁盘上的新内容拿回来，基线与草稿一起换；只更新 mtime 的话，下一次保存会用旧正文把开关冲掉
			const fresh = await api.get(selected.name).catch(() => null);
			if (fresh && fresh.skill) {
				setSelected(fresh.skill);
				setDraft(fresh.skill.content);
			} else {
				const next = Object.assign({}, selected, {
					modelInvocable: result.modelInvocable,
					userInvocable: result.userInvocable
				});
				if (result.mtimeMs) next.mtimeMs = result.mtimeMs;
				setSelected(next);
			}
			setMsg(result.message ?? "已保存。");
			refresh();
		});
	};
	/** 顶部「技能 / 回收站」页签：正在编辑时先过未保存确认（此前直接 setSelected(null)，改动无提示丢失、草稿也不暂存）。 */
	const switchView = (key) => {
		if (selected) {
			if (!confirmDiscard(isDirty(selected, draft, selected.content), UNSAVED_LEAVE)) return;
			if (selected.name) clearUnsavedDraft(browserStorage(), selected.name);
			setDraft("");
			setConflict(null);
		}
		setView(key);
		setSelected(null);
	};
				/**
	 * Group buckets for the list view. Group membership comes from each
	 * skill's SKILL.md frontmatter `metadata.group`; skills without one
	 * fall into a trailing 未分组 bucket. Flat mode returns one bucket.
	 */
	// 每页条数：419 条一次渲染会把面板拉得很长，分页后滚动条短很多
	const PAGE_SIZE = 6;
	const isBuiltin = (skill) => skill.source === "bundled" || skill.source === "runtime";
	const isEnabled = (skill) => skill.modelInvocable === true && skill.userInvocable === true;
	const counts = React.useMemo(() => {
		const list = skills ?? [];
		const builtin = list.filter(isBuiltin).length;
		const enabled = list.filter(isEnabled).length;
		const byGroup = new Map();
		for (const skill of list) {
			const g = typeof skill.group === "string" && skill.group !== "" ? skill.group : "其他";
			byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
		}
		return { all: list.length, builtin, user: list.length - builtin, enabled, disabled: list.length - enabled, byGroup };
	}, [skills]);
	const filteredSkills = React.useMemo(() => {
		const list = skills ?? [];
		const bySource =
			sourceFilter === "all"
				? list
				: sourceFilter === "builtin"
					? list.filter(isBuiltin)
					: list.filter((skill) => !isBuiltin(skill));
		const byActive =
			activeFilter === "all"
				? bySource
				: activeFilter === "on"
					? bySource.filter(isEnabled)
					: bySource.filter((skill) => !isEnabled(skill));
		const byGroup =
			groupFilter === "all"
				? byActive
				: byActive.filter((skill) =>
						groupFilter === "其他"
							? !(typeof skill.group === "string" && skill.group !== "")
							: skill.group === groupFilter
					);
		const needle = query.trim().toLowerCase();
		if (needle === "") return byGroup;
		return byGroup.filter((skill) =>
			(skill.name + " " + (skill.description || "") + " " + (skill.group || "") + " " + (Array.isArray(skill.tags) ? skill.tags.join(" ") : "") + " " + (skill.whenToUse || "")).toLowerCase().includes(needle)
		);
	}, [skills, query, sourceFilter, activeFilter, groupFilter]);
	const pageCount = Math.max(1, Math.ceil(filteredSkills.length / PAGE_SIZE));
	const currentPage = Math.min(page, pageCount - 1);
	React.useEffect(() => {
		setPageInput(String(currentPage + 1));
	}, [currentPage]);
	const pageSkills = React.useMemo(
		() => filteredSkills.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
		[filteredSkills, currentPage]
	);
	const groups = React.useMemo(() => {
		if (!groupView) return [{ key: "__all__", label: "", items: pageSkills }];
		const buckets = new Map();
		for (const skill of pageSkills) {
			const key = typeof skill.group === "string" && skill.group !== "" ? skill.group : "未分组";
			if (!buckets.has(key)) buckets.set(key, []);
			buckets.get(key).push(skill);
		}
		const named = Array.from(buckets.keys())
			.filter((key) => key !== "未分组")
			.sort((a, b) => a.localeCompare(b));
		const order = buckets.has("未分组") ? named.concat(["未分组"]) : named;
		return order.map((key) => ({ key, label: key, items: buckets.get(key) }));
	}, [pageSkills, groupView]);
	const trashOne = (name) =>
		run(async () => {
			await api.trashSkill(name);
			setMsg(name + " 已移入回收站");
			refresh();
			refreshTrash();
		});
	const restoreOne = (batchId, name) =>
		run(async () => {
			await api.restoreTrash(batchId, name);
			setMsg((name ?? "整批") + " 已恢复");
			refreshTrash();
			refresh();
		});
	const purgeOne = (batchId, name) =>
		run(async () => {
			if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("要彻底删除「" + (name ?? "整批") + "」吗？删了就找不回来了。")) return;
			await api.purgeTrash(batchId, name);
			setMsg((name ?? "整批") + " 已永久删除");
			refreshTrash();
		});
	const editable = Boolean(selected && selected.editable);
	// 与 lib/unsaved.js 保持同一套规则。站内离开用 confirm；关页用 beforeunload。
	// 借鉴 react-admin / payload-puck：https://github.com/marmelab/react-admin/blob/master/packages/ra-core/src/form/useWarnWhenUnsavedChanges.tsx
	const UNSAVED_LEAVE = "还有没保存的修改，确定离开吗？";
	const UNSAVED_RELOAD = "重新加载会丢掉没保存的修改，继续吗？";
	const isDirty = (skill, text, baseline) => Boolean(skill && skill.editable) && String(text ?? "") !== String(baseline ?? "");
	const confirmDiscard = (dirty, message) => {
		if (!dirty) return true;
		if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
		return window.confirm(message) === true;
	};
	// 捕获 Esc 并做草稿兜底，规则见 lib/unsaved-escape.js。
	const DRAFT_RESTORE = "有一份未保存的草稿，要恢复吗？";
	const DRAFT_RESTORE_STALE = "有一份未保存的草稿，但磁盘上的文件在那之后被改过。恢复后保存会先和磁盘上的新版本比对（出现冲突提示），不会直接覆盖。要恢复吗？";
	const draftKey = (n) => "dsh-studio.unsaved-draft." + encodeURIComponent(String(n ?? ""));
	const browserStorage = () => { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } };
	// · A9：草稿记下基线 mtime（打开时磁盘上的版本），恢复时据此判断磁盘是否在那之后被改过
	const writeUnsavedDraft = (s, n, c, base) => {
		if (!s || !n || typeof s.setItem !== "function") return false;
		const data = { name: n, content: String(c ?? ""), savedAt: Date.now() };
		if (Number.isFinite(base)) data.baseMtimeMs = base;
		try { s.setItem(draftKey(n), JSON.stringify(data)); return true; } catch { return false; }
	};
	const readUnsavedDraft = (s, n) => {
		if (!s || !n || typeof s.getItem !== "function") return null;
		try { const d = JSON.parse(s.getItem(draftKey(n)) || "null"); return d && typeof d.content === "string" ? d : null; } catch { return null; }
	};
	const clearUnsavedDraft = (s, n) => { try { if (s && n && s.removeItem) s.removeItem(draftKey(n)); } catch {} };
	const draftToRestore = (s, n, base, mtime) => {
		const d = readUnsavedDraft(s, n);
		if (!d) return null;
		if (String(d.content) === String(base ?? "")) { clearUnsavedDraft(s, n); return null; }
		if (Number.isFinite(mtime)) d.stale = !Number.isFinite(d.baseMtimeMs) || d.baseMtimeMs !== mtime;
		return d;
	};
	const restoredExpectedMtime = (d, mtime) => (!d || d.stale !== true ? mtime : Number.isFinite(d.baseMtimeMs) ? d.baseMtimeMs : 0);
	// 与 lib/panel-list-empty.js 保持同一套规则：筛选后为空要提示，不要留下空白列表。
	const listEmptyKind = (state) => {
		const list = state && state.skills;
		const error = String((state && state.err) || "").trim();
		const q = String((state && state.query) || "").trim();
		const source = (state && state.sourceFilter) || "all";
		const active = (state && state.activeFilter) || "all";
		const group = (state && state.groupFilter) || "all";
		const visible = Number((state && state.visibleCount) || 0);
		const loading = list === null;
		const emptyLib = Array.isArray(list) && list.length === 0;
		const filtered = q !== "" || source !== "all" || active !== "all" || group !== "all";
		if (error !== "" && emptyLib && !filtered) return "load-error";
		if (loading && !filtered) return "loading";
		if (emptyLib && error === "" && !filtered) return "empty";
		if (visible === 0 && filtered) return "filtered";
		return null;
	};
	const listEmptyText = (kind) => {
		if (kind === "loading") return "正在读取技能列表…";
		if (kind === "empty") return "这里还没有技能。";
		if (kind === "filtered") return "没有符合条件的技能。";
		return "";
	};
	// 与 lib/panel-shortcuts.js 的 shortcutAction 保持同一套规则。
	const shortcutAction = (event) => {
		if (!event || event.altKey) return null;
		const key = String(event.key ?? "");
		const meta = event.metaKey === true || event.ctrlKey === true;
		const target = event.target;
		const tag = target && target.tagName;
		const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(target && target.isContentEditable);
		const editing = Boolean(selected);
		const canSave = Boolean(selected && selected.editable && draft.trim() !== "");
		if (meta && (key === "s" || key === "S")) return editing ? (canSave ? "save" : "block-save") : null;
		if (key === "Escape") {
			if (editing) return "back";
			if (query.trim() !== "") return "clear-search";
			return null;
		}
		if (key === "/" && !meta && !editing && !inField) return "focus-search";
		return null;
	};
	React.useEffect(() => {
		const onKey = (event) => {
			const action = shortcutAction(event);
			if (!action) return;
			if (action === "back" || action === "clear-search") {
				if (typeof event.stopPropagation === "function") event.stopPropagation();
			}
			if (typeof event.preventDefault === "function") event.preventDefault();
			if (action === "back") {
				if (isDirty(selected, draft, selected && selected.content) && !confirmDiscard(true, UNSAVED_LEAVE)) return;
				back({ skipConfirm: true });
			} else if (action === "save") save(false);
			else if (action === "clear-search") {
				setQuery("");
				setPage(0);
			} else if (action === "focus-search") {
				const el = typeof document !== "undefined" ? document.querySelector(".dshs-search") : null;
				if (el && typeof el.focus === "function") el.focus();
			}
		};
		if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [selected, draft, query]);
	const dirtyRef = React.useRef({ dirty: false, name: "", content: "" });
	dirtyRef.current = {
		dirty: isDirty(selected, draft, selected && selected.content),
		name: selected && selected.name,
		content: draft,
		baseMtimeMs: selected && selected.mtimeMs
	};
	React.useEffect(() => {
		if (typeof window === "undefined") return;
		const onUnload = (event) => {
			if (!dirtyRef.current.dirty) return;
			if (typeof event.preventDefault === "function") event.preventDefault();
			event.returnValue = "";
		};
		const flushDraft = () => {
			const snap = dirtyRef.current;
			if (snap && snap.dirty && snap.name) writeUnsavedDraft(browserStorage(), snap.name, snap.content, snap.baseMtimeMs);
		};
		const onHidden = () => {
			if (typeof document !== "undefined" && document.visibilityState === "hidden") flushDraft();
		};
		window.addEventListener("beforeunload", onUnload);
		window.addEventListener("pagehide", flushDraft);
		if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", onHidden);
		return () => {
			flushDraft();
			window.removeEventListener("beforeunload", onUnload);
			window.removeEventListener("pagehide", flushDraft);
			if (typeof document !== "undefined" && document.removeEventListener) document.removeEventListener("visibilitychange", onHidden);
		};
	}, []);
	const count = skills === null ? "…" : skills.length;
	const invocable = (skills ?? []).filter((x) => x.modelInvocable === true).length;
	const gcount = new Set(
		(skills ?? []).map((x) => x.group).filter((g) => typeof g === "string" && g !== "")
	).size;
	const visibleCount = groups.reduce((n, group) => n + group.items.length, 0);
	const emptyKind = listEmptyKind({
		skills,
		err,
		query,
		sourceFilter,
		activeFilter,
		groupFilter,
		visibleCount
	});
	const clearFilters = () => {
		setQuery("");
		setSourceFilter("all");
		setActiveFilter("all");
		setGroupFilter("all");
		setPage(0);
	};
	const chip = (key, label, n, active, onPick, title) =>
		h(
			"span",
			{
				key,
				role: "button",
				tabIndex: 0,
				title,
				className: "dshs-chip" + (active ? " is-on" : n === 0 ? " is-empty" : ""),
				onClick: onPick,
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onPick();
					}
				}
			},
			label,
			h("i", {}, String(n))
		);
	const trashCount = trash === null ? null : trash.reduce((n, b) => n + b.entries.length, 0);
	return h(
		"div",
		{ className: "dshs-root" },
		h(
			PanelHeader,
			{ kind: "skill", title: "Skill 工作台", sub: h("span", { className: "dshs-path", title: cwd, style: { display: "block", opacity: 0.85 } }, cwd ? cwd + " · 共 " + count + " 个" : "共 " + count + " 个") },
			h(
				"div",
				{ className: "dshs-tabs", role: "tablist" },
				["skills", "trash"].map((key) =>
					h(
						"span",
						{
							key,
							role: "tab",
							tabIndex: 0,
							"aria-selected": view === key,
							className: view === key ? "dshs-chip is-on" : "dshs-chip",
							onClick: () => switchView(key),
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									switchView(key);
								}
							}
						},
						key === "skills" ? "技能" : "回收站" + (trashCount ? " " + trashCount : "")
					)
				)
			)
		),
		h(
			"div",
			{ className: "dshs-stats" },
			h(StatCard, { value: count, label: "技能", tone: "accent" }),
			h(StatCard, { value: invocable, label: "模型可用" }),
			h(StatCard, { value: skills === null ? "…" : counts.disabled, label: "已停用", tone: counts.disabled > 0 ? "warn" : undefined }),
			h(StatCard, { value: gcount, label: "分组" })
		),
		h(
			"details",
			{
				key: "extract",
				className: "dshs-fold",
				// B7：折叠着就不挂提取面板——以前一打开技能页它就发三个请求（状态 / 候选 / 最近记录），
				// 而这一块默认是收起的。第一次展开才挂，之后收起也保留（不丢面板里的状态）。
				onToggle: (event) => {
					if (event.currentTarget.open) setExtractOpened(true);
				}
			},
			h(
				"summary",
				{ className: "dshs-sum" },
				h(
					"svg",
					{ className: "dshs-chev", width: 10, height: 10, viewBox: "0 0 10 10", "aria-hidden": "true" },
					h("path", { d: "M3 1.5 L7 5 L3 8.5", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
				),
				"从对话里提取技能",
				h("span", { className: "dshs-sub", style: { fontWeight: 400 } }, "自动判断、合并与保存设置")
			),
			extractOpened ? h("div", { style: { marginTop: "10px" } }, h(ExtractorPanel, {})) : null
		),
		view === "trash" || selected !== null
			? null
			: h(
					"div",
					{ className: "dshs-card", style: { gap: "9px" } },
					h(
						"div",
						{ className: "dshs-row", style: { flexWrap: "nowrap" } },
						h("input", {
							key: "q",
							type: "search",
							className: "dshs-search",
							style: { flex: "1 1 auto" },
							placeholder: "搜索名称、说明或标签（/）",
							value: query,
							onChange: (event) => {
								setQuery(event.target.value);
								setPage(0);
							}
						}),
						h("button", { key: "r", className: "dshs-btn", onClick: refresh, disabled: busy }, "刷新")
					),
					h(
						"div",
						{ className: "dshs-track" },
						h("span", { className: "dshs-label" }, "来源"),
						[
							["all", "全部", counts.all, "全部技能"],
							["user", "用户", counts.user, "我安装的"],
							["builtin", "内置", counts.builtin, "插件自带，只能看"]
						].map(([key, label, n, title]) =>
							chip(key, label, n, sourceFilter === key, () => {
								setSourceFilter(key);
								setPage(0);
							}, title)
						),
						h("span", { className: "dshs-sep" }),
						h("span", { className: "dshs-label" }, "状态"),
						[
							["on", "已启用", counts.enabled, "模型和你都可以用（再点一次取消）"],
							["off", "已停用", counts.disabled, "目前不能完整使用（再点一次取消）"]
						].map(([key, label, n, title]) =>
							// 再点一次已选中的那个就回到全部
							chip(key, label, n, activeFilter === key, () => {
								setActiveFilter(activeFilter === key ? "all" : key);
								setPage(0);
							}, title)
						)
					),
					h(
						"div",
						{ className: "dshs-track" },
						h("span", { className: "dshs-label" }, "分类"),
						[
							["逆向分析", "逆向"],
							["安全测试", "安全"],
							["代码工程", "代码"],
							["文档写作", "文档"],
							["环境运维", "运维"],
							["数据检索", "数据"],
							["流程协作", "流程"],
							["其他", "其他"]
						].map(([key, label]) =>
							chip(key, label, counts.byGroup.get(key) ?? 0, groupFilter === key, () => {
								setGroupFilter(groupFilter === key ? "all" : key);
								setPage(0);
							}, key)
						)
					)
				),
		selected === null && view === "trash"
			? h(SkillTrashPanel, { trash, busy, onRestore: restoreOne, onPurge: purgeOne })
			: selected === null
			? h(
					"div",
					{ className: "dshs-list" },
					emptyKind === "load-error"
						? h(Note, { tone: "err", key: "load-err" }, err + " 点上面的「刷新」再试一次。")
						: emptyKind === "filtered"
						? h(
								"div",
								{ className: "dshs-empty", key: "none" },
								"没有符合条件的技能。",
								h("button", { type: "button", className: "dshs-btn", onClick: clearFilters }, "清除筛选")
							)
						: emptyKind === "loading" || emptyKind === "empty"
						? h("div", { className: "dshs-empty", key: "empty" }, listEmptyText(emptyKind))
						: null,
					groups.map((group) =>
						h(
							"div",
							{ key: group.key, className: "dshs-list" },
							// 「未分组」不配标题：它只是 metadata.group 的缺失态，列在最后就行
							groupView && group.key !== "未分组"
								? h(GroupHeader, {
										key: "header",
										label: group.label,
										count: group.items.length,
										open: collapsed[group.key] !== true,
										hint: group.key === "未分组" ? "未分类" : null,
										onToggle: () =>
											setCollapsed((prev) =>
												Object.assign({}, prev, { [group.key]: prev[group.key] !== true })
											)
									})
								: null,
							!groupView || collapsed[group.key] !== true
								? group.items.map((skill) =>
										h(SkillRow, {
											key: skill.name,
											skill,
											showGroup: !groupView,
											selected: false,
											onDelete: (row) => trashOne(row.name),
											onSelect: () => open(skill),
											onToggle: (patch) => {
												// List-level toggle without opening detail.
												run(async () => {
													const result = await api.setPolicy(skill.name, patch);
													if (!result.ok) return;
													setMsg(result.message ?? "已保存。");
													refresh();
												});
											}
										})
									)
								: null
						)
					),
					filteredSkills.length > PAGE_SIZE
						? h(
								"div",
								{ className: "dshs-pager" },
								h("button", { className: "dshs-btn dshs-btn-sm", disabled: currentPage === 0, onClick: () => setPage(currentPage - 1) }, "‹ 上一页"),
								h("input", {
									type: "text",
									title: "输入页码后按回车",
									className: "dshs-input dshs-num",
									style: { width: "44px", height: "24px" },
									value: pageInput,
									onChange: (event) => setPageInput(event.target.value.replace(/[^0-9]/g, "")),
									onKeyDown: (event) => {
										if (event.key !== "Enter") return;
										const n = Number(pageInput);
										if (Number.isFinite(n) && n >= 1) setPage(Math.min(n - 1, pageCount - 1));
									},
									onBlur: () => setPageInput(String(currentPage + 1))
								}),
								h("span", { style: { opacity: 0.6 } }, "/ " + pageCount + " · 共 " + filteredSkills.length + " 个"),
								h("button", { className: "dshs-btn dshs-btn-sm", disabled: currentPage >= pageCount - 1, onClick: () => setPage(currentPage + 1) }, "下一页 ›")
							)
						: null
				)
			: h(
					"div",
					{ className: "dshs-card", style: { gap: "12px" } },
					h(
						"div",
						{ className: "dshs-row" },
						h(
							"button",
							{ className: "dshs-btn dshs-btn-sm", onClick: back, disabled: busy, title: "Esc" },
							"← 返回列表"
						),
						h("b", { style: { fontSize: "14px", wordBreak: "break-all" } }, selected.name),
						h(InvBadge, { ok: editable, key: "e" }, editable ? "可编辑" : "只读"),
						h("span", { className: "dshs-tag" }, sourceLabel(selected.source) + " · " + selected.provider)
					),
					h(
						"div",
						{ className: "dshs-path", style: { whiteSpace: "normal", wordBreak: "break-all" } },
						selected.path || "（没有文件，只能看）"
					),
					selected.nested
						? h(Note, { tone: "warn" }, "这是套在「" + (selected.parent ?? "子目录") + "」里的技能。默认不会自动加载，需要的话请把它移到技能目录的顶层。")
						: null,
					h(PolicyRow, { skill: selected, disabled: !editable || busy, onToggle: toggle }),
					editable
						? h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: "8px" } },
								h(
									"div",
									{ className: "dshs-sub" },
									"直接改文件内容，保存后立刻生效。frontmatter 里的 name 要和技能名一致。"
								),
								h("textarea", {
									className: "dshs-code",
									value: draft,
									spellCheck: false,
									onChange: (event) => setDraft(event.target.value)
								}),
								conflict
									? h(
											"div",
											{ style: { display: "flex", flexDirection: "column", gap: "8px" } },
											h(Note, { tone: "err" }, conflict.message),
											h(ConflictDiff, { rows: conflict.diff }),
											h(
												"div",
												{ className: "dshs-row" },
												h(
													"button",
													{ className: "dshs-btn", onClick: reload, disabled: busy },
													"重新加载"
												),
												h(
													"button",
													{ className: "dshs-btn dshs-btn-pri", onClick: () => save(true), disabled: busy || draft.trim() === "" },
													"覆盖保存"
												)
											)
										)
									: null,
								h(
									"div",
									{ className: "dshs-row" },
									h(
										"button",
										{ className: "dshs-btn dshs-btn-pri", onClick: () => save(false), disabled: busy || draft.trim() === "", title: "Ctrl/Cmd+S" },
										"保存"
									),
									h(
										"button",
										{ className: "dshs-btn", onClick: reload, disabled: busy },
										"重新加载"
									),
									h(
										"button",
										{ className: "dshs-btn", title: "打包到 ~/.dsh/dsh-studio/exports/", onClick: () => exportOne(), disabled: busy },
										"导出"
									),
									isDirty(selected, draft, selected.content) ? h("span", { className: "dshs-tag is-warn" }, "未保存") : null
								)
							)
						: h(Note, { tone: "warn" }, "这是内置技能，只能查看，不能改。")
				),
		err !== "" && emptyKind !== "load-error" && h(Note, { tone: "err", key: "e" }, err),
		msg !== "" && h(Note, { tone: "info", key: "m" }, msg)
	);
}

export { SkillManagerPanel };
