/**
 * 设置面板用的基础路由（/api/dsh-studio/*）：技能、回收站、快照、同步、生命周期、导入导出。
 * （从 index.js 拆出，逻辑未改。）
 */
import { ExtractorStore } from "./extractor.js";
import { isLocalRequest } from "./guard.js";
import { markSkillUsed } from "./lifecycle.js";
import { findSkillByName } from "./scanner.js";
import { exportSkill } from "./skill-export.js";
import { importSkill } from "./skillsrc.js";
import {
	countFiles,
	createSnapshot,
	deleteSnapshot,
	exportSnapshot,
	importSnapshot,
	listSnapshots,
	loadSchedule,
	pruneSnapshots,
	restoreSnapshot,
	saveSchedule
} from "./snapshot.js";
import { loadSync, pullSnapshot, pushSnapshot, redactSyncConfig, saveSync } from "./sync.js";
import { listTrash, purgeTrash, restoreTrash, trashSkill } from "./trash.js";
import { API } from "./plugin-meta.js";
import { ErrorMsg, handle, queryValue, readJsonBody, writeJson } from "./route-util.js";
import { getSkillDetail, listSkills, resolveCwd, savePolicy, saveSkill } from "./skill-core.js";

//#endregion

/**
 * Build every /api/dsh-studio route (exact paths).
 * @param ctx - host plugin context.
 * @param store - 提取器配置（skill 导入要读 agentSkillDir）。此前这里引用了一个没定义的 `store`，面板导入必报 "store is not defined"。
 * @returns the route list.
 */
/** POST /snapshot 的回包：manifest 摘要（B7）。 */
export function snapshotSummary(manifest) {
	return {
		id: manifest.id,
		label: manifest.label,
		at: manifest.at,
		archiveBytes: manifest.archiveBytes,
		fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
		redacted: Array.isArray(manifest.redacted) ? manifest.redacted.length : 0,
		excluded: Array.isArray(manifest.excluded) ? manifest.excluded.length : 0,
		skipped: Array.isArray(manifest.skipped) ? manifest.skipped.length : 0
	};
}

