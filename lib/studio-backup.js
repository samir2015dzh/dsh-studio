/**
 * studio 级备份包与跨机恢复。
 *
 * 与 `.dsh` 的快照 / 每日备份分工（详见 STUDIO-BACKUP.md）：
 *   - 快照（lib/snapshot.js）与本机 03:00 的每日备份是**灾备**：按白名单 / 整目录把 `~/.dsh` 原样留一份，
 *     恢复 = 逐文件覆盖回同一台机器。它们不懂「注册表里的一个 server」「技能的版本链」这些语义。
 *   - 本模块是 studio 自己的**可移植**包：只装 studio 管的对象（MCP 注册表、优化器 / 治理 / 蒸馏 / 提取器配置、
 *     技能库、版本史、优化器 / 治理 / 蒸馏 / 目录评测的数据），恢复按对象合并——
 *     版本史按 id 取并集，技能按版本链判断谁新谁旧，判断不了就**报告待裁、不静默覆盖**。
 *   两者不互相替代：换机器 / 合并两台机器的进化成果用本包；`.dsh` 整体被毁用灾备。
 *
 * 包形态：单个 `studio-<时间>-<标签>.tar.gz`，内含
 *   MANIFEST.json     清单：格式 / schema / 时间 / 来源机器的路径口径 / 每类对象的摘要 / 每个条目的字节数与 sha256；
 *   MANIFEST.sha256   清单本身的 sha256（清单被改一个字节也能发现）；
 *   registry/mcp.json 注册表 v2 全量（凭据字段换成占位符，与快照同一套 redactCredentials）；
 *   config/<id>.json  优化器 / 治理 / 蒸馏 / 备份自身 / 提取器的配置文件层（提取器的 llmApiKey 同样脱敏）；
 *   skills/<根>/<技能>/…  两个技能 store 的当前内容（超单文件上限的只记 sha，恢复报告列出）；
 *   history/versions.jsonl + history/objects/…  版本史全量（内容寻址对象原样，恢复时逐个复核 sha）；
 *   data/<区>/…       optimizer / governance / distill / catalog-eval 数据目录（评估集、提案、报告、草稿、归档）。
 * 校验：gzip 可解、清单 sha 对得上、每个条目都在清单里且字节数与 sha 一致、没有清单外条目、路径都在已知前缀下、
 * 版本史对象内容与文件名 sha 一致。任何一项不过，恢复一个字节都不写。
 *
 * 凭据：包里没有任何明文凭据（会推到 WebDAV）。整字段凭据换成占位符；参数 / URL 里内嵌的只换掉那一段（，
 * 这种包标 schema 2，旧版拒收）。恢复时占位符按 server 名 / 字段（内嵌的按键）从目标机现值补回，
 * 目标机也没有的：整字段的不写这个键、内嵌的保持占位，都在恢复报告的 needsCredentials 里逐条列出要补的字段。
 * WebDAV 同步复用 `sync.json` 的 webdav 段（地址与凭据），本模块不另存任何凭据。
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { homedir, platform } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { UserError, notFound } from "./errors.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { CREDENTIAL_FILE_MODE, hardenPermissions } from "./fs-perms.js";
import { fetchWithTimeout } from "./http.js";
import { HISTORY_LOG, HISTORY_OBJECTS, historyRoot, mergeVersionLogText, parseVersionLog } from "./history-paths.js";
import { isInside, isSafeEntryPath } from "./paths.js";
import { REDACTED, hasEmbeddedPlaceholder, mergeRedacted, redactCredentials, remapText, unpackTarGz, writeTarGzStream } from "./snapshot.js";
import { withFileLock } from "./state-lock.js";
import { loadSync, webdavBase, webdavEnsureDir, webdavHeaders } from "./sync.js";
import { inIdleWindow, optimizerConfigFile, optimizerRoot } from "./optimizer-config.js";
import { governanceConfigFile, governanceRoot } from "./governance-config.js";
import { distillConfigFile, distillRoot } from "./distill-config.js";
import { catalogEvalRoot } from "./catalog-watch.js";
import { defaultAgentSkillDir } from "./extractor.js";
import { MAX_STORED_FILE_BYTES, mergeRegistryCredentials, semanticRegistry, skillKeyOf, stableJson, versionedRegistryWrite, versionedSkillWrite, withHistoryLock } from "./versions.js";
import { readStudioBackupConfigFile, resolveStudioBackupConfig, studioBackupConfigFile, studioBackupRoot } from "./studio-backup-config.js";
import { runWithWriteContext } from "./write-context.js";
import { stashRemovedServers, removedServers } from "./mcp-credential-stash.js";

export const PACKAGE_FORMAT = "dsh-studio-backup";
/**
 * 本插件认识的最高 schema。2 = 包里有内嵌占位符（参数 / URL 里只换掉凭据那一段，）：
 * 旧版不认识内嵌占位符，会把它当凭据写进注册表，所以只有这种包才标 2——旧版校验时按「schema 比本插件新：
 * 先升级 dsh-studio 再恢复」拒收，一个字节都不写。没有内嵌占位符的包照旧标 1，旧版照常能恢复。
 */
export const PACKAGE_SCHEMA = 2;
const SCHEMA_PLAIN = 1;
export const MANIFEST_FILE = "MANIFEST.json";
export const MANIFEST_SHA_FILE = "MANIFEST.sha256";
const PACKAGE_ID = /^studio-[\w.-]{1,120}$/;
const RESTORE_ID = /^restore-[\w-]{1,80}$/;
/** 包内只许出现这些前缀（外加两份清单文件）。 */
const PREFIXES = ["registry/", "config/", "skills/", "history/", "data/"];
/** 扫目录时跳过：VCS 元数据与依赖（与快照 / 版本史同口径）。 */
const SKIP_DIRS = new Set([".git", ".svn", ".hg", "node_modules"]);
/** 运行时节奏状态：目标机已有就保留目标机的（不同机器的「上次跑到哪」没有可比性）。 */
const RUNTIME_STATE_FILES = new Set(["state.json"]);
/** 恢复动作 → 中文（报告用）。 */
export const ACTION_LABELS = Object.freeze({
	create: "新建",
	same: "相同（跳过）",
	merged: "已合并",
	"fast-forward": "快进（本机是包内版本的祖先）",
	"kept-local": "保留本机",
	conflict: "冲突·待裁",
	"resolved-package": "按裁定用包内版本",
	"resolved-local": "按裁定保留本机",
	skipped: "跳过",
	failed: "失败"
});
const APPLY_ACTIONS = new Set(["create", "merged", "fast-forward", "resolved-package"]);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const toPosix = (p) => p.split(sep).join("/");
const p2 = (n) => String(n).padStart(2, "0");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clean = (v) => JSON.parse(JSON.stringify(v ?? null));
const errText = (e) => (e instanceof Error ? e.message : String(e));

function stamp(at) {
	const d = new Date(at);
	return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
}

async function pluginVersion() {
	try {
		return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version ?? "";
	} catch {
		return "";
	}
}

async function readJson(file, fallback) {
	try {
		return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
	} catch {
		return fallback;
	}
}
async function readOrNull(file) {
	try {
		return await readFile(file);
	} catch {
		return null;
	}
}
async function statOrNull(file) {
	try {
		return await stat(file);
	} catch {
		return null;
	}
}

async function sha256OfFile(file) {
	const hash = createHash("sha256");
	await new Promise((ok, fail) => {
		createReadStream(file).on("data", (c) => hash.update(c)).on("error", fail).on("end", ok);
	});
	return hash.digest("hex");
}

/** 递归列文件（POSIX 相对路径，排序），跳过 VCS / 依赖目录与 filter 拒绝的。 */
async function walk(root, filter = () => true, base = root, out = []) {
	let entries;
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(base, entry.name);
		const rel = toPosix(relative(root, full));
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			if (!filter(rel, true)) continue;
			await walk(root, filter, full, out);
		} else if (entry.isFile() && filter(rel, false)) out.push(rel);
	}
	return out.sort();
}

// ── 对象口径（导出与恢复共用一份，不许两边各写） ───────────────────────────

const dshHome = () => resolve(process.env.DSH_HOME ?? join(homedir(), ".dsh"));
const registryFile = () => resolve(homedir(), ".dsh", "dsh-studio", "mcp.json");
const extractorFile = () => resolve(homedir(), ".dsh", "dsh-studio", "extractor.json");

/** 配置文件层：id → 文件。credential = 含凭据字段（打包脱敏、恢复按目标机现值补回）；remap = 文本里的路径要随机器改。 */
export const CONFIG_OBJECTS = Object.freeze([
	{ id: "optimizer", file: optimizerConfigFile, label: "优化器配置" },
	{ id: "governance", file: governanceConfigFile, label: "治理配置" },
	{ id: "distill", file: distillConfigFile, label: "蒸馏配置" },
	{ id: "studio-backup", file: studioBackupConfigFile, label: "备份包配置" },
	{ id: "extractor", file: extractorFile, label: "提取器配置（extractor.json）", credential: true, remap: true }
]);

