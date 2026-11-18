/**
 * studio 级备份包与跨机恢复的对外面。
 *   模型工具（2）：skillmgr_studio_backup（status / export / verify / push / pull / delete / report）
 *                 skillmgr_studio_restore（默认只预演；dryRun:false 才写，冲突项只按 resolutions 裁定）
 *   面板路由（6）：GET  /api/dsh-studio/studio-backup/status
 *                 POST /api/dsh-studio/studio-backup/export   {label?, to?}
 *                 POST /api/dsh-studio/studio-backup/verify   {id? | file?}
 *                 POST /api/dsh-studio/studio-backup/restore  {id? | file?, dryRun?, resolutions?, pathMap?}
 *                 POST /api/dsh-studio/studio-backup/remote   {action: "push"|"pull", id?}
 *                 GET  /api/dsh-studio/studio-backup/report?id=restore-…
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isLocalRequest } from "./guard.js";
import { ErrorMsg, handle, queryValue, readJsonBody, text, writeJson } from "./route-util.js";
import { ACTION_LABELS } from "./studio-backup.js";

export const STUDIO_BACKUP_API = {
	status: "/api/dsh-studio/studio-backup/status",
	export: "/api/dsh-studio/studio-backup/export",
	verify: "/api/dsh-studio/studio-backup/verify",
	restore: "/api/dsh-studio/studio-backup/restore",
	remote: "/api/dsh-studio/studio-backup/remote",
	report: "/api/dsh-studio/studio-backup/report"
};

const looseObject = { type: "object", additionalProperties: true };
const clean = (value) => JSON.parse(JSON.stringify(value ?? null));
const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

const BOUNDARY =
	"分工：本包是 studio 自己的可移植备份（注册表 / 配置 / 技能 / 版本史 / 进化数据，按对象合并恢复、冲突报告待裁）；.dsh 快照与每日备份是整目录灾备（原样覆盖回同一台机器）。两者不互相替代。";

function renderStatus(s) {
	const c = s.config;
	const lines = [
		BOUNDARY,
		`自动打包${c.enabled ? "已开启" : "未开启（默认关；手动 action:\"export\"）"}；窗口 ${c.idleWindow.start}–${c.idleWindow.end}、闲 ${c.idleMinutes} 分钟、至少隔 ${c.minIntervalHours} 小时；自动包留 ${c.keep} 份、恢复前保护包留 ${c.keepPreRestore} 份。`,
		`WebDAV：${s.remote.configured ? `${s.remote.host}/…/${s.remote.dir}（复用 sync.json 的 webdav 段）${c.autoPush ? "，自动包打完即推送" : ""}` : "未配置（sync.json 的 webdav.url 为空）"}；远端留 ${c.remoteKeep || "不限"} 份。`,
		`数据目录：${s.dir}`
	];
	if (s.schedule.lastAutoId) lines.push(`上次自动打包：${s.schedule.lastAutoId}（${s.schedule.lastStatus ?? ""}${s.schedule.lastError ? "：" + s.schedule.lastError : ""}）`);
	if (s.schedule.lastPush) lines.push(`上次推送：${s.schedule.lastPush.id} ${s.schedule.lastPush.ok ? "成功" : "失败：" + (s.schedule.lastPush.error ?? "")}`);
	lines.push("", `本地备份包（${s.packages.length}）：`);
	for (const p of s.packages.slice(0, 12)) {
		const m = p.summary;
		lines.push(`- ${p.id} · ${kb(p.bytes)}${m ? ` · 注册表 ${m.registry ?? "—"} 台 · 技能 ${m.skills} · 版本记录 ${m.historyRecords} · 配置 ${m.config.length} · 数据 ${m.dataFiles}${m.skillFilesSkipped ? ` · 超限未打包 ${m.skillFilesSkipped}` : ""}` : ""}${p.imported ? " · 外来" : ""}`);
	}
	if (s.restores.length > 0) {
		lines.push("", "最近恢复：");
		for (const r of s.restores.slice(0, 5)) lines.push(`- ${r.id}${r.dryRun ? "（预演）" : ""} ← ${r.packageId} · 待裁 ${r.pending} · 需补凭据 ${r.needsCredentials}${r.preRestore ? " · 保护包 " + r.preRestore : ""}`);
	}
	return lines.join("\n");
}

/** json 参数：对象 / 数组原样用，字符串按 JSON 解析（模型有时会把对象写成字符串）。 */
function jsonArg(value) {
	if (typeof value === "string" && value.trim() !== "") return JSON.parse(value);
	return value ?? undefined;
}