function makeRoutes(ctx, store = new ExtractorStore()) {
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
	return [
		{
			kind: "exact",
			path: API.list,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const cwd = resolveCwd(queryValue(req, "cwd"));
				writeJson(res, 200, {
					ok: true,
					cwd: cwd ?? process.cwd(),
					skills: await listSkills(ctx, cwd)
				});
			})
		},
		{
			kind: "exact",
			path: API.trash,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, { ok: true, batches: await listTrash() });
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					if (body === void 0 || typeof body.name !== "string") {
						writeJson(res, 400, { error: "invalid JSON body (name required)" });
						return;
					}
					const skill = await findSkillByName(body.name, resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0));
					if (skill === null) {
						writeJson(res, 404, { error: "skill not found: " + body.name });
						return;
					}
					if (typeof skill.dir !== "string" || skill.dir === "") {
						writeJson(res, 400, { error: "内置技能不能删除。" });
						return;
					}
					const cwd = resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0);
					writeJson(res, 200, { ok: true, moved: await trashSkill({ name: skill.name, dir: skill.dir, path: skill.path }, { cwd }) });
					return;
				}
				writeJson(res, 405, { error: "method not allowed: " + method });
			})
		},
		{
			kind: "exact",
			path: API.restore,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.id !== "string") {
					writeJson(res, 400, { error: "invalid JSON body (id required)" });
					return;
				}
				writeJson(res, 200, { ok: true, ...(await restoreTrash(body.id, typeof body.name === "string" ? body.name : void 0, { cwd: resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0) })) });
			})
		},
		{
			kind: "exact",
			path: API.purge,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.id !== "string") {
					writeJson(res, 400, { error: "invalid JSON body (id required)" });
					return;
				}
				writeJson(res, 200, { ok: true, ...(await purgeTrash(body.id, typeof body.name === "string" ? body.name : void 0)) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotList,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, { ok: true, snapshots: await listSnapshots(), collected: await countFiles({ maxSkillFileBytes: (await loadSchedule()).maxSkillFileBytes }) });
					return;
				}
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const label = typeof body?.label === "string" && body.label !== "" ? body.label : "manual";
				// B7：面板只要 id 与文件数，不再把整份 manifest（每个文件的 rel/bytes/sha，上千条）回给它
				const manifest = await createSnapshot(label);
				writeJson(res, 200, { ok: true, snapshot: snapshotSummary(manifest) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotRestore,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (typeof body?.id !== "string" || body.id === "") {
					writeJson(res, 400, { error: "需要 id" });
					return;
				}
				writeJson(res, 200, { ok: true, ...(await restoreSnapshot(body.id, { dryRun: body.dryRun === true, force: body.force === true, pathMap: Array.isArray(body.pathMap) ? body.pathMap : void 0 })) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotPrune,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const keep = Number(body?.keep);
				writeJson(res, 200, { ok: true, ...(await pruneSnapshots(Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 10)) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotDelete,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (typeof body?.id !== "string" || body.id === "") {
					writeJson(res, 400, { error: "需要 id" });
					return;
				}
				writeJson(res, 200, { ok: true, ...(await deleteSnapshot(body.id)) });
			})
		},
		{
			kind: "exact",
			path: API.snapshotTransfer,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const action = body?.action === "import" ? "import" : "export";
				if (typeof body?.path !== "string" || body.path === "") {
					writeJson(res, 400, { error: "需要 path" });
					return;
				}
				if (action === "export") {
					if (typeof body.id !== "string" || body.id === "") {
						writeJson(res, 400, { error: "导出需要 id" });
						return;
					}
					writeJson(res, 200, { ok: true, ...(await exportSnapshot(body.id, body.path)) });
					return;
				}
				writeJson(res, 200, { ok: true, snapshot: await importSnapshot(body.path, typeof body.label === "string" ? body.label : "imported") });
			})
		},
		{
			kind: "exact",
			path: API.snapshotSchedule,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, { ok: true, schedule: await loadSchedule() });
					return;
				}
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				writeJson(res, 200, { ok: true, schedule: await saveSchedule(body) });
			})
		},
		{
			kind: "exact",
			path: API.syncConfig,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					// 只回脱敏视图：gist token / WebDAV 口令 / S3 secretKey 不进面板 state（保存时原样回传的掩码按「没改」处理，见 saveSync）
					writeJson(res, 200, { ok: true, sync: redactSyncConfig(await loadSync()) });
					return;
				}
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				writeJson(res, 200, { ok: true, sync: redactSyncConfig(await saveSync(body)) });
			})
		},
		{
			kind: "exact",
			path: API.syncPush,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (typeof body?.snapshotId !== "string" || body.snapshotId === "") {
					writeJson(res, 400, { error: "需要 snapshotId" });
					return;
				}
				const config = await loadSync();
				const channel = typeof body.channel === "string" ? body.channel : config.channel;
				writeJson(res, 200, { ok: true, ...(await pushSnapshot(channel, config[channel] ?? {}, body.snapshotId)) });
			})
		},
		{
			kind: "exact",
			path: API.syncPull,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const config = await loadSync();
				const channel = typeof body?.channel === "string" ? body.channel : config.channel;
				writeJson(res, 200, { ok: true, ...(await pullSnapshot(channel, config[channel] ?? {}, typeof body?.label === "string" && body.label !== "" ? body.label : "pulled")) });
			})
		},
		{
			kind: "exact",
			path: API.skillImport,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.source !== "string" || body.source.trim() === "") {
					writeJson(res, 400, { error: "invalid JSON body (source required)" });
					return;
				}
				try {
					const cfg = await store.load();
					const result = await importSkill({ source: body.source.trim(), targetDir: cfg.agentSkillDir });
					if (result.changed) await markSkillUsed(result.name);
					writeJson(res, 200, result);
				} catch (error) {
					writeJson(res, 200, { ok: false, message: "导入失败：" + String(ErrorMsg(error)) });
				}
			})
		},
		{
			kind: "exact",
			path: API.skillExport,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.name !== "string" || body.name.trim() === "") {
					writeJson(res, 400, { error: "invalid JSON body (name required)" });
					return;
				}
				writeJson(res, 200, await exportSkill({
					name: body.name,
					path: typeof body.path === "string" ? body.path : "",
					cwd: resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0)
				}));
			})
		},
		{
			kind: "exact",
			path: API.skill,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					const name = queryValue(req, "name");
					if (!name) {
						writeJson(res, 400, { error: "name query is required" });
						return;
					}
					const cwd = resolveCwd(queryValue(req, "cwd"));
					const detail = await getSkillDetail(ctx, name, cwd);
					if (!detail) {
						writeJson(res, 404, { error: "skill not found: " + name });
						return;
					}
					writeJson(res, 200, { ok: true, skill: detail });
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					if (body === void 0 || typeof body.name !== "string") {
						writeJson(res, 400, { error: "invalid JSON body (name required)" });
						return;
					}
					writeJson(res, 200, await saveSkill(ctx, {
						name: body.name,
						content: body.content,
						expectedMtime: body.expectedMtime,
						overwrite: body.overwrite === true
					}, resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0)));
					return;
				}
				writeJson(res, 405, { error: "method not allowed: " + method });
			})
		},
		{
			kind: "exact",
			path: API.policy,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.name !== "string") {
					writeJson(res, 400, { error: "invalid JSON body (name required)" });
					return;
				}
				writeJson(res, 200, await savePolicy(ctx, {
					name: body.name,
					enabled: typeof body.enabled === "boolean" ? body.enabled : void 0,
					modelInvocable: typeof body.modelInvocable === "boolean" ? body.modelInvocable : void 0,
					userInvocable: typeof body.userInvocable === "boolean" ? body.userInvocable : void 0,
					expectedMtime: body.expectedMtime,
					overwrite: body.overwrite === true
				}, resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0)));
			})
		}
	];
}

export { makeRoutes };
