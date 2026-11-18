/**
 * 模块级的运行时句柄（模型通道、最近活跃的 agent）与依赖它们的小工具。
 * apply() 在挂载时写入 pluginState，工具与路由的构造器从这里读。
 * （从 index.js 拆出，逻辑未改。）
 */
import { runExtraction, withExtractLock } from "./extractor.js";

/** 读 DSH settings（新宿主用 describe()，老宿主用 get(ns)）。 */
function resolveSettingsReader(ctx) {
	let settings = null;
	try {
		settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
	} catch {
		settings = null;
	}
	if (!settings) return () => undefined;
	if (typeof settings.get === "function") {
		return (ns) => {
			try {
				return settings.get(ns);
			} catch {
				return undefined;
			}
		};
	}
	let table = null;
	return (ns) => {
		if (table === null) {
			table = new Map();
			try {
				const list = typeof settings.describe === "function" ? settings.describe() : [];
				if (Array.isArray(list)) for (const e of list) if (e && typeof e.ns === "string") table.set(e.ns, e.value);
			} catch {
				/* describe 失败就返回空表 */
			}
		}
		return table.get(ns);
	};
}

/** 列出 DSH 里已配置的 provider/model，供面板下拉选择。 */
function listAvailableModels(ctx) {
	const out = [];
	try {
		const providers = ctx.llm?.listConfigurableProviders?.() ?? [];
		const read = resolveSettingsReader(ctx);
		for (const p of providers) {
			const value = read(p.settingsNs);
			let profile = value;
			if (Array.isArray(p.settingsPath)) for (const key of p.settingsPath) profile = profile?.[key];
			const models = Array.isArray(profile?.models) ? profile.models : [];
			for (const m of models) {
				const id = typeof m === "string" ? m : m?.id;
				if (typeof id === "string" && id !== "") out.push({ provider: p.provider, model: id, label: p.provider + " / " + id });
			}
			const single = profile?.model;
			if (models.length === 0 && typeof single === "string" && single !== "") out.push({ provider: p.provider, model: single, label: p.provider + " / " + single });
		}
	} catch {
		/* 读不到就返回空清单，面板退化为「自动」 */
	}
	return out;
}

/**
 * 模型通道的模块级句柄：模块级的工具/路由构造器拿不到 apply 的闭包，
 * 所以这里存一份，由 apply 在挂载时写入。
 */
const pluginState = { llm: null, agent: null, distillIngest: null, distillAdmit: null };
/** 统一给 runExtraction 传模型通道（走 DSH 自己的 provider/model）。 */
// ：挂了蒸馏模块（distillIngest）时，所有提取路径（定时 / 回合结束 / 面板 / 工具）的候选都先成草稿，过评估门才入库
const runExtract = (cfg, agent, extra = {}) => withExtractLock(() => runExtraction(cfg, void 0, { llm: pluginState.llm, agent: agent ?? pluginState.agent, onCandidates: pluginState.distillIngest ?? null, admit: pluginState.distillAdmit ?? null, ...extra }));

export { listAvailableModels, pluginState, runExtract };
