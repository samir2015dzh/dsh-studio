/**
 * 技能回收站。
 *
 * 删技能不直接 rm：把整个技能目录（或根目录下的单个 .md 文件）Move 到
 * `~/.dsh/dsh-studio/trash/<时间戳>-<名>/`，同目录写一份 manifest.json 记录原路径；
 * 恢复时按 manifest 搬回去。
 *
 * 一个「批次目录」可以装多个条目（批量删除），也可以只有一条（面板上删单个技能）。
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { assertSnapshotId, isInside } from "./paths.js";
import { removeDirForcibly } from "./command.js";
import { UserError, notFound } from "./errors.js";
import { invalidateScanCache, isUnderSkillRoot } from "./scanner.js";
import { versionedSkillWrite } from "./versions.js";
import { atomicWriteFile } from "./fs-atomic.js";

export function trashRoot() {
	return resolve(homedir(), ".dsh", "dsh-studio", "trash");
}

/** 批次 id 带毫秒：同秒连删两个同名 skill 时不会互相覆盖（BUG-15）。 */
function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * 校验一条 manifest 记录：`to` 必须在本批次目录内，`from` 必须落在某个 skill 根内。
 * 根目录以「当前扫描根」为准，旧批次则接受写入时记下的 `root`（项目级技能换了 cwd 也能恢复）。
 * manifest 是外部数据（可被手改），直接拿去 rm/move 等于把路径控制权交出去（S-06）。
 */
async function assertRestorableEntry(item, batch, cwd) {
	const name = typeof item?.name === "string" ? item.name : "";
	if (name === "") throw new UserError("回收站 manifest 缺 name");
	const to = typeof item?.to === "string" && item.to !== "" ? item.to : join(batch, name);
	if (!isInside(batch, to)) throw new UserError(`回收站 manifest 的 to 越出批次目录：${to}`);
	const from = typeof item?.from === "string" ? item.from : "";
	if (from === "") throw new UserError(`回收站 manifest 的 from 不在 skill 根内：${from}`);
	const liveRoot = await isUnderSkillRoot(from, cwd);
	const recordedRoot = typeof item.root === "string" ? item.root : "";
	if (liveRoot === null && (recordedRoot === "" || !isInside(recordedRoot, from))) {
		throw new UserError(`回收站 manifest 的 from 不在 skill 根内：${from}`);
	}
	return { name, from, to, root: liveRoot ?? recordedRoot };
}

