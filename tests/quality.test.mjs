// Q-3 测试：伪 HOME fixture 断言聚合逐项吻合（含「字段缺失 → 指标报不可得」用例），并验证工具只读。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-quality-"));
// 时间基准取运行时刻：extractor 的窗口判断用的是真实 Date.now()，写死时间戳会让
// fixture 造的「3 天前」会话随日历推进滑出 windowDays=7，测试自己把自己跑红。
const NOW = Date.now();

let fails = 0;
const ok = (cond, msg) => {
	if (cond) console.log("  ok   " + msg);
	else {
		console.log("  FAIL " + msg);
		fails += 1;
	}
};

// 公开导出不含开发历史：基线对拍依赖历史提交 d99332c，缺失时整体跳过
try {
	execFileSync("git", ["cat-file", "-e", "d99332c^{commit}"], { cwd: path.join(here, ".."), stdio: "pipe" });
} catch {
	console.log("SKIP quality: 公开导出不含开发历史（基线提交 d99332c 不在），跳过基线对拍");
	process.exit(0);
}

const run = spawnSync(process.execPath, [path.join(here, "fixtures", "quality-home.mjs"), home, String(NOW)], {
	env: { ...process.env, USERPROFILE: home, HOME: home, DSH_AGENTS_HOME: "", DSH_SKILL_EXTRACTOR_CANDIDATES: "" },
	encoding: "utf8"
});
if (run.status !== 0) {
	console.error(run.stderr || run.stdout);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const { full, partial, before1, after1, before2, after2 } = JSON.parse(run.stdout);

// ---- 1. 漏斗：全量按名字最新裁决计数 ----
ok(full.funnel.available === true, "provenance 存在时漏斗可用");
ok(full.funnel.all.save === 2 && full.funnel.all.fold === 1 && full.funnel.all.drop === 1, `全量 SAVE/FOLD/DROP = 2/1/1（实际 ${full.funnel.all.save}/${full.funnel.all.fold}/${full.funnel.all.drop}）`);
ok(full.funnel.all.total === 4 && full.funnel.all.other === 0, "全量文件 4 条，无未识别 action");

// ---- 2. 窗口：最近 30 天（beta 在 40 天前，被排除） ----
ok(full.funnel.window.days === 30, "窗口口径 = 最近 30 天");
ok(full.funnel.window.total === 3 && full.funnel.window.save === 1 && full.funnel.window.fold === 1 && full.funnel.window.drop === 1, `窗口内 3 条：SAVE 1 / FOLD 1 / DROP 1（实际 ${full.funnel.window.total}/${full.funnel.window.save}/${full.funnel.window.fold}/${full.funnel.window.drop}）`);

// ---- 3. cohort：SAVE 队列 ----
ok(full.cohort.n === 2, "cohort = 2（alpha、beta 两个 SAVE）");
ok(full.cohort.used.count === 1 && full.cohort.used.denominator === 2 && full.cohort.used.ratio === 0.5, `used 1/2 = 0.5（beta 缺 lastUsedAt 不计入，实际 ${full.cohort.used.count}/${full.cohort.used.denominator}）`);
ok(full.cohort.used.available === true, "lifecycle 存在时 used 可用（个别记录缺字段不算不可得）");
ok(full.cohort.active.count === 1 && full.cohort.active.denominator === 2 && full.cohort.active.ratio === 0.5, `active 1/2 = 0.5（只有 alpha 仍在 skill 根）`);
ok(full.cohort.archived.count === 1 && full.cohort.archived.denominator === 2 && full.cohort.archived.ratio === 0.5, `archived 1/2 = 0.5（beta 命中归档目录）`);

// ---- 4. 字段缺失 → 首次使用距入库不可得 ----
ok(full.cohort.medianDaysToFirstUse.available === false && full.cohort.medianDaysToFirstUse.value === null, "缺 firstUsedAt → 首次使用距入库中位数不可得");
ok(/firstUsedAt/.test(full.cohort.medianDaysToFirstUse.reason), "不可得带原因: " + full.cohort.medianDaysToFirstUse.reason);
ok(full.unavailable.some((u) => u.metric === "首次使用距入库中位数"), "不可得项进入 unavailable 清单");

// ---- 5. 候选积压：pending 3 条（accepted 被过滤），最老 2 天 ----
ok(full.backlog.available === true && full.backlog.pending === 3, `pending 3 条（1 条 accepted 被过滤，实际 ${full.backlog.pending}）`);
ok(full.backlog.oldestWaitDays === 2, `最老一条等待 2 天（缺 created 的条目不参与，实际 ${full.backlog.oldestWaitDays}）`);

// ---- 6. 摘要 ----
ok(typeof full.summary === "string" && full.summary.includes("漏斗") && full.summary.includes("cohort") && full.summary.includes("积压"), "一行摘要含漏斗 / cohort / 积压: " + full.summary);

// ---- 7. 文件整体缺失 → 指标报不可得 ----
ok(partial.funnel.available === false && /provenance/.test(partial.funnel.reason), "provenance 目录缺失 → 漏斗不可得");
ok(partial.cohort.n === 0, "provenance 缺失 → cohort 为 0");
ok(partial.cohort.used.available === false && /skill-lifecycle\.json/.test(partial.cohort.used.reason), "lifecycle 文件缺失 → used 不可得: " + partial.cohort.used.reason);
ok(partial.cohort.used.ratio === null, "不可得的比例是 null 而不是 0");
ok(partial.backlog.pending === 3, "candidates 仍在 → 积压照常可算");

// ---- 8. 只读：收集前后文件内容哈希完全一致 ----
ok(JSON.stringify(before1) === JSON.stringify(after1), "第一次聚合未改动伪 HOME 中任何文件");
ok(JSON.stringify(before2) === JSON.stringify(after2), "第二次聚合未改动伪 HOME 中任何文件");

// ---- 9. M-5：同一 skill 连续 SAVE→FOLD，按名文件留最终裁决、事件流水可按事件计数 ----
const historyHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-quality-history-"));
const historyRun = spawnSync(process.execPath, [path.join(here, "fixtures", "quality-history-home.mjs"), historyHome, String(NOW)], {
	env: { ...process.env, USERPROFILE: historyHome, HOME: historyHome, DSH_AGENTS_HOME: "", DSH_SKILL_EXTRACTOR_CANDIDATES: "" },
	encoding: "utf8"
});
if (historyRun.status !== 0) {
	console.error(historyRun.stderr || historyRun.stdout);
	rmSync(historyHome, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const history = JSON.parse(historyRun.stdout);
ok(history.byName.action === "FOLD_INTO" && history.byName.into === "host-skill", "按名文件保留最终裁决（FOLD_INTO → host-skill）");
ok(history.byName.rationale === "第二次裁决：FOLD", "按名文件保留最终那次裁决的理由");
ok(history.mergeMeEvents === 2, "同一 skill 的两次裁决都进了事件流水（实际 " + history.mergeMeEvents + " 条）");
ok(
	history.events.every((e) => ["at", "name", "action", "rationale"].every((key) => key in e)),
	"事件流水字段齐全：at/name/action/rationale"
);
ok(history.withEvents.funnel.source === "events", "有事件流水时漏斗按事件计数");
ok(
	history.withEvents.funnel.all.total === 3 && history.withEvents.funnel.all.save === 2 && history.withEvents.funnel.all.fold === 1,
	`按事件计 3 条：SAVE 2 / FOLD 1（实际 ${history.withEvents.funnel.all.total}/${history.withEvents.funnel.all.save}/${history.withEvents.funnel.all.fold}）`
);
ok(/按事件计数/.test(history.withEvents.funnel.all.note), "口径注脚写明按事件计数: " + history.withEvents.funnel.all.note);
ok(
	history.withoutEvents.funnel.source === "by-name" && history.withoutEvents.funnel.all.total === 2,
	`无流水时回退按名最新裁决（2 条文件，实际 ${history.withoutEvents.funnel.all.total}）`
);
ok(/按名字最新裁决/.test(history.withoutEvents.funnel.all.note), "回退口径的注脚保持原口径");

// ---- 10. M-6：接受/拒绝不再直接删，终局进归档；quality 报历史接受/拒绝 ----
ok(history.queueAfter.length === 0, `接受+拒绝后候选主表干净（实际 ${history.queueAfter.length} 条）`);
ok(history.acceptResult?.ok === true && history.rejectResult?.ok === true, "接受与拒绝各走通一次（工具层）");
ok(history.archive.length === 2, `归档 2 条（实际 ${history.archive.length}）`);
const acceptedEntry = history.archive.find((e) => e.name === "accepted-cand");
const rejectedEntry = history.archive.find((e) => e.name === "rejected-cand");
ok(acceptedEntry?.decision === "accepted" && rejectedEntry?.decision === "rejected", "归档记录裁决结果 accepted / rejected");
ok(
	[acceptedEntry, rejectedEntry].every((e) => typeof e?.decidedAt === "string" && e.decidedAt !== "" && typeof e?.id === "string"),
	"归档记录带 decidedAt 与原始 id"
);
ok(history.withEvents.history.available === true && history.withEvents.history.accepted === 1 && history.withEvents.history.rejected === 1, `quality 报出历史接受/拒绝 1/1（实际 ${history.withEvents.history.accepted}/${history.withEvents.history.rejected}）`);
ok(/历史 接受\/拒绝 1\/1/.test(history.withEvents.summary), "一行摘要含历史接受/拒绝: " + history.withEvents.summary);
ok(history.withEvents.history.cap === 500 && /归档上限 500 条/.test(history.withEvents.summary), "摘要注明归档上限 500 条");
ok(history.capResult.dropped === 2 && history.capResult.total === 500, `超过上限丢弃最旧 2 条（dropped=${history.capResult.dropped}, total=${history.capResult.total}）`);
ok(history.archiveAfterCap.length === 500 && history.archiveAfterCap.first === "fill-0", "归档只留最近 500 条，最旧的是新批次第一条");

// ---- 11. M-7 / N-03：firstUsedAt 只写一次、写路径不再冒充「被调用过」；使用计数只认加载会话 ----
const DAY_MS = 86_400_000;
ok(history.lifecycle.writeCount === 3, `同一 skill 标 3 次写入 → writeCount=3（实际 ${history.lifecycle.writeCount}）`);
ok(history.lifecycle.useCount === undefined, `写路径不再给 useCount 计数（实际 ${history.lifecycle.useCount}）`);
ok(
	history.lifecycle.firstUsedAt === history.lifecycleAfterFirst.firstUsedAt && history.lifecycle.firstUsedAt === NOW - 5 * DAY_MS,
	"firstUsedAt 停在第一次使用，不被后两次覆盖"
);
ok(history.lifecycle.lastUsedAt === NOW - DAY_MS, "lastUsedAt 语义不变：跟着最后一次使用走");
ok(history.lifecycleAfterFirst.writeCount === 1, "第一次写完 writeCount 就是 1");
ok(history.lifecycleModel === "load-sessions", `状态文件打上使用口径标记（实际 ${history.lifecycleModel}）`);
ok(history.legacy?.lastUsedAt === NOW - 20 * DAY_MS && history.legacy.firstUsedAt === undefined, "老格式 lifecycle 条目读入不报错、字段不被改写");
ok(
	history.withEvents.cohort.medianDaysToFirstUse.available === true && history.withEvents.cohort.medianDaysToFirstUse.value === 3,
	`首次使用距入库中位数可算 = 3 天（实际 ${history.withEvents.cohort.medianDaysToFirstUse.value}）`
);
ok(
	history.withEvents.cohort.avgUseCount.available === false && /loadSessions/.test(history.withEvents.cohort.avgUseCount.reason),
	"只有写路径、没有加载会话 → 平均使用次数报不可得（不拿旧计数冒充新口径）: " + history.withEvents.cohort.avgUseCount.reason
);
ok(/首次使用距入库 3 天/.test(history.withEvents.summary) && /均加载 不可得/.test(history.withEvents.summary), "一行摘要带中位数与平均使用次数（新口径）");
ok(
	full.cohort.avgUseCount.available === false && /loadSessions/.test(full.cohort.avgUseCount.reason),
	"老数据没有加载会话记录 → 平均使用次数报不可得: " + full.cohort.avgUseCount.reason
);
ok(full.unavailable.some((u) => u.metric === "平均使用次数"), "不可得的平均使用次数进入 unavailable 清单");

// ---- 12. F-2：注册层 output schema 与 handler 返回体必须一致（宿主口径，不是 lib 层口径） ----
const qs = history.qualitySchema;
ok(qs.violations.length === 0, `skillmgr_quality 返回体通过宿主 output schema 校验（校验器 ${qs.checker}；违规 ${qs.violations.length} 条：${qs.violations.join("; ") || "无"}）`);
ok(qs.schemaKeys.includes("history"), "注册 schema 声明了 history 键");
ok(qs.valueKeys.includes("history"), "handler 实际返回 history 键（修 schema，不删字段）");
ok(
	qs.valueKeys.every((key) => qs.schemaKeys.includes(key)),
	`返回体每个顶层键都被声明（返回 ${qs.valueKeys.length} 个 / 声明 ${qs.schemaKeys.length} 个；未声明：${qs.valueKeys.filter((k) => !qs.schemaKeys.includes(k)).join(", ") || "无"}）`
);
ok(qs.history?.accepted === 1 && qs.history?.rejected === 1, `经注册层调用拿到的 history 仍是真实数据 1/1（实际 ${qs.history?.accepted}/${qs.history?.rejected}）`);
ok(history.toolShape.length === 48, `注册表里共 ${history.toolShape.length} 个工具（期望 48：新增 skillmgr_darwin_submit；新增 skillmgr_studio_backup / restore；新增 skillmgr_optimize_*；新增 mcp_catalog_eval；新增 skillmgr_governance_status / run / decide；新增 skillmgr_distill_status / run / decide）`);
ok(history.toolShape.every((t) => t.hasSchema), `全部工具都声明了 output schema（缺声明的：${history.toolShape.filter((t) => !t.hasSchema).map((t) => t.name).join(", ") || "无"}）`);
const bad = history.liveChecks.filter((c) => c.error !== undefined || c.violations.length > 0);
ok(
	bad.length === 0,
	`只读工具实跑并通过注册层 schema 校验（${history.liveChecks.length} 个：${history.liveChecks.map((c) => c.name.replace("skillmgr_", "")).join(", ")}；异常：${bad.map((c) => c.name + "→" + (c.error ?? c.violations.join("; "))).join(" | ") || "无"}）`
);

// ---- 13. F-3：restore 的 preSnapshot 允许 null（同样是宿主口径，走注册 schema + 返回体样本） ----
const { validateJsonSchemaValue, assertSupportedJsonSchema } = await import("@deepseek-ai/dsh-tools");
const restoreSchema = history.restoreSchema;
try {
	assertSupportedJsonSchema(restoreSchema);
	ok(true, "restore 注册 schema 通过宿主 assertSupportedJsonSchema（oneOf 在宿主支持的写法子集内）");
} catch (error) {
	ok(false, "restore 注册 schema 未通过宿主 assertSupportedJsonSchema: " + String(error?.message ?? error));
}
const pref = restoreSchema.properties.preSnapshot ?? {};
ok(pref.type === undefined && Array.isArray(pref.oneOf) && pref.oneOf.length === 2, `preSnapshot 声明成 oneOf 两分支（实际 ${JSON.stringify(pref)}）`);
// 样本只覆盖 F-3 相关键；pendingPulls 由本段末尾单独验（F-4 已补声明）
const restoreBodyNull = { ok: true, id: "snap-fixture", dryRun: false, total: 2, create: 2, overwrite: 0, same: 0, written: 2, preSnapshot: null, remapped: 0, rejected: 0, failed: [], plan: [], rejectedPaths: [] };
const legacySchema = structuredClone(restoreSchema);
legacySchema.properties.preSnapshot = { type: "string" }; // F-3 修复前的原声明
const beforeFix = validateJsonSchemaValue(legacySchema, restoreBodyNull, "value");
ok(beforeFix.some((v) => /preSnapshot/.test(v)), `修复前形态把 null 打回：${beforeFix.join("; ")}`);
const afterFix = validateJsonSchemaValue(restoreSchema, restoreBodyNull, "value");
ok(afterFix.length === 0, `修复后形态接受 null：${afterFix.join("; ") || "0 违规"}`);
const afterFixString = validateJsonSchemaValue(restoreSchema, { ...restoreBodyNull, preSnapshot: "snap-pre-restore" }, "value");
ok(afterFixString.length === 0, `string 分支仍然通过：${afterFixString.join("; ") || "0 违规"}`);
// F-4：restore 的 summary 恒带 pendingPulls，schema 必须声明它（未声明时 additionalProperties:false 整包打回）
const pendingPullsViolations = validateJsonSchemaValue(restoreSchema, { ...restoreBodyNull, pendingPulls: [] }, "value");
ok(pendingPullsViolations.length === 0, `pendingPulls 已声明，空数组 0 违规：${pendingPullsViolations.join("; ") || "0 违规"}`);
const pendingPullsFilled = validateJsonSchemaValue(
	restoreSchema,
	{
		...restoreBodyNull,
		pendingPulls: [{ name: "big-skill", repo: "https://example.invalid/org/repo", ref: "main", sha: "a".repeat(40), subdir: "" }]
	},
	"value"
);
ok(pendingPullsFilled.length === 0, `pendingPulls 带真实条目也 0 违规：${pendingPullsFilled.join("; ") || "0 违规"}`);
// N-04：恢复侧新增 skipped（计数）/ skippedPaths（清单），必须同时声明进注册 schema（F-4 的教训）
const skippedDeclared = restoreSchema.properties.skipped?.type === "number" && restoreSchema.properties.skippedPaths?.items?.type === "string";
ok(skippedDeclared, `restore 注册 schema 声明了 skipped / skippedPaths（实际 ${JSON.stringify({ skipped: restoreSchema.properties.skipped, skippedPaths: restoreSchema.properties.skippedPaths })})`);
const skippedViolations = validateJsonSchemaValue(
	restoreSchema,
	{ ...restoreBodyNull, skipped: 3, skippedPaths: ["dsh-studio/sync.json", "dsh-studio/snapshots/evil.txt"] },
	"value"
);
ok(skippedViolations.length === 0, `带跳过清单的返回体 0 违规：${skippedViolations.join("; ") || "0 违规"}`);

// ---- 14. F-4：全部 29 个工具的注册层 schema 常驻校验（一个不漏；豁免项必须列名并写理由） ----
const allHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-all-tools-"));
const allRun = spawnSync(process.execPath, [path.join(here, "fixtures", "all-tools-home.mjs")], {
	env: {
		...process.env,
		USERPROFILE: allHome,
		HOME: allHome,
		DSH_HOME: path.join(allHome, ".dsh"),
		DSH_AGENTS_HOME: "",
		DSH_SKILL_EXTRACTOR_CANDIDATES: ""
	},
	encoding: "utf8",
	timeout: 180000
});
if (allRun.status !== 0) {
	console.error(allRun.stderr || allRun.stdout);
	rmSync(allHome, { recursive: true, force: true });
	rmSync(historyHome, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const all = JSON.parse(allRun.stdout);
const ALL_TOOL_COUNT = 48; // ：47 → 48（skillmgr_darwin_submit）；：45 → 47（skillmgr_studio_backup / skillmgr_studio_restore）；：33 → 35（mcp_unregister / mcp_verify）；：35 → 38（skillmgr_optimize_status / run / decide）；：38 → 39（mcp_catalog_eval）；：39 → 42（skillmgr_governance_status / run / decide）；：42 → 45（skillmgr_distill_status / run / decide）
ok(all.count === ALL_TOOL_COUNT, `注册表里共 ${all.count} 个工具（期望 ${ALL_TOOL_COUNT}）`);
ok(all.profileImported === true, "profile 里的原生 MCP 已导入注册表（mcp_takeover 的调用前提）");
const schemaBad = all.schemaChecks.filter((c) => !c.ok);
ok(
	all.schemaChecks.length === ALL_TOOL_COUNT && schemaBad.length === 0,
	`${ALL_TOOL_COUNT} 个 output schema 全过宿主 assertSupportedJsonSchema（失败：${schemaBad.map((c) => c.name + "→" + c.reason).join(" | ") || "无"}）`
);
const liveAll = all.checks.filter((c) => c.mode === "live");
const exemptAll = all.checks.filter((c) => c.mode === "exempt");
const missingAll = all.checks.filter((c) => c.mode !== "live" && c.mode !== "exempt");
const badAll = liveAll.filter((c) => c.error !== undefined || c.violationCount > 0);
ok(missingAll.length === 0, `每个工具都有结论，没有静默跳过（漏：${missingAll.map((c) => c.name).join(", ") || "无"}）`);
ok(
	badAll.length === 0,
	`全部工具经注册层真实调用 0 违规（实跑 ${liveAll.length} 次，覆盖 ${new Set(liveAll.map((c) => c.name)).size} 个工具；异常：${
		badAll.map((c) => c.name + "→" + (c.error ?? c.violations.join("; "))).join(" | ") || "无"
	}）`
);
ok(
	exemptAll.every((c) => typeof c.reason === "string" && c.reason !== ""),
	`豁免项单列且写明理由（豁免：${exemptAll.map((c) => c.name + "→" + c.reason).join(" | ") || "无"}）`
);
const coveredAll = new Set(all.checks.map((c) => c.name));
ok(
	all.toolNames.every((name) => coveredAll.has(name)),
	`${ALL_TOOL_COUNT} 个工具逐个都有结论（未覆盖：${all.toolNames.filter((name) => !coveredAll.has(name)).join(", ") || "无"}）`
);
rmSync(allHome, { recursive: true, force: true });

// ---- 15. N-03：真实使用信号来自会话日志里的加载事件（合成 fixture，不读真机会话文件） ----
const usageHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-usage-"));
const usageRun = spawnSync(process.execPath, [path.join(here, "fixtures", "usage-home.mjs"), usageHome, String(NOW)], {
	env: { ...process.env, USERPROFILE: usageHome, HOME: usageHome, DSH_AGENTS_HOME: "", DSH_SKILL_EXTRACTOR_CANDIDATES: "" },
	encoding: "utf8",
	timeout: 180000
});
if (usageRun.status !== 0) {
	console.error(usageRun.stderr || usageRun.stdout);
	rmSync(usageHome, { recursive: true, force: true });
	rmSync(historyHome, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const u = JSON.parse(usageRun.stdout);
const s1 = u.phase1.state;
const s3 = u.phase3.state;
const sig = u.phase1.usageSignals;

// 15.1 核心场景：200 天没动过的技能，被近期会话真实加载 → 保持 active
ok(u.legacyVerdicts.alpha === "archive", `旧公式下 alpha-skill 会判 archive（回退抽查；实际 ${u.legacyVerdicts.alpha}）`);
ok(sig?.ok === true && sig.sessions === 2 && sig.newSessions === 2, `第一次采集：2 个会话带加载事件、2 个新会话（实际 ${sig?.sessions}/${sig?.newSessions}）`);
ok(s1["alpha-skill"]?.useCount === 2, `alpha-skill 的加载会话数 = 2（实际 ${s1["alpha-skill"]?.useCount}）`);
ok(s1["alpha-skill"]?.lastUsedAt === u.tB, "lastUsedAt = 最近一次加载事件的时间（会话 B）");
ok(
	!u.scan.previewStale.includes("alpha-skill") && !u.scan.previewArchived.includes("alpha-skill"),
	`采集 + 巡检后 alpha-skill 保持 active（stale ${JSON.stringify(u.scan.previewStale)} / archive ${JSON.stringify(u.scan.previewArchived)}）`
);
ok(u.scan.skillsAfterApply.includes("alpha-skill"), "真跑巡检后 alpha-skill 目录还在原位（没被归档）");

// 15.2 回归对照：从没被加载、也没被写过的技能，分档与旧公式逐项一致
ok(u.scan.previewStale.length === 1 && u.scan.previewStale[0] === "beta-stale" && u.legacyVerdicts.stale === "stale", "beta-stale（100 天）与新公式/旧公式同判 stale");
ok(u.scan.previewArchived.includes("beta-archive") && u.legacyVerdicts.archive === "archive", "beta-archive（200 天）与新公式/旧公式同判 archive");
ok(s1["beta-stale"] === undefined && s1["beta-archive"] === undefined, "没有任何信号的两个技能不产生 lifecycle 记录（与旧行为一致）");
ok(s1["beta-stale"] === undefined, "窗口外（30 天前）会话里的加载信号不补计：beta-stale 仍无记录");

// 15.3 会话内去重：同一会话里 3 次加载只计 1 个会话
ok(u.rawLoads.alpha === 3 && u.rawLoads.order === 3, `原始加载事件各 3 条（alpha ${u.rawLoads.alpha} / order ${u.rawLoads.order}）`);
ok(s1["order-skill"]?.useCount === 1 && s1["order-skill"]?.loadSessions?.length === 1, `会话内只计一次：order-skill 3 次加载 → 1（实际 ${s1["order-skill"]?.useCount}）`);

// 15.4 跨会话累计：两个会话各一次 → 2，lastUsedAt 取较晚
ok(s1["alpha-skill"]?.loadSessions?.length === 2 && s1["alpha-skill"]?.lastUsedAt === Math.max(u.tA, u.tB), "两个会话各加载一次 → 计数 2 且 lastUsedAt 取较晚那个");

// 15.5 乱序与损坏：文件内事件乱序取最大时间；坏行/未知类型行只是跳过
ok(s1["order-skill"]?.lastUsedAt === u.tA + 2000, `乱序事件取最大时间戳（期望 ${u.tA + 2000}，实际 ${s1["order-skill"]?.lastUsedAt}）`);
ok(u.rawFiles.length === 3, `只解析窗口内的 3 个可读会话（坏 .zstd / 目录冒充 / 窗口外都不进；实际 ${JSON.stringify(u.rawFiles)}）`);

// 15.6 增量幂等：同一批日志第二遍状态逐字段不变；新增会话只计新会话
ok(u.phase2.usageSignals.newSessions === 0 && u.phase2.usageSignals.applied === 0, `第二遍没有新会话、没有改动（实际 ${u.phase2.usageSignals.newSessions}/${u.phase2.usageSignals.applied}）`);
ok(u.phase2.sameState === true, "第二遍跑完 skill-lifecycle.json 逐字节不变（幂等）");
ok(
	u.phase25.usageSignals.newSessions === 2 && u.phase25.usageSignals.applied === 0 && u.phase25.sameState === true,
	`删掉水位线后重放：会话被重新看到（${u.phase25.usageSignals.newSessions} 个）但没有一条重复计数，状态逐字节不变`
);
ok(u.phase3.usageSignals.newSessions === 1 && s3["alpha-skill"]?.useCount === 3, `新增一个会话 → 只计这一条，计数 2→3（实际 ${s3["alpha-skill"]?.useCount}）`);
ok(s3["alpha-skill"]?.lastUsedAt === u.tG, "新增会话的加载事件把 lastUsedAt 推进到它");

// 15.7 best-effort 隔离：水线写不进去、条目畸形、目录不存在，都不冒泡
ok(u.bestEffort.boIngest.ok === false && u.bestEffort.boIngest.error !== "", `水位线写失败被兜住（ok=false + 原因：${u.bestEffort.boIngest.error.slice(0, 40)}…）`);
ok(u.bestEffort.boIngest.applied === 1, "写水线失败之前，lifecycle 状态已经落地（重放靠 loadSessions 去重）");
ok(u.bestEffort.weirdIngest.ok === true && u.bestEffort.weirdIngest.applied === 0, "畸形 entries（null / 非字符串 file / 坏 name）全部跳过，不抛");
ok(u.bestEffort.boScan && Array.isArray(u.bestEffort.boScan.stale) && u.bestEffort.boScan.archived.length === 0, "lifecycle 巡检在采集失败的环境里照常返回报告");
ok(/没有可用的模型通道/.test(u.phase1.message) && u.phase1.ok === false, "提取主流程（无模型通道）照常早退，没被采集拖垮");

// 15.8 提及不算：消息正文里出现技能名不产生信号
ok(s1["mention-only"] === undefined, "只在消息正文被提到的 mention-only 没有产生任何记录");
ok(u.scan.previewArchived.includes("mention-only") && u.legacyVerdicts.mention === "archive", "提及没救活它：mention-only 仍按 200 天判 archive");

// 15.9 firstUsedAt：只写最早一次；首次信号即加载事件的技能等于该事件时间
ok(s1["alpha-skill"]?.firstUsedAt === u.t0, `已有 firstUsedAt 不被加载信号覆盖（期望 ${u.t0}，实际 ${s1["alpha-skill"]?.firstUsedAt}）`);
ok(s1["fresh-skill"]?.firstUsedAt === u.tB + 10 && s1["fresh-skill"]?.lastUsedAt === u.tB + 10, "首次信号就是加载事件时，firstUsedAt = 该事件时间");

// 15.10 存量过渡：旧 useCount（写路径计数）搬到 writeCount，useCount 只由加载会话数写
ok(s1["alpha-skill"]?.writeCount === 5, `旧 useCount=5 迁移到 writeCount=5（实际 ${s1["alpha-skill"]?.writeCount}）`);
ok(s1.__usageModel === "load-sessions", `状态文件打上使用口径标记（实际 ${s1.__usageModel}）`);

// 15.11 名字归一：日志里的「My Skill」与 markSkillUsed 记的 my-skill 命中同一条
ok(s1["my-skill"]?.useCount === 1 && s1["my-skill"]?.writeCount === 1, `归一形态的加载事件落到既有记录（useCount=${s1["my-skill"]?.useCount} / writeCount=${s1["my-skill"]?.writeCount}）`);
ok(s1["My Skill"] === undefined, "没有生出第二条记录（原样大小写不是独立键）");
ok(u.scan.skillsAfterApply.includes("my-skill"), "归一命中的技能被加载信号救活，200 天没动也没被归档");

// 15.12 quality 口径：平均使用次数按加载会话数
ok(u.quality.avgUseCount.available === true && u.quality.avgUseCount.value === 2 && u.quality.avgUseCount.samples === 2, `平均使用次数 = (3+1)/2 = 2（实际 ${u.quality.avgUseCount.value}，样本 ${u.quality.avgUseCount.samples}）`);
ok(/均加载 2 会话/.test(u.quality.summary), "一行摘要按加载会话口径出数: " + u.quality.summary.slice(0, 120));
ok(u.quality.used.ratio === 1, "加载信号同时更新 lastUsedAt → cohort used 比例按新信号算");

// 15.13 归档永不硬删：只搬进墓碑目录
const copies = u.scan.archiveCopies;
ok(copies.length === 2 && copies.every((c) => c.hasSkillFile), `归档目录里有完整副本（${JSON.stringify(copies.map((c) => c.name))}，SKILL.md 齐全）`);
ok(!u.scan.skillsAfterApply.includes("beta-archive") && !u.scan.skillsAfterApply.includes("mention-only"), "原位置的目录已搬走（不是复制残留在根里）");
rmSync(usageHome, { recursive: true, force: true });
rmSync(usageHome + "-bo", { recursive: true, force: true });

// ---- 16. N-04：恢复侧白名单镜像（S-05 残留）----
const guardHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-guard-"));
const guardRun = spawnSync(process.execPath, [path.join(here, "fixtures", "snapshot-guard-home.mjs")], {
	env: {
		...process.env,
		USERPROFILE: guardHome,
		HOME: guardHome,
		DSH_HOME: path.join(guardHome, ".dsh"),
		DSH_AGENTS_HOME: "",
		DSH_SKILL_EXTRACTOR_CANDIDATES: ""
	},
	encoding: "utf8",
	timeout: 180000
});
if (guardRun.status !== 0) {
	console.error(guardRun.stderr || guardRun.stdout);
	rmSync(guardHome, { recursive: true, force: true });
	rmSync(historyHome, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const g = JSON.parse(guardRun.stdout);

// 16.1 恶意包·凭据覆盖：同一份手搓包，基线版写穿、当前版原样不动
ok(
	/POISONED-BY-PACKAGE/.test(g.baseline.syncText),
	`基线版（d99332c）把手搓包里的 dsh-studio/sync.json 覆盖到本机凭据（红）：${g.baseline.syncSha.slice(0, 12)}…`
);
ok(
	g.baseline.hasSkippedField === false && g.baseline.wroteEvil === true && g.baseline.wroteSyncWork === true,
	"基线版没有白名单镜像：snapshots/evil.txt 与 sync-work/x.txt 都照写（红）"
);
ok(g.current.syncUnchanged === true, `当前版：本机 sync.json 逐字节不变（sha ${g.current.syncSha.slice(0, 12)}…）`);
const poisonPaths = ["dsh-studio/sync.json", "dsh-studio/snapshots/evil.txt", "dsh-studio/sync-work/x.txt"];
ok(
	g.current.skipped === 3 && poisonPaths.every((p) => g.current.skippedPaths.includes(p)),
	`三个毒路径全部被跳过并列明：${JSON.stringify(g.current.skippedPaths)}`
);
ok(g.current.wroteEvil === false && g.current.wroteSyncWork === false, "毒路径没有落盘（磁盘上不存在）");
ok(g.current.agentsWritten === "# 包里的 AGENTS.md\n", "同包的正常文件（AGENTS.md）照常恢复");
ok(g.current.rejected === 0, "白名单跳过不进 rejected 计数（语义不混）");

// 16.2 白名单外路径：profiles/<名>/evil.sh 与根级 random.txt 被跳过，profiles/<名>/package.json 照常恢复
ok(
	g.whitelist.skippedPaths.join(",") === "profiles/p1/evil.sh,random.txt",
	`白名单外路径逐条列明：${JSON.stringify(g.whitelist.skippedPaths)}`
);
ok(
	g.whitelist.evilExists === false && g.whitelist.randomExists === false && g.whitelist.escapeExists === false,
	"磁盘上不存在 profiles/p1/evil.sh、random.txt、../escape.txt"
);
ok(g.whitelist.pkg === "p1-from-pack" && g.whitelist.written === 1, `同包的 profiles/p1/package.json 正常恢复（name=${g.whitelist.pkg}，写入 ${g.whitelist.written} 个）`);
ok(
	g.whitelist.rejectedPaths.length === 1 && g.whitelist.rejectedPaths[0] === "../escape.txt" && g.whitelist.rejected === 1 && g.whitelist.skipped === 2,
	`不安全路径仍归 rejected、白名单跳过归 skipped（rejected=${JSON.stringify(g.whitelist.rejectedPaths)}, skipped=${g.whitelist.skipped}）`
);
ok(g.whitelist.dryPlanRels.join(",") === "profiles/p1/package.json", `dryRun 的 plan 只留白名单内的条目：${g.whitelist.dryPlanRels.join(",")}`);

// 16.3 正规包 round-trip：收集清单与恢复结果逐项一致、跳过为空
ok(g.roundTrip.mismatch.length === 0, `round-trip 无差异（收集 ${g.roundTrip.collected.length} 项，差异 ${JSON.stringify(g.roundTrip.mismatch)}）`);
ok(g.roundTrip.written === g.roundTrip.collected.length && g.roundTrip.failed.length === 0, `恢复写入数 = 收集数（${g.roundTrip.written}/${g.roundTrip.collected.length}，失败 ${g.roundTrip.failed.length}）`);
ok(g.roundTrip.skipped === 0 && g.roundTrip.skippedPaths.length === 0, "正规包没有跳过项（白名单只扩不缩，历史包天然全在定义内）");
ok(
	["AGENTS.md", "cordis.patch.yml"].every((rel) => g.roundTrip.collected.includes(rel)) &&
		g.roundTrip.collected.some((rel) => rel.startsWith("skills/")) &&
		g.roundTrip.collected.some((rel) => rel.startsWith("dsh-studio/") && !rel.includes("snapshots")) &&
		g.roundTrip.collected.some((rel) => rel.startsWith("profiles/")) &&
		g.roundTrip.collected.some((rel) => rel.startsWith("agents-skills/")),
	`收集清单覆盖五类形态：${g.roundTrip.collected.join(", ")}`
);
ok(!g.roundTrip.collected.some((rel) => rel === "dsh-studio/sync.json"), "收集侧不打 sync.json（与恢复侧 skip 集同一份定义）");

// 16.4 dryRun：跳过清单齐全、磁盘零写入
ok(g.dry.dryRun === true && g.dry.skipped === 3 && g.dry.skippedPaths.length === 3, `dryRun 也给出跳过计数与清单（${g.dry.skipped} 条）`);
ok(g.dry.planLength === 1 && g.dry.planRels.join(",") === "AGENTS.md", `dryRun 的 plan 只剩合法条目：${g.dry.planRels.join(",")}`);
ok(g.dry.diskUnchanged === true, "dryRun 磁盘零写入（sync.json 逐字节未变）");
rmSync(guardHome, { recursive: true, force: true });

// ---- 17. N-06：共享 JSON 状态并发写保护（真实入口并发，基线版对拍）----
const raceHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-race-"));
const raceRun = spawnSync(process.execPath, [path.join(here, "fixtures", "state-race-home.mjs")], {
	env: {
		...process.env,
		USERPROFILE: raceHome,
		HOME: raceHome,
		DSH_HOME: path.join(raceHome, ".dsh"),
		DSH_AGENTS_HOME: "",
		DSH_SKILL_EXTRACTOR_CANDIDATES: ""
	},
	encoding: "utf8",
	timeout: 180000
});
if (raceRun.status !== 0) {
	console.error(raceRun.stderr || raceRun.stdout);
	rmSync(raceHome, { recursive: true, force: true });
	rmSync(historyHome, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const r = JSON.parse(raceRun.stdout);

// 17.1 lifecycle 并发不丢（8 路 markSkillUsed + 8 路 recordSkillLoads + 4 路同名 mark）
{
	const old = r.lifecycleRace.old;
	const now = r.lifecycleRace.new;
	ok(
		old.keyCount < old.expectedKeys,
		`基线版并发 20 路后只有 ${old.keyCount} 个键在位（期望 ${old.expectedKeys}）：${old.run.rejected} 路在临界区直接抛 .tmp 争用（${old.run.firstError.slice(0, 60)}…），文件存在=${old.file.exists}、可解析=${old.file.parsable}（红）`
	);
	ok(now.run.rejected === 0 && now.keyCount === now.expectedKeys, `当前版 20 路全部成功、${now.keyCount}/${now.expectedKeys} 个键在位（绿）`);
	ok(
		Object.values(now.writeCounts).length === 8 && Object.values(now.writeCounts).every((v) => v === 1),
		`每个 write-* 的 writeCount 精确为 1：${JSON.stringify(now.writeCounts)}`
	);
	ok(
		Object.values(now.loadCounts).every((v) => v === 1) &&
			now.loadSessions["load-0"]?.[0] === "s-0" &&
			now.loadSessions["load-7"]?.[0] === "s-7",
		`每个 load-* 的 useCount=1 且 loadSessions 逐项正确：${JSON.stringify(now.loadSessions)}`
	);
	ok(now.sameTargetWriteCount === 4, `同一技能被 4 路并发 markSkillUsed → writeCount=4（基线版会互相覆盖，实际 ${now.sameTargetWriteCount}）`);
}

// 17.2 skill-lock 并发不丢（8 路 importSkill + 1 路 pullPending 的 satisfied→relock）
{
	const old = r.lockRace.old;
	const now = r.lockRace.new;
	ok(old.lockCount < old.expected, `基线版并发写 lock 后只剩 ${old.lockCount} 条记录（期望 ${old.expected}；${old.run.rejected} 路抛错）（红）`);
	ok(now.lockCount === now.expected && now.run.rejected === 0, `当前版 ${now.lockCount}/${now.expected} 条记录全在、无异常（绿）`);
	ok(now.allFieldsOk === true, `每条记录五字段形态正确：${now.keys.join(",")}`);
	ok(now.relocked === true, "relock 形态（satisfied 补锁）在同一把锁里正常完成");
}

// 17.3 candidates 并发不丢（8 路 updateCandidate + 4 路 archiveCandidates）
{
	const old = r.candidatesRace.old;
	const now = r.candidatesRace.new;
	ok(
		old.rationaleUpdated === 1 && old.archiveLength === 1,
		`基线版：8 路并发编辑只有 ${old.rationaleUpdated} 条的改动生效，4 路归档只留下 ${old.archiveLength} 条（红）`
	);
	ok(now.rationaleUpdated === 8, `当前版 8 路编辑逐条生效（${now.rationaleUpdated}/8）`);
	ok(now.archiveLength === 4 && new Set(now.archiveNames).size === 4, `归档 4 条全在且无重复：${now.archiveNames.join(",")}`);
	ok(now.queueLength === 8 && now.run.rejected === 0, `候选主表 8 条无丢失、无异常（${now.queueLength}）`);
}

// 17.4 异常必释放（临界区内抛错 → 错误外抛、后续同文件周期 5 秒内完成）
{
	const e = r.exception;
	ok(e.threw === "boom-in-critical-section", `临界区内抛错照常向外抛（${e.threw}）`);
	ok(e.after === "ok" && e.elapsed < 5000, `同一文件的下一个周期在 ${e.elapsed} ms 内完成（deadline 5000 ms）`);
	ok(e.afterRecorded === true, "后续周期真的写进了状态（不是空跑）");
	ok(e.primitiveThrew === "boom-primitive" && e.primitiveAfter === "ok", "串行器原语层同样 finally 放行（同一 key 抛错后可用）");
}

// 17.5 顺序等价（同一组顺序操作，基线版与当前版四个状态文件逐字节一致）
{
	const same = r.sequential.same;
	ok(
		same.lifecycle && same.lock && same.candidates && same.archive,
		`顺序执行落盘逐字节一致：lifecycle=${same.lifecycle} lock=${same.lock} candidates=${same.candidates} archive=${same.archive}（lifecycle ${r.sequential.hashes.new.lifecycle.slice(0, 12)}…）`
	);
}

// 17.6 usage-signals 水位线并发（两路 ingest 各带一个独立会话）
{
	ok(r.watermark.old.keys.length === 1, `基线版两路并发 ingest 只剩 ${r.watermark.old.keys.length} 个会话水位（期望 2）（红）`);
	ok(
		r.watermark.new.keys.length === 2 && r.watermark.new.keys.join(",") === "wa,wb",
		`当前版两个会话水位都在：${r.watermark.new.keys.join(",")}`
	);
}

// 17.7 串行化自身开销（60 次顺序 markSkillUsed，粗测；阈值只防明显变慢）
ok(
	r.timing.new <= r.timing.old * 2 + 100,
	`顺序 60 次 markSkillUsed：基线版 ${r.timing.old} ms / 当前版 ${r.timing.new} ms（文件级排队没有串进不相干的等待）`
);
rmSync(raceHome, { recursive: true, force: true });

// ---- 18. N-07：digest 路径先排序截断、再解压（基线版对拍 + 真实 zstd 子进程计数）----
const digestHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-digest-"));
const digestRun = spawnSync(process.execPath, [path.join(here, "fixtures", "extractor-digest-home.mjs")], {
	env: {
		...process.env,
		USERPROFILE: digestHome,
		HOME: digestHome,
		DSH_HOME: path.join(digestHome, ".dsh"),
		DSH_AGENTS_HOME: "",
		DSH_SKILL_EXTRACTOR_CANDIDATES: ""
	},
	encoding: "utf8",
	timeout: 180000
});
if (digestRun.status !== 0) {
	console.error(digestRun.stderr || digestRun.stdout);
	rmSync(digestHome, { recursive: true, force: true });
	rmSync(historyHome, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const n7 = JSON.parse(digestRun.stdout);
const dq = (v) => JSON.stringify(v);
const firstDiff = (d) => (d ? `第 ${d.at} 字符起：旧=${d.a} 新=${d.b}` : "全等");

// 18.0 三件套：探针只在伪 HOME 里跑（fixture 自检通过才会走到这里）
ok(
	n7.env.USERPROFILE === digestHome && n7.env.HOME === digestHome && n7.env.DSH_HOME === path.join(digestHome, ".dsh"),
	`探针三件套指向伪 HOME：USERPROFILE=${n7.env.USERPROFILE} / HOME=${n7.env.HOME} / DSH_HOME=${n7.env.DSH_HOME}`
);
ok(typeof n7.env.zstdPath === "string" && n7.env.zstdPath !== "zstd", `计数对象是真 zstd：${n7.env.zstdPath}`);

// 18.1 maxSessions=12：新旧 digest 列表逐项深比对（file/mtime/size/log 全字段 + buildDigest 文本）
ok(n7.main.base12.n === 12 && n7.main.cur12.n === 12, `两条路径各取 12 条（旧 ${n7.main.base12.n} / 新 ${n7.main.cur12.n}）`);
ok(n7.main.same12 === null, `maxSessions=12 的 digest 条目逐项深比对全等（${firstDiff(n7.main.same12)}）`);
ok(n7.main.sameTexts12 === null, `buildDigest 文本逐条全等（${firstDiff(n7.main.sameTexts12)}）`);
ok(
	n7.main.cur12.files.every((f) => /[\\/]s(0\d|1[01])[\\/]session\.jsonl\.zstd$/.test(f)),
	`新路径取到的全是有效会话（最新 12 个 = s00~s11）：${n7.main.cur12.files.map((f) => path.basename(path.dirname(f))).join(",")}`
);

// 18.2 (1,1) 口径：shouldExtract 走的那条
ok(n7.main.base11.n === 1 && n7.main.cur11.n === 1, `(1,1) 两条路径各 1 条（旧 ${n7.main.base11.n} / 新 ${n7.main.cur11.n}）`);
ok(n7.main.same11 === null && n7.main.sameTexts11 === null, `(1,1) 的条目与文本同样全等（${firstDiff(n7.main.same11)}）`);

// 18.3 并列 mtime 的稳定序：并列组相对次序必须等于 findSessionFiles 枚举序
ok(n7.main.tieGroup.length === 3, `并列 mtime 组命中 3 个（实际 ${n7.main.tieGroup.length}）`);
ok(
	dq(n7.main.tieGroup) === dq(n7.main.tieGroupEnumOrder),
	`并列组保持枚举序（实测 ${n7.main.tieGroup.map((f) => path.basename(path.dirname(f))).join(" → ")}）`
);

// 18.4 补位：前 3 个空/坏不占名额，继续往后凑满 12
ok(n7.fill.baseCount === 12 && n7.fill.curCount === 12, `补位场景两条路径都取满 12 条（旧 ${n7.fill.baseCount} / 新 ${n7.fill.curCount}）`);
ok(n7.fill.same === null && n7.fill.sameTexts === null, `补位后的序列与旧逻辑全等（${firstDiff(n7.fill.same)}）`);
ok(
	n7.fill.curFiles[0].endsWith(path.join("f03", "session.jsonl.zstd")) && n7.fill.curFiles[11].endsWith(path.join("f14", "session.jsonl.zstd")),
	`补位命中第 4~15 个会话：${path.basename(path.dirname(n7.fill.curFiles[0]))} … ${path.basename(path.dirname(n7.fill.curFiles[11]))}`
);

// 18.5 解压计数（真实 zstd 子进程：拦截 execFile 且转发真调用，只数 argv = ["-d","-c","*.zstd"]）
ok(
	n7.main.counts12.baseline === 47 && n7.main.counts12.current === 12,
	`maxSessions=12 的 zstd 子进程次数：基线版 ${n7.main.counts12.baseline} 次 → 当前版 ${n7.main.counts12.current} 次（窗口内 47 个 .zstd 全部解压 vs 只解压取到的 12 个）`
);
ok(
	n7.main.counts11.baseline === 47 && n7.main.counts11.current === 1,
	`(1,1) 的 zstd 子进程次数：基线版 ${n7.main.counts11.baseline} 次 → 当前版 ${n7.main.counts11.current} 次`
);
ok(
	n7.fill.counts.baseline === 20 && n7.fill.counts.current === 15,
	`补位场景：基线版 ${n7.fill.counts.baseline} 次 → 当前版 ${n7.fill.counts.current} 次（跳过 3 个空/坏 + 取满 12）`
);

// 18.6 N-03 承重墙：collectSessionLogs 全量口径逐项不变（解压次数也不变）
ok(
	n7.logs.baseCount === n7.logs.curCount && n7.logs.baseCount === 46,
	`collectSessionLogs 返回条数不变（旧 ${n7.logs.baseCount} / 新 ${n7.logs.curCount}）`
);
ok(n7.logs.same === null, `collectSessionLogs 全部字段逐项深比对全等（${firstDiff(n7.logs.same)}）`);
ok(
	n7.logs.counts.baseline === 47 && n7.logs.counts.current === 47,
	`全量路径照旧解压全部窗口内 .zstd：基线版 ${n7.logs.counts.baseline} / 当前版 ${n7.logs.counts.current} 次`
);

// 18.7 shouldExtract（windowDays=1 / maxSessions=1）：返回形态与 worth 判定逐项不变
ok(
	n7.shouldExtract.remember.same === null && n7.shouldExtract.remember.cur.worth === true && n7.shouldExtract.remember.cur.remember === true,
	`remember 分支：返回体全等且 worth/remember 都是 true（解压 ${n7.shouldExtract.remember.counts.baseline} → ${n7.shouldExtract.remember.counts.current} 次）`
);
ok(
	n7.shouldExtract.no.same === null && n7.shouldExtract.no.cur.worth === false && n7.shouldExtract.no.base.worth === false,
	"llm 答 NO → 两版都是 worth=false"
);
ok(
	n7.shouldExtract.yes.same === null && n7.shouldExtract.yes.cur.worth === true && n7.shouldExtract.yes.base.worth === true,
	"llm 答 YES → 两版都是 worth=true"
);

// 18.8 边界：非正整数上限仍走旧的 filter→slice 语义（slice(0,0) 为空）
ok(n7.main.edge0.base === 0 && n7.main.edge0.cur === 0 && n7.main.edge0.same === null, "maxSessions=0 两版都返回空列表");
rmSync(digestHome, { recursive: true, force: true });

rmSync(historyHome, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
