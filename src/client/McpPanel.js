import * as React from "react";
import { api, h, Note, PanelHeader, Seg, StatCard } from "./ui-base.js";

/**
 * MCP 服务器面板（独立设置页）。
 * 布局参照 MCP-cell：顶部统计条 → 设置行 → 一行一个服务器。
 */
function McpPanel() {
	const [data, setData] = React.useState(null);
	// 忙状态记到具体服务器：一台在重连时，别的服务器的档位仍可点
	const [busyKey, setBusyKey] = React.useState(null);
	const busy = busyKey !== null;
	const [msg, setMsg] = React.useState("");
	const [err, setErr] = React.useState("");
	const [openTools, setOpenTools] = React.useState(null);
	const [serverQuery, setServerQuery] = React.useState("");
	const [tierFilter, setTierFilter] = React.useState("all");
	const [connFilter, setConnFilter] = React.useState("all");
	// 凭据默认掩码：key = "<server>|<kind>|<key>"，展开过才显示原文
	const [revealedCreds, setRevealedCreds] = React.useState({});
	// 明文缓存：点过「显示 / 复制」才有值；服务端列表里永远只有掩码（WO-SEC-1）
	const [revealedValues, setRevealedValues] = React.useState({});
	const [copiedKey, setCopiedKey] = React.useState("");
	const [toolQuery, setToolQuery] = React.useState("");
	const [confirmRemove, setConfirmRemove] = React.useState(null);
	const [idle, setIdle] = React.useState("5");
	const [trunc, setTrunc] = React.useState("150");
	// 上游更新检查结果：只有点过「检查更新」才有值，key = server 名。不自动跑——会联网。
	const [updates, setUpdates] = React.useState({});
	const [checking, setChecking] = React.useState(false);
	const refresh = React.useCallback(async () => {
		try {
			const result = await api.mcpList();
			setData(result);
			setIdle(String(result.idleTimeoutMinutes ?? 5));
			setTrunc(String(result.toolDescriptionMaxLength ?? 150));
			setErr("");
		} catch (error) {
			setErr("读取失败：" + String(error instanceof Error ? error.message : error));
		}
	}, []);
	React.useEffect(() => {
		refresh();
	}, [refresh]);
	// 忙状态记到具体服务器：一台在重连时，别的服务器的档位胶囊仍可点
	const run = async (action, key = "*") => {
		setBusyKey(key);
		setMsg("");
		setErr("");
		try {
			return await action();
		} catch (error) {
			setErr("操作失败：" + String(error instanceof Error ? error.message : error));
			return null;
		} finally {
			setBusyKey(null);
		}
	};
	const setTier = (server, tier) =>
		run(async () => {
			await api.mcpUpsert({ name: server.name, tier });
			setMsg(server.name + " 已设为「" + TIER_LABEL[tier] + "」");
			refresh();
		}, server.name);
	const reload = (server) =>
		run(async () => {
			await api.mcpReload(server.name);
			setMsg(server.name + " 已重连");
			refresh();
		}, server.name);
	const remove = (server) =>
		run(async () => {
			// 删除会连带丢掉 notes / 工具白名单 / 空闲阈值，所以点两下才删
			if (confirmRemove !== server.name) {
				setConfirmRemove(server.name);
				setMsg("再点一次「确认删除」，会同时清掉 " + server.name + " 的备注、可见工具和空闲时间设置");
				setTimeout(() => setConfirmRemove((cur) => (cur === server.name ? null : cur)), 4000);
				return;
			}
			setConfirmRemove(null);
			await api.mcpRemove(server.name);
			setMsg("已删除 " + server.name);
			refresh();
		}, server.name);
	const saveTools = (server, mode, names) =>
		run(async () => {
			const result = await api.mcpTools(server.name, mode, names);
			setMsg(
				server.name +
					" 工具过滤已保存：" +
					result.server.toolCount +
					" / " +
					result.server.rawToolCount +
					" 个对外可见"
			);
			refresh();
		}, server.name);
	const takeover = (server) =>
		run(async () => {
			const result = await api.mcpTakeover(server.name);
			setMsg(
				server.name +
					" 已接管（原生行 " +
					(result.rowId || "?") +
					(result.changed ? " 已禁用" : " 本来就是禁用") +
					"），重启 DSH 后由本插件按需连接"
			);
			refresh();
		}, server.name);
	const saveSettings = () =>
		run(async () => {
			const result = await api.mcpSettings({
				idleTimeoutMinutes: Number(idle),
				toolDescriptionMaxLength: Number(trunc)
			});
			setMsg("空闲 " + result.idleTimeoutMinutes + " 分钟后断开 · 说明最长 " + result.toolDescriptionMaxLength + " 字");
			refresh();
		});
	/** 查上游版本：会联网（npm registry / git ls-remote），只在点按钮时跑；不下载不更新。 */
	const checkUpdates = async () => {
		setChecking(true);
		setMsg("");
		setErr("");
		try {
			const result = await api.mcpUpdateCheck();
			const map = {};
			for (const item of result.servers ?? []) map[item.name] = item;
			setUpdates(map);
			const t = result.totals ?? {};
			setMsg(
				"已查 " + (t.total ?? 0) + " 个 · 有新版 " + (t.behind ?? 0) + " · 最新 " + (t.latest ?? 0) +
					" · 无法判定 " + (t.unknownSource ?? 0) + " · 失败 " + (t.failed ?? 0) + "（只检查，不更新）"
			);
		} catch (error) {
			setErr("检查更新失败：" + String(error instanceof Error ? error.message : error));
		} finally {
			setChecking(false);
		}
	};
	// 上游状态徽标：没查过就不渲染；无法判定的用最弱的灰字，免得每行都在喊
	const updateBadge = (up) => {
		if (up === undefined) return null;
		const palette = {
			behind: ["有新版", "is-warn"],
			latest: ["最新", "is-ok"],
			"unknown-source": ["无上游", "is-line"],
			failed: ["检查失败", "is-bad"]
		};
		const entry = palette[up.status];
		if (entry === undefined) return null;
		const [label, tone] = entry;
		const detail = up.status === "behind" ? " " + (up.localVersion || "?") + " → " + (up.remoteVersion || "?") : "";
		const title = [up.via ? up.via + " " + (up.source || "") : "", up.note || ""].filter((x) => x !== "").join("\n");
		return h("span", { title, className: "dshs-tag " + tone }, label + detail);
	};
	// 三档只讲状态：启用 / 按需启用 / 停用（内部值仍是 eager / on-demand / disabled）
	const TIER_LABEL = { eager: "启用", "on-demand": "按需启用", disabled: "停用" };
	const TIER_HINT = {
		eager: "一连接就把全部工具交给模型，省事，但每轮都会多占一些字数。",
		"on-demand": "只显示名字和一句说明，模型要用时再加载完整参数。",
		disabled: "不连接，也不告诉模型有这些工具。"
	};
	const servers = data === null ? [] : data.servers ?? [];
	const connected = servers.filter((x) => x.status === "connected").length;
	// 只数真正空闲的：停用档不连接、错误档连过但失败，各有各的状态，不能冒充「未连接」
	const idleCount = servers.filter((x) => x.status === "idle").length;
	const errorCount = servers.filter((x) => x.status === "error").length;
	const toolTotal = servers.reduce((sum, x) => sum + (x.toolCount ?? 0), 0);
	const checkedCount = Object.keys(updates).length;
	const behindCount = Object.values(updates).filter((u) => u.status === "behind").length;
	const tierCount = (tier) => servers.filter((x) => x.tier === tier).length;
	const visibleServers = servers.filter((server) => {
		if (tierFilter !== "all" && server.tier !== tierFilter) return false;
		if (connFilter !== "all" && server.status !== connFilter) return false;
		const needle = serverQuery.trim().toLowerCase();
		if (needle === "") return true;
		return (server.name + " " + (server.notes ?? "")).toLowerCase().includes(needle);
	});

	const copyValue = async (key, value) => {
		try {
			await navigator.clipboard.writeText(String(value ?? ""));
			setCopiedKey(key);
			setTimeout(() => setCopiedKey(""), 1200);
		} catch {
			setErr("复制失败：浏览器不允许写入剪贴板。");
		}
	};
	/** 按需取一条凭据明文；取到就缓存，避免每帧都打路由。 */
	const fetchCredential = async (serverName, cred, id) => {
		if (revealedValues[id] !== undefined) return revealedValues[id];
		const result = await api.mcpCredential(serverName, cred.kind, cred.key);
		const value = typeof result?.value === "string" ? result.value : "";
		setRevealedValues((prev) => Object.assign({}, prev, { [id]: value }));
		return value;
	};
	const toggleReveal = async (serverName, cred, id) => {
		try {
			if (revealedCreds[id] === true) {
				setRevealedCreds((prev) => Object.assign({}, prev, { [id]: false }));
				return;
			}
			await fetchCredential(serverName, cred, id);
			setRevealedCreds((prev) => Object.assign({}, prev, { [id]: true }));
		} catch (error) {
			setErr(String(error instanceof Error ? error.message : error));
		}
	};
	const copyCredential = async (serverName, cred, id) => {
		try {
			const value = await fetchCredential(serverName, cred, id);
			await copyValue(id, value);
		} catch (error) {
			setErr(String(error instanceof Error ? error.message : error));
		}
	};
	// 归 studio 管即视为已接管：studio 自建条目没有原生行可禁用，与原生行已禁用等价
	const owned = (server) => server.sourceRowId == null || server.nativeDisabled === true;
	// 漂移：有接管意图，但原生条目又活了。最常见是升级 / pnpm install 把 bundle 的
	// patch 整份换掉——注册表里还写着已接管，实际原生已经把全部工具注册了一遍。
	const drifted = (server) => server.sourceRowId != null && server.desiredNative === "disabled" && server.nativeState === "active";
	const statusLabel = (status) =>
		status === "connected"
			? "已连接"
			: status === "error"
				? "连接错误"
				: status === "disabled"
					? "已停用（不连接）"
					: "空闲（未连接）";
	const statusTone = (status) => (status === "connected" ? "is-ok" : status === "error" ? "is-bad" : "is-line");
	// 状态点 = 归属状态：绿＝由本插件全权加载，灰＝原生行仍常驻（未接管），红＝漂移
	const dotClass = (server) => (drifted(server) ? "dshs-dot is-bad" : owned(server) ? "dshs-dot is-on" : "dshs-dot");
	// 审计 9：内建 MCP 守卫状态徽标（armed / unavailable + 累计拦截数）；unavailable 主动提示
	const builtin = data && data.builtin ? data.builtin : null;
	const guardBadge = (() => {
		if (builtin === null) return null;
		const g = builtin.guard;
		const tone = g === "armed" ? "is-ok" : g === "off" ? "is-line" : "is-bad";
		const label = g === "armed" ? "内建 MCP 守卫：已布防" : g === "off" ? "内建 MCP 守卫：已关闭（lockBuiltinManager=false）" : "内建 MCP 守卫：不可用";
		const rejected = Number(builtin.rejected) || 0;
		const tail = [
			"已拦截 " + rejected + " 次",
			builtin.identity && builtin.identity !== "instance" ? "按" + (builtin.identity === "class" ? "类" : "名字") + "识别 manager" : null,
			builtin.lastRejected ? "最近：" + (builtin.lastRejected.names || []).join("、") : null
		].filter(Boolean).join(" · ");
		return h(
			"div",
			{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
			h(
				"div",
				{ className: "dshs-row", style: { gap: "8px" }, title: "DSH 自带的 Settings → MCP 写路径：新增 / 修改 / 启用被拦，删除 / 停用放行" },
				h("span", { className: "dshs-tag " + tone }, label),
				h("span", { className: "dshs-sub", style: { fontSize: "11.5px" } }, tail)
			),
			g === "unavailable"
				? h(
						Note,
						{ tone: "err" },
						"守卫没挂上：在 DSH 的 Settings → MCP 里新增的 server 不会被拦，会和 dsh-studio 注册表分叉。请只用本页 / mcp_register 增删 MCP，并把此情况告诉维护者。"
					)
				: null
		);
	})();
	const corrupt = data && data.registryCorrupt ? data.registryCorrupt : null;
	const corruptBanner =
		corrupt === null
			? null
			: h(
					Note,
					{ tone: "err" },
					"注册表 mcp.json 损坏保护中（" + (corrupt.at || "?") + "，坏文件留档 " + (corrupt.archivedTo || "无") + "）：所有写入已暂停。先用 skillmgr_rollback（name=mcp-registry）回到损坏前的版本；确认不要旧内容时再点：",
					h(
						"button",
						{
							className: "dshs-btn dshs-btn-sm",
							style: { marginLeft: "8px" },
							disabled: busy,
							onClick: () =>
								run(async () => {
									await api.mcpCorruptAck();
									setMsg("已确认，写入闸解除（坏文件仍留档）");
									refresh();
								})
						},
						"确认并重新开始"
					)
				);
	const chip = (key, label, n, active, onPick) =>
		h(
			"span",
			{
				key,
				role: "button",
				tabIndex: 0,
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
	const credentialList = (server) =>
		h(
			"div",
			{ className: "dshs-mono", style: { display: "flex", flexDirection: "column", gap: "2px", marginTop: "6px", padding: "5px 8px", borderRadius: "7px", background: "var(--ds-fill-2)", fontSize: "11px" } },
			server.credentials.map((cred) => {
				const id = server.name + "|" + cred.kind + "|" + cred.key;
				const shown = revealedCreds[id] === true;
				// 列表里的 value 已经是掩码（WO-SEC-1）：明文只在点开时向 /mcp/credential 要
				const text = shown && revealedValues[id] !== undefined ? revealedValues[id] : cred.value;
				return h(
					"div",
					{ key: id, style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "nowrap" } },
					h("span", { title: cred.kind + " · " + cred.key, style: { opacity: 0.55, minWidth: "96px", whiteSpace: "nowrap", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis" } }, cred.key),
					h("span", { style: { opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto", minWidth: 0 } }, text),
					cred.sensitive === true
						? h("span", { className: "dshs-link", title: shown ? "隐藏" : "显示原文", onClick: () => toggleReveal(server.name, cred, id) }, shown ? "隐藏" : "显示")
						: null,
					h("span", { className: "dshs-link", title: "复制全部内容", onClick: () => copyCredential(server.name, cred, id) }, copiedKey === id ? "已复制" : "复制")
				)
			})
		);
	const toolsPanel = (cur) => {
		const names = new Set((cur.toolFilter && cur.toolFilter.names) || []);
		const mode = (cur.toolFilter && cur.toolFilter.mode) || "all";
		const q = toolQuery.trim().toLowerCase();
		const list = (cur.allTools || []).filter((t) => q === "" || (t.name + " " + t.description).toLowerCase().includes(q));
		return h(
			"div",
			{
				key: cur.name + ":tools",
				className: "dshs-card",
				style: { gap: "9px", marginTop: "-2px", borderColor: "var(--ds-a-line)", background: "color-mix(in srgb, var(--ds-a) 4%, transparent)" }
			},
			h(
				"div",
				{ className: "dshs-card-h" },
				h("b", { style: { fontSize: "12.5px" } }, cur.name + " 的工具"),
				h("span", { className: "dshs-tag" }, "对外 " + cur.toolCount + " / 共 " + (cur.rawToolCount || cur.toolCount)),
				h("div", { className: "dshs-grow" }),
				h(Seg, {
					small: true,
					busy: busyKey === cur.name,
					value: mode,
					options: [
						["all", "全部", "全部工具都对模型可见"],
						["allow", "只留勾选", "只有打勾的工具对模型可见"],
						["deny", "去掉勾选", "打勾的工具对模型隐藏"]
					],
					onChange: (m) => saveTools(cur, m, Array.from(names))
				})
			),
			h("input", {
				type: "search",
				className: "dshs-search",
				placeholder: "搜索工具名或说明",
				value: toolQuery,
				onChange: (e) => setToolQuery(e.target.value)
			}),
			h(
				"div",
				{ style: { maxHeight: "260px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "1px" } },
				list.length === 0 ? h("div", { className: "dshs-sub", style: { padding: "4px" } }, "没有工具。") : null,
				list.map((t) =>
					h(
						"label",
						{ key: t.name, style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", padding: "4px 6px", borderRadius: "6px", cursor: mode === "all" ? "default" : "pointer" } },
						h("input", {
							type: "checkbox",
							className: "dshs-check",
							// 勾选 = 在名单里，两种模式同一口径（「只留勾选」/「去掉勾选」说的都是打了勾的那些）。
							// 此前 deny 模式显示的是 !names.has，而点击仍是「勾上 → 加入名单」，于是每次点击都是空操作。
							checked: mode === "all" ? true : names.has(t.name),
							disabled: busyKey === cur.name || mode === "all",
							onChange: (e) => {
								const next = new Set(names);
								if (e.target.checked) next.add(t.name);
								else next.delete(t.name);
								saveTools(cur, mode === "all" ? "allow" : mode, Array.from(next));
							}
						}),
						h("span", { className: "dshs-mono", style: { fontWeight: 600, flex: "0 0 auto" } }, t.name),
						h("span", { style: { opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.description || "")
					)
				)
			)
		);
	};
	const serverRow = (server) =>
		h(
			"div",
			{ key: server.name, className: "dshs-item is-static", style: { alignItems: "flex-start" } },
			h("span", {
				className: dotClass(server),
				style: { marginTop: "6px" },
				title: drifted(server) ? "接管漂移：原生条目又启用了，现在有两份在跑——点「重新接管」写回并重启" : server.sourceRowId == null ? "由本插件管理" : server.nativeDisabled === true ? "已接管（原来的条目已关闭）" : "未接管（原来的条目仍在运行）"
			}),
			h(
				"div",
				{ className: "dshs-main" },
				h(
					"div",
					{ className: "dshs-name" },
					h("b", {}, server.name),
					h("span", { className: "dshs-tag " + statusTone(server.status) }, statusLabel(server.status)),
					updateBadge(updates[server.name])
				),
				h(
					"div",
					{ className: "dshs-meta" },
					server.toolCount +
						" 个工具 · " +
						server.transport +
						(server.sourceRowId
							? drifted(server)
								? " · 接管漂移（原生条目又启用了）"
								: server.nativeDisabled === true
									? " · 已接管"
									: " · 未接管"
							: " · 由本插件管理")
				),
				server.error ? h("div", { className: "dshs-meta", style: { color: "var(--ds-bad)", opacity: 0.9 } }, server.error) : null,
				server.notes ? h("div", { className: "dshs-meta" }, server.notes) : null,
				Array.isArray(server.credentials) && server.credentials.length > 0 ? credentialList(server) : null
			),
			h(
				"div",
				{ className: "dshs-actions", style: { flexDirection: "column", alignItems: "flex-end", gap: "6px" } },
				h(Seg, {
					small: true,
					busy: busyKey === server.name,
					value: server.tier,
					options: ["eager", "on-demand", "disabled"].map((tier) => [tier, TIER_LABEL[tier], TIER_HINT[tier]]),
					onChange: (tier) => {
						if (server.tier === tier) {
							setMsg(server.name + " 已经是「" + TIER_LABEL[tier] + "」");
							return;
						}
						setTier(server, tier);
					}
				}),
				h(
					"div",
					{ className: "dshs-actions" },
					h(
						"button",
						{
							className: openTools === server.name ? "dshs-btn dshs-btn-sm is-on" : "dshs-btn dshs-btn-sm",
							style: openTools === server.name ? { borderColor: "var(--ds-a-line)", color: "var(--ds-a-text)" } : undefined,
							disabled: busyKey === server.name,
							onClick: () => {
								if (openTools === server.name) {
									setOpenTools(null);
									return;
								}
								setOpenTools(server.name);
								setToolQuery("");
								// 停用档不会预热，缓存是空的——点开时试连一次把工具清单拉下来
								if ((server.rawToolCount || 0) === 0) {
									run(async () => {
										const result = await api.mcpPrefetch(server.name);
										setMsg(server.name + " 拉到 " + result.toolCount + " 个工具（试连后已断开）");
										refresh();
									});
								}
							}
						},
						"工具 " + server.toolCount + "/" + (server.rawToolCount || server.toolCount)
					),
					server.sourceRowId && server.nativeDisabled !== true
						? h("button", { className: "dshs-btn dshs-btn-sm dshs-btn-pri", disabled: busyKey === server.name, onClick: () => takeover(server) }, drifted(server) ? "重新接管" : "接管")
						: null,
					h("button", { className: "dshs-btn dshs-btn-sm", disabled: busyKey === server.name, onClick: () => reload(server) }, "重载"),
					h(
						"button",
						{
							className: confirmRemove === server.name ? "dshs-btn dshs-btn-sm is-danger" : "dshs-btn dshs-btn-sm dshs-btn-ghost dshs-btn-danger",
							disabled: busyKey === server.name,
							onClick: () => remove(server)
						},
						confirmRemove === server.name ? "确认删除" : "删除"
					)
				)
			)
		);
	return h(
		"div",
		{ className: "dshs-root" },
		h(
			PanelHeader,
			{ kind: "mcp", title: "MCP 服务器", sub: "按需加载：先只显示名字和摘要，用到时再加载完整说明。" },
			h(
				"div",
				{ className: "dshs-row" },
				h("button", { className: "dshs-btn", disabled: busy || checking, onClick: checking ? undefined : checkUpdates, title: "会联网查 npm / git 上游，只检查不更新" }, checking ? "检查中…" : "检查更新"),
				h("button", { className: "dshs-btn", disabled: busy, onClick: refresh }, "刷新")
			)
		),
		guardBadge,
		corruptBanner,
		h(
			"div",
			{ className: "dshs-stats" },
			h(StatCard, { value: servers.length, label: "服务器", tone: "accent" }),
			h(StatCard, { value: connected, label: "已连接" }),
			h(StatCard, { value: toolTotal, label: "工具" }),
			checkedCount > 0 ? h(StatCard, { value: behindCount, label: "有新版", tone: behindCount > 0 ? "warn" : undefined }) : null
		),
		h(
			"div",
			{ className: "dshs-card", style: { gap: "9px" } },
			h("input", {
				type: "search",
				className: "dshs-search",
				placeholder: "搜索服务器名或备注",
				value: serverQuery,
				onChange: (event) => setServerQuery(event.target.value)
			}),
			h(
				"div",
				{ className: "dshs-track" },
				h("span", { className: "dshs-label" }, "档位"),
				[
					["all", "全部", servers.length],
					["eager", "启用", tierCount("eager")],
					["on-demand", "按需", tierCount("on-demand")],
					["disabled", "停用", tierCount("disabled")]
				].map(([key, label, n]) => chip(key, label, n, tierFilter === key, () => setTierFilter(key))),
				h("span", { className: "dshs-sep" }),
				h("span", { className: "dshs-label" }, "状态"),
				[
					["connected", "已连接", connected],
					["idle", "未连接", idleCount],
					["error", "错误", errorCount]
				]
					.filter(([key, , n]) => key !== "error" || n > 0)
					.map(([key, label, n]) => chip(key, label, n, connFilter === key, () => setConnFilter(connFilter === key ? "all" : key)))
			),
			h(
				"div",
				{ className: "dshs-row", style: { fontSize: "12px", paddingTop: "9px", borderTop: "1px solid var(--ds-line)" } },
				h("span", { className: "dshs-label" }, "全局"),
				h("span", { style: { opacity: 0.7 } }, "空闲"),
				h("input", { className: "dshs-input dshs-num", style: { width: "50px" }, value: idle, disabled: busy, onChange: (event) => setIdle(event.target.value) }),
				h("span", { style: { opacity: 0.7, marginRight: "10px" } }, "分钟后断开"),
				h("span", { style: { opacity: 0.7 } }, "工具说明最长"),
				h("input", { className: "dshs-input dshs-num", style: { width: "58px" }, value: trunc, disabled: busy, onChange: (event) => setTrunc(event.target.value) }),
				h("span", { style: { opacity: 0.7 } }, "字"),
				h("div", { className: "dshs-grow" }),
				h("button", { className: "dshs-btn dshs-btn-sm dshs-btn-pri", disabled: busy, onClick: saveSettings }, "保存")
			)
		),
		err ? h(Note, { tone: "err" }, err) : null,
		msg ? h(Note, { tone: "info" }, msg) : null,
		servers.length === 0
			? h("div", { className: "dshs-empty" }, data === null ? "正在读取…" : "还没有 MCP 服务器。在对话里用 mcp_register 添加即可。")
			: visibleServers.length === 0
				? h("div", { className: "dshs-empty" }, "没有匹配的服务器。")
				: h(
						"div",
						{ className: "dshs-list" },
						visibleServers.map((server) => [serverRow(server), openTools === server.name ? toolsPanel(server) : null])
					)
	);
}

export { McpPanel };