/** 数据区：id → 根目录。每个区根上的 config.json 属于配置层，不在这里重复。 */
export const DATA_AREAS = Object.freeze([
	{ id: "optimizer", root: optimizerRoot, label: "优化器数据（评估集 / 提案 / 报告 / 丢弃记录）" },
	{ id: "governance", root: governanceRoot, label: "治理数据（合并提案 / 冲突报告 / 教训）" },
	{ id: "distill", root: distillRoot, label: "蒸馏数据（草稿 / 报告 / 淘汰记录）" },
	{ id: "catalog-eval", root: catalogEvalRoot, label: "目录评测归档" }
]);

const dataFilter = (rel, isDir) => {
	const name = rel.split("/").pop() ?? "";
	if (name.startsWith(".")) return false;
	if (/\.lock$/i.test(name) || /\.tmp$/i.test(name)) return false;
	if (!isDir && rel === "config.json") return false;
	return true;
};

/** 技能根 → 稳定 id：两个默认 store 叫 dsh / agents，其余按顺序 root<i>。导出与恢复两端各自按本机算。 */
export function skillRootIds(roots) {
	const out = [];
	const seen = new Set();
	const cmp = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
	(roots ?? []).forEach((root, i) => {
		if (typeof root !== "string" || root.trim() === "") return;
		const abs = resolve(root);
		let id = cmp(abs) === cmp(join(dshHome(), "skills")) ? "dsh" : cmp(abs) === cmp(defaultAgentSkillDir()) ? "agents" : `root${i}`;
		if (seen.has(id)) id = `root${i}`;
		if (seen.has(id)) return;
		seen.add(id);
		out.push({ id, path: abs });
	});
	return out;
}

/** 根下的技能单元：目录（含嵌套 bundle，整个目录算一个单元）与根上的 `<name>.md`。 */
async function skillUnits(root) {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const e of entries) {
		if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
		if (e.isDirectory()) out.push({ name: e.name, kind: "dir" });
		else if (e.isFile() && /\.md$/i.test(e.name)) out.push({ name: e.name, kind: "file" });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 一个技能单元在本机的状态（只算 sha，不写对象库——dry-run 也要能算）：
 * {exists, kind, files: {rel: {sha, size}}}，口径与版本史 captureSkillState 相同（可直接比 sha）。
 */
async function localSkillState(target) {
	const info = await statOrNull(target);
	if (info === null) return { exists: false, kind: null, files: {} };
	const files = {};
	if (info.isDirectory()) {
		for (const rel of await walk(target)) {
			const abs = join(target, rel);
			files[rel] = { sha: await sha256OfFile(abs), size: (await stat(abs)).size };
		}
		return { exists: true, kind: "dir", files };
	}
	files[basename(target)] = { sha: await sha256OfFile(target), size: info.size };
	return { exists: true, kind: "file", files };
}

function sameFiles(a, b) {
	const ka = Object.keys(a ?? {}).sort();
	const kb = Object.keys(b ?? {}).sort();
	return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k].sha === b[k].sha);
}

// ── 存储 ───────────────────────────────────────────────────────────────────

const dirs = {
	packages: () => join(studioBackupRoot(), "packages"),
	restores: () => join(studioBackupRoot(), "restores"),
	state: () => join(studioBackupRoot(), "state.json"),
	opsLock: () => join(studioBackupRoot(), "ops")
};
const packageFile = (id) => join(dirs.packages(), id + ".tar.gz");
const sidecarFile = (id) => join(dirs.packages(), id + ".json");

export function assertPackageId(id) {
	const value = String(id ?? "").trim().replace(/\.tar\.gz$/i, "");
	if (!PACKAGE_ID.test(value)) throw new UserError(`备份包 id 不合法：${JSON.stringify(id)}（形如 studio-20261116-030000123-manual）`);
	return value;
}

/** 本地备份包列表（新的在前），信息取自旁挂的 <id>.json；旁挂丢了的只给最小信息。 */
export async function listPackages() {
	let names = [];
	try {
		names = await readdir(dirs.packages());
	} catch {
		return [];
	}
	const out = [];
	for (const name of names.filter((n) => n.endsWith(".tar.gz"))) {
		const id = name.slice(0, -".tar.gz".length);
		if (!PACKAGE_ID.test(id)) continue;
		const side = await readJson(sidecarFile(id), null);
		if (side) out.push(side);
		else {
			const st = await statOrNull(packageFile(id));
			out.push({ id, label: "", createdAt: st ? new Date(st.mtimeMs).toISOString() : null, bytes: st?.size ?? 0, sha256: null, summary: null });
		}
	}
	return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
}

async function saveSidecar(id, manifest, file) {
	const st = await stat(file);
	const side = { id, label: manifest.label, trigger: manifest.trigger, createdAt: manifest.createdAt, bytes: st.size, sha256: await sha256OfFile(file), source: manifest.source, summary: summaryOf(manifest), imported: manifest.imported ?? undefined };
	await atomicWriteFile(sidecarFile(id), JSON.stringify(clean(side), null, 2) + "\n", "utf8");
	return side;
}

function summaryOf(manifest) {
	const o = manifest.objects ?? {};
	return {
		registry: o.registry?.included ? o.registry.servers : null,
		config: (o.config ?? []).map((c) => c.id),
		skills: o.skills?.units?.length ?? 0,
		skillFilesSkipped: o.skills?.skippedFiles?.length ?? 0,
		historyRecords: o.history?.records ?? 0,
		historyObjects: o.history?.objects ?? 0,
		dataFiles: (o.data ?? []).reduce((n, a) => n + a.files, 0),
		entries: (manifest.entries ?? []).length,
		redacted: (manifest.redacted ?? []).reduce((n, r) => n + r.fields.length, 0)
	};
}

// ── 导出 ───────────────────────────────────────────────────────────────────

/**
 * 收集要进包的条目。返回 {entries, describe(written)}：entries 交给流式 tar 写出，
 * describe 在最后一条（清单）生成时调用，用写出时算的 sha 拼清单。
 */
async function collect(config, roots, pluginConfig) {
	const entries = [];
	const redacted = [];
	const objects = {};
	const inc = config.include;
	// 要恢复的对象（注册表 / 凭据配置）里有没有内嵌占位符：有就把包标成 schema 2，挡住旧版
	let embedded = false;

	// 注册表
	if (inc.registry) {
		const raw = await readOrNull(registryFile());
		if (raw !== null) {
			let parsed = null;
			try {
				parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
			} catch {
				parsed = null;
			}
			if (parsed === null) objects.registry = { included: false, reason: "mcp.json 无法解析，未打包（不能把可能含明文的原样打进可外推的包）" };
			else {
				const fields = redactCredentials(parsed);
				if (fields.length > 0) redacted.push({ object: "registry", fields });
				if (hasEmbeddedPlaceholder(parsed)) embedded = true;
				entries.push({ rel: "registry/mcp.json", data: Buffer.from(JSON.stringify(parsed, null, 2) + "\n", "utf8") });
				objects.registry = { included: true, version: parsed.version ?? 1, servers: Array.isArray(parsed.servers) ? parsed.servers.length : 0, names: (parsed.servers ?? []).map((s) => s?.name).filter((n) => typeof n === "string") };
			}
		} else objects.registry = { included: false, reason: "本机没有 mcp.json" };
	}

	// 配置文件层
	objects.config = [];
	if (inc.config) {
		for (const c of CONFIG_OBJECTS) {
			const raw = await readOrNull(c.file());
			if (raw === null) continue;
			let data = raw;
			if (c.credential) {
				let parsed;
				try {
					parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
				} catch {
					objects.config.push({ id: c.id, included: false, reason: "JSON 解析失败，未打包（含凭据字段的文件读不懂就不出机）" });
					continue;
				}
				const fields = redactCredentials(parsed);
				if (fields.length > 0) redacted.push({ object: `config:${c.id}`, fields });
				if (hasEmbeddedPlaceholder(parsed)) embedded = true;
				data = Buffer.from(JSON.stringify(parsed, null, 2) + "\n", "utf8");
			}
			entries.push({ rel: `config/${c.id}.json`, data });
			objects.config.push({ id: c.id, included: true, path: c.file() });
		}
	}

	// 技能
	const units = [];
	const skippedFiles = [];
	const rootIds = skillRootIds(roots);
	if (inc.skills) {
		for (const root of rootIds) {
			for (const unit of await skillUnits(root.path)) {
				const target = join(root.path, unit.name);
				const rels = unit.kind === "dir" ? await walk(target) : [unit.name];
				const files = {};
				for (const rel of rels) {
					const abs = unit.kind === "dir" ? join(target, rel) : target;
					const pkgRel = `skills/${root.id}/${unit.kind === "dir" ? unit.name + "/" + rel : unit.name}`;
					if (!isSafeEntryPath(pkgRel)) continue;
					const size = (await stat(abs)).size;
					if (config.maxSkillFileBytes > 0 && size > config.maxSkillFileBytes) {
						const sha = await sha256OfFile(abs);
						files[rel] = { sha, size, packed: false };
						skippedFiles.push({ root: root.id, skill: unit.name, path: rel, size, sha });
						continue;
					}
					files[rel] = { size, packed: true, entry: pkgRel };
					entries.push({ rel: pkgRel, abs });
				}
				units.push({ root: root.id, name: unit.name, kind: unit.kind, files });
			}
		}
	}

	// 版本史
	let historyRecords = 0;
	let historyObjects = 0;
	if (inc.history) {
		const root = historyRoot();
		const log = await readOrNull(join(root, HISTORY_LOG));
		if (log !== null) {
			historyRecords = parseVersionLog(log.toString("utf8")).length;
			entries.push({ rel: "history/" + HISTORY_LOG, abs: join(root, HISTORY_LOG) });
		}
		for (const rel of await walk(join(root, HISTORY_OBJECTS))) {
			if (!/^[0-9a-f]{2}\/[0-9a-f]{64}\.gz$/.test(rel)) continue;
			entries.push({ rel: `history/${HISTORY_OBJECTS}/${rel}`, abs: join(root, HISTORY_OBJECTS, rel) });
			historyObjects += 1;
		}
	}

	// 数据区
	objects.data = [];
	if (inc.data) {
		for (const area of DATA_AREAS) {
			const root = area.root();
			const rels = await walk(root, dataFilter);
			let n = 0;
			for (const rel of rels) {
				const pkgRel = `data/${area.id}/${rel}`;
				if (!isSafeEntryPath(pkgRel)) continue;
				entries.push({ rel: pkgRel, abs: join(root, rel) });
				n += 1;
			}
			objects.data.push({ id: area.id, path: root, files: n });
		}
	}

	// 插件配置行只作参考（归 DSH profile 管，由 .dsh 快照 / 每日备份负责），不恢复
	let reference = null;
	if (isObj(pluginConfig)) {
		const copy = clean(pluginConfig);
		const fields = redactCredentials(copy);
		if (fields.length > 0) redacted.push({ object: "reference:pluginConfig", fields });
		reference = { pluginConfig: copy, note: "插件配置行（profile 的 cordis.patch.yml）只作参考、恢复时不写回：它归 DSH profile 管，由 .dsh 快照 / 每日备份负责。" };
	}

	const describe = (written) => {
		const shaOf = new Map(written.map((w) => [w.rel, w]));
		for (const u of units) {
			for (const f of Object.values(u.files)) {
				if (!f.packed) continue;
				const w = shaOf.get(f.entry);
				f.sha = w?.sha ?? null;
				f.size = w?.bytes ?? f.size;
				delete f.entry;
			}
		}
		objects.skills = { included: inc.skills, roots: rootIds, units, skippedFiles };
		objects.history = { included: inc.history, path: historyRoot(), records: historyRecords, objects: historyObjects };
		return { objects, redacted, reference, entries: written.map((w) => ({ path: w.rel, bytes: w.bytes, sha256: w.sha })) };
	};
	return { entries, describe, embedded: () => embedded };
}

