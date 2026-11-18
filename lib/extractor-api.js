/**
 * 提取功能的对外面：面向模型的提取工具，以及设置面板调用的提取路由。
 * （从 index.js 拆出，逻辑未改。）
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	archiveCandidates,
	candidateFile,
	defaults as extractorDefaults,
	loadCandidates,
	recentSkills,
	runtimeState,
	saveCandidates,
	updateCandidate,
	writeSkillDual
} from "./extractor.js";
import { isLocalRequest } from "./guard.js";
import { listArchived, loadState as loadLifecycleState, markSkillUsed, scanLifecycle } from "./lifecycle.js";
import { collectQualityMetrics } from "./quality.js";
import { loadLock as loadSkillLock } from "./skillsrc.js";
import { withFileLock } from "./state-lock.js";
import { API } from "./plugin-meta.js";
import { listAvailableModels, pluginState, runExtract } from "./plugin-state.js";
import { ErrorMsg, handle, readJsonBody, text, writeJson } from "./route-util.js";

//#region extractor (merged from dsh-skill-extractor)
/** Model-facing extraction tools. @returns an array of defineTool results. */
function buildExtractorTools(store) {
	return [
		defineTool({
			name: "skillmgr_extract_status",
			description: "查看会话提取插件状态：是否启用、定时提取间隔（分钟）、扫描窗口（天）、LLM 是否配置（baseUrl/apiKey/model）、目标 skill 库目录、最近一次提取结果与候选队列里的待确认 skill 数量。不会泄露任何密钥。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						enabled: { type: "boolean" },
						intervalMinutes: { type: "number" },
						windowDays: { type: "number" },
						llmConfigured: { type: "boolean" },
						skillLanguage: { type: "string" },
						mirrorDir: { type: "string" },
						agentSkillDir: { type: "string" },
						autoAccept: { type: "boolean" },
						mergeThreshold: { type: "number" },
						lastRunAt: { type: "string" },
						lastRunSummary: { type: "string" },
						queued: { type: "number" }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute() {
				try {
					const view = await store.view();
					const queue = await loadCandidates();
					const pending = queue.filter((c) => c.status === "pending").length;
					const interval = view.intervalMinutes === 0 ? "已关闭定时" : `每 ${view.intervalMinutes} 分钟`;
					return {
						ok: true,
						message:
							"插件" + (view.enabled ? "已启用" : "已禁用") + " · " + interval + " · 窗口 " + view.windowDays +
							" 天 · LLM " + (view.configured ? "已配置（" + view.llmModel + "）" : pluginState.llm ? "走 DSH 模型" : "未配置") + " · 待确认 " + pending + " 个 · 上次 " + (view.lastRunAt ? new Date(view.lastRunAt).toLocaleString() : "未运行") +
							" · 默认存 agent 根（" + view.agentSkillDir + "）" + (view.mirrorDir ? " · 额外镜像 " + view.mirrorDir : "") + " · 自动接受 " + (view.autoAccept ? "开" : "关") + " · 合并阈值 " + view.mergeThreshold,
						enabled: view.enabled,
						intervalMinutes: view.intervalMinutes,
						windowDays: view.windowDays,
						llmConfigured: view.configured,
						skillLanguage: view.skillLanguage,
						mirrorDir: view.mirrorDir,
						agentSkillDir: view.agentSkillDir,
						lastRunAt: view.lastRunAt,
						lastRunSummary: view.lastRunSummary,
						queued: pending
					};
				} catch (error) {
					return { ok: false, message: String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_config",
			description: "配置会话提取：enabled（总开关）、intervalMinutes（每隔多少分钟自动提取一次，0=关闭）、windowDays（扫描最近几天会话）、maxCandidatesPerRun（每次最多候选数）、skillLanguage（正文语言 zh/en）、mirrorDir（可选额外镜像目录）、agentSkillDir（agent 自动加载根）、autoAccept（旧行为：提取后直接入库；插件内的提取一律先成蒸馏草稿、过评估门才入库，此项不再生效）、mergeThreshold（语义合并阈值，默认 0.2）。**模型走 DSH 自己配置的 provider/model，不需要设置 baseUrl/apiKey/model**；llmBaseUrl/llmApiKey/llmModel 仅在 DSH 未提供 llm 服务时作为 HTTP 回退。持久化到 ~/.dsh/dsh-studio/extractor.json（0600）。传 reset: true 恢复默认。不会泄露 llmApiKey。",
			parameters: {
				enabled: { type: "boolean", description: "总开关" },
				intervalMinutes: { type: "number", description: "提取间隔（分钟），0 关闭" },
				windowDays: { type: "number", description: "扫描窗口（天）" },
				maxCandidatesPerRun: { type: "number", description: "每次最多候选数" },
				skillLanguage: { type: "string", enum: ["zh", "en"], description: "候选正文语言" },
				llmBaseUrl: { type: "string", description: "LLM Base URL（OpenAI 兼容）" },
				llmApiKey: { type: "string", description: "LLM API Key" },
				llmModel: { type: "string", description: "LLM 模型名" },
				mirrorDir: { type: "string", description: "可选额外镜像目录（默认关闭，留空=只存 agent 根）" },
				agentSkillDir: { type: "string", description: "agent 自动加载根（默认 ~/.agents/skills，必须，不用设置）" },
				autoAccept: { type: "boolean", description: "旧开关（不再生效：候选一律先成蒸馏草稿，过评估门才入库；见 skillmgr_distill_status）" },
				mergeThreshold: { type: "number", description: "语义合并阈值 0–1（默认 0.2）：name+description 相似度超过它才尝试并入既有 skill" },
				provider: { type: "string", description: "手动指定 provider（留空=跟随当前会话 / DSH 默认）" },
				model: { type: "string", description: "手动指定 model（留空=跟随当前会话 / DSH 默认）" },
				reset: { type: "boolean", description: "恢复默认配置" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						enabled: { type: "boolean" },
						intervalMinutes: { type: "number" },
						windowDays: { type: "number" },
						llmConfigured: { type: "boolean" },
						skillLanguage: { type: "string" },
						mirrorDir: { type: "string" },
						agentSkillDir: { type: "string" },
						autoAccept: { type: "boolean" },
						mergeThreshold: { type: "number" }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					if (args !== void 0 && args.reset === true) await store.patch(extractorDefaults());
					else await store.patch(args);
					const view = await store.view();
					return {
						ok: true,
						message: "配置已保存：" + (view.enabled ? "启用" : "禁用") + " · " + (view.intervalMinutes === 0 ? "已关闭定时" : "每 " + view.intervalMinutes + " 分钟") + " · 窗口 " + view.windowDays + " 天 · 正文" + (view.skillLanguage === "en" ? "英文" : "中文") + " · LLM " + (view.configured ? "已配置" : pluginState.llm ? "走 DSH 模型" : "未配置") + " · 默认存 agent 根" + (view.mirrorDir ? " · 额外镜像 " + view.mirrorDir : "") + " · 自动接受 " + (view.autoAccept ? "开" : "关") + " · 合并阈值 " + view.mergeThreshold,
						enabled: view.enabled,
						intervalMinutes: view.intervalMinutes,
						windowDays: view.windowDays,
						llmConfigured: view.configured,
						skillLanguage: view.skillLanguage,
						mirrorDir: view.mirrorDir,
						agentSkillDir: view.agentSkillDir
					};
				} catch (error) {
					return { ok: false, message: "配置失败：" + String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_run",
			description: "立即执行一次会话提取：扫描最近 windowDays 天的会话日志，调用 LLM 产出候选 skill 草稿，写入待确认队列（去重）。不会自动写入正式库，需 skillmgr_extract_accept 确认。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						candidates: { type: "array", items: { type: "object", additionalProperties: true } },
						digests: { type: "number" },
						queued: { type: "number" }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute() {
				try {
					const cfg = await store.load();
					const result = await runExtract(cfg);
					if (result.site) await store.patch(result.site);
					return {
						ok: result.ok,
						message: (result.ok ? "提取完成：" : "提取失败：") + result.message + "；候选：" + (result.candidates || []).map((c) => c.name).join(", ") || "无",
						candidates: result.candidates ?? [],
						digests: result.digests ?? 0,
						queued: result.queued ?? 0
					};
				} catch (error) {
					const message = String(ErrorMsg(error));
					return { ok: false, message: error && error.code === "EXTRACT_BUSY" ? message : "提取失败：" + message };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_list",
			description: "列出待确认的候选 skill 草稿（id、name、description、rationale、来源会话数、创建时间）。接受用 skillmgr_extract_accept，拒绝用 skillmgr_extract_reject；候选可在 Web 面板中编辑后再接受。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						candidates: { type: "array", items: { type: "object", additionalProperties: true } }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute() {
				try {
					const queue = await loadCandidates();
					const pending = queue.filter((c) => c.status === "pending");
					if (pending.length === 0) return { ok: true, message: "候选队列为空", candidates: [] };
					return {
						ok: true,
						message: "候选 " + pending.length + " 个：\n" + pending.map((c) => `- ${c.name}（${c.id}）：${c.description}`).join("\n"),
						candidates: pending.map((c) => ({ id: c.id, name: c.name, description: c.description, rationale: c.rationale, sourceCount: c.sourceCount, created: c.created }))
					};
				} catch (error) {
					return { ok: false, message: String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_accept",
			description: "接受候选：把给定 id 的候选 skill 写入目标库（2️⃣ AI/Skill/<name>/SKILL.md，去重），并从待确认队列移除。参数 ids：候选 id 数组。",
			parameters: {
				ids: { type: "array", items: { type: "string" }, description: "要接受的候选 id 数组" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						written: { type: "array", items: { type: "string" } }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const ids = new Set(Array.isArray(args && args.ids) ? args.ids : []);
					if (ids.size === 0) return { ok: false, message: "请提供要接受的候选 id（ids）" };
					const cfg = await store.load();
					const queue = await loadCandidates();
					const written = [];
					const decided = [];
					const kept = [];
					for (const c of queue) {
						if (ids.has(c.id)) {
							const r = await writeSkillDual(cfg.agentSkillDir, cfg.mirrorDir, c);
							if (r.written && r.written.length) {
								written.push(c.name);
								decided.push(c);
							} else kept.push(c);
						} else kept.push(c);
					}
					// N-06：写盘全在锁外；进锁后重新 load 最新队列，只删本轮真正裁决掉的 id
					const dropIds = new Set(decided.map((c) => c.id));
					await withFileLock(candidateFile(), async () => {
						const latest = await loadCandidates();
						await saveCandidates(latest.filter((c) => !dropIds.has(c.id)));
					});
					// M-6：接受的候选留档（接受率可复盘），主表照旧只留未决项
					await archiveCandidates(decided, { decision: "accepted" });
					return { ok: true, message: "已写入 " + written.length + " 个：" + (written.join(", ") || "无") + "；未写入 " + (kept.filter((c) => ids.has(c.id)).length) + " 个（可能已存在同名）", written };
				} catch (error) {
					return { ok: false, message: String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_extract_reject",
			description: "拒绝候选：把给定 id 的候选从待确认队列移除，不写入正式库。参数 ids：候选 id 数组。",
			parameters: {
				ids: { type: "array", items: { type: "string" }, description: "要拒绝的候选 id 数组" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						removed: { type: "number" }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute(args) {
				try {
					const ids = new Set(Array.isArray(args && args.ids) ? args.ids : []);
					if (ids.size === 0) return { ok: false, message: "请提供要拒绝的候选 id（ids）" };
					const queue = await loadCandidates();
					const rejected = queue.filter((c) => ids.has(c.id));
					const kept = queue.filter((c) => !ids.has(c.id));
					// N-06：进锁后重新 load 最新队列，只删本轮点名的 id
					await withFileLock(candidateFile(), async () => {
						const latest = await loadCandidates();
						await saveCandidates(latest.filter((c) => !ids.has(c.id)));
					});
					// M-6：拒绝的候选也留档，拒绝率同样可复盘
					await archiveCandidates(rejected, { decision: "rejected" });
					return { ok: true, message: "已移除 " + (queue.length - kept.length) + " 个候选", removed: queue.length - kept.length };
				} catch (error) {
					return { ok: false, message: String(ErrorMsg(error)) };
				}
			}
		}),
		defineTool({
			name: "skillmgr_quality",
			description: "只读的质量度量：聚合 provenance 裁决漏斗（SAVE/FOLD/DROP，全量 + 最近 30 天；有事件流水时按事件计数）、SAVE 队列的使用/活跃/归档比例（比例都带分母）、候选积压条数与最老等待时长、归档里的历史接受/拒绝计数（滚动上限 500 条）。使用侧数据来自会话日志里的真实加载事件（N-03），平均使用次数的单位是「加载过该 skill 的会话数」。字段缺失或 join 不上的指标报不可得并给原因；不写任何文件。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						message: { type: "string", required: true },
						summary: { type: "string" },
						funnel: { type: "object", additionalProperties: true },
						cohort: { type: "object", additionalProperties: true },
						backlog: { type: "object", additionalProperties: true },
						history: { type: "object", additionalProperties: true },
						unavailable: { type: "array", items: { type: "object", additionalProperties: true } },
						sources: { type: "object", additionalProperties: true }
					}
				},
				render: (_args, value) => text(String(value.message ?? ""))
			},
			async execute() {
				try {
					const cfg = await store.load();
					const data = await collectQualityMetrics({
						skillRoots: [cfg.agentSkillDir, cfg.mirrorDir].filter((d) => typeof d === "string" && d !== "")
					});
					return { ok: true, message: data.summary, ...data };
				} catch (error) {
					return {
						ok: false,
						message: "质量度量失败：" + String(ErrorMsg(error)),
						summary: "",
						funnel: {},
						cohort: {},
						backlog: {},
						unavailable: [],
						sources: {}
					};
				}
			}
		})
	];
}

/** Build the /api/dsh-studio/extract-* routes. */
function buildExtractorRoutes(ctx, store) {
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
			path: API.extractStatus,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const view = await store.view();
				const queue = await loadCandidates();
				writeJson(res, 200, {
					...view,
					queued: queue.filter((c) => c.status === "pending").length,
					availableModels: listAvailableModels(ctx),
					resolvedModel: runtimeState.lastRoute ? runtimeState.lastRoute.provider + " / " + runtimeState.lastRoute.model : ""
				});
			})
		},
		{
			kind: "exact",
			path: API.extractConfig,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, await store.view());
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					if (body === void 0) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					if (body.reset === true) await store.patch(extractorDefaults());
					else await store.patch(body);
					writeJson(res, 200, await store.view());
					return;
				}
				writeJson(res, 405, { error: "method not allowed: " + method });
			})
		},
		{
			kind: "exact",
			path: API.extractRun,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const cfg = await store.load();
					const result = await runExtract(cfg);
					if (result.site) await store.patch(result.site);
					// WO-BORROW-1：落库与合并算「写入过」，巡检按这个时间戳算 age（N-03 起不再当作「被调用过」）
					for (const a of result.accepted ?? []) await markSkillUsed(a.name);
					for (const m of result.merged ?? []) await markSkillUsed(m.into);
					writeJson(res, 200, result);
				} catch (error) {
					const message = String(ErrorMsg(error));
					writeJson(res, 200, { ok: false, message: error && error.code === "EXTRACT_BUSY" ? message : "提取失败：" + message });
				}
			})
		},
		{
			kind: "exact",
			path: API.lifecycle,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				const cfg = await store.load();
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, {
						ok: true,
						state: await loadLifecycleState(),
					lock: await loadSkillLock(),
						archived: await listArchived(),
						preview: await scanLifecycle(cfg, { apply: false }),
						staleAfterDays: cfg.staleAfterDays,
						archiveAfterDays: cfg.archiveAfterDays
					});
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const report = await scanLifecycle(cfg, { apply: true });
					writeJson(res, 200, { ok: true, ...report });
					return;
				}
				writeJson(res, 405, { error: "method not allowed: " + method });
			})
		},
		{
			kind: "exact",
			path: API.extractCandidates,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const queue = await loadCandidates();
				writeJson(res, 200, { ok: true, candidates: queue.filter((c) => c.status === "pending") });
			})
		},
		{
			kind: "exact",
			path: API.extractCandidate,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.id !== "string") {
					writeJson(res, 400, { error: "invalid JSON body (id required)" });
					return;
				}
				const updated = await updateCandidate(body.id, body);
				if (updated === null) {
					writeJson(res, 404, { error: "找不到这条候选。" });
					return;
				}
				writeJson(res, 200, { ok: true, candidate: updated });
			})
		},
		{
			kind: "exact",
			path: API.extractAccept,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const ids = new Set(body && Array.isArray(body.ids) ? body.ids : []);
				if (ids.size === 0) {
					writeJson(res, 200, { ok: false, message: "请提供要接受的候选 id（ids）" });
					return;
				}
				const cfg = await store.load();
				const queue = await loadCandidates();
				const written = [];
				const decided = [];
				const kept = [];
				for (const c of queue) {
					if (ids.has(c.id)) {
						const r = await writeSkillDual(cfg.agentSkillDir, cfg.mirrorDir, c);
						if (r.written && r.written.length) {
							written.push(c.name);
							decided.push(c);
						} else kept.push(c);
					} else kept.push(c);
				}
				// N-06：与工具入口同一口径 —— 写盘在锁外，锁内重新 load 后只删已裁决的 id
				const dropIds = new Set(decided.map((c) => c.id));
				await withFileLock(candidateFile(), async () => {
					const latest = await loadCandidates();
					await saveCandidates(latest.filter((c) => !dropIds.has(c.id)));
				});
				await archiveCandidates(decided, { decision: "accepted" });
				writeJson(res, 200, { ok: true, written });
			})
		},
		{
			kind: "exact",
			path: API.extractReject,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const ids = new Set(body && Array.isArray(body.ids) ? body.ids : []);
				if (ids.size === 0) {
					writeJson(res, 200, { ok: false, message: "请提供要拒绝的候选 id（ids）" });
					return;
				}
				const queue = await loadCandidates();
				const rejected = queue.filter((c) => ids.has(c.id));
				const kept = queue.filter((c) => !ids.has(c.id));
				await withFileLock(candidateFile(), async () => {
					const latest = await loadCandidates();
					await saveCandidates(latest.filter((c) => !ids.has(c.id)));
				});
				await archiveCandidates(rejected, { decision: "rejected" });
				writeJson(res, 200, { ok: true, removed: queue.length - kept.length });
			})
		},
		{
			kind: "exact",
			path: API.extractRecent,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const view = await store.view();
				const skills = await recentSkills(view.agentSkillDir, 20);
				writeJson(res, 200, { skills });
			})
		}
	];
}

export { buildExtractorRoutes, buildExtractorTools };
