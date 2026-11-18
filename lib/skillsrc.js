/**
 * 从 GitHub 仓库 / tarball 导入 skill（WO-BORROW-6）。
 *
 * 设计参考：
 * - functy23/dsh-mcp-studio 的 `repos.ts` / `repos.utils.ts` / `tar.ts`
 *   （仓库与 tarball 导入、目录内 SKILL.md 根自动探测）
 * - vercel-labs/skills（MIT）的 `src/local-lock.ts`（source + ref + 内容哈希锁文件）
 *   与 `src/agents.ts`（多 agent 目录探测表）
 * 两个仓库都不在本机、本次未取到源码，按需求自行实现，未移植其代码。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isInside, isSafeEntryPath } from "./paths.js";
import { fetchWithTimeout } from "./http.js";
import { unpackTarGz } from "./snapshot.js";
import { withFileLock } from "./state-lock.js";
import { versionedSkillWrite } from "./versions.js";

/** 安装锁：记录每个导入 skill 的来源、ref 与内容哈希。 */
export function lockPath() {
	return resolve(homedir(), ".dsh", "dsh-studio", "skill-lock.json");
}

export async function loadLock(file = lockPath()) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export async function saveLock(lock) {
	await mkdir(dirname(lockPath()), { recursive: true });
	const tmp = lockPath() + ".tmp";
	await writeFile(tmp, JSON.stringify(lock, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	await rename(tmp, lockPath());
	return lock;
}

/**
 * 解析来源。
 * 支持 `https://github.com/<owner>/<repo>[/tree/<ref>[/<subPath>]]` 与本地 `.tar.gz` 路径。
 */
export function parseSkillSource(input) {
	const raw = String(input ?? "").trim();
	if (raw === "") throw new Error("来源不能为空");
	if (!/^https?:\/\//i.test(raw)) {
		if (!/\.(tar\.gz|tgz)$/i.test(raw)) throw new Error("本地来源只支持 .tar.gz / .tgz：" + raw);
		return { kind: "tarball", path: raw, ref: "", subPath: "" };
	}
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("看不懂的来源：" + raw);
	}
	if (!/(^|\.)github\.com$/i.test(url.hostname)) throw new Error("只支持 GitHub 仓库地址或本地 tarball");
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 2) throw new Error("GitHub 地址要带 owner/repo");
	const owner = parts[0];
	const repo = parts[1].replace(/\.git$/i, "");
	let ref = "HEAD";
	let subPath = "";
	if (parts[2] === "tree" && typeof parts[3] === "string" && parts[3] !== "") {
		ref = decodeURIComponent(parts[3]);
		subPath = parts.slice(4).map((p) => decodeURIComponent(p)).join("/");
	}
	return {
		kind: "github",
		owner,
		repo,
		ref,
		subPath,
		url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`
	};
}

/** 目标 skill 目录是否真的在磁盘上。 */
async function isDir(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** 网络类重试（M-3）：codeload 偶发断连 / 5xx 退避重试 2 次；404、内容校验失败不重试。 */
const RETRY_DELAYS_MS = [300, 900];
const NETWORK_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"ABORT_ERR"
]);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** fetch 抛的多是 TypeError("fetch failed")，真实错误码在 cause.code 里。 */
function isNetworkError(error) {
	if (error?.name === "TimeoutError") return true;
	return NETWORK_CODES.has(String(error?.code ?? error?.cause?.code ?? ""));
}

async function loadSourceBytes(parsed, fetchImpl = fetch) {
	if (parsed.kind === "tarball") return readFile(parsed.path);
	for (let attempt = 0; ; attempt += 1) {
		let retry = false;
		try {
			const response = await fetchWithTimeout(parsed.url, {}, 60_000, fetchImpl);
			if (response.ok) return Buffer.from(await response.arrayBuffer());
			// 5xx 是对端暂时不可用（值得退避重试）；4xx 是确定性错误，重试没意义
			retry = response.status >= 500;
			throw new Error(`下载失败（HTTP ${response.status}）：${parsed.url}`);
		} catch (error) {
			if (!retry && !isNetworkError(error)) throw error;
			if (attempt >= RETRY_DELAYS_MS.length) throw error;
			await sleep(RETRY_DELAYS_MS[attempt]);
		}
	}
}

/**
 * 在包内找 SKILL.md 的根。
 * tarball 顶层一般包一层 `<repo>-<ref>/`，先剥掉；再按 subPath 收窄，找不到就取第一个 SKILL.md。
 */
export function findSkillRoot(entries, subPath = "") {
	const list = Array.isArray(entries) ? entries : [];
	if (list.length === 0) return null;
	const firstSeg = list[0].rel.split("/")[0];
	const stripped = list.map((e) => ({
		rel: e.rel.startsWith(firstSeg + "/") ? e.rel.slice(firstSeg.length + 1) : e.rel,
		data: e.data
	}));
	const prefix = String(subPath ?? "").replace(/^\/+|\/+$/g, "");
	const inScope = prefix === "" ? stripped : stripped.filter((e) => e.rel === prefix || e.rel.startsWith(prefix + "/"));
	const pick = inScope.find((e) => e.rel === (prefix === "" ? "SKILL.md" : prefix + "/SKILL.md")) ?? inScope.find((e) => e.rel.endsWith("/SKILL.md") || e.rel === "SKILL.md");
	if (pick === undefined) return null;
	const rootRel = pick.rel === "SKILL.md" ? "" : pick.rel.slice(0, -"/SKILL.md".length);
	const files = inScope
		.filter((e) => (rootRel === "" ? true : e.rel.startsWith(rootRel + "/")))
		.map((e) => ({ rel: rootRel === "" ? e.rel : e.rel.slice(rootRel.length + 1), data: e.data }))
		.filter((e) => e.rel !== "");
	return { rootRel, files, skillText: pick.data.toString("utf8") };
}

/** 从 SKILL.md 正文里取 frontmatter name，取不到就用目录名。 */
export function skillNameOf(found) {
	const text = String(found?.skillText ?? "").replace(/^\uFEFF/, "");
	const name = text.match(/^---\r?\n[\s\S]*?^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
	const fallback = found?.rootRel ? basename(found.rootRel) : "";
	const picked = (name && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : fallback) || "imported-skill";
	// 兜底名来自包内目录名，同样不可信：只接受单段、不以点开头的名字
	return /[\\/]/.test(picked) || picked.startsWith(".") ? "imported-skill" : picked;
}

/**
 * 一条 lock 记录（U-3）：source 只存仓库根 URL，子目录单独结构化进 subPath，
 * 与快照导出（lib/snapshot.js 的 resolveSkillSource）用同一套字段口径。
 * 旧记录里 source 是完整 tree URL 也照样能读 —— 读侧用 lib/paths.js 的 splitSourceUrl 归一。
 *
 * N-02：补齐 `commit`（来源 ref 的 commit sha，与读侧 lib/upstream.js 的 rec.commit 首选口径一致）。
 * 纯增字段：查不到就整条不写，老记录形状不变，读侧不受影响。
 */
export function lockRecordFor(parsed, { sha256, now = Date.now(), commit = "" }) {
	const record = {
		source: parsed?.kind === "tarball" ? String(parsed.path ?? "") : `https://github.com/${parsed.owner}/${parsed.repo}`,
		ref: parsed?.ref ?? "",
		sha256,
		at: new Date(now).toISOString(),
		subPath: parsed?.subPath ?? ""
	};
	if (typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit)) record.commit = commit;
	return record;
}