/**
 * 打一份备份包。
 * @param {{label?: string, trigger?: string, config: object, roots: string[], pluginConfig?: object, now?: number}} args
 */
async function exportPackageUnlocked(args) {
	const at = args.now ?? Date.now();
	const label = String(args.label ?? "manual").replace(/[^\w.-]+/g, "_").slice(0, 40) || "manual";
	const id = `studio-${stamp(at)}-${label}`;
	const { entries, describe, embedded } = await collect(args.config, args.roots, args.pluginConfig);
	let manifestBuf = null;
	const head = {
		format: PACKAGE_FORMAT,
		schema: embedded() ? PACKAGE_SCHEMA : SCHEMA_PLAIN,
		id,
		label,
		trigger: args.trigger ?? "manual",
		createdAt: new Date(at).toISOString(),
		plugin: { version: await pluginVersion() },
		source: { platform: platform(), home: toPosix(resolve(homedir())), historyRoot: toPosix(historyRoot()) }
	};
	entries.push({
		rel: MANIFEST_FILE,
		build: (written) => {
			manifestBuf = Buffer.from(JSON.stringify(clean({ ...head, ...describe(written) }), null, 2) + "\n", "utf8");
			return manifestBuf;
		}
	});
	entries.push({ rel: MANIFEST_SHA_FILE, build: () => Buffer.from(sha256(manifestBuf) + "\n", "utf8") });
	await mkdir(dirs.packages(), { recursive: true });
	const final = packageFile(id);
	const tmp = join(dirs.packages(), `.${id}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`);
	try {
		await writeTarGzStream(tmp, entries);
		await rename(tmp, final);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
	const manifest = JSON.parse(manifestBuf.toString("utf8"));
	const side = await saveSidecar(id, manifest, final);
	return { id, file: final, bytes: side.bytes, sha256: side.sha256, manifest, summary: side.summary };
}

async function pruneLabel(label, keep) {
	const doomed = (await listPackages()).filter((p) => p.label === label).slice(Math.max(0, keep));
	for (const p of doomed) await deletePackage(p.id);
	return doomed.map((p) => p.id);
}

export async function deletePackage(id) {
	const safe = assertPackageId(id);
	if ((await statOrNull(packageFile(safe))) === null) throw notFound("备份包不存在：" + safe);
	await rm(packageFile(safe), { force: true });
	await rm(sidecarFile(safe), { force: true });
	return { id: safe, deleted: true };
}

// ── 校验 ───────────────────────────────────────────────────────────────────

/**
 * 校验一份包（Buffer）。不抛：结论在 {ok, errors}；ok 时附解开的条目 Map 与清单。
 * @returns {{ok: boolean, errors: string[], manifest: object|null, files: Map<string, Buffer>|null, stats: object}}
 */
export function verifyPackageBuffer(buf) {
	const errors = [];
	let list;
	try {
		list = unpackTarGz(buf);
	} catch (error) {
		return { ok: false, errors: ["不是可解开的 tar.gz：" + errText(error)], manifest: null, files: null, stats: {} };
	}
	const files = new Map();
	for (const e of list) {
		if (files.has(e.rel)) errors.push("条目重复：" + e.rel);
		files.set(e.rel, e.data);
	}
	const manifestBuf = files.get(MANIFEST_FILE);
	const shaBuf = files.get(MANIFEST_SHA_FILE);
	if (manifestBuf === undefined) return { ok: false, errors: [...errors, "缺少 " + MANIFEST_FILE + "（不是 studio 备份包？.dsh 快照请用 skillmgr_snapshot_restore）"], manifest: null, files: null, stats: {} };
	if (shaBuf === undefined) errors.push("缺少 " + MANIFEST_SHA_FILE);
	else if (shaBuf.toString("utf8").trim() !== sha256(manifestBuf)) errors.push("清单 sha256 对不上（清单被改过或损坏）");
	let manifest = null;
	try {
		manifest = JSON.parse(manifestBuf.toString("utf8"));
	} catch {
		return { ok: false, errors: [...errors, "清单不是合法 JSON"], manifest: null, files: null, stats: {} };
	}
	if (manifest?.format !== PACKAGE_FORMAT) errors.push(`格式不对：${JSON.stringify(manifest?.format)}（期望 ${PACKAGE_FORMAT}）`);
	if (!Number.isInteger(manifest?.schema) || manifest.schema < 1) errors.push("清单缺少 schema");
	else if (manifest.schema > PACKAGE_SCHEMA) errors.push(`包的 schema ${manifest.schema} 比本插件认识的 ${PACKAGE_SCHEMA} 新：先升级 dsh-studio 再恢复`);
	const listed = new Map();
	for (const e of Array.isArray(manifest?.entries) ? manifest.entries : []) if (e && typeof e.path === "string") listed.set(e.path, e);
	let verified = 0;
	for (const [path, entry] of listed) {
		const data = files.get(path);
		if (data === undefined) {
			errors.push("清单里有、包里没有：" + path);
			continue;
		}
		if (data.length !== entry.bytes) errors.push(`字节数不符：${path}（清单 ${entry.bytes}，实际 ${data.length}）`);
		else if (sha256(data) !== entry.sha256) errors.push("sha256 不符：" + path);
		else verified += 1;
	}
	let historyObjects = 0;
	for (const [path, data] of files) {
		if (path === MANIFEST_FILE || path === MANIFEST_SHA_FILE) continue;
		if (!isSafeEntryPath(path) || !PREFIXES.some((p) => path.startsWith(p))) errors.push("不在已知前缀下的条目（拒收）：" + path);
		else if (!listed.has(path)) errors.push("清单外的条目（拒收）：" + path);
		const obj = /^history\/objects\/[0-9a-f]{2}\/([0-9a-f]{64})\.gz$/.exec(path);
		if (obj) {
			try {
				if (sha256(gunzipSync(data)) !== obj[1]) errors.push("版本史对象内容与 sha 不符：" + path);
				else historyObjects += 1;
			} catch {
				errors.push("版本史对象解不开：" + path);
			}
		}
	}
	return { ok: errors.length === 0, errors, manifest, files: errors.length === 0 ? files : null, stats: { entries: listed.size, verified, historyObjects } };
}

// ── 恢复 ───────────────────────────────────────────────────────────────────

/** 包里的文本按「来源机 home → 本机 home」+ 调用方 pathMap 改路径（remapText 同时处理 JSON 里的双反斜杠写法）。 */
function remapper(manifest, pathMap) {
	const pairs = [];
	const from = typeof manifest?.source?.home === "string" ? manifest.source.home : "";
	const to = toPosix(resolve(homedir()));
	if (from !== "" && from !== to) {
		pairs.push({ from, to });
		// Windows 来源：清单里是正斜杠，文件里多半是反斜杠
		if (/^[A-Za-z]:\//.test(from)) pairs.push({ from: from.replace(/\//g, "\\"), to: process.platform === "win32" ? to.replace(/\//g, "\\") : to });
	}
	for (const p of Array.isArray(pathMap) ? pathMap : []) if (p && typeof p.from === "string" && typeof p.to === "string") pairs.push({ from: p.from, to: p.to });
	return {
		pairs,
		buf: (buf) => remapText(buf, pairs).data,
		/** 绝对路径前缀替换（版本记录的 target 用）；没命中就原样返回，不 resolve（别处机器的 Windows 路径在本机 resolve 会变形）。 */
		path: (value) => {
			if (typeof value !== "string") return value;
			const slash = (x) => x.replace(/\\/g, "/").replace(/\/+$/, "");
			const norm = slash(value);
			for (const p of pairs) {
				const f = slash(p.from.trim());
				const t = p.to.trim();
				if (f === "" || t === "") continue;
				const ci = process.platform === "win32" || /^[A-Za-z]:\//.test(f);
				const hit = ci ? norm.toLowerCase() === f.toLowerCase() || norm.toLowerCase().startsWith(f.toLowerCase() + "/") : norm === f || norm.startsWith(f + "/");
				if (hit) return resolve(slash(t) + norm.slice(f.length));
			}
			return value;
		}
	};
}

/**
 * 版本链：ancestorId 是否是 descendantId 的祖先（含自身）。沿 parent（本机上一条）与 restoreOf
 * （恢复记录指向来源机那条）两条边往上找。
 */
function isAncestor(byId, ancestorId, descendantId) {
	const queue = [descendantId];
	const seen = new Set();
	while (queue.length > 0) {
		const id = queue.shift();
		if (id === ancestorId) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		const rec = byId.get(id);
		if (!rec) continue;
		if (rec.parent) queue.push(rec.parent);
		if (rec.restoreOf) queue.push(rec.restoreOf);
	}
	return false;
}

/** 某 key 下状态与 files 一致的全部记录（新的在前）。同一内容可能出现多次（回滚、跨机恢复）。 */
function allMatching(records, key, files) {
	const out = [];
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const r = records[i];
		if (r.key === key && r.state?.exists === true && sameFiles(r.state.files, files)) out.push(r);
	}
	return out;
}
const anyAncestor = (byId, from, to) => from.some((a) => to.some((d) => a.id !== d.id && isAncestor(byId, a.id, d.id)));

/** 去掉值为占位符的键：「包里有占位符、本机没这个键」不算配置不同（缺的凭据另由 needsCredentials 报）。 */
function stripRedacted(node) {
	if (Array.isArray(node)) return node.map(stripRedacted);
	if (!isObj(node)) return node;
	const out = {};
	for (const [k, v] of Object.entries(node)) if (v !== REDACTED) out[k] = stripRedacted(v);
	return out;
}

/**
 * 算恢复计划（dry-run 与真恢复共用）。不写盘。
 * 每项 {id, section, action, reason, detail?}；冲突项的 id 就是 resolutions 的键。
 */
async function planRestore(verified, opts) {
	const { manifest, files } = verified;
	const map = remapper(manifest, opts.pathMap);
	const resolutions = isObj(opts.resolutions) ? opts.resolutions : {};
	const items = [];
	const decide = (item, conflictReason) => {
		const r = resolutions[item.id];
		if (r === "package") return { ...item, action: "resolved-package", reason: conflictReason + "；所有者裁定用包内版本" };
		if (r === "local") return { ...item, action: "resolved-local", reason: conflictReason + "；所有者裁定保留本机" };
		return { ...item, action: "conflict", reason: conflictReason };
	};

	// 1) 版本史：按 id 取并集（不会冲突），target 路径随机器改
	const localRecords = parseVersionLog((await readOrNull(join(historyRoot(), HISTORY_LOG)))?.toString("utf8") ?? "");
	const localIds = new Set(localRecords.map((r) => r.id));
	const pkgLog = files.get("history/" + HISTORY_LOG);
	const incoming = pkgLog ? parseVersionLog(pkgLog.toString("utf8")).filter((r) => !localIds.has(r.id)).map((r) => (typeof r.target === "string" ? { ...r, target: map.path(r.target) } : r)) : [];
	const newObjects = [];
	for (const path of files.keys()) {
		const m = /^history\/objects\/([0-9a-f]{2})\/([0-9a-f]{64})\.gz$/.exec(path);
		if (m && (await statOrNull(join(historyRoot(), HISTORY_OBJECTS, m[1], m[2] + ".gz"))) === null) newObjects.push(path);
	}
	const mergedRecords = [...localRecords, ...incoming].sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
	const byId = new Map(mergedRecords.map((r) => [r.id, r]));
	if (manifest.objects?.history?.included) {
		items.push({ id: "history", section: "history", action: incoming.length + newObjects.length > 0 ? "merged" : "same", reason: incoming.length + newObjects.length > 0 ? `并入 ${incoming.length} 条版本记录、${newObjects.length} 个内容对象（按 id 取并集，本机记录一条不动）` : "本机已包含包里的全部版本记录与对象", detail: { newRecords: incoming.length, newObjects: newObjects.length }, _apply: { incoming, newObjects } });
	}

	// 2) 技能：按版本链判断
	const localRoots = new Map(skillRootIds(opts.roots).map((r) => [r.id, r.path]));
	for (const unit of manifest.objects?.skills?.units ?? []) {
		const id = `skill:${unit.root}/${unit.name}`;
		const base = { id, section: "skills", name: unit.name, root: unit.root };
		const rootPath = localRoots.get(unit.root);
		if (rootPath === undefined) {
			items.push({ ...base, action: "skipped", reason: `本机没有对应的技能根「${unit.root}」（来源机路径见清单 objects.skills.roots）` });
			continue;
		}
		const target = join(rootPath, unit.name);
		if (!isInside(rootPath, target) || !isSafeEntryPath(unit.name)) {
			items.push({ ...base, action: "skipped", reason: "技能名不安全，拒绝落盘" });
			continue;
		}
		const pkgFiles = {};
		for (const [rel, f] of Object.entries(unit.files ?? {})) pkgFiles[rel] = { sha: f.sha, size: f.size };
		const unpacked = Object.entries(unit.files ?? {}).filter(([, f]) => !f.packed).map(([rel, f]) => ({ path: rel, size: f.size, sha: f.sha }));
		const local = await localSkillState(target);
		// 比较时不看「包里没打包、本机也没有」的大文件：恢复不了它，也不该因此每次都报不同
		const cmpFiles = Object.fromEntries(Object.entries(pkgFiles).filter(([rel]) => unit.files[rel]?.packed !== false || local.files[rel] !== undefined));
		const withPlan = (item) => ({ ...item, target, ...(unpacked.length > 0 ? { detail: { unpackedLargeFiles: unpacked } } : {}), _apply: { unit, target, local } });
		if (!local.exists) {
			const P = allMatching(mergedRecords, skillKeyOf(target), pkgFiles)[0];
			items.push(withPlan({ ...base, action: "create", reason: "本机没有这个技能", ...(P ? { _restoreOf: P.id } : {}) }));
			continue;
		}
		if (sameFiles(local.files, cmpFiles)) {
			const absent = unpacked.filter((f) => local.files[f.path] === undefined).map((f) => f.path);
			items.push({ ...base, target, action: "same", reason: absent.length > 0 ? "内容与本机一致（包里只记了 sha 的大文件本机也没有，见 detail）" : "内容与本机一致", ...(absent.length > 0 ? { detail: { missingLargeFiles: absent } } : {}) });
			continue;
		}
		if (local.kind !== unit.kind) {
			items.push({ ...base, target, action: "conflict", reason: `形态冲突：本机是${local.kind === "dir" ? "目录" : "单文件"}、包里是${unit.kind === "dir" ? "目录" : "单文件"}，需手工处理（裁定不适用）` });
			continue;
		}
		const key = skillKeyOf(target);
		const Ps = allMatching(mergedRecords, key, pkgFiles);
		const Ls = allMatching(mergedRecords, key, local.files);
		const P = Ps[0];
		const L = Ls[0];
		if (P && L && anyAncestor(byId, Ls, Ps)) {
			items.push(withPlan({ ...base, action: "fast-forward", reason: `本机版本 ${L.id} 是包内版本 ${P.id} 的祖先：直接前进（本机现状已在版本史里，可回滚）`, _restoreOf: P.id }));
			continue;
		}
		if (P && L && anyAncestor(byId, Ps, Ls)) {
			items.push({ ...base, target, action: "kept-local", reason: `本机版本 ${L.id} 比包内版本 ${P.id} 新（包内版本是本机的祖先），保留本机` });
			continue;
		}
		const why = P && L ? `版本分叉：本机 ${L.id} 与包内 ${P.id} 各自改过，谁也不是谁的祖先` : `内容不同且版本链判断不了（${P ? "" : "包内现状不在版本史里"}${!P && !L ? "；" : ""}${L ? "" : "本机现状不在版本史里"}）`;
		items.push(withPlan({ ...decide(base, why), ...(P ? { _restoreOf: P.id } : {}) }));
	}

	// 3) 注册表：按 server 名对齐
	const regBuf = files.get("registry/mcp.json");
	if (regBuf) {
		const pkgReg = JSON.parse(map.buf(regBuf).toString("utf8"));
		const localRaw = (await readOrNull(registryFile()))?.toString("utf8") ?? null;
		let localReg = null;
		try {
			localReg = localRaw === null ? null : JSON.parse(localRaw.replace(/^\uFEFF/, ""));
		} catch {
			localReg = null;
		}
		if (localRaw !== null && localReg === null) {
			items.push({ id: "registry:*", section: "registry", action: "conflict", reason: "本机 mcp.json 无法解析：不在坏文件上合并，先修好或移走它再恢复（裁定不适用）" });
		} else {
			const localRedacted = localReg === null ? null : clean(localReg);
			if (localRedacted) redactCredentials(localRedacted);
			const semLocal = localRedacted ? semanticRegistry(stripRedacted(localRedacted)) : { servers: [] };
			const semPkg = semanticRegistry(stripRedacted(pkgReg));
			const localByName = new Map(semLocal.servers.map((s) => [s.name, s]));
			const regPlan = [];
			for (const server of semPkg.servers) {
				const id = `registry:${server.name}`;
				const base = { id, section: "registry", name: server.name };
				const mine = localByName.get(server.name);
				let item;
				if (mine === undefined) item = { ...base, action: "create", reason: "本机注册表没有这个 server" };
				else if (stableJson(mine) === stableJson(server)) item = { ...base, action: "same", reason: "与本机条目一致（凭据 / 运行时字段不比）" };
				else {
					const fields = [...new Set([...Object.keys(mine), ...Object.keys(server)])].filter((k) => stableJson(mine[k]) !== stableJson(server[k])).sort();
					item = decide(base, `同名 server 两边配置不同（${fields.join("、")}）`);
				}
				items.push(item);
				regPlan.push(item);
			}
			const settings = ["idleTimeoutMinutes", "toolDescriptionMaxLength"].filter((k) => pkgReg[k] !== undefined && localReg !== null && localReg[k] !== undefined && stableJson(pkgReg[k]) !== stableJson(localReg[k]));
			if (settings.length > 0) items.push(decide({ id: "registry:@settings", section: "registry", name: "@settings" }, `全局设置不同：${settings.map((k) => `${k} 本机 ${localReg[k]} / 包内 ${pkgReg[k]}`).join("；")}`));
			items._registry = { pkgReg, localReg };
		}
	}

	// 4) 配置文件层
	for (const c of CONFIG_OBJECTS) {
		const buf = files.get(`config/${c.id}.json`);
		if (!buf) continue;
		const id = `config:${c.id}`;
		const base = { id, section: "config", name: c.id, target: c.file() };
		const incomingBuf = c.remap ? map.buf(buf) : buf;
		const local = await readOrNull(c.file());
		let item;
		if (local === null) item = { ...base, action: "create", reason: "本机没有这份配置" };
		else {
			const norm = (b, redact) => {
				try {
					const v = JSON.parse(b.toString("utf8").replace(/^\uFEFF/, ""));
					if (redact) redactCredentials(v);
					return stableJson(stripRedacted(v));
				} catch {
					return b.toString("utf8");
				}
			};
			item = norm(local, c.credential) === norm(incomingBuf, false) ? { ...base, action: "same", reason: "与本机一致" } : decide(base, "两边配置不同");
		}
		items.push({ ...item, _apply: { c, data: incomingBuf } });
	}

	// 5) 数据区
	const areaRoots = new Map(DATA_AREAS.map((a) => [a.id, a.root()]));
	for (const [path, data] of files) {
		const m = /^data\/([^/]+)\/(.+)$/.exec(path);
		if (!m) continue;
		const root = areaRoots.get(m[1]);
		const rel = m[2];
		const id = `data:${m[1]}/${rel}`;
		const base = { id, section: "data", name: `${m[1]}/${rel}` };
		if (root === undefined) {
			items.push({ ...base, action: "skipped", reason: "不认识的数据区：" + m[1] });
			continue;
		}
		const target = join(root, ...rel.split("/"));
		if (!isInside(root, target)) {
			items.push({ ...base, action: "skipped", reason: "路径越界，拒绝落盘" });
			continue;
		}
		const local = await readOrNull(target);
		let item;
		if (local === null) item = { ...base, action: "create", reason: "本机没有" };
		else if (sha256(local) === sha256(data)) item = { ...base, action: "same", reason: "内容一致" };
		else if (/\.jsonl$/i.test(rel)) {
			const have = new Set(local.toString("utf8").split(/\r?\n/).filter((l) => l.trim() !== ""));
			const add = data.toString("utf8").split(/\r?\n/).filter((l) => l.trim() !== "" && !have.has(l));
			item = add.length === 0 ? { ...base, action: "same", reason: "包里的行本机都有" } : { ...base, action: "merged", reason: `追加型日志按行取并集：补 ${add.length} 行`, _lines: add };
		} else if (RUNTIME_STATE_FILES.has(basename(rel))) item = { ...base, action: "kept-local", reason: "运行时节奏状态，保留本机的" };
		else item = decide(base, "同一路径两边内容不同");
		items.push({ ...item, target, _apply: { target, data, lines: item._lines } });
	}
	return items;
}

const publicItem = (item) => {
	const { _apply, _lines, _restoreOf, ...rest } = item;
	return clean(rest);
};

async function applyItem(item, ctx) {
	const a = item._apply;
	if (item.section === "history") {
		await withHistoryLock(async () => {
			for (const path of a.newObjects) {
				const target = join(historyRoot(), ...path.slice("history/".length).split("/"));
				if ((await statOrNull(target)) !== null) continue;
				await atomicWriteFile(target, ctx.files.get(path), { mode: 0o600 });
			}
			// 锁内再读一次本机日志：按 id 取并集（与快照恢复同一个 mergeVersionLogText：本机记录一条不动），整份原子写回
			const current = (await readOrNull(join(historyRoot(), HISTORY_LOG)))?.toString("utf8") ?? "";
			const incomingText = a.incoming.map((r) => JSON.stringify(r)).join("\n");
			await atomicWriteFile(join(historyRoot(), HISTORY_LOG), mergeVersionLogText(incomingText, current), { encoding: "utf8", mode: 0o600 });
		});
		return {};
	}
	if (item.section === "skills") {
		const { unit, target } = a;
		const missingLarge = [];
		const keptLarge = [];
		// 本机某个文件「找不回来」= 两张安全网都不接：版本史只存 ≤ MAX_STORED_FILE_BYTES 的内容，
		// 恢复前保护包跳过 > maxSkillFileBytes 的文件（0 = 不设上限）。这样的文件既不许删也不许盖。
		const cap = Number(ctx.maxSkillFileBytes);
		const unrecoverable = (f) => f !== undefined && f.size > MAX_STORED_FILE_BYTES && Number.isFinite(cap) && cap > 0 && f.size > cap;
		await versionedSkillWrite(target, { action: "studio-restore", actor: ctx.actor, reason: `从 studio 备份包 ${ctx.packageId} 恢复（${ACTION_LABELS[item.action]}）`, ...(item._restoreOf ? { restoreOf: item._restoreOf } : {}) }, async () => {
			if (unit.kind === "file") {
				const f = unit.files[unit.name];
				if (!f?.packed) throw new UserError(`${unit.name} 超过单文件上限、包里只有 sha，无法恢复`);
				const cur = (await localSkillState(target)).files[basename(target)];
				if (cur !== undefined && cur.sha !== f.sha && unrecoverable(cur)) {
					throw new UserError(`本机 ${unit.name}（${cur.size} 字节）超过版本史与保护包的单文件上限，覆盖后无法找回；未改动。请先自行备份或移走再恢复`);
				}
				await atomicWriteFile(target, ctx.files.get(`skills/${unit.root}/${unit.name}`));
				return;
			}
			const now = await localSkillState(target);
			// 先查后写：会被覆盖的本机大文件若找不回来，整项拒绝（此时一个字节都还没写）
			const clobbered = Object.entries(unit.files)
				.filter(([rel, f]) => f.packed && now.files[rel] !== undefined && now.files[rel].sha !== f.sha && unrecoverable(now.files[rel]))
				.map(([rel]) => rel);
			if (clobbered.length > 0) {
				throw new UserError(`本机这些文件超过版本史与保护包的单文件上限，覆盖后无法找回；该技能未改动：${clobbered.join("、")}。请先自行备份或移走再恢复`);
			}
			for (const [rel, f] of Object.entries(unit.files)) {
				const abs = join(target, ...rel.split("/"));
				if (!isInside(target, abs) || !isSafeEntryPath(rel)) throw new UserError("包内技能路径越界：" + rel);
				if (!f.packed) {
					if (now.files[rel]?.sha !== f.sha) missingLarge.push(rel);
					continue;
				}
				if (now.files[rel]?.sha === f.sha) continue;
				await atomicWriteFile(abs, ctx.files.get(`skills/${unit.root}/${unit.name}/${rel}`));
			}
			// 包内版本没有、本机有的文件删掉（本机现状已由版本史 / 保护包记下，可回滚）；包里没打包的大文件不在此列。
			// 两张安全网都不接的大文件留在原地并报出来——旧写法照删，删完既不在保护包里也不在版本史里。
			for (const rel of Object.keys(now.files)) {
				if (Object.hasOwn(unit.files, rel)) continue;
				if (unrecoverable(now.files[rel])) {
					keptLarge.push(rel);
					continue;
				}
				const abs = join(target, ...rel.split("/"));
				if (isInside(target, abs)) await rm(abs, { force: true });
			}
		});
		ctx.changed.skills = true;
		return { ...(missingLarge.length > 0 ? { missingLargeFiles: missingLarge } : {}), ...(keptLarge.length > 0 ? { keptLargeFiles: keptLarge } : {}) };
	}
	if (item.section === "config") {
		const { c, data } = a;
		const file = c.file();
		let out = data;
		if (c.credential) {
			let current = null;
			try {
				current = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
			} catch {
				current = null;
			}
			const parsed = JSON.parse(data.toString("utf8"));
			const missing = [];
			const merged = mergeRedacted(parsed, current, missing);
			ctx.needsCredentials.push(...missing.map((field) => ({ object: item.id, field })));
			out = Buffer.from(JSON.stringify(merged, null, 2) + "\n", "utf8");
			await atomicWriteFile(file, out, { mode: CREDENTIAL_FILE_MODE });
			await hardenPermissions(file);
		} else await atomicWriteFile(file, out);
		return {};
	}
	if (item.section === "data") {
		if (item.action === "merged") {
			const cur = (await readOrNull(a.target))?.toString("utf8") ?? "";
			await atomicWriteFile(a.target, cur + (cur === "" || cur.endsWith("\n") ? "" : "\n") + a.lines.join("\n") + "\n", "utf8");
		} else await atomicWriteFile(a.target, a.data);
		return {};
	}
	return {};
}

/** 注册表一次写完（逐 server 的结论汇总成一份新注册表）。 */
async function applyRegistry(regItems, reg, ctx) {
	const apply = regItems.filter((i) => APPLY_ACTIONS.has(i.action));
	if (apply.length === 0) return;
	const { pkgReg, localReg } = reg;
	const pkgByName = new Map((pkgReg.servers ?? []).map((s) => [s.name, s]));
	const takeSettings = apply.some((i) => i.id === "registry:@settings");
	const base = localReg ?? { version: pkgReg.version, idleTimeoutMinutes: pkgReg.idleTimeoutMinutes, toolDescriptionMaxLength: pkgReg.toolDescriptionMaxLength, servers: [] };
	const next = { ...base, version: Math.max(Number(base.version) || 1, Number(pkgReg.version) || 1), servers: [...(base.servers ?? [])] };
	if (takeSettings || localReg === null) for (const k of ["idleTimeoutMinutes", "toolDescriptionMaxLength"]) if (pkgReg[k] !== undefined) next[k] = pkgReg[k];
	const desiredServers = [];
	for (const item of apply) {
		if (item.id === "registry:@settings") continue;
		const server = pkgByName.get(item.name);
		if (server === undefined) continue;
		desiredServers.push(server);
	}
	// 占位符按 server 名从本机现值 / 注销暂存补回（与回滚同一函数，不会串号）
	const merged = await mergeRegistryCredentials({ servers: desiredServers }, localReg, (name, field) => ctx.needsCredentials.push({ object: `registry:${name}`, field }));
	for (const server of merged.servers) {
		const at = next.servers.findIndex((s) => s?.name === server.name);
		if (at >= 0) next.servers[at] = server;
		else next.servers.push(server);
	}
	const file = registryFile();
	const write = async () => {
		await stashRemovedServers(removedServers(localReg?.servers ?? [], next.servers));
		await runWithWriteContext({ actor: ctx.actor, registryAction: "studio-restore", reason: `从 studio 备份包 ${ctx.packageId} 恢复：${apply.map((i) => i.name).join("、")}` }, () =>
			versionedRegistryWrite(file, {}, async () => {
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: CREDENTIAL_FILE_MODE });
				await hardenPermissions(file);
			})
		);
	};
	// 与 McpStore 的读-改-写串行（传了 store 的话），免得和后台工具缓存同步交错
	if (typeof ctx.registrySerial === "function") await ctx.registrySerial(write);
	else await write();
	ctx.changed.registry = true;
}

