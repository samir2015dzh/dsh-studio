/**
 * 把一个技能打包成 .tar.gz，方便拷到别的机器再用「从仓库/压缩包导入」。
 * 目录技能打成 <name>/SKILL.md 及同目录其它文件；根上的单个 .md 只打该文件。
 * 跳过 node_modules 与版本库元数据，避免把依赖或 .git 打进去。
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { findSkillByName } from "./scanner.js";
import { packTarGz } from "./snapshot.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { UserError } from "./errors.js";

const SKIP = [/(^|[\\/])node_modules([\\/]|$)/, /(^|[\\/])\.(git|svn|hg)([\\/]|$)/i];

function isSkipped(rel) {
	return SKIP.some((re) => re.test(rel));
}

async function walkFiles(root, dir, out) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		const rel = relative(root, full);
		if (isSkipped(rel)) continue;
		if (entry.isDirectory()) await walkFiles(root, full, out);
		else if (entry.isFile()) out.push(full);
	}
}

function defaultExportPath(name) {
	return join(homedir(), ".dsh", "dsh-studio", "exports", `${name}.tar.gz`);
}

/** 没填路径时写到 ~/.dsh/dsh-studio/exports/<name>.tar.gz；填了目录则在下面生成文件名。 */
export function resolveExportPath(targetPath, name) {
	const trimmed = typeof targetPath === "string" ? targetPath.trim() : "";
	if (trimmed === "") return defaultExportPath(name);
	const dest = resolve(trimmed);
	if (dest.endsWith(".tar.gz") || dest.endsWith(".tgz")) return dest;
	return join(dest, `${name}.tar.gz`);
}

function isLooseMarkdown(skill) {
	return basename(skill.path).toLowerCase() !== "skill.md";
}

/**
 * @param {{ name: string, path?: string, cwd?: string }} args
 * @returns {Promise<{ ok: true, path: string, bytes: number, files: number, name: string }>}
 */
export async function exportSkill(args) {
	const name = typeof args?.name === "string" ? args.name.trim() : "";
	if (name === "") throw new UserError("请提供要导出的技能名。");
	const skill = await findSkillByName(name, args.cwd);
	if (!skill) throw new UserError("找不到这个技能：" + name, 404);
	if (typeof skill.path !== "string" || skill.path === "") {
		throw new UserError("这个技能没有可导出的文件（可能是内置技能）。");
	}

	/** @type {{ rel: string, data: Buffer }[]} */
	const entries = [];
	if (isLooseMarkdown(skill)) {
		entries.push({ rel: basename(skill.path), data: await readFile(skill.path) });
	} else {
		const root = skill.dir || dirname(skill.path);
		const files = [];
		await walkFiles(root, root, files);
		const prefix = basename(root);
		for (const file of files) {
			const rel = [prefix, ...relative(root, file).split(sep).filter(Boolean)].join("/");
			entries.push({ rel, data: await readFile(file) });
		}
	}
	if (entries.length === 0) throw new UserError("这个技能里没有可以打包的文件。");

	const dest = resolveExportPath(args.path, skill.name);
	const archive = packTarGz(entries);
	await atomicWriteFile(dest, archive);
	return { ok: true, path: dest, bytes: archive.length, files: entries.length, name: skill.name };
}
