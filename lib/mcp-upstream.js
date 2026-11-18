/**
 * MCP server 上游版本检查（只读）。给 mcp_update_check 用。
 *
 * 来源判定按证据强度分三层，取第一个命中的：
 *   npm   —— command/args 落在 node_modules/<pkg>/ 里：本地 package.json 版本 vs registry latest。
 *   git   —— cwd 或 args 里存在的路径向上找到 .git：origin HEAD vs 本地 HEAD。
 *   notes —— 备注里显式写的 owner/repo@sha（inline launcher 型，没有 .git 也没有包名）。
 * 都命中不了（streamable-http、纯本地目录）落 unknown-source，并把原因说清楚。
 *
 * 只比「相同 / 不同」，不排大小：本地版本领先上游是开发中的正常态，用两串版本号
 * 直接摆出来比一个假的大小判断更诚实。不下载、不更新、不改注册表。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fetchWithTimeout } from "./http.js";
import { maskUrlSecrets } from "./redact.js";
import { lsRemoteSha } from "./upstream.js";

const execFileAsync = promisify(execFile);
/** node_modules/<pkg>/…，兼容 scoped（node_modules/@scope/name/…）与 pnpm 的 .pnpm 布局 */
const NM_RE = /[\\/]node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/;
/** 备注里的 owner/repo 与可选的短 sha：Fanqi89/dsh-craft-anything@e5abcb2 */
const NOTES_REPO_RE = /(?:github\.com[\\/:])?([\w.-]+\/[\w.-]+)(?:@([0-9a-f]{7,40}))?/i;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** 从文件路径向上找 .git 的层数上限（别一路走到盘符） */
const ASCEND_LIMIT = 5;

