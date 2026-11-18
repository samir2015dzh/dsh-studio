/**
 * 面向模型的 skillmgr_* 工具：技能的列出 / 读取 / 保存 / 启停 / 导出、回收站、
 * 配置快照、同步、上游更新检查与应用。
 * （从 index.js 拆出，逻辑未改。）
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULTS as DARWIN_DEFAULTS } from "./darwin.js";
import { pullPending } from "./pending.js";
import { findSkillByName } from "./scanner.js";
import { exportSkill } from "./skill-export.js";
import { loadLock as loadSkillLock } from "./skillsrc.js";
import { createSnapshot, exportSnapshot, importSnapshot, listSnapshots, restoreSnapshot } from "./snapshot.js";
import { loadSync, pullSnapshot, pushSnapshot, redactChannelConfig, saveSync } from "./sync.js";
import { listTrash, purgeTrash, restoreTrash, trashSkill } from "./trash.js";
import { applySkillUpdate } from "./update-apply.js";
import { checkUpstream, listSkillDirs } from "./upstream.js";
import { ErrorMsg, text } from "./route-util.js";
import { getSkillDetail, listSkills, resolveCwd, savePolicy, saveSkill } from "./skill-core.js";

/** The list tool. */
function skillmgrListTool(ctx) {
	return defineTool({
		name: "skillmgr_list",
		description: "列出当前工作区全部已发现的 skill（技能）：名称、描述、来源（user-agents/user-dsh/project-dsh/...）、嵌套标记、以及模型可调用与用户可调用状态。",
		parameters: {
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）；只影响项目级 skill 的发现范围"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					cwd: { type: "string" },
					skills: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string" },
								description: { type: "string" },
								whenToUse: { type: "string" },
								source: { type: "string" },
								provider: { type: "string" },
								modelInvocable: { type: "boolean" },
								userInvocable: { type: "boolean" },
								editable: { type: "boolean" },
								nested: { type: "boolean" },
								parent: { type: "string" },
								group: { type: "string" },
								tags: {
									type: "array",
									items: { type: "string" }
								},
								declaredName: { type: "string" },
								nameValid: { type: "boolean" },
								dirName: { type: "string" },
								dir: { type: "string" },
								shadowedBy: { type: "string" },
								shadows: {
									type: "array",
									items: { type: "string" }
								}
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const items = (value.skills ?? []).map((s) => {
					const flags = (s.modelInvocable ? "模型✓" : "模型✗") + "/" + (s.userInvocable ? "用户✓" : "用户✗");
					const nested = s.nested ? "（嵌套）" : "";
					const group = typeof s.group === "string" && s.group !== "" ? "【" + s.group + "】" : "";
					return "- " + group + s.name + nested + " [" + flags + "]（" + (s.source ?? "?") + "）: " + (s.description ?? "");
				});
				return text("[ok] 共 " + items.length + " 个 skill\n" + items.join("\n"));
			}
		},
		async execute(args) {
			return {
				ok: true,
				cwd: resolveCwd(args.cwd) ?? process.cwd(),
				skills: await listSkills(ctx, resolveCwd(args.cwd))
			};
		}
	});
}
/** The get-detail tool. */
function skillmgrGetTool(ctx) {
	return defineTool({
		name: "skillmgr_get",
		description: "查看一个 skill 的完整详情：描述、来源、模型/用户可调用状态、文件路径（有则说明可编辑）、以及正文全文（frontmatter + Markdown 内容）。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "skill 名称（kebab-case，如 obsidian-project-kb；嵌套 skill 可用 parent/child 形式）"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					skill: {
						type: "object",
						additionalProperties: true,
						properties: {
							name: { type: "string" },
							description: { type: "string" },
							whenToUse: { type: "string" },
							source: { type: "string" },
							provider: { type: "string" },
							modelInvocable: { type: "boolean" },
							userInvocable: { type: "boolean" },
							editable: { type: "boolean" },
							nested: { type: "boolean" },
							path: { type: "string" },
							content: { type: "string" },
							metadata: { type: "object", additionalProperties: true }
						}
					}
				}
			},
			render: (_args, value) => {
				const s = value.skill;
				if (!s) return text("找不到这个技能。");
				const head = [
					s.name + (s.nested ? "（嵌套）" : "") + "（" + (s.source ?? "?") + "/" + (s.provider ?? "?") + "）",
					"调用策略: 模型" + (s.modelInvocable ? "✓" : "✗") + " / 用户" + (s.userInvocable ? "✓" : "✗"),
					"路径: " + (s.path ?? "（只读，无文件）"),
					"描述: " + (s.description ?? ""),
					"正文:"
				].join("\n");
				return text(head + "\n" + (s.content ?? ""));
			}
		},
		async execute(args) {
			const detail = await getSkillDetail(ctx, args.name, resolveCwd(args.cwd));
			// schema 里 skill 声明为 object：不存在时省略该键，不返回 null（宿主会整包打回）
			return detail === null ? { ok: false } : { ok: true, skill: detail };
		}
	});
}
/** The save-edit tool. */
function skillmgrSaveTool(ctx) {
	return defineTool({
		name: "skillmgr_save",
		description: "保存一个 skill 的全文编辑（frontmatter + 正文一起写回 SKILL.md 文件）。只对文件系统来源的 skill 可用（有 path）；保存后 DSH 会自动重新发现，无需重启。注意：frontmatter 的 name 需与 skill 名一致，格式错误可能导致该 skill 被跳过。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "skill 名称（kebab-case）"
			},
			content: {
				type: "string",
				required: true,
				description: "新的完整文件内容（含 --- frontmatter --- 与正文）"
			},
			expectedMtime: {
				type: "number",
				description: "打开文件时的 mtimeMs；和磁盘上的不一致时拒绝保存，避免覆盖别人刚改的内容"
			},
			overwrite: {
				type: "boolean",
				description: "为 true 时忽略 mtime 检查，强制覆盖"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: { type: "string" },
					path: { type: "string" },
					bytes: { type: "number" },
					mtimeMs: { type: "number" }
				}
			},
			render: (_args, value) => text((value.ok ? "[ok] " : "[failed] ") + (value.message ?? ""))
		},
		async execute(args) {
			return saveSkill(ctx, args, resolveCwd(args.cwd));
		}
	});
}
/** The enable/disable tool. */
function skillmgrPolicyTool(ctx) {
	return defineTool({
		name: "skillmgr_policy",
		description: "设置一个 skill 的启用/调用策略：enabled=true 启用（模型与用户都可调用，移除 frontmatter 的 disable-model-invocation / user-invocable 行），enabled=false 禁用（两者都关闭）；也可单独用 modelInvocable / userInvocable 只改一侧。修改写入 SKILL.md frontmatter，DSH 自动重新发现。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "skill 名称（kebab-case）"
			},
			enabled: {
				type: "boolean",
				description: "总开关：true 同时启用模型与用户调用；false 同时禁用"
			},
			modelInvocable: {
				type: "boolean",
				description: "可选：单独设置模型是否可调用（true 启用 / false 禁用）"
			},
			userInvocable: {
				type: "boolean",
				description: "可选：单独设置用户是否可调用（true 启用 / false 禁用）"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: { type: "string" },
					path: { type: "string" },
					modelInvocable: { type: "boolean" },
					userInvocable: { type: "boolean" },
					mtimeMs: { type: "number" }
				}
			},
			render: (_args, value) => {
				if (!value.ok) return text("[failed] " + (value.message ?? ""));
				return text("[ok] " + value.message + "（模型" + (value.modelInvocable ? "✓" : "✗") + " / 用户" + (value.userInvocable ? "✓" : "✗") + "）");
			}
		},
		async execute(args) {
			return savePolicy(ctx, args, resolveCwd(args.cwd));
		}
	});
}
/** 把一个技能打包成 .tar.gz，方便拷到别的机器再导入。 */
function skillmgrExportTool() {
	return defineTool({
		name: "skillmgr_export",
		description: "把一个已安装的技能打包成 .tar.gz。目录技能会带上同目录的附属文件；根上的单个 .md 只打包该文件。不传 path 时写到 ~/.dsh/dsh-studio/exports/<name>.tar.gz。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "技能名称（kebab-case）"
			},
			path: {
				type: "string",
				description: "导出文件路径（.tar.gz）。省略时写到 ~/.dsh/dsh-studio/exports/<name>.tar.gz"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					path: { type: "string" },
					bytes: { type: "number" },
					files: { type: "number" },
					name: { type: "string" },
					message: { type: "string" }
				}
			},
			render: (_args, value) => text((value.ok ? "[ok] 已导出 " : "[failed] ") + (value.path ?? value.message ?? ""))
		},
		async execute(args) {
			return exportSkill({ name: args.name, path: args.path, cwd: resolveCwd(args.cwd) });
		}
	});
}
/** 删除到回收站：只移动，不真删。 */
function skillmgrTrashTool(ctx) {
	return defineTool({
		name: "skillmgr_trash",
		description: "把一个技能移进回收站（移动目录，不真删，可恢复）。只对文件系统里有实体目录的技能有效；运行时/内置技能删不了。",
		parameters: {
			name: { type: "string", description: "技能名（skillmgr_list 里的 name）", required: true },
			cwd: { type: "string", description: "工作区目录（默认当前 cwd）" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					name: { type: "string" },
					id: { type: "string" },
					from: { type: "string" },
					message: { type: "string" }
				}
			},
			render: (_args, value) =>
				text(value.ok ? `已移入回收站：${value.name}（批次 ${value.id}）` : `失败：${value.message ?? ""}`)
		},
		async execute(args) {
			const skill = await findSkillByName(String(args.name ?? ""), resolveCwd(args.cwd));
			if (skill === null) return { ok: false, name: String(args.name ?? ""), message: "找不到这个技能。" };
			if (typeof skill.dir !== "string" || skill.dir === "") {
				return { ok: false, name: skill.name, message: "内置技能不能删除。" };
			}
			const result = await trashSkill({ name: skill.name, dir: skill.dir, path: skill.path }, { cwd: resolveCwd(args.cwd) });
			return { ok: true, name: skill.name, id: result.id, from: result.from };
		}
	});
}
/** 看回收站里有什么。 */
function skillmgrTrashListTool() {
	return defineTool({
		name: "skillmgr_trash_list",
		description: "列出回收站里的批次与条目（名称、原路径、文件是否还在）。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					batches: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: true,
							properties: {
								id: { type: "string" },
								entries: { type: "array", items: { type: "object", additionalProperties: true } }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				if (value.batches.length === 0) return text("回收站是空的。");
				const lines = value.batches.map(
					(batch) =>
						`- ${batch.id}（${batch.entries.length} 项）\n` +
						batch.entries.map((entry) => `    ${entry.name} ← ${entry.from}`).join("\n")
				);
				return text("回收站 " + value.batches.length + " 个批次：\n" + lines.join("\n"));
			}
		},
		async execute() {
			return { ok: true, batches: await listTrash() };
		}
	});
}
/** 从回收站恢复。 */
function skillmgrRestoreTool() {
	return defineTool({
		name: "skillmgr_restore",
		description: "把回收站里的技能搬回原位置。name 省略时恢复整个批次。",
		parameters: {
			id: { type: "string", description: "批次 id（skillmgr_trash_list 里的 id）", required: true },
			name: { type: "string", description: "只恢复这一条；省略则整批恢复" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "string" },
					restored: { type: "array", items: { type: "string" } },
					message: { type: "string" }
				}
			},
			render: (_args, value) =>
				text(value.ok ? `已恢复 ${value.restored.length} 项：${value.restored.join(", ")}` : `失败：${value.message ?? ""}`)
		},
		async execute(args) {
			const id = String(args.id ?? "");
			try {
				return { ok: true, ...(await restoreTrash(id, args.name === undefined ? undefined : String(args.name), { cwd: resolveCwd(args.cwd) })) };
			} catch (error) {
				return { ok: false, id, restored: [], message: ErrorMsg(error) };
			}
		}
	});
}
/** 永久删除回收站条目。不可恢复。 */
function skillmgrPurgeTool() {
	return defineTool({
		name: "skillmgr_purge",
		description: "永久删除回收站里的条目（不可恢复）。name 省略时删整个批次。",
		parameters: {
			id: { type: "string", description: "批次 id", required: true },
			name: { type: "string", description: "只删这一条；省略则删整批" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "string" },
					purged: { type: "array", items: { type: "string" } },
					message: { type: "string" }
				}
			},
			render: (_args, value) =>
				text(value.ok ? `已永久删除 ${value.purged.length} 项：${value.purged.join(", ")}` : `失败：${value.message ?? ""}`)
		},
		async execute(args) {
			const id = String(args.id ?? "");
			try {
				return { ok: true, ...(await purgeTrash(id, args.name === undefined ? undefined : String(args.name))) };
			} catch (error) {
				return { ok: false, id, purged: [], message: ErrorMsg(error) };
			}
		}
	});
}
/** 建一份配置快照。 */
function skillmgrSnapshotTool() {
	return defineTool({
		name: "skillmgr_snapshot",
		description: "把 ~/.dsh 的配置（cordis.patch.yml、AGENTS.md、skills/、dsh-studio/、各 profile 的 package.json 与 patch）打成一份快照存到 ~/.dsh/dsh-studio/snapshots。密钥与会话日志永不包含。",
		parameters: {
			label: { type: "string", description: "快照标签，会拼进目录名" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "string" },
					label: { type: "string" },
					fileCount: { type: "number" },
					archiveBytes: { type: "number" }
				}
			},
			render: (_a, v) => text(`已建快照 ${v.id}：${v.fileCount} 个文件，${(v.archiveBytes / 1024).toFixed(0)} KB`)
		},
		async execute(args) {
			const snap = await createSnapshot(typeof args.label === "string" && args.label !== "" ? args.label : "manual");
			return { ok: true, id: snap.id, label: snap.label, fileCount: snap.files.length, archiveBytes: snap.archiveBytes };
		}
	});
}
/** 列快照。 */
function skillmgrSnapshotListTool() {
	return defineTool({
		name: "skillmgr_snapshot_list",
		description: "列出配置快照（时间、标签、文件数、体积）。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					snapshots: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								label: { type: "string" },
								at: { type: "number" },
								fileCount: { type: "number" },
								archiveBytes: { type: "number" }
							}
						}
					}
				}
			},
			render: (_a, v) => text(v.snapshots.length === 0 ? "还没有快照。" : v.snapshots.map((s) => `- ${s.id} · ${s.fileCount} 文件 · ${(s.archiveBytes / 1024).toFixed(0)} KB`).join("\n"))
		},
		async execute() {
			return { ok: true, snapshots: await listSnapshots() };
		}
	});
}
/** 恢复快照。 */
function skillmgrSnapshotRestoreTool() {
	return defineTool({
		name: "skillmgr_snapshot_restore",
		description: "把配置恢复到某份快照。dryRun 只算差异不写盘；真恢复前会自动打一份 pre-restore 快照，打不成且要覆盖现有文件时中止。",
		parameters: {
			id: { type: "string", description: "快照 id", required: true },
			dryRun: { type: "boolean", description: "只预览差异" },
			force: { type: "boolean", description: "恢复前保护快照打不成时仍然覆盖（默认中止；只在所有者明确要求时用）" },
			pathMap: { type: "json", description: "跨机路径重映射：数组 [{from, to}]，或它的 JSON 字符串" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "string" },
					dryRun: { type: "boolean" },
					total: { type: "number" },
					create: { type: "number" },
					overwrite: { type: "number" },
					same: { type: "number" },
					written: { type: "number" },
					// B7：与包里逐字节相同、没有重写的文件数（已计入 written）
					unchanged: { type: "number" },
					preSnapshot: { oneOf: [{ type: "string" }, { type: "null" }] },
					remapped: { type: "number" },
					rejected: { type: "number" },
					// N-04：白名单镜像拦下的条目（包里有、收集侧永远不打进来）与 rejected 分开计数
					skipped: { type: "number" },
					skippedPaths: { type: "array", items: { type: "string" } },
					failed: { type: "array", items: { type: "json" } },
					plan: { type: "array", items: { type: "json" } },
					rejectedPaths: { type: "array", items: { type: "string" } },
					// summary 恒带 pendingPulls（可能是空数组）：漏声明会被宿主按整包打回
					pendingPulls: { type: "array", items: { type: "object", additionalProperties: true } },
					// ：占位符没补回的凭据字段（目标机没有同名同键的现值），恒带（可能是空数组）
					missingCredentials: { type: "array", items: { type: "object", additionalProperties: true } }
				}
			},
			render: (_a, v) =>
				text(
					(v.dryRun ? `[预览] ${v.total} 个文件：新建 ${v.create}、覆盖 ${v.overwrite}、相同 ${v.same}` : `已恢复 ${v.written} 个文件${v.preSnapshot ? `（恢复前快照 ${v.preSnapshot}）` : ""}`) +
						(Array.isArray(v.missingCredentials) && v.missingCredentials.length > 0
							? `\n${v.dryRun ? "将有" : "有"} ${v.missingCredentials.length} 处凭据目标机没有现值、未补回（需手动补上）：\n` +
								v.missingCredentials.map((m) => `- ${m.file} · ${m.field}`).join("\n")
							: "")
				)
		},
		async execute(args) {
			const rawMap = args.pathMap;
			let pathMap;
			if (Array.isArray(rawMap)) pathMap = rawMap;
			else if (typeof rawMap === "string" && rawMap.trim() !== "") pathMap = JSON.parse(rawMap);
			const result = await restoreSnapshot(String(args.id ?? ""), { dryRun: args.dryRun === true, force: args.force === true, pathMap });
			return { ok: true, ...result };
		}
	});
}
/**
 * 消费恢复端待拉清单（PULL-2）：恢复只写清单不联网，拉不拉由这个显式动作决定。
 */
