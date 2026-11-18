/**
 * studio 级备份包的配置：默认值、合并规则、落盘位置。
 *
 * 三层合并（后者逐字段覆盖前者，类型不对的值忽略；与 #3/#4/#5 同一个 mergeInto）：
 *   1. STUDIO_BACKUP_DEFAULTS（保守：闲时自动打包关闭）；
 *   2. 插件配置行 `studioBackup: {...}`；
 *   3. `~/.dsh-studio/studio-backup/config.json`（可选）。
 *
 * 数据目录刻意放在 `.dsh` 之外（与版本史同理：.dsh 整个被清空过），
 * 默认 `~/.dsh-studio/studio-backup/`，环境变量 DSH_STUDIO_BACKUP_DIR 可改（例如 D 盘）。
 * 目录结构：packages/（备份包）· restores/（恢复报告）· state.json（自动打包节奏）· config.json。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mergeInto } from "./optimizer-config.js";

export const STUDIO_BACKUP_DEFAULTS = Object.freeze({
	/** 闲时自动打包总开关（默认关：只有手动 skillmgr_studio_backup {action:"export"} / 面板） */
	enabled: false,
	idleWindow: Object.freeze({ start: "02:00", end: "06:00" }),
	/** 距最近一次会话活动至少多少分钟才算「闲」 */
	idleMinutes: 30,
	/** 两次自动打包至少隔多少小时 */
	minIntervalHours: 24,
	checkEveryMinutes: 10,
	/** 自动打包（label=scheduled）保留几份；手动包不受它影响，只能手动删 */
	keep: 7,
	/** 恢复前自动打的保护包（label=pre-restore）保留几份 */
	keepPreRestore: 3,
	/** 自动打包后顺手推到 WebDAV（复用 sync.json 里 webdav 段的地址与凭据；没配就跳过并记原因） */
	autoPush: false,
	/** WebDAV 远端保留几份（按推送顺序，超出的删掉；0 = 不清理远端） */
	remoteKeep: 7,
	/** WebDAV 远端子目录（挂在 sync.json 的 webdav.url 之下，与快照的 config.tar.gz / LATEST 分开） */
	remoteDir: "studio-backup",
	/** 技能文件单文件上限（字节）：超过只记 sha 不打包，恢复报告里列出（0 = 不限） */
	maxSkillFileBytes: 5 * 1024 * 1024,
	/** 备份对象开关（默认全开） */
	include: Object.freeze({ registry: true, config: true, skills: true, history: true, data: true })
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function studioBackupRoot() {
	const override = typeof process.env.DSH_STUDIO_BACKUP_DIR === "string" ? process.env.DSH_STUDIO_BACKUP_DIR.trim() : "";
	return override !== "" ? resolve(override) : resolve(homedir(), ".dsh-studio", "studio-backup");
}

export function studioBackupConfigFile() {
	return join(studioBackupRoot(), "config.json");
}

export function resolveStudioBackupConfig(pluginConfig, fileConfig) {
	let config = mergeInto(JSON.parse(JSON.stringify(STUDIO_BACKUP_DEFAULTS)), pluginConfig);
	config = mergeInto(config, fileConfig);
	if (!HHMM.test(config.idleWindow.start)) config.idleWindow.start = STUDIO_BACKUP_DEFAULTS.idleWindow.start;
	if (!HHMM.test(config.idleWindow.end)) config.idleWindow.end = STUDIO_BACKUP_DEFAULTS.idleWindow.end;
	config.keep = Math.max(1, Math.floor(config.keep));
	config.keepPreRestore = Math.max(1, Math.floor(config.keepPreRestore));
	config.remoteKeep = Math.max(0, Math.floor(config.remoteKeep));
	// 远端子目录只许单段安全名：它要拼进 URL
	config.remoteDir = /^[\w.-]{1,64}$/.test(config.remoteDir) && !config.remoteDir.startsWith(".") ? config.remoteDir : STUDIO_BACKUP_DEFAULTS.remoteDir;
	return { config, sources: { defaults: true, plugin: isObj(pluginConfig), file: isObj(fileConfig) } };
}

export async function readStudioBackupConfigFile() {
	let text;
	try {
		text = await readFile(studioBackupConfigFile(), "utf8");
	} catch {
		return { value: null, error: null };
	}
	try {
		const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
		return isObj(parsed) ? { value: parsed, error: null } : { value: null, error: "config.json 不是 JSON 对象，已忽略" };
	} catch (error) {
		return { value: null, error: "config.json 解析失败，已忽略：" + (error instanceof Error ? error.message : String(error)) };
	}
}
