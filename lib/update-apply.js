/**
 * 技能更新应用（N-01）：把 `skillmgr_update_check` 报出的「有新版」真正落地。
 *
 * 分工：update_check（lib/upstream.js）只读比对版本；本模块负责写入侧 —— 取包、组装新树、
 * 备份旧目录、同卷换位、写 lock，全部成功才动安装目录。
 *
 * 三条不变式都是 2026-11-07 那晚手工升级 5 个花叔 skill 时踩出来的：
 *   1. 备份必须落在两棵扫描根之外 —— 那次备份放进技能根，被 listSkillDirs 当成 5 个幽灵技能；
 *   2. 拉取失败 / 包里没有 SKILL.md / 组装失败 → 安装目录零改动（失败点在 stage 里写明）；
 *   3. 旧目录有、上游没有的文件带进新目录（`.git` 与 `SKILL.md.bak-group` 除外），
 *      典型是 `.huashu-skill-meta.json`；里面的 commit 标记换成新 commit。
 *
 * 只用既有通道：来源解析 parseSkillSource、取包 resolveSkillPackage、commit 用 resolveSourceCommit
 * （git ls-remote）、lock 记录用 lockRecordFor。不新增任何代理配置，也不设持久化环境变量。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { isInside, splitSourceUrl } from "./paths.js";
import { loadLock, lockPath, lockRecordFor, parseSkillSource, resolveSkillPackage, resolveSourceCommit, saveLock } from "./skillsrc.js";
import { listSkillDirs, lsRemoteSha, resolveUpstream } from "./upstream.js";
import { withFileLock } from "./state-lock.js";
import { captureSkillBefore, recordSkillAfter } from "./versions.js";

/** 旧检出的版本库内脏（新溯源由 lock.commit 承载）与工具自管的原件备份，都不走保留通道。 */
const SKIP_NAMES = new Set([".git", "SKILL.md.bak-group"]);

/** 插件数据目录：备份与临时组装区都落在这里，天然在扫描根之外。 */
export function pluginDataDir() {
	return path.join(homedir(), ".dsh", "dsh-studio");
}

export function defaultBackupsRoot() {
	return path.join(pluginDataDir(), "skill-backups");
}

const tsOf = (now) => new Date(now).toISOString().replace(/[:.]/g, "-");

/** 每个技能保留的更新前备份份数（B5）。 */
export const BACKUPS_KEEP_PER_SKILL = 3;

/**
 * 删掉某个技能多出来的旧备份：`<root>/<时间戳>/<name>`，按时间戳（目录名，ISO 形态可直接按字典序比）保留最近
 * keep 份；时间戳目录删空了顺手删掉。失败不影响更新本身。
 * @returns {number} 删掉的份数
 */
export function pruneSkillBackups(root, name, keep = BACKUPS_KEEP_PER_SKILL) {
	let stamps = [];
	try {
		stamps = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return 0;
	}
	const mine = stamps.filter((stamp) => fs.existsSync(path.join(root, stamp, name))).sort().reverse();
	let removed = 0;
	for (const stamp of mine.slice(keep)) {
		try {
			fs.rmSync(path.join(root, stamp, name), { recursive: true, force: true });
			removed += 1;
			if (fs.readdirSync(path.join(root, stamp)).length === 0) fs.rmdirSync(path.join(root, stamp));
		} catch {
			/* 删不掉就留着，下次再试 */
		}
	}
	return removed;
}
const rand = () => Math.random().toString(36).slice(2, 8);

/** 目录树 → Map<相对路径, Buffer>。跳过 .git 与 SKILL.md.bak-group（见 SKIP_NAMES）。 */
function listTree(root, prefix = "") {
	const out = new Map();
	let entries;
	try {
		entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (SKIP_NAMES.has(entry.name)) continue;
		const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
		if (entry.isDirectory()) {
			for (const [key, data] of listTree(root, rel)) out.set(key, data);
		} else if (entry.isFile()) {
			try {
				out.set(rel, fs.readFileSync(path.join(root, rel)));
			} catch {
				/* 单个文件读不了就当它不在，别让整次应用失败 */
			}
		}
	}
	return out;
}