function renderReport(r) {
	const lines = [];
	lines.push(`# studio 备份包恢复${r.dryRun ? "（预演，未写盘）" : ""}：${r.packageId}`);
	lines.push("", `- 时间：${r.at}　操作者：${r.actor}`, `- 包：${r.packageId}（${r.package.createdAt ?? "—"} 打包于 ${r.package.source?.platform ?? "?"}，sha256 ${String(r.package.sha256 ?? "").slice(0, 16)}…）`, `- 校验：${r.verify.ok ? `通过（${r.verify.entries} 个条目逐一核对 sha256）` : "未通过"}`);
	if (r.preRestore) lines.push(`- 恢复前保护包：${r.preRestore}（要退回去：skillmgr_studio_restore {id:"${r.preRestore}"}）`);
	lines.push("", "## 汇总", "", Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `${ACTION_LABELS[k] ?? k} ${n}`).join(" · ") || "无");
	if (r.pending.length > 0) {
		lines.push("", `## 待裁冲突（${r.pending.length}）——未改动，等所有者裁定`, "");
		for (const p of r.pending) lines.push(`- \`${p.id}\`：${p.reason}`);
		lines.push("", "裁定后重跑：skillmgr_studio_restore {id, dryRun:false, resolutions:{\"<id>\":\"package\" 或 \"local\"}}");
	}
	if (r.needsCredentials.length > 0) {
		lines.push("", "## 需补凭据（包里没有明文凭据，本机也没有现值）", "");
		for (const n of r.needsCredentials) lines.push(`- ${n.object} · ${n.field}`);
	}
	const shown = r.items.filter((i) => i.action !== "same");
	if (shown.length > 0) {
		lines.push("", "## 明细（相同项略）", "");
		for (const i of shown) lines.push(`- [${ACTION_LABELS[i.action] ?? i.action}] \`${i.id}\`：${i.reason}${i.error ? "；错误：" + i.error : ""}${i.detail?.missingLargeFiles ? "；未能恢复的大文件：" + i.detail.missingLargeFiles.join("、") : ""}${i.detail?.keptLargeFiles ? "；本机保留未删的大文件（包内没有、删了找不回）：" + i.detail.keptLargeFiles.join("、") : ""}`);
	}
	if (r.reference) lines.push("", "## 参考（不写回）", "", r.reference);
	return lines.join("\n") + "\n";
}