async function pathExists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(p) {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

/** 跨盘 rename 会 EXDEV，退化成 copy + rm。文件和目录都能搬。 */
async function movePath(from, to) {
	try {
		await rename(from, to);
	} catch (error) {
		if (error?.code !== "EXDEV") throw error;
		if (await isDirectory(from)) await cp(from, to, { recursive: true });
		else await cp(from, to);
		await rm(from, { recursive: true, force: true });
	}
}

/** 列出回收站里的全部批次。 */
export async function listTrash() {
	const root = trashRoot();
	let dirs;
	try {
		dirs = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const entry of dirs) {
		if (!entry.isDirectory()) continue;
		const base = join(root, entry.name);
		let manifest;
		try {
			const parsed = JSON.parse(await readFile(join(base, "manifest.json"), "utf8"));
			manifest = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			continue; // 没有 manifest 的目录不认
		}
		const items = [];
		for (const item of manifest) {
			if (typeof item?.name !== "string") continue;
			const to = item.to ?? join(base, item.name);
			items.push({
				name: item.name,
				from: item.from ?? "",
				present: await pathExists(to)
			});
		}
		if (items.length === 0) continue;
		out.push({ id: entry.name, path: base, entries: items });
	}
	return out.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * 决定真正要搬的路径：目录技能搬整个技能目录；根上的单个 .md 只搬那个文件。
 * 绝不允许把技能根目录本身扔进回收站。
 */
async function resolveTrashSource(skill, cwd) {
	const dir = skill.dir;
	if (typeof dir !== "string" || dir === "") throw new UserError("内置技能不能删除。");
	const root = await isUnderSkillRoot(dir, cwd);
	if (root === null) throw new UserError("只能删除技能根目录里的技能。");
	const filePath = typeof skill.path === "string" ? skill.path : "";
	let from;
	if (resolve(dir) === resolve(root)) {
		if (filePath === "" || resolve(filePath) === resolve(root) || !isInside(root, filePath)) {
			throw new UserError("不能把整个技能根目录扔进回收站。");
		}
		from = filePath;
	} else {
		from = dir;
		if (resolve(from) === resolve(root) || !isInside(root, from)) {
			throw new UserError("不能把整个技能根目录扔进回收站。");
		}
	}
	if ((await pathExists(from)) === false) throw new UserError("目录不存在：" + from, 404);
	return { from, root };
}

/**
 * 把一个技能目录（或根上的单个 .md）移进回收站。
 * @param {{name:string, dir:string, path?:string}} skill 扫描结果里的条目
 * @param {{cwd?:string, meta?:{action?:string, reason?:string, merge?:object}}} [opts]
 */
export async function trashSkill(skill, { cwd, meta } = {}) {
	const { from, root } = await resolveTrashSource(skill, cwd);
	const trash = trashRoot();
	await mkdir(trash, { recursive: true });
	const safeName = skill.name.replace(/[^\w.-]+/g, "_");
	const id = `${stamp()}-${safeName}`;
	const batch = join(trash, id);
	await mkdir(batch, { recursive: true });
	const to = join(batch, basename(from));
	// C2：manifest 先落（原子写）、再搬目录。以前反过来：搬完、写 manifest 之前崩了，技能从库里消失、
	// 回收站面板又看不见这个批次（没有 manifest 的批次不列），等于丢了。现在最坏是 manifest 在、目录还没搬：
	// 面板里显示「不在」，技能仍在原处，什么都没丢。搬失败就把这个空批次撤掉。
	await atomicWriteFile(join(batch, "manifest.json"), JSON.stringify([{ name: skill.name, from, to, root, at: Date.now() }], null, 2), "utf8");
	try {
		// · G2：移入回收站 = 该 skill 的一个「不存在」版本；回滚可以再把它拿回来
		// meta：被合并的来源以 action=merge-archive 入站，并带 merge 溯源字段
		await versionedSkillWrite(from, { action: "delete", reason: "移入回收站 " + id, ...(meta ?? {}), ...(meta?.reason ? { reason: meta.reason + "（回收站 " + id + "）" } : {}) }, () => movePath(from, to));
	} catch (error) {
		if (!(await pathExists(to))) await removeDirForcibly(batch).catch(() => {});
		throw error;
	}
	invalidateScanCache();
	return { id, from, to };
}

/** 从回收站搬回原位置。name 省略时恢复整个批次。 */
export async function restoreTrash(id, name, { cwd } = {}) {
	const batch = join(trashRoot(), assertSnapshotId(id));
	let manifest;
	try {
		const parsed = JSON.parse(await readFile(join(batch, "manifest.json"), "utf8"));
		manifest = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		throw notFound("找不到批次：" + id);
	}
	const targets = name === undefined || name === "" ? manifest : manifest.filter((item) => item.name === name);
	if (targets.length === 0) throw notFound(`批次 ${id} 里没有 "${name}"`);
	const done = [];
	for (const item of targets) {
		const entry = await assertRestorableEntry(item, batch, cwd);
		if ((await pathExists(entry.to)) === false) continue; // 已经被恢复或手动删了
		const parent = dirname(entry.from);
		if ((await pathExists(parent)) === false) throw new UserError("原目录已不存在：" + parent, 404);
		if (await pathExists(entry.from)) throw new UserError("目标位置已有同名项：" + entry.from);
		await versionedSkillWrite(entry.from, { action: "restore", reason: "从回收站 " + id + " 恢复" }, () => movePath(entry.to, entry.from));
		done.push(entry.name);
	}
	// 批次空了就清掉，否则把剩下的写回去
	const remaining = manifest.filter((item) => !done.includes(item.name));
	if (remaining.length === 0) await removeDirForcibly(batch);
	else await atomicWriteFile(join(batch, "manifest.json"), JSON.stringify(remaining, null, 2), "utf8");
	invalidateScanCache();
	return { id, restored: done };
}

/** 永久删除回收站里的条目（name 省略时删整个批次）。 */
export async function purgeTrash(id, name) {
	const batch = join(trashRoot(), assertSnapshotId(id));
	let manifest;
	try {
		const parsed = JSON.parse(await readFile(join(batch, "manifest.json"), "utf8"));
		manifest = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		throw notFound("找不到批次：" + id);
	}
	if (name === undefined || name === "") {
		await removeDirForcibly(batch);
		invalidateScanCache();
		return { id, purged: manifest.map((item) => item.name) };
	}
	const item = manifest.find((x) => x.name === name);
	if (item === undefined) throw notFound(`批次 ${id} 里没有 "${name}"`);
	const to = typeof item.to === "string" && item.to !== "" ? item.to : join(batch, item.name);
	// 只允许删批次目录里的东西：manifest 被改过也不能把 rm 指到外面（S-06）
	if (!isInside(batch, to)) throw new UserError(`回收站 manifest 的 to 越出批次目录：${to}`);
	await removeDirForcibly(to);
	const remaining = manifest.filter((x) => x.name !== name);
	if (remaining.length === 0) await removeDirForcibly(batch);
	else await atomicWriteFile(join(batch, "manifest.json"), JSON.stringify(remaining, null, 2), "utf8");
	invalidateScanCache();
	return { id, purged: [name] };
}