/**
 * 取来源 ref 的当前 commit（N-02）。写 lock 时补记它，update_check 才有可比的版本。
 * 查不到一律返回空串 —— 查 commit 失败绝不能让导入本身失败（退回 unknown-version 的现状）。
 * 动态 import 是为了避开 skillsrc ↔ upstream 的静态循环依赖。
 */
export async function resolveSourceCommit(parsed, { timeoutMs = 8000 } = {}) {
	if (parsed?.kind !== "github" || typeof parsed.owner !== "string" || typeof parsed.repo !== "string") return "";
	try {
		const { lsRemoteSha } = await import("./upstream.js");
		return await lsRemoteSha(`https://github.com/${parsed.owner}/${parsed.repo}`, parsed.ref ?? "", { timeoutMs });
	} catch {
		return "";
	}
}

/**
 * 拉字节 + 解包 + 定名，导入的前半段单独可调（PULL-2）：
 * 待拉清单的消费端要先判定 satisfied / conflict 才决定写不写，不能等 importSkill 落完盘再看。
 * @param {{fetchImpl?:typeof fetch}} options fetchImpl 只给测试替换网络通道
 * @returns {Promise<{parsed:object, sha256:string, found:object, name:string}>}
 */
export async function resolveSkillPackage(source, { fetchImpl } = {}) {
	const parsed = parseSkillSource(source);
	const bytes = await loadSourceBytes(parsed, fetchImpl);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const found = findSkillRoot(unpackTarGz(bytes), parsed.subPath);
	if (found === null) throw new Error("这个包里没有 SKILL.md");
	// 包可能来自任何人：`pkg/../../x`、绝对路径、盘符路径一律拒收（导入、待拉清单、原地更新三条路都从这里取包）
	const unsafe = found.files.filter((file) => !isSafeEntryPath(file.rel)).map((file) => file.rel);
	if (unsafe.length > 0) throw new Error("包内有越界路径，拒绝导入：" + unsafe.slice(0, 3).join("、"));
	return { parsed, sha256, found, name: skillNameOf(found) };
}