// ── WebDAV（复用 sync.json 的 webdav 段） ─────────────────────────────────

async function remote(config) {
	const sync = await loadSync();
	const w = isObj(sync.webdav) ? sync.webdav : {};
	if (typeof w.url !== "string" || w.url.trim() === "") throw new UserError("sync.json 里没有配置 webdav.url：在面板「同步」里配好 WebDAV 通道（本功能复用那里的地址与凭据，不另存）");
	const root = await webdavBase(w);
	return { root, base: `${root}/${config.remoteDir}`, headers: webdavHeaders(w), host: (() => { try { return new URL(root).host; } catch { return ""; } })() };
}

async function davGetText(url, headers) {
	const res = await fetchWithTimeout(url, { headers });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`GET ${basename(url)} → HTTP ${res.status}`);
	return res.text();
}

async function davPut(url, headers, body) {
	const res = await fetchWithTimeout(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body }, 10 * 60_000);
	if (!res.ok) throw new Error(`PUT ${basename(url)} → HTTP ${res.status}`);
}

// ── 组装 ───────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   pluginConfig?: object,           插件配置行的 studioBackup 段
 *   fullPluginConfig?: object,       整个插件配置行（只作参考进清单，不恢复）
 *   skillRoots?: () => Promise<string[]> | string[],   技能根（index 里传优化回路的生效根）
 *   registrySerial?: (fn) => Promise<any>,              McpStore.serial
 *   onRegistryChange?: () => void, onSkillsChanged?: () => void,
 *   logger?: object, now?: () => number
 * }} deps
 */
