import { McpPanel } from "./McpPanel.js";
import { SnapshotPanel } from "./SnapshotPanel.js";
import { SkillManagerPanel } from "./SkillManagerPanel.js";

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

export { apply, inject };
