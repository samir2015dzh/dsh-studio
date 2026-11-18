import * as React from "react";
import { api, h, Note } from "./ui-base.js";

/**
 * 模型下拉的取值 = provider + MODEL_SEP + model。分隔符必须到处是同一个：此前保存 / 回填用的是字面 NUL 字符，
 * 下拉选项与「在不在列表里」的判断用的是空格，结果选了模型保存出去是 provider="prov model"、model=""，
 * 服务端当成没配、回落到会话模型，下拉也弹回「自动」。写成转义而不是字面控制字符，源码里看得见。
 */
const MODEL_SEP = "\u0000";

/** Skill extraction candidates panel (merged from dsh-skill-extractor). */
function ExtractorPanel() {
	const [view, setView] = React.useState(null);
	const [enabled, setEnabled] = React.useState(true);
	const [intervalMinutes, setIntervalMinutes] = React.useState("1440");
	const [windowDays, setWindowDays] = React.useState("7");
	const [maxCandidatesPerRun, setMaxCandidatesPerRun] = React.useState("3");
	const [skillLanguage, setSkillLanguage] = React.useState("zh");
	const [llmBaseUrl, setLlmBaseUrl] = React.useState("");
	const [llmApiKey, setLlmApiKey] = React.useState("");
	const [modelChoice, setModelChoice] = React.useState("");
	const [mirrorDir, setMirrorDir] = React.useState("");
	const [agentSkillDir, setAgentSkillDir] = React.useState("");
	const [candidates, setCandidates] = React.useState([]);
	const [recent, setRecent] = React.useState([]);
	const [editingId, setEditingId] = React.useState(null);
	const [draft, setDraft] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [msg, setMsg] = React.useState("");
	const [err, setErr] = React.useState("");
	/** Assemble the full SKILL.md text for a candidate (frontmatter + body). */
	const assemble = (c) => {
		const front = "---\nname: " + c.name + "\ndescription: " + (c.description || "") + (c.group ? "\nmetadata:\n  group: " + c.group : "") + "\n---\n";
		const body = (c.body || "").startsWith("#") ? c.body : "# " + c.name + "\n\n" + (c.body || "");
		return front + "\n" + body + "\n";
	};
	const load = React.useCallback(async () => {
		try {
			const v = await api.extractStatus();
			setView(v);
			setEnabled(v.enabled !== false);
			setIntervalMinutes(String(v.intervalMinutes ?? "1440"));
			setWindowDays(String(v.windowDays ?? "7"));
			setMaxCandidatesPerRun(String(v.maxCandidatesPerRun ?? "3"));
			setSkillLanguage(v.skillLanguage || "zh");
			setLlmBaseUrl(v.llmBaseUrl || "");
			setModelChoice(v.provider && v.model ? v.provider + MODEL_SEP + v.model : "");
			setMirrorDir(v.mirrorDir || "");
			setAgentSkillDir(v.agentSkillDir || "");
			const c = await api.extractCandidates();
			setCandidates((c && c.candidates) || []);
			const rec = await api.extractRecent().catch(() => null);
			setRecent((rec && rec.skills) || []);
			setErr("");
		} catch (error) {
			setErr("没法读取提取状态：" + String(error instanceof Error ? error.message : error));
		}
	}, []);
	React.useEffect(() => {
		load();
	}, [load]);
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
	const saveConfig = () =>
		run(async () => {
			const patch = {
				enabled,
				intervalMinutes: Number(intervalMinutes) || 0,
				windowDays: Number(windowDays) || 7,
				maxCandidatesPerRun: Number(maxCandidatesPerRun) || 3,
				skillLanguage,
				llmBaseUrl: llmBaseUrl.trim(),
				provider: (modelChoice ? modelChoice.split(MODEL_SEP)[0] : "").trim(),
				model: (modelChoice ? modelChoice.split(MODEL_SEP)[1] || "" : "").trim(),
				mirrorDir: mirrorDir.trim()
			};
			if (llmApiKey.trim() !== "") patch.llmApiKey = llmApiKey.trim();
			await api.extractConfig(patch);
			setLlmApiKey("");
			setMsg("配置已保存。");
			await load();
		});
	const runExtract = () =>
		run(async () => {
			const r = await api.extractRun();
			if (r.ok) setMsg(r.message ?? "提取完成。");
			else setErr(r.message && String(r.message).startsWith("正在提取") ? r.message : "提取失败：" + (r.message ?? "请稍后再试。"));
			await load();
		});
	const openEdit = (c) => {
		setEditingId(c.id);
		setDraft(assemble(c));
		setMsg("编辑候选 " + c.name);
	};
	const saveDraft = () =>
		run(async () => {
			const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(draft);
			let name = "";
			let description = "";
			if (m) {
				const n = /^name\s*:\s*(.+)$/m.exec(m[1]);
				const d = /^description\s*:\s*(.+)$/m.exec(m[1]);
				if (n) name = n[1].trim();
				if (d) description = d[1].trim();
			}
			const body = m ? draft.slice(m[0].length).trim() : draft.trim();
			if (!name) {
				setErr("草稿里没有名称，没法保存。");
				return null;
			}
			const r = await api.extractCandidate(editingId, {
				name: name.replace(/\s+/g, "-").toLowerCase(),
				description,
				body
			});
			setMsg(r.ok ? "草稿已保存。" : "草稿没有保存成功。");
			setEditingId(null);
			await load();
		});
	const acceptCand = (c) =>
		run(async () => {
			const r = await api.extractAccept([c.id]);
			setMsg("已接受: " + ((r && r.written && r.written.length) ? r.written.join(", ") : "（无写入）"));
			await load();
		});
	const rejectCand = (c) =>
		run(async () => {
			await api.extractReject([c.id]);
			setMsg("已忽略这条候选。");
			await load();
		});
	const status = view
		? [
				[view.enabled ? "已启用" : "已禁用", view.enabled ? "is-ok" : "is-line"],
				[view.intervalMinutes === 0 ? "已关闭定时" : "每 " + view.intervalMinutes + " 分钟", ""],
				["窗口 " + view.windowDays + " 天", ""],
				["LLM " + (view.dshModel ? "走 DSH 模型" : view.configured ? "已配置" : "未配置") + (view.resolvedModel ? "（实际用 " + view.resolvedModel + "）" : ""), ""],
				["待确认 " + (view.queued ?? 0) + " 个", (view.queued ?? 0) > 0 ? "is-warn" : ""],
				["上次 " + (view.lastRunAt ? new Date(view.lastRunAt).toLocaleString() : "未运行"), ""],
				["默认存 agent 根" + (view.mirrorDir ? " · 额外镜像 " + view.mirrorDir : "（不存镜像）"), ""]
			]
		: null;
	// 四组：开关 / 调度 / 输出位置 / 模型。每组一张小卡，一行一个字段。
	const group = (title, children) =>
		h(
			"div",
			{ className: "dshs-card", style: { gap: "8px", padding: "11px 13px" } },
			h("span", { className: "dshs-label" }, title),
			...children.filter(Boolean)
		);
	const field = (label, control, hint) =>
		h(
			"div",
			{ className: "dshs-row", style: { gap: "8px" } },
			h("span", { style: { fontSize: "12px", opacity: 0.7, minWidth: "60px" } }, label),
			control,
			hint ? h("span", { style: { fontSize: "11px", opacity: 0.5 } }, hint) : null
		);
	// 与 .dshs-item.is-static 同一套外观（用的设计变量也是同一组）
	const rowCard = {
		display: "flex",
		alignItems: "center",
		gap: "12px",
		padding: "10px 12px",
		borderRadius: "10px",
		border: "1px solid var(--ds-line)",
		background: "var(--ds-fill)",
		minWidth: 0
	};
	const sectionTitle = (text, n) =>
		h(
			"div",
			{ className: "dshs-row", style: { marginTop: "6px" } },
			h("b", { style: { fontSize: "12.5px" } }, text),
			h("span", { className: "dshs-tag" }, String(n))
		);
	return h(
		"div",
		{ style: { display: "flex", flexDirection: "column", gap: "10px" } },
		h(
			"div",
			{ className: "dshs-row", style: { gap: "5px" } },
			status === null
				? h("span", { className: "dshs-sub" }, "加载中…")
				: status.map(([text, tone]) => h("span", { key: text, className: "dshs-tag " + tone }, text))
		),
		h(
			"div",
			{ style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "8px" } },
			group("开关", [
				h(
					"label",
					{ className: "dshs-toggle", style: { fontSize: "12.5px" } },
					h("input", {
						type: "checkbox",
						className: "dshs-switch",
						checked: enabled,
						onChange: (e) => setEnabled(e.target.checked)
					}),
					"自动提取"
				),
				h("div", { style: { fontSize: "11px", opacity: 0.55 } }, "每轮对话结束后先判断值不值得存，值得才提取。")
			]),
			group("模型", [
				h(
					"select",
					{ className: "dshs-input", style: { width: "100%" }, value: modelChoice, onChange: (e) => setModelChoice(e.target.value) },
					[
						h("option", { value: "", key: "auto" }, "自动（跟随当前会话）"),
						...((view && view.availableModels) || []).map((m) =>
							h("option", { value: m.provider + MODEL_SEP + m.model, key: m.label }, m.label)
						),
						modelChoice && !((view && view.availableModels) || []).some((m) => m.provider + MODEL_SEP + m.model === modelChoice)
							? h("option", { value: modelChoice, key: "custom" }, "自定义 " + modelChoice.split(MODEL_SEP).join(" / "))
							: null
					].filter(Boolean)
				),
				h(
					"div",
					{ style: { fontSize: "11px", opacity: 0.55 } },
					"留空则跟当前对话用同一个模型。提取在后台进行，不会换掉你正在用的模型。"
				)
			]),
			group("调度", [
				field(
					"兜底间隔",
					h("input", {
						className: "dshs-input dshs-num",
						style: { width: "72px" },
						placeholder: "1440",
						value: intervalMinutes,
						onChange: (e) => setIntervalMinutes(e.target.value)
					}),
					"分钟（0 = 只在每轮结束时判断）"
				),
				field(
					"扫描窗口",
					h("input", {
						className: "dshs-input dshs-num",
						value: windowDays,
						onChange: (e) => setWindowDays(e.target.value)
					}),
					"天"
				),
				field(
					"每次候选",
					h("input", {
						className: "dshs-input dshs-num",
						value: maxCandidatesPerRun,
						onChange: (e) => setMaxCandidatesPerRun(e.target.value)
					}),
					"条"
				),
				field(
					"正文语言",
					h(
						"select",
						{ className: "dshs-input", style: { width: "110px" }, value: skillLanguage, onChange: (e) => setSkillLanguage(e.target.value) },
						[
							h("option", { value: "auto", key: "auto" }, "跟随会话"),
							h("option", { value: "zh", key: "zh" }, "中文"),
							h("option", { value: "en", key: "en" }, "英文")
						]
					)
				)
			]),
			group("输出位置", [
				field("保存到", h("span", { className: "dshs-mono", style: { fontSize: "11.5px", opacity: 0.8, wordBreak: "break-all" } }, agentSkillDir || "~/.agents/skills")),
				field(
					"额外镜像",
					h("input", {
						className: "dshs-input",
						style: { flex: "1 1 160px" },
						placeholder: "可不填，留空只写上面的目录",
						value: mirrorDir,
						onChange: (e) => setMirrorDir(e.target.value)
					})
				)
			])
		),
		h(
			"div",
			{ className: "dshs-row" },
			h("button", { className: "dshs-btn dshs-btn-pri", onClick: () => void saveConfig(), disabled: busy }, "保存配置"),
			h("button", { className: "dshs-btn", onClick: () => void runExtract(), disabled: busy }, "立即提取"),
			h("button", { className: "dshs-btn dshs-btn-ghost", onClick: () => void load(), disabled: busy }, "刷新")
		),
		err !== "" && h(Note, { tone: "err" }, err),
		msg !== "" && h(Note, { tone: "info" }, msg),
		h(
			"div",
			{ className: "dshs-list" },
			sectionTitle("最近添加", recent.length),
			recent.length === 0
				? h("div", { className: "dshs-empty", style: { padding: "12px" } }, "还没有记录。自动保存或手动保存的技能会显示在这里。")
				: null,
			// C7：下面子节点数目固定的地方一律按展开参数传（...[ ]），不传数组——数组子节点 React 要求每项带 key，
			// 以前渲染时报缺 key 的警告（scripts/e2e-panels.mjs 跑的时候能看到）
			recent.map((r) =>
				h("div", { key: r.path, style: rowCard }, ...[
					h(
						"div",
						{ className: "dshs-main" },
						h("div", { className: "dshs-name" }, h("b", {}, r.name), r.mtime ? h("span", { className: "dshs-tag" }, new Date(r.mtime).toLocaleString()) : null),
						h("div", { className: "dshs-desc" }, r.description || "")
					)
				])
			)
		),
		h(
			"div",
			{ className: "dshs-list" },
			sectionTitle("待确认候选", candidates.length),
			candidates.length === 0
				? h(
						"div",
						{ className: "dshs-empty", style: { padding: "12px" } },
						"还没有待确认项。提取成功后一般会直接写入技能库；只有没写成时才会出现在这里。"
					)
				: null,
			candidates.map((c) =>
				editingId === c.id
					? h("div", { key: c.id, className: "dshs-card", style: { gap: "8px" } }, ...[
							h("div", { className: "dshs-name" }, h("b", {}, c.name), c.group ? h("span", { className: "dshs-tag is-accent" }, c.group) : null),
							h("textarea", { className: "dshs-code", value: draft, spellCheck: false, onChange: (e) => setDraft(e.target.value) }),
							h("div", { className: "dshs-row" }, ...[
								h("button", { className: "dshs-btn dshs-btn-pri", onClick: () => void saveDraft(), disabled: busy }, "保存草稿"),
								h("button", { className: "dshs-btn", onClick: () => setEditingId(null), disabled: busy }, "取消")
							])
						])
					: h(
							"div",
							{ key: c.id, className: "dshs-item is-static", style: { alignItems: "flex-start" } },
							h(
								"div",
								{ className: "dshs-main" },
								h("div", { className: "dshs-name" }, h("b", {}, c.name), c.group ? h("span", { className: "dshs-tag is-accent" }, c.group) : null),
								h("div", { className: "dshs-desc", style: { whiteSpace: "normal" } }, c.description || ""),
								c.rationale ? h("div", { className: "dshs-meta" }, "可复用：" + c.rationale) : null
							),
							h(
								"div",
								{ className: "dshs-actions" },
								h("button", { className: "dshs-btn dshs-btn-sm", onClick: () => openEdit(c), disabled: busy }, "编辑"),
								h("button", { className: "dshs-btn dshs-btn-sm dshs-btn-pri", onClick: () => void acceptCand(c), disabled: busy }, "接受"),
								h("button", { className: "dshs-btn dshs-btn-sm dshs-btn-ghost dshs-btn-danger", onClick: () => void rejectCand(c), disabled: busy }, "拒绝")
							)
						)
			)
		)
	);
}

export { ExtractorPanel };
