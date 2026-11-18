window.__ModuleLoader__.load({
	id: "dsh-studio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		//#region src/client/api.js
		/** Error carrying the route's JSON error message. */
		var ApiError = class extends Error {
			constructor(message, extra) {
				super(message);
				this.name = "SkillManagerApiError";
				this.status = extra && extra.status;
				this.code = extra && extra.code;
				this.body = extra && extra.body;
			}
		};
		/** Parse a JSON response or throw an ApiError. */
		async function readJson(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new ApiError("HTTP " + response.status + ": invalid JSON response");
			}
			if (!response.ok) {
				throw new ApiError(typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : "HTTP " + response.status, {
					status: response.status,
					code: typeof body === "object" && body !== null && typeof body.code === "string" ? body.code : undefined,
					body
				});
			}
			return body;
		}
		/** Plain fetch helper with an error wrapper. */
		async function request(path, init) {
			let response;
			try {
				response = await fetch(path, init);
			} catch (error) {
				throw new ApiError("网络请求失败：" + String(error instanceof Error ? error.message : error));
			}
			return readJson(response);
		}
		/** The skill-manager panel API. */
		var Api = class {
			async list() {
				return request("/api/dsh-studio/list");
			}
			async get(name) {
				return request("/api/dsh-studio/skill?name=" + encodeURIComponent(name));
			}
			async save(name, content, opts) {
				const body = { name, content };
				if (opts && opts.expectedMtime !== undefined) body.expectedMtime = opts.expectedMtime;
				if (opts && opts.overwrite === true) body.overwrite = true;
				return request("/api/dsh-studio/skill", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body)
				});
			}
			async setPolicy(name, patch) {
				return request("/api/dsh-studio/policy", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(Object.assign({ name }, patch))
				});
			}
			/** 回收站：列表 / 删除到回收站 / 恢复 / 永久删除。 */
			async trashList() {
				return request("/api/dsh-studio/trash");
			}
			async trashSkill(name, cwd) {
				return request("/api/dsh-studio/trash", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, cwd })
				});
			}
			async restoreTrash(id, name) {
				return request("/api/dsh-studio/restore", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, name })
				});
			}
			async purgeTrash(id, name) {
				return request("/api/dsh-studio/purge", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, name })
				});
			}
			/** 配置快照：建 / 列 / 恢复 / 清理 / 导出导入。 */
			async snapshotList() {
				return request("/api/dsh-studio/snapshot");
			}
			async snapshotCreate(label) {
				return request("/api/dsh-studio/snapshot", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ label })
				});
			}
			async snapshotRestore(id, dryRun, pathMap) {
				return request("/api/dsh-studio/snapshot/restore", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id, dryRun, pathMap })
				});
			}
			async snapshotPrune(keep) {
				return request("/api/dsh-studio/snapshot/prune", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ keep })
				});
			}
			async syncConfig(patch) {
				if (patch === undefined) return request("/api/dsh-studio/sync");
				return request("/api/dsh-studio/sync", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			async syncPush(snapshotId, channel) {
				return request("/api/dsh-studio/sync/push", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ snapshotId, channel })
				});
			}
			async syncPull(channel, label) {
				return request("/api/dsh-studio/sync/pull", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ channel, label })
				});
			}
			async snapshotSchedule(patch) {
				if (patch === undefined) return request("/api/dsh-studio/snapshot/schedule");
				return request("/api/dsh-studio/snapshot/schedule", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			async snapshotDelete(id) {
				return request("/api/dsh-studio/snapshot/delete", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id })
				});
			}
			async skillImport(source) {
				return request("/api/dsh-studio/skill-import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ source })
				});
			}
			async skillExport(name, path) {
				const body = { name };
				if (path) body.path = path;
				return request("/api/dsh-studio/skill-export", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body)
				});
			}
			async snapshotTransfer(payload) {
				return request("/api/dsh-studio/snapshot/transfer", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload)
				});
			}
			async extractStatus() {
				return request("/api/dsh-studio/extract-status");
			}
			async extractConfig(patch) {
				return request("/api/dsh-studio/extract-config", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			async extractRun() {
				return request("/api/dsh-studio/extract-run", { method: "POST" });
			}
			async extractCandidates() {
				return request("/api/dsh-studio/extract-candidates");
			}
			async extractCandidate(id, patch) {
				return request("/api/dsh-studio/extract-candidate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(Object.assign({ id }, patch))
				});
			}
			async extractAccept(ids) {
				return request("/api/dsh-studio/extract-accept", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ids })
				});
			}
			async extractRecent() {
				return request("/api/dsh-studio/extract-recent");
			}
			async extractReject(ids) {
				return request("/api/dsh-studio/extract-reject", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ids })
				});
			}
			/** MCP 按需加载：注册表、档位、空闲阈值。 */
			async mcpList() {
				return request("/api/dsh-studio/mcp");
			}
			/** ：注册表损坏闸——所有者确认后解闸（坏文件仍留档）。 */
			async mcpCorruptAck() {
				return request("/api/dsh-studio/mcp/registry-corrupt", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ confirm: true })
				});
			}
			async mcpUpsert(entry) {
				return request("/api/dsh-studio/mcp", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(entry)
				});
			}
			async mcpRemove(name) {
				return request("/api/dsh-studio/mcp?name=" + encodeURIComponent(name), { method: "DELETE" });
			}
			async mcpReload(name) {
				return request("/api/dsh-studio/mcp/reload", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name })
				});
			}
			async mcpPrefetch(name) {
				return request("/api/dsh-studio/mcp/prefetch", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name })
				});
			}
			async mcpTools(name, mode, names) {
				return request("/api/dsh-studio/mcp/tools", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, mode, names })
				});
			}
			async mcpTakeover(name) {
				return request("/api/dsh-studio/mcp/takeover", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name })
				});
			}
			async mcpSettings(patch) {
				return request("/api/dsh-studio/mcp/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			/** 凭据明文只走这条 loopback 路由按需取，列表里永远是掩码。 */
			async mcpCredential(name, kind, key) {
				return request("/api/dsh-studio/mcp/credential", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, kind, key })
				});
			}
			/** 上游版本检查：会联网查 npm registry / git ls-remote，只在用户点按钮时调。 */
			async mcpUpdateCheck(name) {
				const query = typeof name === "string" && name !== "" ? "?name=" + encodeURIComponent(name) : "";
				return request("/api/dsh-studio/mcp/update-check" + query);
			}
		};
		//#endregion
		//#region src/client/ui-base.js
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
		//#endregion
		//#region src/client/skill-widgets.js
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
		//#endregion
		//#region src/client/McpPanel.js
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
		//#endregion
		//#region src/client/ExtractorPanel.js
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
		//#endregion
		//#region src/client/SnapshotPanel.js
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
				setMsg("已恢复 " + r.written + " 个文件" + (r.preSnapshot !== null ? "（恢复前快照 " + r.preSnapshot + "）" : ""));
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
		//#endregion
		//#region src/client/skill-dialogs.js
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
		//#endregion
		//#region src/client/SkillManagerPanel.js
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
		//#endregion
		//#region src/client/index.js
		/** Required services. */
		const inject = ["slots"];
		/**
		 * Register the Skill 管理器 settings page.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "skill-manager",
							order: 300,
							label: () => "Skill 工作台"
						},
						SkillManagerPanel
					)
				);
			} catch (error) {
				console.warn("[dsh-studio] settings panel registration failed:", error);
			}
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "skill-mcp",
							order: 301,
							label: () => "MCP 服务器"
						},
						McpPanel
					)
				);
			} catch (error) {
				console.warn("[dsh-studio] MCP panel registration failed:", error);
			}
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "skill-snapshot",
							order: 302,
							label: () => "配置快照"
						},
						SnapshotPanel
					)
				);
			} catch (error) {
				console.warn("[dsh-studio] snapshot panel registration failed:", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