function skillmgrPullPendingTool(store) {
	return defineTool({
		name: "skillmgr_pull_pending",
		description:
			"消费恢复端待拉清单（外部 skill 根下的 PENDING_PULLS.json）：把快照里只记链接、没打包内容的 skill 真拉回来并写 lock。逐条独立成败；已存在且内容一致的记 satisfied 跳过，同名但内容不一致的记 conflict 且绝不覆盖；成功与已满足的从清单消项，冲突与失败的留着下次重试。清单不存在时返回空结果、不报错。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					total: { type: "number", required: true },
					pulled: { type: "number", required: true },
					satisfied: { type: "number", required: true },
					conflict: { type: "number", required: true },
					failed: { type: "number", required: true },
					remaining: { type: "number" },
					pendingFile: { type: "string" },
					results: { type: "array", items: { type: "json" } }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			const cfg = await store.load();
			return pullPending({ targetDir: cfg.agentSkillDir });
		}
	});
}
/** 导出 / 导入快照文件。 */
function skillmgrSnapshotTransferTool() {
	return defineTool({
		name: "skillmgr_snapshot_transfer",
		description: "把某份快照导出成 .tar.gz 文件，或把外部 .tar.gz 导入成快照（导入不写配置，先落成快照再恢复）。",
		parameters: {
			action: { type: "string", description: "export 或 import", required: true },
			path: { type: "string", description: "文件绝对路径", required: true },
			id: { type: "string", description: "导出时的快照 id" },
			label: { type: "string", description: "导入后的标签" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					path: { type: "string" },
					bytes: { type: "number" },
					files: { type: "number" },
					id: { type: "string" }
				}
			},
			render: (_a, v) => text(v.id ? `已导入为快照 ${v.id}（${v.files} 个文件）` : `已导出到 ${v.path}（${(v.bytes / 1024).toFixed(0)} KB）`)
		},
		async execute(args) {
			const action = args.action === "import" ? "import" : "export";
			const path = String(args.path ?? "");
			if (action === "export") {
				const r = await exportSnapshot(String(args.id ?? ""), path);
				return { ok: true, path: r.path, bytes: r.bytes, files: r.files };
			}
				const snap = await importSnapshot(path, typeof args.label === "string" ? args.label : "imported");
			return { ok: true, id: snap.id, files: snap.files.length };
		}
	});
}
/** 同步通道：看配置 / 推 / 拉。 */
function skillmgrSyncTool() {
	return defineTool({
		name: "skillmgr_sync",
		description: "配置快照的多机同步。action=config 读或改通道配置；action=push 把某份快照推到远端；action=pull 从远端取回并落成快照。通道：git / webdav / gist / s3。",
		parameters: {
			action: { type: "string", description: "config / push / pull", required: true },
			channel: { type: "string", description: "git / webdav / gist / s3，省略用配置里的当前通道" },
			snapshotId: { type: "string", description: "push 时的快照 id" },
			settings: { type: "string", description: "config 时要合并进去的配置（JSON 字符串）" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					action: { type: "string" },
					channel: { type: "string" },
					pushed: { type: "boolean" },
					id: { type: "string" },
					files: { type: "number" },
					bytes: { type: "number" },
					remoteId: { type: "string" },
					snapshotId: { type: "string" },
					note: { type: "string" },
					gistId: { type: "string" },
					created: { type: "boolean" },
					sync: { type: "string" }
				}
			},
			render: (_a, v) => text(
				v.pushed === true
					? `已推送 ${v.snapshotId ?? v.id ?? ""} 到 ${v.channel}${v.note !== void 0 ? "（" + v.note + "）" : ""}`
					: v.pushed === false
						? `远端已经是最新的（${v.channel}）`
						: v.id !== void 0
							? `已拉取为快照 ${v.id}（${v.files} 个文件，远端 ${v.remoteId ?? "?"}）`
							: `当前通道：${v.channel}`
			)
		},
		async execute(args) {
			const action = String(args.action ?? "config");
			const current = await loadSync();
			const channel = typeof args.channel === "string" && args.channel !== "" ? args.channel : current.channel;
			if (action === "push") {
				const result = await pushSnapshot(channel, current[channel] ?? {}, String(args.snapshotId ?? ""));
				return { ok: true, action, ...result };
			}
			if (action === "pull") {
				const result = await pullSnapshot(channel, current[channel] ?? {}, "pulled");
				return { ok: true, action, ...result };
			}
			if (typeof args.settings === "string" && args.settings !== "") {
				const patch = JSON.parse(args.settings);
				const next = await saveSync({ ...patch, channel });
				return { ok: true, action: "config", channel: next.channel, sync: JSON.stringify(redactChannelConfig(next[channel])) };
			}
				return { ok: true, action: "config", channel: current.channel, sync: JSON.stringify(redactChannelConfig(current[channel])) };
		}
	});
}
/**
 * 只读的上游版本检查（U-2）。
 * 只跑 git ls-remote 取远端 sha，不下载、不 clone、不改动任何 skill，也不写 lock。
 *
 * N-10：走 darwin 同一份 upstreamTtlMs 缓存（同一配置来源），TTL 窗口内重复查询同一 skill
 * 的上游 sha 可能来自缓存 —— 输出里明写这一点，避免把缓存当成「刚查过」。
 */
