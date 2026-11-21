import * as React from "react";
import { api, h, Note, PanelHeader, Seg, StatCard } from "./ui-base.js";

// ── 配置快照面板 ───────────────────────────────────────────────

/** 一行快照。 */
/** 每条通道要填哪些字段。secret=true 的用密码框。 */
const SYNC_FIELDS = {
	git: [
		{ key: "remote", label: "仓库地址", placeholder: "https://github.com/you/dsh-config.git" },
		{ key: "workDir", label: "工作副本", placeholder: "留空 = ~/.dsh/dsh-studio/sync-work" }
	],
	webdav: [
		{ key: "url", label: "地址", placeholder: "https://dav.example.com/dsh" },
		{ key: "username", label: "用户名", placeholder: "" },
		{ key: "password", label: "密码", placeholder: "", secret: true }
	],
	gist: [
		{ key: "token", label: "GitHub token", placeholder: "ghp_…", secret: true },
		{ key: "gistId", label: "Gist id", placeholder: "可不填，第一次推送时会自动创建。" }
	],
	s3: [
		{ key: "endpoint", label: "Endpoint", placeholder: "https://s3.us-east-1.amazonaws.com" },
		{ key: "bucket", label: "Bucket", placeholder: "" },
		{ key: "region", label: "Region", placeholder: "us-east-1" },
		{ key: "accessKey", label: "AccessKey", placeholder: "" },
		{ key: "secretKey", label: "SecretKey", placeholder: "", secret: true }
	]
};
/** 当前通道的字段列表。 */
function SyncFields({ channel, config, busy, onChange }) {
	const fields = SYNC_FIELDS[channel] ?? [];
	return h(
		"div",
		{ className: "dshs-field" },
		...fields.flatMap((f) => [
			h("span", { key: f.key + ":l" }, f.label),
			h("input", {
				key: f.key,
				className: "dshs-input",
				type: f.secret === true ? "password" : "text",
				placeholder: f.placeholder,
				value: String(config[f.key] ?? ""),
				disabled: busy,
				onChange: (event) => onChange(f.key, event.target.value)
			})
		])
	);
}