const ID_DESC = "备份包 id（studio-…，见 action:\"status\" 的列表）";

/** @param {{backup: ReturnType<import("./studio-backup.js").createStudioBackup>}} options */
export function buildStudioBackupTools({ backup }) {
	return [
		defineTool({
			name: "skillmgr_studio_backup",
			description:
				"studio 级备份包（换机器 / 跨机覆盖用；与 .dsh 快照的整目录灾备分工不同）。action：status（只读：本地包、最近恢复报告、自动打包与 WebDAV 状态）/ export（打一份包：MCP 注册表 v2 全量 + 优化器 / 治理 / 蒸馏 / 提取器配置 + 两个技能库 + 版本史 + 进化数据；凭据一律脱敏；可给 to 顺手拷到某个路径）/ verify（逐条核对 sha256，给 id 或外部包的 file 路径）/ push（推到 sync.json 配好的 WebDAV）/ pull（从 WebDAV 取 LATEST 或指定 id 并校验）/ delete（删本地一份包）/ report（看一份恢复报告）。恢复用 skillmgr_studio_restore。",
			parameters: {
				action: { type: "string", description: "status / export / verify / push / pull / delete / report", required: true },
				id: { type: "string", description: ID_DESC + "；report 时是恢复报告 id（restore-…）" },
				file: { type: "string", description: "verify：外部包文件的路径（别的机器拷来的 .tar.gz）" },
				label: { type: "string", description: "export：标签（拼进包名，默认 manual）" },
				to: { type: "string", description: "export：打完再拷一份到这个路径（目录或文件名）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						result: looseObject
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				const action = String(args?.action ?? "status").trim();
				try {
					if (action === "status") {
						const s = await backup.status();
						return clean({ ok: true, message: renderStatus(s), result: s });
					}
					if (action === "export") {
						const r = await backup.exportPackage({ label: args?.label, to: args?.to });
						const m = r.summary;
						const skipped = r.skippedFiles.length > 0 ? `；${r.skippedFiles.length} 个超限技能文件只记 sha 未打包` : "";
						const red = r.redacted.reduce((n, x) => n + x.fields.length, 0);
						return clean({ ok: true, message: `已打包 ${r.id}（${kb(r.bytes)}，sha256 ${r.sha256.slice(0, 16)}…）：注册表 ${m.registry ?? "—"} 台、配置 ${m.config.join("/") || "无"}、技能 ${m.skills} 个、版本记录 ${m.historyRecords} 条 / 对象 ${m.historyObjects} 个、数据文件 ${m.dataFiles} 个；脱敏 ${red} 个凭据字段${skipped}${r.copiedTo ? `；已拷到 ${r.copiedTo}` : ""}${r.pruned.length ? `；清理旧包 ${r.pruned.length} 份` : ""}`, result: r });
					}
					if (action === "verify") {
						const r = await backup.verify({ id: args?.id, file: args?.file });
						return clean({ ok: r.ok, message: r.ok ? `校验通过：${r.id}，${r.stats.entries} 个条目 sha256 逐一对上（版本史对象 ${r.stats.historyObjects} 个也复核过内容）` : `校验未通过（${r.errors.length} 处）：\n- ${r.errors.slice(0, 10).join("\n- ")}`, result: r });
					}
					if (action === "push") {
						const r = await backup.push({ id: args?.id });
						return clean({ ok: true, message: `已推到 WebDAV ${r.host}/…/${r.remoteDir}：${r.id}（${kb(r.bytes)}）；LATEST 已更新${r.remoteRemoved.length ? `；远端清理 ${r.remoteRemoved.length} 份旧包` : ""}`, result: r });
					}
					if (action === "pull") {
						const r = await backup.pull({ id: args?.id });
						return clean({ ok: true, message: `已从 WebDAV 取回 ${r.id}（${kb(r.bytes)}）并校验通过${r.checksumChecked ? "（含远端 sha256 比对）" : ""}；恢复前先 skillmgr_studio_restore {id:"${r.id}"} 预演`, result: r });
					}
					if (action === "delete") {
						const r = await backup.deletePackage(args?.id);
						return clean({ ok: true, message: `已删除本地备份包 ${r.id}`, result: r });
					}
					if (action === "report") {
						const r = await backup.getRestoreReport(args?.id);
						return clean({ ok: true, message: r.markdown ?? "", result: r });
					}
					return { ok: false, message: `不认识的 action：${action}（status / export / verify / push / pull / delete / report）` };
				} catch (error) {
					return { ok: false, message: `studio 备份 ${action} 失败：` + ErrorMsg(error) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_studio_restore",
			description:
				"从 studio 备份包恢复（所有者要求时才调用）。默认只预演（dryRun 默认 true，不写盘、出一份预演报告）；dryRun:false 才真写，写前自动给本机打一份 pre-restore 保护包。合并口径：版本史按 id 取并集；技能按版本链判断——本机没有就新建、本机是包内版本的祖先就前进、本机更新就保留；版本分叉 / 判断不了的同名技能、同名但配置不同的 MCP server、两边不同的配置文件一律报告为「待裁冲突」，不静默覆盖——所有者裁定后用 resolutions {\"<冲突 id>\": \"package\" 或 \"local\"} 重跑。包里没有明文凭据：目标机也没有的凭据字段在报告 needsCredentials 里列出。",
			parameters: {
				id: { type: "string", description: ID_DESC },
				file: { type: "string", description: "或：外部包文件路径（别的机器拷来的 .tar.gz；真恢复时会先收进本地包目录）" },
				dryRun: { type: "boolean", description: "默认 true（只预演）；false 才写盘" },
				resolutions: { type: "json", description: "冲突裁定：{\"skill:agents/foo\": \"package\", \"registry:rea\": \"local\", …}（id 见预演报告的待裁冲突）" },
				pathMap: { type: "json", description: "额外的路径前缀替换：数组 [{from, to}] 或它的 JSON 字符串（来源机 home → 本机 home 已自动处理）" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						reportId: { type: "string" },
						dryRun: { type: "boolean" },
						counts: looseObject,
						pending: { type: "array", items: looseObject },
						needsCredentials: { type: "array", items: looseObject },
						preRestore: { type: "string" }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const r = await backup.restore({ id: args?.id, file: args?.file, dryRun: args?.dryRun !== false, resolutions: jsonArg(args?.resolutions), pathMap: jsonArg(args?.pathMap), actor: "tool:skillmgr_studio_restore" });
					const counts = Object.entries(r.counts).map(([k, n]) => `${ACTION_LABELS[k] ?? k} ${n}`).join(" · ");
					return clean({ ok: (r.counts.failed ?? 0) === 0, message: `${r.markdown}\n（报告 ${r.id}；${counts}）`, reportId: r.id, dryRun: r.dryRun, counts: r.counts, pending: r.pending, needsCredentials: r.needsCredentials, ...(r.preRestore ? { preRestore: r.preRestore } : {}) });
				} catch (error) {
					return { ok: false, message: "恢复未执行：" + ErrorMsg(error) };
				}
			}
		})
	];
}

export function buildStudioBackupRoutes(ctx, { backup }) {
	const guard = (req, res, method) => {
		if (!isLocalRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: "method not allowed: " + req.method });
			return false;
		}
		return true;
	};
	const body = async (req, res) => {
		const parsed = await readJsonBody(req);
		if (parsed === undefined) writeJson(res, 400, { error: "请求体不是合法 JSON" });
		return parsed;
	};
	const post = (path, fn) => ({
		kind: "exact",
		path,
		handler: handle(ctx, async (req, res) => {
			if (!guard(req, res, "POST")) return;
			const b = await body(req, res);
			if (b === undefined) return;
			writeJson(res, 200, clean(await fn(b)));
		})
	});
	return [
		{
			kind: "exact",
			path: STUDIO_BACKUP_API.status,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, clean(await backup.status()));
			})
		},
		post(STUDIO_BACKUP_API.export, (b) => backup.exportPackage({ label: b.label, to: b.to })),
		post(STUDIO_BACKUP_API.verify, (b) => backup.verify({ id: b.id, file: b.file })),
		post(STUDIO_BACKUP_API.restore, (b) => backup.restore({ id: b.id, file: b.file, dryRun: b.dryRun !== false, resolutions: b.resolutions, pathMap: b.pathMap, actor: "panel" })),
		post(STUDIO_BACKUP_API.remote, (b) => {
			if (b.action === "push") return backup.push({ id: b.id });
			if (b.action === "pull") return backup.pull({ id: b.id });
			return Promise.reject(Object.assign(new Error("action 只能是 push / pull"), { statusCode: 400 }));
		}),
		{
			kind: "exact",
			path: STUDIO_BACKUP_API.report,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, clean(await backup.getRestoreReport(queryValue(req, "id"))));
			})
		}
	];
}