function skillmgrUpdateCheckTool(extractStore, options = {}) {
	const ttlMs =
		Number.isFinite(Number(options?.upstreamTtlMs)) && Number(options.upstreamTtlMs) >= 0
			? Number(options.upstreamTtlMs)
			: DARWIN_DEFAULTS.upstreamTtlMs;
	const shortRepo = (skill) => {
		const repo = String(skill.repo ?? "").replace(/^https:\/\/github\.com\//, "");
		const sub = String(skill.subPath ?? "");
		return repo === "" ? "?" : sub === "" ? repo : repo + "/" + sub;
	};
	return defineTool({
		name: "skillmgr_update_check",
		description: "只读检查 skill 的上游版本：扫描两棵 skill 根（配置里的 agentSkillDir + ~/.dsh/skills），按「skill-lock.json 记录 > 目录内 .git 的 origin > .huashu-skill-meta.json」判定上游，用 git ls-remote 比对本地 commit。全库口径：凡含 SKILL.md 的目录都算一个 skill（含嵌套层），跟随符号链接，按真实路径去重（同一个目录被多个根扫到只算一次）。返回每个可判定 skill 的状态（最新/有新版/无法比对/检查失败）与强制双数字汇总（已查 N / 全库 M，可判定 K）。单个检查失败逐条标注、不中断全量；不下载、不更新任何 skill。应用新版用 `skillmgr_update_apply`（本工具只读报版本）。",
		parameters: {
			root: { type: "string", description: "可选：覆盖 agent 根的扫描目录（默认取插件配置的 agentSkillDir）" },
			timeoutMs: { type: "number", description: "可选：单个上游 ls-remote 的超时毫秒数（默认 8000）" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					totals: {
						type: "object",
						required: true,
						additionalProperties: false,
						properties: {
							total: { type: "number", required: true },
							checked: { type: "number", required: true },
							determinable: { type: "number", required: true },
							behind: { type: "number" },
							latest: { type: "number" },
							unknownVersion: { type: "number" },
							failed: { type: "number" }
						}
					},
					skills: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string" },
								dir: { type: "string" },
								via: { type: "string" },
								repo: { type: "string" },
								ref: { type: "string" },
								subPath: { type: "string" },
								localSha: { type: "string" },
								upstreamSha: { type: "string" },
								status: { type: "string" },
								note: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const lines = [String(value.message ?? "")];
				const MARK = { behind: "[有新版]", latest: "[最新]", "unknown-version": "[无法比对]", failed: "[失败]" };
				for (const skill of value.skills ?? []) {
					const sha =
						skill.status === "behind"
							? `${String(skill.localSha).slice(0, 7)}→${String(skill.upstreamSha).slice(0, 7)}`
							: String(skill.localSha || skill.upstreamSha || "").slice(0, 7);
					lines.push(
						`- ${MARK[skill.status] ?? "[?]"} ${skill.name}（${skill.via}）${shortRepo(skill)} ${sha}` +
							(skill.note ? " · " + skill.note : ""),
					);
				}
				return text(lines.join("\n"));
			}
		},
		async execute(args) {
			try {
				const cfg = await extractStore.view();
				const override = typeof args?.root === "string" && args.root.trim() !== "" ? resolve(args.root.trim()) : "";
				const roots = [override !== "" ? override : cfg.agentSkillDir, resolve(homedir(), ".dsh", "skills")];
				const timeoutMs = typeof args?.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 8000;
				const lock = await loadSkillLock();
				const found = listSkillDirs(roots);
				const results = await Promise.all(found.map((skill) => checkUpstream(skill.dir, { lock, timeoutMs, ttlMs })));
				const count = (status) => results.filter((r) => r.status === status).length;
				const determinable = results.filter((r) => r.via !== "").length;
				const checked = determinable;
				return {
					ok: true,
					message:
						`已查 ${checked} / 全库 ${results.length}（可判定 ${determinable}）` +
						` · 有新版 ${count("behind")} · 最新 ${count("latest")}` +
						` · 无法比对 ${count("unknown-version")} · 检查失败 ${count("failed")}` +
						`（全库口径：含 SKILL.md 的目录，跟随符号链接，按真实路径去重）` +
						(ttlMs > 0 ? `（${Math.round(ttlMs / 60_000)} 分钟 TTL 内重复查询同一 skill 的上游 sha 可能来自缓存）` : "（未启用上游缓存）"),
					totals: {
						total: results.length,
						checked,
						determinable,
						behind: count("behind"),
						latest: count("latest"),
						unknownVersion: count("unknown-version"),
						failed: count("failed")
					},
					skills: results.filter((r) => r.via !== "").map((r) => ({
						name: r.name,
						dir: r.dir,
						via: r.via,
						repo: r.repo,
						ref: r.ref,
						subPath: r.subPath,
						localSha: r.localSha,
						upstreamSha: r.upstreamSha,
						status: r.status,
						...(r.note !== void 0 ? { note: r.note } : {})
					}))
				};
			} catch (error) {
				return {
					ok: false,
					message: "检查失败：" + String(ErrorMsg(error)),
					totals: { total: 0, checked: 0, determinable: 0 },
					skills: []
				};
			}
		}
	});
}
/**
 * 应用一个技能的更新（N-01）：update_check 只报「有新版」，本工具负责把新版真正装上去。
 * 语义全部在 lib/update-apply.js（工作流、备份不变式、文件取舍、标注重打、lock 收尾），
 * 这里只做注册层接线：取扫描根、透传 TTL 口径、把结构化返回原样交给宿主。
 * 只处理调用方点名的那一个技能；没有定时、批量、通配入口。
 */
function skillmgrUpdateApplyTool(extractStore, options = {}) {
	const ttlMs =
		Number.isFinite(Number(options?.upstreamTtlMs)) && Number(options.upstreamTtlMs) >= 0
			? Number(options.upstreamTtlMs)
			: DARWIN_DEFAULTS.upstreamTtlMs;
	const failure = (name, message, stage) => ({
		ok: false,
		message,
		name,
		changed: false,
		oldCommit: "",
		newCommit: "",
		added: 0,
		deleted: 0,
		modified: 0,
		backupPath: "",
		preservedFiles: [],
		annotationReapplied: false,
		lockUpdated: [],
		stage
	});
	return defineTool({
		name: "skillmgr_update_apply",
		description: "把一个已装 skill 从上游更新到最新提交（update_check 报「有新版」后的应用环节）。仅当 skill-lock.json 里有可判定来源（GitHub 仓库 + ref + subPath）时才动手：取上游 tarball、在临时区组装新树（上游文件 + 保留本地独有文件 + 按旧值重打 metadata.group）、校验后同卷换位，最后写 lock 的 sha256 与 commit；全程失败即零改动，失败点用 stage 标明（locate/source/fetch/assemble/swap/lock）。旧目录整份备份到 ~/.dsh/dsh-studio/skill-backups/<时间戳>/<name>（断言不在扫描根内）。无 lock 记录、来源是本地 tarball、已是最好版本、上游包内无 SKILL.md 都会明确返回原因。一次只处理参数里点名的一个技能，不接受「全部/通配」，也没有定时或批量入口。",
		parameters: {
			name: { type: "string", description: "要应用的技能名（必填；一次只处理这一个）" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					name: { type: "string", required: true },
					changed: { type: "boolean", required: true },
					oldCommit: { type: "string", required: true },
					newCommit: { type: "string", required: true },
					added: { type: "number", required: true },
					deleted: { type: "number", required: true },
					modified: { type: "number", required: true },
					backupPath: { type: "string", required: true },
					preservedFiles: { type: "array", required: true, items: { type: "string" } },
					annotationReapplied: { type: "boolean", required: true },
					lockUpdated: { type: "array", required: true, items: { type: "string" } },
					stage: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			const name = String(args?.name ?? "").trim();
			try {
				const cfg = await extractStore.view();
				const roots = [cfg.agentSkillDir, resolve(homedir(), ".dsh", "skills")].filter((dir) => typeof dir === "string" && dir !== "");
				return await applySkillUpdate({ name, roots, timeoutMs: 8000, ttlMs });
			} catch (error) {
				return failure(name, "应用失败：" + String(ErrorMsg(error)), "locate");
			}
		}
	});
}

export { skillmgrExportTool, skillmgrGetTool, skillmgrListTool, skillmgrPolicyTool, skillmgrPullPendingTool, skillmgrPurgeTool, skillmgrRestoreTool, skillmgrSaveTool, skillmgrSnapshotListTool, skillmgrSnapshotRestoreTool, skillmgrSnapshotTool, skillmgrSnapshotTransferTool, skillmgrSyncTool, skillmgrTrashListTool, skillmgrTrashTool, skillmgrUpdateApplyTool, skillmgrUpdateCheckTool };