/** frontmatter 边界：block 为 null 表示没有 frontmatter，此时体改原样返回。 */
function splitFront(text) {
	const nl = text.includes("\r\n") ? "\r\n" : "\n";
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?/);
	if (m === null) return { block: null, body: text, nl, tail: "" };
	return { block: m[1], body: text.slice(m[0].length), nl, tail: m[0].slice(m[0].lastIndexOf("---") + 3) };
}

/** 读 frontmatter 里 metadata.group 的值（没有就空串）。 */
function readGroup(text) {
	const { block } = splitFront(text);
	if (block === null) return "";
	let inMeta = false;
	for (const line of block.split(/\r?\n/)) {
		if (/^metadata\s*:/.test(line)) {
			inMeta = true;
			continue;
		}
		if (!inMeta) continue;
		if (/^[A-Za-z0-9_.-]+\s*:/.test(line)) {
			inMeta = false;
			continue;
		}
		const m = /^\s+group\s*:\s*(.+)$/.exec(line);
		if (m !== null) return m[1].trim().replace(/^["']|["']$/g, "");
	}
	return "";
}

/**
 * 只补 metadata.group，一行不动其余内容 —— 验收要求「剥掉 group 行后与上游原件逐字节相等」，
 * 所以不能走 extractor 的 rewriteFrontmatterBlock（它会重写 name/description 的引号形态）。
 * group 的写法与 extractor 同款：`metadata:` + 两空格缩进 `group: <值>`。
 * @returns {string|null} null = frontmatter 缺失或 metadata 是内联形态，不强行改
 */
function addGroup(text, group) {
	const { block, body, nl, tail } = splitFront(text);
	if (block === null) return null;
	const lines = block.split(/\r?\n/);
	let start = -1;
	for (let i = 0; i < lines.length; i += 1) {
		if (/^metadata\s*:/.test(lines[i])) {
			start = i;
			break;
		}
	}
	const rebuild = (next) => "---" + nl + next + nl + "---" + tail + body;
	if (start === -1) return rebuild([...lines, "metadata:", `  group: ${group}`].join(nl));
	// metadata 是内联映射（metadata: {a: b}）时插行会破坏结构，交给调用方报告
	if (!/^metadata\s*:\s*$/.test(lines[start])) return null;
	let end = start + 1;
	while (end < lines.length && !/^[A-Za-z0-9_.-]+\s*:/.test(lines[end])) end += 1;
	while (end - 1 > start && lines[end - 1].trim() === "") end -= 1;
	return rebuild([...lines.slice(0, end), `  group: ${group}`, ...lines.slice(end)].join(nl));
}

/** 保留文件里的溯源标记：JSON 解析成功且顶层 commit 是字符串 → 换成新 commit。 */
function rebaseCommitMark(data, newCommit) {
	if (newCommit === "") return data;
	let parsed;
	try {
		parsed = JSON.parse(data.toString("utf8"));
	} catch {
		return data;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.commit !== "string") return data;
	parsed.commit = newCommit;
	return Buffer.from(JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

/** 失败/成功共用的返回骨架：每个键都在注册 output schema 里声明过。 */
function baseResult(name) {
	return {
		ok: false,
		message: "",
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
		lockUpdated: []
	};
}

/**
 * 应用一个技能的更新（点名调用，一次只处理一个）。
 * @param {{name:string, roots:string[], lock?:object, fetchImpl?:typeof fetch, now?:number,
 *   backupsRoot?:string, timeoutMs?:number, ttlMs?:number}} options
 * @returns {Promise<object>} 结构化结果；失败时带 stage（locate/source/fetch/assemble/swap/lock）
 */
export async function applySkillUpdate(options = {}) {
	const name = String(options.name ?? "").trim();
	const out = baseResult(name);
	const fail = (stage, message, patch = {}) => ({ ...out, ...patch, ok: false, message, stage });
	const roots = (Array.isArray(options.roots) ? options.roots : []).filter((dir) => typeof dir === "string" && dir !== "");
	const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
	const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000;
	const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? Number(options.ttlMs) : 0;
	const backupsRoot = typeof options.backupsRoot === "string" && options.backupsRoot !== "" ? path.resolve(options.backupsRoot) : defaultBackupsRoot();

	// ---- stage locate：按名在两棵扫描根里定位已安装目录
	if (name === "") return fail("locate", "缺少 name：必须点名一个技能，不接受「全部/通配」");
	if (roots.length === 0) return fail("locate", "没有可用的 skill 扫描根");
	const installed = listSkillDirs(roots).filter((skill) => skill.name === name.toLowerCase());
	if (installed.length === 0) return fail("locate", `没有安装名为 ${name} 的 skill（扫描根：${roots.join(" · ")}）`);
	const dir = installed[0].dir;

	// ---- stage source：准入 —— 只有 lock 里有可判定来源时才允许应用
	const table = options.lock ?? (await loadLock());
	const lockKey = Object.keys(table).find((key) => key.toLowerCase() === name.toLowerCase());
	const rec = lockKey === undefined ? undefined : table[lockKey];
	if (rec === undefined || rec === null || typeof rec !== "object" || Array.isArray(rec)) {
		return fail("source", `skill-lock.json 里没有 ${name} 的来源记录，无法确定上游`);
	}
	const sourceText = typeof rec.source === "string" ? rec.source.trim() : "";
	if (sourceText === "") return fail("source", `skill-lock.json 里 ${name} 的来源为空，无法确定上游`);
	let parsed;
	try {
		parsed = parseSkillSource(sourceText);
	} catch (error) {
		return fail("source", `来源不是可解析的 GitHub 仓库地址（${String(error?.message ?? error)}）`);
	}
	if (parsed.kind !== "github") {
		return fail("source", `来源是本地 tarball 路径（${parsed.path}），没有可比的远端仓库，无法应用更新`);
	}
	const split = splitSourceUrl(sourceText);
	const ref = String(rec.ref ?? "").trim() || split.ref;
	if (ref === "") return fail("source", `来源 ${parsed.owner}/${parsed.repo} 没有 ref，无法确定要拉哪个版本`);
	const subPath = (typeof rec.subPath === "string" ? rec.subPath : split.subdir).trim().replace(/^\/+|\/+$/g, "");
	const repoRoot = `https://github.com/${parsed.owner}/${parsed.repo}`;
	const pullSource =
		subPath === ""
			? `${repoRoot}/tree/${encodeURIComponent(ref)}`
			: `${repoRoot}/tree/${encodeURIComponent(ref)}/${subPath.split("/").map((seg) => encodeURIComponent(seg)).join("/")}`;

	// ---- 版本比较：本地 commit 走 resolveUpstream 的既有优先级（lock.commit → .git HEAD → meta.commit）
	const up = await resolveUpstream(dir, { lock: table });
	const oldCommit = String(up?.localSha ?? "");
	let upstreamCommit;
	try {
		upstreamCommit = await lsRemoteSha(repoRoot, ref, { timeoutMs, ttlMs });
	} catch (error) {
		const reason = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200);
		return fail("fetch", `取上游 ${ref} 的 commit 失败：${reason}`, { oldCommit });
	}
	if (oldCommit !== "" && upstreamCommit === oldCommit) {
		return {
			...out,
			ok: true,
			changed: false,
			oldCommit,
			newCommit: upstreamCommit,
			message: `已是最新（${repoRoot}@${ref} 停在 ${oldCommit.slice(0, 7)}），未备份、未拉取、未写 lock`
		};
	}

	// ---- stage fetch：取包（tarball 字节的 sha256 与 lock 同源，都出自 resolveSkillPackage）
	let pkg;
	try {
		pkg = await resolveSkillPackage(pullSource, { fetchImpl: options.fetchImpl });
	} catch (error) {
		const reason = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200);
		return fail("fetch", `拉取失败：${reason}`, { oldCommit, newCommit: upstreamCommit });
	}

	// ---- stage assemble：在临时区组装新树（安装目录一动不动）
	const oldFiles = listTree(dir);
	const newTree = new Map();
	for (const file of pkg.found.files) newTree.set(file.rel, file.data);

	const preserved = [];
	for (const [rel, data] of oldFiles) {
		if (newTree.has(rel)) continue;
		newTree.set(rel, data);
		preserved.push(rel);
	}

	// 保留下来的溯源文件换成新 commit；JSON 坏了原样留着，不拖垮整次应用
	for (const rel of preserved) {
		const data = newTree.get(rel);
		if (!rel.toLowerCase().endsWith(".json")) continue;
		newTree.set(rel, rebaseCommitMark(data, upstreamCommit));
	}

	// 标注重打：旧 SKILL.md 有 metadata.group、新上游没有 → 先把原件存在 bak-group，再补回
	let annotationReapplied = false;
	let note = "";
	const oldSkill = oldFiles.get("SKILL.md");
	const newSkill = newTree.get("SKILL.md");
	if (oldSkill !== undefined && newSkill !== undefined) {
		const oldGroup = readGroup(oldSkill.toString("utf8"));
		const newText = newSkill.toString("utf8");
		const newGroup = readGroup(newText);
		if (oldGroup !== "" && newGroup === "") {
			const patched = addGroup(newText, oldGroup);
			if (patched === null) note = " · 上游 SKILL.md 无可用 frontmatter，未重打 metadata.group";
			else {
				newTree.set("SKILL.md.bak-group", newSkill);
				newTree.set("SKILL.md", Buffer.from(patched, "utf8"));
				annotationReapplied = true;
			}
		}
	}

	if (!newTree.has("SKILL.md")) return fail("assemble", "组装结果里没有 SKILL.md，未改动安装目录", { oldCommit, newCommit: upstreamCommit });

	// ---- 备份：整份复制到数据目录，且必须断言不在任何扫描根之内
	const backupPath = path.join(backupsRoot, tsOf(now), name);
	const insideRoot = roots.find((root) => isInside(root, backupPath));
	if (insideRoot !== undefined) {
		return fail("assemble", `备份路径落在扫描根内（${insideRoot}），拒绝执行以免制造幽灵技能`, { oldCommit, newCommit: upstreamCommit });
	}
	const tmpRoot = path.join(pluginDataDir(), "skill-tmp", `${name}-${tsOf(now)}-${rand()}`);
	const tmpNew = path.join(tmpRoot, "new");
	const tmpOld = path.join(tmpRoot, "old");
	// · G2：换位前取一次状态，换位成功后记一条 update 版本（失败路径零改动，不记）
	const versionBefore = await captureSkillBefore(dir);
	try {
		try {
			fs.mkdirSync(path.dirname(backupPath), { recursive: true });
			fs.cpSync(dir, backupPath, { recursive: true, force: true });
		} catch (error) {
			return fail("assemble", `备份旧目录失败：${String(error?.message ?? error)}`, { oldCommit, newCommit: upstreamCommit });
		}
		try {
			for (const [rel, data] of newTree) {
				const target = path.join(tmpNew, rel);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, data);
			}
		} catch (error) {
			return fail("assemble", `组装新树失败：${String(error?.message ?? error)}`, { oldCommit, newCommit: upstreamCommit });
		}

		// ---- stage swap：同卷改名换位。第一步失败就零改动退出；第二步失败尝试还原
		// ponytail: 只走同卷 rename —— 临时区在插件数据目录下，与安装目录不同卷时第一步会 EXDEV，
		// 此时按 stage:swap 零改动返回。真要支持跨卷，改成 cp + rm 的慢路径并接受非原子替换。
		try {
			fs.renameSync(dir, tmpOld);
		} catch (error) {
			return fail("swap", `无法把旧目录移出（${String(error?.message ?? error)}），安装目录未改动`, {
				oldCommit,
				newCommit: upstreamCommit,
				backupPath
			});
		}
		try {
			fs.renameSync(tmpNew, dir);
		} catch (error) {
			let restored = false;
			try {
				fs.renameSync(tmpOld, dir);
				restored = true;
			} catch {
				/* 还原失败也要如实报告，备份路径已给 */
			}
			return fail(
				"swap",
				`新树就位失败（${String(error?.message ?? error)}）；${restored ? "已用旧目录还原" : "旧目录还原失败，请用备份恢复"}：${backupPath}`,
				{ oldCommit, newCommit: upstreamCommit, backupPath }
			);
		}
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
	await recordSkillAfter(dir, versionBefore, { action: "update", reason: `上游更新 ${oldCommit || "?"} → ${upstreamCommit || "?"}` });

	// ---- stage lock：文件就位之后才写 lock（写失败不回滚文件，如实报告）
	const newCommit = await resolveSourceCommit(pkg.parsed, { timeoutMs });
	const record = lockRecordFor(pkg.parsed, { sha256: pkg.sha256, now, commit: newCommit });
	// 取不到 commit 就显式留空：update_check 会落到「无法比对」，不许伪造可判 latest
	if (newCommit === "") record.commit = "";
	const prev = table[lockKey] ?? {};
	const lockUpdated = Object.keys(record)
		.filter((key) => String(prev[key] ?? "") !== String(record[key] ?? ""))
		.sort();
	try {
		// N-06：176 行那次读只用于判定；写入侧进锁后重新 load 最新 lock 再合并本条记录，
		// 不拿几秒前（中间夹着 git ls-remote 与整树下载）的旧表覆盖同期别人的写入。
		// options.lock 是调用方显式注入的整表（测试用），维持既有语义。
		await withFileLock(lockPath(), async () => {
			const base = options.lock ?? (await loadLock());
			await saveLock({ ...base, [lockKey]: record });
		});
	} catch (error) {
		return fail("lock", `文件已更新为新版本（${backupPath}），但写 lock 失败：${String(error?.message ?? error)}`, {
			oldCommit,
			newCommit,
			backupPath,
			preservedFiles: preserved.sort(),
			annotationReapplied
		});
	}

	// B5：更新前备份以前只增不减；同一个技能只留最近 BACKUPS_KEEP_PER_SKILL 份
	const prunedBackups = pruneSkillBackups(backupsRoot, name);
	const added = [...newTree.keys()].filter((rel) => !oldFiles.has(rel)).length;
	const deleted = [...oldFiles.keys()].filter((rel) => !newTree.has(rel)).length;
	const modified = [...newTree.keys()].filter((rel) => oldFiles.has(rel) && !oldFiles.get(rel).equals(newTree.get(rel))).length;
	const short = (sha) => (sha === "" ? "?" : sha.slice(0, 7));
	return {
		...out,
		ok: true,
		changed: true,
		oldCommit,
		newCommit,
		added,
		deleted,
		modified,
		backupPath,
		prunedBackups,
		preservedFiles: preserved.sort(),
		annotationReapplied,
		lockUpdated,
		message:
			`已应用 ${name}：${short(oldCommit)}→${short(upstreamCommit)} · 文件 +${added}/-${deleted}/~${modified}` +
			(annotationReapplied ? " · 已按旧值重打 metadata.group" : "") +
			(preserved.length > 0 ? ` · 保留本地文件 ${preserved.length} 个` : "") +
			` · 备份 ${backupPath}` +
			(newCommit === "" ? " · 新 commit 取不到，lock 的 commit 留空（update_check 会判「无法比对」）" : "") +
			note
	};
}
