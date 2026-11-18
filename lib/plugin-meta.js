/**
 * 插件的静态信息：cordis 名字、依赖的服务、路由前缀、系统提示里的公告文案。
 * （从 index.js 拆出，逻辑未改。）
 */

/** Stable cordis plugin name. */
const name = "skill-manager";
/** Services required before the skill manager surfaces can mount. */
const inject = ["skills", "tools", "systemPrompt", "webServer", "timer", "llm"];
/** Route family prefix. */
const API = {
	list: "/api/dsh-studio/list",
	skill: "/api/dsh-studio/skill",
	policy: "/api/dsh-studio/policy",
	extractStatus: "/api/dsh-studio/extract-status",
	extractConfig: "/api/dsh-studio/extract-config",
	extractRun: "/api/dsh-studio/extract-run",
	extractCandidates: "/api/dsh-studio/extract-candidates",
	extractCandidate: "/api/dsh-studio/extract-candidate",
	extractAccept: "/api/dsh-studio/extract-accept",
	extractReject: "/api/dsh-studio/extract-reject",
	extractRecent: "/api/dsh-studio/extract-recent",
	trash: "/api/dsh-studio/trash",
	restore: "/api/dsh-studio/restore",
	purge: "/api/dsh-studio/purge",
	snapshotList: "/api/dsh-studio/snapshot",
	snapshotRestore: "/api/dsh-studio/snapshot/restore",
	snapshotPrune: "/api/dsh-studio/snapshot/prune",
	snapshotTransfer: "/api/dsh-studio/snapshot/transfer",
	snapshotSchedule: "/api/dsh-studio/snapshot/schedule",
	snapshotDelete: "/api/dsh-studio/snapshot/delete",
	syncConfig: "/api/dsh-studio/sync",
	syncPush: "/api/dsh-studio/sync/push",
	syncPull: "/api/dsh-studio/sync/pull",
	lifecycle: "/api/dsh-studio/lifecycle",
	skillImport: "/api/dsh-studio/skill-import",
	skillExport: "/api/dsh-studio/skill-export"
};
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150;
/** Model-facing announcement: plugin presence and capabilities. */
const GUIDANCE = "本机已安装 dsh-studio 插件（skill 技能工作台）：可用 skillmgr_list 列出全部已发现 skill（名称/描述/来源/嵌套标记/模型与用户可调用状态/分组 metadata.group）、skillmgr_get 查看正文、skillmgr_save 保存全文编辑、skillmgr_policy 设置启用/禁用（modelInvocable / userInvocable）。也内置「会话提取」：skillmgr_extract_run 定时从会话日志用 LLM 提取候选 skill，skillmgr_extract_list 查看候选、skillmgr_extract_accept/reject 接受或拒绝、skillmgr_extract_config/status 配置与查看，确认后自动写入 agent skill 根（配置了 mirrorDir 时再镜像一份）。也可以在 Web 设置页「Skill 工作台」面板中可视化查看、编辑、开关 skill 与提取候选，并按分组（SKILL.md frontmatter 的 metadata.group）折叠筛选。skillmgr_quality 只读聚合提取漏斗、SAVE 队列的使用/活跃/归档比例与候选积压，用于质量度量。用户提到「管理 skill / 技能 / skill 列表 / 查看技能 / 提取 skill」时即指本插件，请据此协作。";

export { API, GUIDANCE, inject, name, SECTION_ORDER };