function SnapshotRow({ item, busy, onPreview, onRestore, onDelete }) {
	const meta = item.fileCount + " 个文件 · " + (item.archiveBytes / 1024).toFixed(0) + " KB";
	return h(
		"div",
		{ className: "dshs-item is-static" },
		h(
			"span",
			{ className: "dshs-mark", style: { width: "30px", height: "30px", background: "var(--ds-fill-2)", color: "inherit", opacity: 0.75 }, "aria-hidden": "true" },
			h(
				"svg",
				{ width: 15, height: 15, viewBox: "0 0 16 16" },
				h("path", { d: "M2.5 4.5h11v8.5h-11zM2.5 4.5 4 2.5h8l1.5 2M6.2 7.5h3.6", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" })
			)
		),
		h(
			"div",
			{ className: "dshs-main" },
			h("div", { className: "dshs-name" }, h("b", { className: "dshs-mono", style: { fontSize: "12px" } }, item.id)),
			h("div", { className: "dshs-meta" }, new Date(item.at).toLocaleString() + " · " + meta)
		),
		h(
			"div",
			{ className: "dshs-actions" },
			h("button", { className: "dshs-btn dshs-btn-sm", disabled: busy, onClick: () => onPreview(item.id) }, "预览"),
			h("button", { className: "dshs-btn dshs-btn-sm", disabled: busy, onClick: () => onRestore(item.id) }, "恢复"),
			h("button", { className: "dshs-btn dshs-btn-sm dshs-btn-ghost dshs-btn-danger", disabled: busy, onClick: () => onDelete(item.id) }, "删除")
		)
	);
}

/** 恢复预览：只列会变的文件。 */
function SnapshotPreview({ preview }) {
	const rows = (preview.plan ?? []).filter((p) => p.action !== "same").slice(0, 60);
	return h(
		"div",
		{ className: "dshs-card", style: { gap: "4px", fontSize: "11.5px", maxHeight: "240px", overflow: "auto", borderColor: "var(--ds-a-line)" } },
		h("b", { style: { fontSize: "12px", marginBottom: "4px" } }, "恢复预览 · " + preview.total + " 个文件，其中 " + rows.length + " 个会变"),
		preview.integrity === "legacy-unverified" ? h(Note, { tone: "info" }, "旧包没有文件校验清单，本次未验证内容完整性。") : null,
		rows.map((p) =>
			h(
				"div",
				{ key: p.rel, style: { display: "flex", gap: "8px", alignItems: "center" } },
				h("span", { className: p.action === "create" ? "dshs-tag is-ok" : "dshs-tag is-warn" }, p.action === "create" ? "新建" : "覆盖"),
				h("span", { className: "dshs-mono", style: { wordBreak: "break-all" } }, p.rel)
			)
		)
	);
}

/** 配置快照：备份 / 恢复 / 导出导入。 */
function SnapshotPanel() {
	const [data, setData] = React.useState(null);
	const [busy, setBusy] = React.useState(false);
	const [msg, setMsg] = React.useState("");
	const [err, setErr] = React.useState("");
	const [label, setLabel] = React.useState("");
	const [transferPath, setTransferPath] = React.useState("");
	const [importSrc, setImportSrc] = React.useState("");
	const [preview, setPreview] = React.useState(null);
	const [schedule, setSchedule] = React.useState(null);
	const [sync, setSync] = React.useState(null);
	React.useEffect(() => {
		api.syncConfig().then((r) => setSync(r.sync)).catch(() => setSync(null));
	}, []);
	React.useEffect(() => {
		api.snapshotSchedule().then((r) => setSchedule(r.schedule)).catch(() => setSchedule(null));
	}, []);
	const refresh = React.useCallback(async () => {
		try {
			const r = await api.snapshotList();
			setData(r);
			setErr("");
		} catch (error) {
			setErr("读取失败：" + String(error instanceof Error ? error.message : error));
		}
	}, []);
	React.useEffect(() => {
		refresh();
	}, [refresh]);
	const run = async (fn) => {
		setBusy(true);
		setMsg("");
		setErr("");
		try {
			await fn();
		} catch (error) {
			setErr(String(error instanceof Error ? error.message : error));
		} finally {
			setBusy(false);
		}
	};
	const doBackup = () => run(async () => {
		const r = await api.snapshotCreate(label.trim() === "" ? "manual" : label.trim());
		setMsg("已建快照 " + r.snapshot.id + "：" + (r.snapshot.fileCount ?? r.snapshot.files?.length ?? 0) + " 个文件");
		setLabel("");
		await refresh();
	});
	const doRestore = (id) => run(async () => {
		const r = await api.snapshotRestore(id, false);
		setPreview(null);
		setMsg("已恢复 " + r.written + " 个文件" + (r.preSnapshot !== null ? "（恢复前快照 " + r.preSnapshot + "）" : "") + (r.integrity === "legacy-unverified" ? "；旧包无文件校验清单，未验证内容完整性。" : ""));
		await refresh();
	});
	const doPreview = (id) => run(async () => {
		const r = await api.snapshotRestore(id, true);
		setPreview(r);
		setMsg("[预览] " + r.total + " 个文件：新建 " + r.create + "、覆盖 " + r.overwrite + "、相同 " + r.same);
	});
	const doDelete = (id) => {
		// 删快照不可逆，先问一句
		if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("要删除备份「" + id + "」吗？删了就找不回来了。")) return;
		return run(async () => {
			await api.snapshotDelete(id);
			setMsg("已删除备份 " + id);
			await refresh();
		});
	};
	const doPrune = () => run(async () => {
		const r = await api.snapshotPrune(10);
		setMsg("保留 " + r.kept + " 份，删掉 " + r.removed.length + " 份");
		await refresh();
	});
	const doTransfer = (action) => run(async () => {
		const path = transferPath.trim();
		if (path === "") throw new Error("请先填写文件路径。");
		const latest = (data === null ? [] : data.snapshots ?? [])[0];
		if (action === "export") {
			if (latest === undefined) throw new Error("还没有可以导出的备份。");
			const r = await api.snapshotTransfer({ action: "export", path, id: latest.id });
			setMsg("已导出到 " + r.path);
			return;
		}
		const r = await api.snapshotTransfer({ action: "import", path });
		setMsg("已导入为快照 " + r.snapshot.id);
		await refresh();
	});
	const doImport = () => run(async () => {
		const source = importSrc.trim();
		if (source === "") throw new Error("请先填写 GitHub 地址或本地 .tar.gz 路径。");
		const r = await api.skillImport(source);
		if (r.ok === false) throw new Error(r.message ?? "导入失败");
		setMsg(r.changed ? "已导入 skill：" + r.name : "同 ref 内容没有变化：" + r.name);
		await refresh();
	});
	const snapshots = data === null ? [] : data.snapshots ?? [];
	const totalBytes = snapshots.reduce((n, x) => n + (x.archiveBytes ?? 0), 0);
	const toolbar = h(
		"div",
		{ className: "dshs-row", style: { fontSize: "12px" } },
		h("input", {
			className: "dshs-input",
			style: { flex: "1 1 200px" },
			placeholder: "标签（可不填）",
			value: label,
			onChange: (event) => setLabel(event.target.value)
		}),
		h("button", { className: "dshs-btn dshs-btn-pri", disabled: busy, onClick: doBackup }, "立即备份"),
		h("button", { className: "dshs-btn", disabled: busy, onClick: doPrune, title: "删掉更早的，只留最近 10 份" }, "保留最近 10 份")
	);
	const transferBar = h(
		"div",
		{ className: "dshs-row", style: { fontSize: "12px" } },
		h("input", {
			className: "dshs-input",
			style: { flex: "1 1 220px" },
			placeholder: "导出或导入的文件路径（.tar.gz）",
			value: transferPath,
			onChange: (event) => setTransferPath(event.target.value)
		}),
		h("button", { className: "dshs-btn", disabled: busy, onClick: () => doTransfer("export") }, "导出最新"),
		h("button", { className: "dshs-btn", disabled: busy, onClick: () => doTransfer("import") }, "导入")
	);
	const importBar = h(
		"div",
		{ className: "dshs-row", style: { fontSize: "12px" } },
		h("input", {
			className: "dshs-input",
			style: { flex: "1 1 220px" },
			placeholder: "GitHub 地址或本地 .tar.gz 文件",
			value: importSrc,
			onChange: (event) => setImportSrc(event.target.value)
		}),
		h("button", { className: "dshs-btn", disabled: busy, onClick: doImport }, "导入 skill")
	);
	const syncCfg = sync === null ? { channel: "git", git: {}, webdav: {}, gist: {}, s3: {} } : sync;
	const syncChannel = syncCfg.channel;
	const syncFields = syncCfg[syncChannel] ?? {};
	const saveSyncConfig = () => run(async () => {
		const r = await api.syncConfig({ channel: syncChannel, [syncChannel]: syncFields });
		setSync(r.sync);
		setMsg("同步配置已保存（通道：" + r.sync.channel + "）");
	});
	const doSyncPush = () => run(async () => {
		const latest = (data === null ? [] : data.snapshots ?? [])[0];
		if (latest === undefined) throw new Error("还没有可以推送的备份。");
		await api.syncConfig({ channel: syncChannel, [syncChannel]: syncFields });
		const r = await api.syncPush(latest.id, syncChannel);
		setMsg(r.pushed === true ? "已推送 " + latest.id + " 到 " + r.channel : "远端已经是最新的");
	});
	const doSyncPull = () => run(async () => {
		await api.syncConfig({ channel: syncChannel, [syncChannel]: syncFields });
		const r = await api.syncPull(syncChannel, "pulled");
		setMsg("已从 " + r.channel + " 拉取为快照 " + r.id + "（" + r.files + " 个文件）");
		await refresh();
	});
	const syncBar = h(
		"div",
		{ className: "dshs-card" },
		h(
			"div",
			{ className: "dshs-card-h" },
			h("span", { className: "dshs-label" }, "远端同步"),
			h(Seg, {
				small: true,
				value: syncChannel,
				options: [["git", "Git"], ["webdav", "WebDAV"], ["gist", "Gist"], ["s3", "S3"]],
				onChange: (name) => setSync((prev) => ({ ...(prev ?? { git: {}, webdav: {}, gist: {}, s3: {} }), channel: name }))
			}),
			h("div", { className: "dshs-grow" }),
			h("button", { className: "dshs-btn dshs-btn-sm", disabled: busy, onClick: saveSyncConfig }, "保存"),
			h("button", { className: "dshs-btn dshs-btn-sm", disabled: busy, onClick: doSyncPush }, "推送最新"),
			h("button", { className: "dshs-btn dshs-btn-sm", disabled: busy, onClick: doSyncPull }, "从远端拉取")
		),
		h(SyncFields, {
			channel: syncChannel,
			config: syncFields,
			busy,
			onChange: (key, value) => setSync((prev) => {
				const base = prev === null ? { channel: "git", git: {}, webdav: {}, gist: {}, s3: {} } : prev;
				return { ...base, [base.channel]: { ...(base[base.channel] ?? {}), [key]: value } };
			})
		})
	);
	const sched = schedule === null ? { enabled: false, intervalHours: 24, keep: 10 } : schedule;
	// 数字框先改本地草稿，失焦 / 回车才提交：逐键提交的话敲 "12" 会先存一次 1，还会在请求期间把输入框禁掉、丢焦点
	const [schedDraft, setSchedDraft] = React.useState({});
	const changeSchedule = async (patch) => {
		setErr("");
		try {
			const r = await api.snapshotSchedule(patch);
			setSchedule(r.schedule);
		} catch (error) {
			setErr("定时备份设置没保存上：" + String(error instanceof Error ? error.message : error));
		} finally {
			setSchedDraft({});
		}
	};
	const scheduleNumber = (key, width, min) => {
		const commit = () => {
			if (!(key in schedDraft)) return;
			const value = Number(schedDraft[key]);
			if (Number.isFinite(value) && value >= min && value !== sched[key]) changeSchedule({ [key]: value });
			else setSchedDraft({});
		};
		return h("input", {
			className: "dshs-input dshs-num",
			style: { width },
			value: key in schedDraft ? schedDraft[key] : String(sched[key]),
			disabled: busy || sched.enabled !== true,
			onChange: (event) => setSchedDraft((prev) => ({ ...prev, [key]: event.target.value })),
			onBlur: commit,
			onKeyDown: (event) => {
				if (event.key === "Enter") event.target.blur();
			}
		});
	};
	const scheduleBar = h(
		"div",
		{ className: "dshs-row", style: { fontSize: "12px" } },
		h("label", { className: "dshs-toggle", style: { marginRight: "6px" } },
			h("input", {
				type: "checkbox",
				className: "dshs-switch",
				checked: sched.enabled === true,
				disabled: busy,
				onChange: (event) => changeSchedule({ enabled: event.target.checked })
			}),
			"定时备份"
		),
		h("span", { style: { opacity: 0.7 } }, "每"),
		scheduleNumber("intervalHours", "52px", 0.1),
		h("span", { style: { opacity: 0.7 } }, "小时，保留"),
		scheduleNumber("keep", "46px", 1),
		h("span", { style: { opacity: 0.7 } }, "份"),
		sched.lastError
			? h("span", { className: "dshs-tag is-bad", title: sched.lastError }, "上次定时备份失败：" + sched.lastError)
			: null
	);
	const listPart = snapshots.length === 0
		? h("div", { className: "dshs-empty" }, data === null ? "正在读取…" : "还没有备份。点「立即备份」建一份即可。")
		: h(
			"div",
			{ className: "dshs-list" },
			snapshots.map((item) => h(SnapshotRow, { key: item.id, item, busy, onPreview: doPreview, onRestore: doRestore, onDelete: doDelete }))
		);
	return h(
		"div",
		{ className: "dshs-root" },
		h(
			PanelHeader,
			{ kind: "snapshot", title: "配置快照", sub: "备份 DSH 配置。密钥和对话记录不会放进去。" },
			h("button", { className: "dshs-btn", disabled: busy, onClick: refresh }, "刷新")
		),
		h(
			"div",
			{ className: "dshs-stats" },
			h(StatCard, { value: snapshots.length, label: "快照", tone: "accent" }),
			h(StatCard, { value: data === null ? "…" : data.collected, label: "会备份的文件" }),
			h(StatCard, { value: (totalBytes / 1024 / 1024).toFixed(1) + " MB", label: "总占用" })
		),
		h("div", { className: "dshs-card" }, h("div", { className: "dshs-card-h" }, h("span", { className: "dshs-label" }, "备份")), toolbar, scheduleBar),
		syncBar,
		h(
			"div",
			{ className: "dshs-card" },
			h("div", { className: "dshs-card-h" }, h("span", { className: "dshs-label" }, "导入 / 导出")),
			transferBar,
			importBar
		),
		err !== "" && h(Note, { tone: "err" }, err),
		msg !== "" && h(Note, { tone: "info" }, msg),
		preview !== null && h(SnapshotPreview, { preview }),
		h(
			"div",
			{ className: "dshs-row", style: { marginTop: "2px" } },
			h("b", { style: { fontSize: "13px" } }, "备份列表"),
			h("span", { className: "dshs-tag" }, String(snapshots.length))
		),
		listPart
	);
}

export { SnapshotPanel };