function isDir(target) {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function isFile(target) {
	try {
		return fs.statSync(target).isFile();
	} catch {
		return false;
	}
}

function readJson(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/** 把 `owner/repo`、`https://github.com/owner/repo.git`、`git@github.com:owner/repo` 归一成 https 仓库根。 */
function normalizeRepo(raw) {
	const text = String(raw ?? "")
		.trim()
		.replace(/^git@([^:]+):/, "https://$1/")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
	if (text === "") return "";
	if (/^https?:\/\//i.test(text)) return text;
	if (/^[\w.-]+\/[\w.-]+$/.test(text)) return "https://github.com/" + text;
	return "";
}

/** command + args 里出现的所有绝对路径（args 里既有脚本路径也可能有相对路径，相对的不算）。 */
function absolutePaths(entry) {
	const out = [];
	for (const raw of [entry.command, ...(entry.args ?? [])]) {
		const text = String(raw ?? "").trim();
		if (text === "") continue;
		if (path.isAbsolute(text)) out.push(text);
	}
	return out;
}

/**
 * 从一条注册表记录判定上游。同步、纯本地、不联网。
 * @returns {null | {via:"npm", pkg:string, pkgRoot:string, localVersion:string}
 *              | {via:"git", repo:string, localSha:string, dir:string}
 *              | {via:"notes", repo:string, localSha:string}}
 */
export function probeServerSource(entry) {
	const paths = absolutePaths(entry);

	// ---- npm：args 里出现 node_modules/<pkg>/ 就是包安装
	for (const p of paths) {
		const hit = NM_RE.exec(p);
		if (hit === null) continue;
		const pkg = hit[1].replace(/\\/g, "/");
		// hit[0] 是 `…/node_modules/<pkg>`，结尾正好是包根
		const pkgRoot = path.resolve(p.slice(0, hit.index + hit[0].length));
		const manifest = readJson(path.join(pkgRoot, "package.json"));
		if (manifest === null) continue;
		return {
			via: "npm",
			pkg: typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : pkg,
			pkgRoot,
			localVersion: String(manifest.version ?? "")
		};
	}

	// ---- git：cwd 或脚本路径所在目录向上找 .git
	const starts = [];
	if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") starts.push(path.resolve(entry.cwd.trim()));
	for (const p of paths) starts.push(isDir(p) ? p : path.dirname(p));
	for (const start of starts) {
		let dir = start;
		for (let i = 0; i <= ASCEND_LIMIT; i += 1) {
			if (isDir(path.join(dir, ".git"))) {
				return { via: "git", repo: "", localSha: "", dir };
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	// ---- notes：没有仓库也没有包，但备注里写明了来源仓库
	const notes = String(entry.notes ?? "");
	const m = NOTES_REPO_RE.exec(notes);
	if (m !== null && /github\.com|[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}/i.test(notes)) {
		const repo = normalizeRepo(m[1]);
		if (repo !== "") {
			return { via: "notes", repo, localSha: SHA_RE.test(m[2] ?? "") ? String(m[2]).toLowerCase() : "" };
		}
	}

	return null;
}

/** 读本地 git 仓库的 origin 与 HEAD；本地没有 .git 或读不出 origin 就返回 null。 */
async function readGitLocal(dir, timeoutMs) {
	const run = async (args) => {
		try {
			const { stdout } = await execFileAsync("git", ["-C", dir, ...args], { timeout: timeoutMs, windowsHide: true });
			return String(stdout ?? "").trim();
		} catch {
			return "";
		}
	};
	const origin = normalizeRepo(await run(["remote", "get-url", "origin"]));
	if (origin === "") return null;
	const sha = (await run(["rev-parse", "HEAD"])).toLowerCase();
	return { repo: origin, localSha: SHA_RE.test(sha) ? sha : "" };
}

/** 查 npm registry 的 latest 版本；包不存在（404）与网络失败分开报。 */
async function fetchNpmLatest(pkg, { timeoutMs, fetchImpl }) {
	const url = "https://registry.npmjs.org/" + pkg.replace("/", "%2f") + "/latest";
	const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, timeoutMs, fetchImpl);
	if (response.status === 404) return { status: "not-published" };
	if (!response.ok) throw new Error("registry " + response.status + " " + pkg);
	const body = await response.json();
	const version = String(body?.version ?? "");
	if (version === "") throw new Error("registry 没给版本号：" + pkg);
	return { status: "ok", version };
}

/**
 * 检查一批 server 的上游版本。
 * status: latest（与上游一致）/ behind（与上游不同）/ unknown-source（没有可判定的上游）/ failed（查询失败）
 */
export async function checkServerUpdates(entries, options = {}) {
	const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000;
	const fetchImpl = options.fetchImpl ?? fetch;
	const lsRemote = options.lsRemote ?? lsRemoteSha;
	const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : 0;

	const results = await Promise.all(
		(entries ?? []).map(async (entry) => {
			const base = { name: entry.name, via: "", source: "", localVersion: "", remoteVersion: "", status: "unknown-source", note: "" };
			let probe;
			try {
				probe = probeServerSource(entry);
			} catch (error) {
				return { ...base, status: "failed", note: String(error?.message ?? error).slice(0, 200) };
			}
			if (probe === null) {
				return { ...base, note: entry.transport === "streamable-http" ? "远程 HTTP 端点，没有可比的版本" : "本地目录，既不是 npm 包也没有 .git origin" };
			}

			// ---- npm
			if (probe.via === "npm") {
				const out = { ...base, via: "npm", source: probe.pkg, localVersion: probe.localVersion };
				try {
					const remote = await fetchNpmLatest(probe.pkg, { timeoutMs, fetchImpl });
					if (remote.status === "not-published") {
						return { ...out, status: "unknown-source", note: "npm 上没有这个包（本地私有/未发布）" };
					}
					const same = remote.version === probe.localVersion;
					return { ...out, remoteVersion: remote.version, status: same ? "latest" : "behind" };
				} catch (error) {
					return { ...out, status: "failed", note: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200) };
				}
			}

			// ---- git（本地 .git）与 notes（备注声明的仓库）共用 ls-remote
			let repo = probe.repo;
			let localSha = probe.localSha;
			if (probe.via === "git") {
				const local = await readGitLocal(probe.dir, timeoutMs);
				if (local === null) {
					return { ...base, via: "git", note: "有 .git 但读不出 origin" };
				}
				repo = local.repo;
				localSha = local.localSha;
			}
			// source 会进工具返回值与面板：origin 可能是 https://user:token@… 形态，展示前抹掉 userinfo
			const out = { ...base, via: probe.via, source: maskUrlSecrets(repo), localVersion: localSha.slice(0, 7) };
			if (localSha === "") return { ...out, status: "unknown-source", note: "只知道上游仓库，本地没有可比的 commit" };
			try {
				const remote = await lsRemote(repo, "", { timeoutMs, ttlMs });
				// notes 型只有短 sha，用前缀比；git 型两边都是全长 sha
				const same = localSha.length === 40 ? remote === localSha : remote.startsWith(localSha);
				return { ...out, remoteVersion: remote.slice(0, 7), status: same ? "latest" : "behind" };
			} catch (error) {
				return { ...out, status: "failed", note: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200) };
			}
		})
	);
	return results;
}