/**
 * 导入一个 skill。
 * @param {{source:string, targetDir:string, now?:number, pkg?:object, fetchImpl?:typeof fetch}} options
 *   pkg 是已用 resolveSkillPackage 取好的包，传入就不再下载第二次。
 * @returns {Promise<{ok:boolean,name:string,changed:boolean,sha256:string,files?:number}>}
 */
export async function importSkill({ source, targetDir, now = Date.now(), pkg = null, fetchImpl = fetch }) {
	if (typeof targetDir !== "string" || targetDir === "") throw new Error("没有可写的目标目录（agentSkillDir）");
	const { parsed, sha256, found, name } = pkg ?? (await resolveSkillPackage(source, { fetchImpl }));
	const dest = join(resolve(targetDir), name);
	const lock = await loadLock();
	const prev = lock[name];
	// 短路以「目标目录真实存在」为前提（F-1）：锁会随快照恢复到另一台机器上，
	// 那边 skill 目录还是空的；这时凭锁返回 changed:false 会让恢复端永远拿不到文件。
	if (prev !== undefined && prev.sha256 === sha256 && String(prev.ref ?? "") === String(parsed.ref ?? "") && (await isDir(dest))) {
		return { ok: true, name, changed: false, sha256, message: "同 ref 内容没有变化，跳过" };
	}
	// · G2：导入 / 重新导入记一条版本
	await versionedSkillWrite(dest, { action: "import", reason: "导入 " + String(source ?? "").replace(/\/\/[^@/\s]+@/, "//***@") }, async () => {
		for (const file of found.files) {
			const target = join(dest, file.rel);
			// 双保险（pkg 也可能由调用方直接传入）：落点必须在技能目录之内
			if (!isSafeEntryPath(file.rel) || !isInside(dest, target)) throw new Error("包内路径越界：" + file.rel);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, file.data);
		}
	});
	// N-06：包内容落盘与查 commit（网络）都在锁外；进锁后重新 load 最新 lock 再合并，
	// 只动自己这一条记录，不拿旧快照覆盖同期别人的导入。
	const commit = await resolveSourceCommit(parsed);
	await withFileLock(lockPath(), async () => {
		const latest = await loadLock();
		latest[name] = lockRecordFor(parsed, { sha256, now, commit });
		await saveLock(latest);
	});
	return { ok: true, name, changed: true, sha256, files: found.files.length, path: dest };
}