export function createStudioBackup(deps = {}) {
	const now = typeof deps.now === "function" ? deps.now : () => Date.now();
	const logger = deps.logger ?? null;
	let lastActivityAt = now();
	let lastCheckAt = 0;
	let lastCheckEveryMs = 0;
	let running = null;

	async function effective() {
		const file = await readStudioBackupConfigFile();
		const { config, sources } = resolveStudioBackupConfig(deps.pluginConfig, file.value);
		return { config, sources, fileError: file.error };
	}
	async function roots() {
		const r = typeof deps.skillRoots === "function" ? await deps.skillRoots() : deps.skillRoots;
		return Array.isArray(r) && r.length > 0 ? r : [join(dshHome(), "skills"), defaultAgentSkillDir()];
	}
	/** 同一时刻只做一件事（打包 / 恢复 / 推拉），跨进程也排队。 */
	function exclusive(kind, fn) {
		const run = withFileLock(dirs.opsLock(), async () => {
			running = { kind, since: now() };
			try {
				return await fn();
			} finally {
				running = null;
			}
		}, { timeoutMs: 30 * 60_000 });
		return run;
	}
	async function readState() {
		return readJson(dirs.state(), {});
	}
	async function patchState(patch) {
		const s = { ...(await readState()), ...patch };
		await mkdir(studioBackupRoot(), { recursive: true });
		await atomicWriteFile(dirs.state(), JSON.stringify(clean(s), null, 2) + "\n", "utf8");
		return s;
	}

	async function exportPackage(args = {}) {
		const { config } = await effective();
		return exclusive("export", async () => {
			const r = await exportPackageUnlocked({ label: args.label, trigger: args.trigger ?? "manual", config, roots: await roots(), pluginConfig: deps.fullPluginConfig, now: now() });
			let copiedTo = null;
			if (typeof args.to === "string" && args.to.trim() !== "") {
				let dest = resolve(args.to.trim());
				const st = await statOrNull(dest);
				if (st?.isDirectory() || /[\\/]$/.test(args.to)) dest = join(dest, r.id + ".tar.gz");
				await mkdir(dirname(dest), { recursive: true });
				await copyFile(r.file, dest);
				copiedTo = dest;
			}
			const pruned = r.manifest.label === "scheduled" ? await pruneLabel("scheduled", config.keep) : r.manifest.label === "pre-restore" ? await pruneLabel("pre-restore", config.keepPreRestore) : [];
			return { id: r.id, file: r.file, bytes: r.bytes, sha256: r.sha256, summary: r.summary, redacted: r.manifest.redacted, skippedFiles: r.manifest.objects?.skills?.skippedFiles ?? [], copiedTo, pruned };
		});
	}

	async function loadPackage({ id, file }) {
		if (typeof file === "string" && file.trim() !== "") {
			const abs = resolve(file.trim());
			const buf = await readOrNull(abs);
			if (buf === null) throw notFound("读不到备份包文件：" + abs);
			return { buf, external: abs };
		}
		const safe = assertPackageId(id);
		const buf = await readOrNull(packageFile(safe));
		if (buf === null) throw notFound("备份包不存在：" + safe + "（skillmgr_studio_backup {action:\"status\"} 看本地有哪些包）");
		return { buf, external: null };
	}

	async function verify(args = {}) {
		const { buf, external } = await loadPackage(args);
		const v = verifyPackageBuffer(buf);
		return { ok: v.ok, errors: v.errors, id: v.manifest?.id ?? null, file: external, bytes: buf.length, sha256: sha256(buf), createdAt: v.manifest?.createdAt ?? null, source: v.manifest?.source ?? null, summary: v.manifest ? summaryOf(v.manifest) : null, stats: v.stats };
	}

	/** 把外部包文件收进本地 packages（已有同 id 且 sha 相同就复用；同 id 不同内容拒绝）。 */
	async function importBuffer(buf, manifest) {
		const id = assertPackageId(manifest.id);
		const existing = await readOrNull(packageFile(id));
		if (existing !== null) {
			if (sha256(existing) !== sha256(buf)) throw new UserError(`本地已有同 id 但内容不同的包 ${id}，拒绝覆盖（先删掉本地那份或改名）`);
			return id;
		}
		await mkdir(dirs.packages(), { recursive: true });
		await atomicWriteFile(packageFile(id), buf);
		await saveSidecar(id, { ...manifest, imported: true }, packageFile(id));
		return id;
	}

	async function restore(args = {}) {
		const dryRun = args.dryRun !== false;
		const actor = typeof args.actor === "string" && args.actor !== "" ? args.actor : "studio-restore";
		return exclusive("restore", async () => {
			const { buf, external } = await loadPackage(args);
			const v = verifyPackageBuffer(buf);
			if (!v.ok) throw new UserError("备份包校验未通过，未做任何改动：\n- " + v.errors.slice(0, 10).join("\n- ") + (v.errors.length > 10 ? `\n…共 ${v.errors.length} 条` : ""), 400);
			const packageId = !dryRun && external !== null ? await importBuffer(buf, v.manifest) : v.manifest.id;
			const opts = { resolutions: args.resolutions, pathMap: args.pathMap, roots: await roots() };
			const items = await planRestore(v, opts);
			const reg = items._registry;
			const at = now();
			const report = {
				id: `restore-${stamp(at)}-${randomBytes(3).toString("hex")}`,
				at: new Date(at).toISOString(),
				dryRun,
				actor,
				packageId,
				package: { createdAt: v.manifest.createdAt, source: v.manifest.source, sha256: sha256(buf), file: external },
				verify: { ok: true, entries: v.stats.entries },
				preRestore: null,
				items: [],
				counts: {},
				pending: [],
				needsCredentials: [],
				reference: v.manifest.reference?.note ?? null,
				changed: {}
			};
			const ctx = { actor, packageId, files: v.files, needsCredentials: report.needsCredentials, changed: report.changed, registrySerial: deps.registrySerial };
			if (!dryRun) {
				// 写盘前给本机现状打一份保护包：保护包没打成就一个字节都不写（.dsh 被清空过的教训）
				const willWrite = items.some((i) => APPLY_ACTIONS.has(i.action));
				if (willWrite) {
					const { config } = await effective();
					ctx.maxSkillFileBytes = config.maxSkillFileBytes;
					try {
						const pre = await exportPackageUnlocked({ label: "pre-restore", trigger: "pre-restore", config, roots: opts.roots, pluginConfig: deps.fullPluginConfig, now: now() });
						report.preRestore = pre.id;
						await pruneLabel("pre-restore", config.keepPreRestore).catch(() => {});
					} catch (error) {
						throw new UserError("恢复前保护包没打成，未做任何改动：" + errText(error), 500);
					}
				}
				// 顺序：技能 → 注册表 → 配置 → 数据 → 版本史最后并入。
				// 技能先写：写入时本机版本史的最后一条就是本机现状，studio-restore 记录直接接在它后面（restoreOf 指向包内版本）；
				// 版本史若先并入，包内更晚的记录会排到最后，写入就会被误判成「插件外改动」补出一条假 baseline。
				// 版本链的判断在计划阶段已用「本机 ∪ 包内」的内存并集算完，不依赖落盘顺序。
				for (const section of ["skills", "config", "data", "history"]) {
					if (section === "config" && reg) {
						const regItems = items.filter((i) => i.section === "registry");
						try {
							await applyRegistry(regItems, reg, ctx);
						} catch (error) {
							for (const i of regItems) if (APPLY_ACTIONS.has(i.action)) Object.assign(i, { action: "failed", error: errText(error) });
						}
					}
					for (const item of items.filter((i) => i.section === section && APPLY_ACTIONS.has(i.action))) {
						try {
							const extra = await applyItem(item, ctx);
							if (extra.missingLargeFiles) item.detail = { ...(item.detail ?? {}), missingLargeFiles: extra.missingLargeFiles };
							if (extra.keptLargeFiles) item.detail = { ...(item.detail ?? {}), keptLargeFiles: extra.keptLargeFiles };
						} catch (error) {
							item.error = errText(error);
							item.action = "failed";
						}
					}
				}
			} else if (reg) {
				// 预演也要报出会缺哪些凭据：按本机现值算一遍，不落盘
				const pkgByName = new Map((reg.pkgReg.servers ?? []).map((s) => [s.name, s]));
				const desired = items.filter((i) => i.section === "registry" && APPLY_ACTIONS.has(i.action) && pkgByName.has(i.name)).map((i) => pkgByName.get(i.name));
				await mergeRegistryCredentials({ servers: desired }, reg.localReg, (name, field) => report.needsCredentials.push({ object: `registry:${name}`, field }));
				for (const item of items.filter((i) => i.section === "config" && APPLY_ACTIONS.has(i.action) && i._apply.c.credential)) {
					const current = await readJson(item._apply.c.file(), null);
					const parsed = JSON.parse(item._apply.data.toString("utf8"));
					const missing = [];
					mergeRedacted(parsed, current, missing);
					report.needsCredentials.push(...missing.map((field) => ({ object: item.id, field })));
				}
			}
			report.items = items.map(publicItem);
			for (const i of report.items) report.counts[i.action] = (report.counts[i.action] ?? 0) + 1;
			report.pending = report.items.filter((i) => i.action === "conflict").map((i) => ({ id: i.id, section: i.section, reason: i.reason }));
			report.markdown = renderReport(report);
			// 恢复全程留痕：预演与真恢复都落一份报告
			await mkdir(dirs.restores(), { recursive: true });
			await atomicWriteFile(join(dirs.restores(), report.id + ".json"), JSON.stringify(clean(report), null, 2) + "\n", "utf8");
			await atomicWriteFile(join(dirs.restores(), report.id + ".md"), report.markdown, "utf8");
			if (!dryRun) {
				await patchState({ lastRestore: { id: report.id, at: report.at, packageId, pending: report.pending.length, failed: report.counts.failed ?? 0 } }).catch(() => {});
				if (report.changed.registry) {
					try {
						deps.onRegistryChange?.();
					} catch {
						/* 重挂失败不影响恢复结果 */
					}
				}
				if (report.changed.skills) {
					try {
						deps.onSkillsChanged?.();
					} catch {
						/* 同上 */
					}
				}
				logger?.info?.(`[dsh-studio] studio 备份包恢复 ${packageId}：${Object.entries(report.counts).map(([k, n]) => `${k} ${n}`).join("、")}`);
			}
			return clean(report);
		});
	}

	async function listRestores(limit = 10) {
		let names = [];
		try {
			names = (await readdir(dirs.restores())).filter((n) => n.endsWith(".json")).sort().reverse();
		} catch {
			return [];
		}
		const out = [];
		for (const n of names.slice(0, limit)) {
			const r = await readJson(join(dirs.restores(), n), null);
			if (r) out.push({ id: r.id, at: r.at, dryRun: r.dryRun, packageId: r.packageId, counts: r.counts, pending: r.pending?.length ?? 0, needsCredentials: r.needsCredentials?.length ?? 0, preRestore: r.preRestore ?? null });
		}
		return out;
	}

	async function getRestoreReport(id) {
		const value = String(id ?? "").trim();
		if (!RESTORE_ID.test(value)) throw new UserError("恢复报告 id 不合法：" + JSON.stringify(id));
		const r = await readJson(join(dirs.restores(), value + ".json"), null);
		if (r === null) throw notFound("没有这份恢复报告：" + value);
		return r;
	}

	async function push(args = {}) {
		const { config } = await effective();
		return exclusive("push", async () => {
			const list = await listPackages();
			const id = args.id ? assertPackageId(args.id) : list[0]?.id;
			if (!id) throw new UserError("本地还没有备份包：先 export 一份");
			const buf = await readOrNull(packageFile(id));
			if (buf === null) throw notFound("备份包不存在：" + id);
			const r = await remote(config);
			await webdavEnsureDir(r.root, r.headers);
			await webdavEnsureDir(r.base, r.headers);
			const digest = sha256(buf);
			await davPut(`${r.base}/${id}.tar.gz`, r.headers, buf);
			await davPut(`${r.base}/${id}.tar.gz.sha256`, r.headers, Buffer.from(digest + "\n", "utf8"));
			let index = [];
			try {
				const t = await davGetText(`${r.base}/INDEX.json`, r.headers);
				index = t === null ? [] : (JSON.parse(t).packages ?? []);
			} catch {
				index = [];
			}
			index = [...index.filter((p) => p?.id !== id), { id, sha256: digest, bytes: buf.length, pushedAt: new Date(now()).toISOString() }];
			const removed = [];
			if (config.remoteKeep > 0) {
				while (index.length > config.remoteKeep) {
					const old = index.shift();
					if (!old?.id || !PACKAGE_ID.test(old.id)) continue;
					for (const name of [`${old.id}.tar.gz`, `${old.id}.tar.gz.sha256`]) await fetchWithTimeout(`${r.base}/${name}`, { method: "DELETE", headers: r.headers }).catch(() => null);
					removed.push(old.id);
				}
			}
			await davPut(`${r.base}/INDEX.json`, r.headers, Buffer.from(JSON.stringify({ format: PACKAGE_FORMAT, packages: index }, null, 2) + "\n", "utf8"));
			// LATEST 是远端当前版本的唯一指针，最后写；写失败就不算推成功
			await davPut(`${r.base}/LATEST`, r.headers, Buffer.from(id + "\n", "utf8"));
			const result = { id, pushed: true, host: r.host, remoteDir: config.remoteDir, sha256: digest, bytes: buf.length, remoteRemoved: removed };
			await patchState({ lastPush: { at: new Date(now()).toISOString(), id, ok: true } }).catch(() => {});
			return result;
		});
	}

	async function pull(args = {}) {
		const { config } = await effective();
		return exclusive("pull", async () => {
			const r = await remote(config);
			const id = args.id ? assertPackageId(args.id) : String((await davGetText(`${r.base}/LATEST`, r.headers)) ?? "").trim();
			if (id === "") throw new UserError("远端没有 LATEST：那边还没推过 studio 备份包");
			assertPackageId(id);
			const res = await fetchWithTimeout(`${r.base}/${id}.tar.gz`, { headers: r.headers }, 10 * 60_000);
			if (!res.ok) throw new Error(`GET ${id}.tar.gz → HTTP ${res.status}`);
			const buf = Buffer.from(await res.arrayBuffer());
			const expect = String((await davGetText(`${r.base}/${id}.tar.gz.sha256`, r.headers)) ?? "").trim();
			if (expect !== "" && expect !== sha256(buf)) throw new UserError(`下载的包 sha256 与远端记录不符（${id}），已丢弃`);
			const v = verifyPackageBuffer(buf);
			if (!v.ok) throw new UserError("下载的包校验未通过，已丢弃：" + v.errors.slice(0, 5).join("；"));
			const localId = await importBuffer(buf, v.manifest);
			return { id: localId, pulled: true, host: r.host, bytes: buf.length, sha256: sha256(buf), summary: summaryOf(v.manifest), checksumChecked: expect !== "" };
		});
	}

	async function tick() {
		const t = now();
		// 审计 10：节流判断提到读配置之前（用上次读到的 checkEveryMinutes；首次为 0 不节流），
		// 每分钟的定时器不再每次都读一遍配置文件；读到新配置后按新值再判一次，口径不变
		if (t - lastCheckAt < lastCheckEveryMs) return { ran: false, reason: "throttled" };
		const { config } = await effective();
		lastCheckEveryMs = config.checkEveryMinutes * 60_000;
		if (t - lastCheckAt < lastCheckEveryMs) return { ran: false, reason: "throttled" };
		lastCheckAt = t;
		if (config.enabled !== true) return { ran: false, reason: "disabled" };
		if (!inIdleWindow(config.idleWindow, t)) return { ran: false, reason: "outside-window" };
		if (t - lastActivityAt < config.idleMinutes * 60_000) return { ran: false, reason: "busy" };
		const state = await readState();
		if (t - Number(state.lastAutoAt || 0) < config.minIntervalHours * 3_600_000) return { ran: false, reason: "too-soon" };
		if (running !== null) return { ran: false, reason: "running" };
		let result;
		try {
			result = await exportPackage({ label: "scheduled", trigger: "auto" });
		} catch (error) {
			// 不记 lastAutoAt：失败不该把下一次尝试推迟一整天（窗口内按 checkEveryMinutes 再试）
			await patchState({ lastStatus: "error", lastError: errText(error), lastErrorAt: new Date(t).toISOString() }).catch(() => {});
			throw error;
		}
		let pushed = null;
		if (config.autoPush) {
			try {
				pushed = await push({ id: result.id });
			} catch (error) {
				pushed = { pushed: false, error: errText(error) };
				await patchState({ lastPush: { at: new Date(now()).toISOString(), id: result.id, ok: false, error: errText(error) } }).catch(() => {});
				logger?.warn?.("[dsh-studio] studio 备份包推送 WebDAV 失败：" + errText(error));
			}
		}
		await patchState({ lastAutoAt: t, lastAutoId: result.id, lastStatus: "ok", lastError: "" });
		return { ran: true, reason: "ok", id: result.id, pushed };
	}

	async function status() {
		const eff = await effective();
		let remoteInfo = { configured: false, host: "" };
		try {
			const r = await remote(eff.config);
			remoteInfo = { configured: true, host: r.host, dir: eff.config.remoteDir };
		} catch {
			/* 没配 WebDAV */
		}
		return clean({
			dir: studioBackupRoot(),
			config: eff.config,
			sources: eff.sources,
			fileError: eff.fileError,
			schedule: { ...(await readState()), inWindowNow: inIdleWindow(eff.config.idleWindow, now()), running },
			packages: await listPackages(),
			restores: await listRestores(),
			remote: remoteInfo,
			objects: {
				registry: registryFile(),
				config: CONFIG_OBJECTS.map((c) => ({ id: c.id, label: c.label, path: c.file() })),
				skills: skillRootIds(await roots()),
				history: historyRoot(),
				data: DATA_AREAS.map((a) => ({ id: a.id, label: a.label, path: a.root() }))
			}
		});
	}

	return { effective, exportPackage, verify, restore, push, pull, tick, status, listPackages, listRestores, getRestoreReport, deletePackage, noteActivity: () => (lastActivityAt = now()) };
}
