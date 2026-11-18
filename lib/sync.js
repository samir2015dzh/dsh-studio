/**
 * 同步通道：把最新快照推到远端，或从远端取回来。
 *
 * 四条通道统一两个动作：
 *   push(channel, config, snapshotId)  → 上传（{ channel, snapshotId, pushed }）
 *   pull(channel, config)              → 取回并落成一份本地快照
 *
 * 配置在 `~/.dsh/dsh-studio/sync.json`，结构：
 *   { channel: "git" | "webdav" | "gist" | "s3", git: {...}, webdav: {...}, ... }
 *
 * 凭据只从这份文件读，不进快照（collectFiles 的白名单里没有 sync.json）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createHmac } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { CREDENTIAL_FILE_MODE, hardenPermissions } from "./fs-perms.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { CorruptFileError, isObjectJson, readJsonState } from "./json-file.js";
import { assertSnapshotId } from "./paths.js";
import { fetchWithTimeout } from "./http.js";
import { isSensitiveField, maskSecret, maskUrlSecrets } from "./redact.js";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const dshHome = () => resolve(homedir(), ".dsh");
const syncFile = () => resolve(dshHome(), "dsh-studio", "sync.json");
const snapshotsDir = () => resolve(dshHome(), "dsh-studio", "snapshots");

const CHANNELS = ["git", "webdav", "gist", "s3"];
const DEFAULT_SYNC = { channel: "git", git: {}, webdav: {}, gist: {}, s3: {} };

async function pathExists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * 读同步配置。文件不存在 → 默认值；存在但解析失败 → 抛 CorruptFileError（审计 2：
 * 原文件保留并留档，不静默回默认——否则下一次 saveSync 会用空配置把 WebDAV 凭据覆盖掉）。
 */
export async function loadSync() {
	const read = await readJsonState(syncFile(), { validate: isObjectJson });
	if (read.status === "missing") return { ...DEFAULT_SYNC };
	if (read.status === "corrupt") throw new CorruptFileError(syncFile(), read);
	const parsed = read.value;
	const out = { ...DEFAULT_SYNC };
	out.channel = CHANNELS.includes(parsed?.channel) ? parsed.channel : "git";
	for (const name of CHANNELS) {
		out[name] = typeof parsed?.[name] === "object" && parsed[name] !== null ? parsed[name] : {};
	}
	return out;
}

/** 单个通道配置的脱敏视图（WO-SEC-1）：凭据字段打码，其余字符串抹掉 URL 里的 userinfo / 凭据查询参数。 */
export function redactChannelConfig(config) {
	const out = {};
	for (const [key, value] of Object.entries(config ?? {})) {
		if (typeof value !== "string" || value === "") out[key] = value;
		else out[key] = isSensitiveField(key, value) ? maskSecret(value) : maskUrlSecrets(value);
	}
	return out;
}

/**
 * 整份同步配置的脱敏视图：面板路由与工具返回值只许带这个。
 * 明文凭据留在 sync.json 里，推 / 拉时由服务端自己读，前端与模型都不需要拿到原值。
 */
export function redactSyncConfig(sync) {
	const out = { channel: sync.channel };
	for (const name of CHANNELS) out[name] = redactChannelConfig(sync[name]);
	return out;
}

export async function saveSync(patch = {}) {
	const current = await loadSync();
	const next = { ...current };
	if (CHANNELS.includes(patch.channel)) next.channel = patch.channel;
	for (const name of CHANNELS) {
		if (typeof patch[name] !== "object" || patch[name] === null) continue;
		// 调用方拿到的是脱敏视图，原样回传的字段（掩码 / 抹过凭据的 URL）= 「没改」，不许把掩码当新值存进去
		const shown = redactChannelConfig(current[name]);
		const incoming = { ...patch[name] };
		for (const [key, value] of Object.entries(incoming)) {
			if (typeof value === "string" && value === shown[key] && value !== current[name]?.[key]) delete incoming[key];
		}
		next[name] = { ...current[name], ...incoming };
	}
	await atomicWriteFile(syncFile(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: CREDENTIAL_FILE_MODE });
	await hardenPermissions(syncFile());
	return next;
}

/**
 * 快照包传输的超时。默认的 30 秒连同请求体上传 / 响应体下载一起算，家用上行传一个几十 MB 的包根本不够——
 * 而 pull 正是灾备路径。控制类请求（MKCOL、LATEST、列表）仍用默认值。
 */
const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

/** 打一次超时上限，网络慢时不至于挂死（超时实现见 lib/http.js）。 */
async function httpJson(url, init = {}) {
	const response = await fetchWithTimeout(url, init);
	const text = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status} · ${text.slice(0, 200)}`);
	return text === "" ? null : JSON.parse(text);
}

// ── Git 通道 ──────────────────────────────────────────────────────────────

async function git(workDir, args) {
	const { stdout } = await execFileAsync("git", args, {
		cwd: workDir,
		timeout: 120_000,
		windowsHide: true,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
	});
	return String(stdout).trim();
}

async function gitSync(config) {
	const work = typeof config.workDir === "string" && config.workDir !== ""
		? resolve(config.workDir)
		: resolve(dshHome(), "dsh-studio", "sync-work");
	const remote = typeof config.remote === "string" ? config.remote.trim() : "";
	return { work, remote };
}

/**
 * 确保工作副本存在且指向远端的最新提交。
 *
 * 不用 `git clone`：空仓库（bare 但没有任何 commit）clone 出来没有 HEAD，
 * 之后的 `git pull --ff-only` 会报 "no tracking information"。改成
 * init → remote add → fetch → 有分支才 checkout，空仓库就停在未跟踪状态，
 * 等第一次 push 再建分支。
 */
async function gitEnsureWork(config) {
	const { work, remote } = await gitSync(config);
	const hasGit = await pathExists(join(work, ".git"));
	if (!hasGit) {
		if (remote === "") throw new Error("Git 通道需要 remote（仓库地址）");
		// 没有 .git 的工作目录只在「它是插件自己的 sync-work」时才清空重建。git.workDir 可由面板 / 模型改成任意路径
		//（"." 会解析成进程 cwd），旧写法对它直接 rm -rf：指到 Documents 就把 Documents 清了。
		// 自定义目录必须不存在或为空，否则拒绝，一个文件都不碰。
		const owned = work === resolve(dshHome(), "dsh-studio", "sync-work");
		if (owned) await rm(work, { recursive: true, force: true });
		else {
			const existing = await readdir(work).catch((error) => (error?.code === "ENOENT" ? [] : Promise.reject(error)));
			if (existing.length > 0) {
				throw new Error(`Git 通道的工作目录 ${work} 不是 git 仓库且非空（${existing.length} 项），拒绝清空。请把 git.workDir 指向一个空目录，或留空使用默认位置。`);
			}
		}
		await mkdir(work, { recursive: true });
		await git(work, ["init"]);
		await git(work, ["remote", "add", "origin", remote]);
	}

	// 远端可能连不上、也可能是空仓库。这里把「fetch 到底成没成」交给调用方判断：
	// pull 必须失败，push 可以先按本地副本走（WO-FIX-4）。
	const fetched = await git(work, ["fetch", "origin"])
		.then(() => true)
		.catch(() => false);
	if (!fetched) return { work, fetched: false };

	// 远端有分支就跟上（优先 origin 的默认分支）
	let branch = await git(work, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
		.then((out) => out.replace("origin/", "").trim())
		.catch(() => "");
	if (branch === "") {
		const remotes = await git(work, ["branch", "-r"]).catch(() => "");
		const line = remotes
			.split(/\r?\n/)
			.map((s) => s.trim())
			.find((s) => s.startsWith("origin/") && !s.endsWith("/HEAD"));
		branch = line === undefined ? "" : line.replace("origin/", "");
	}
	if (branch !== "") {
		await git(work, ["checkout", "-B", branch, `origin/${branch}`]).catch(() => {});
	}
	return { work, fetched: true };
}

/** commit 兜底：机器上没配 user.name/email 时不让提交失败。 */
const COMMIT_IDENTITY = ["-c", "user.name=dsh-studio", "-c", "user.email=dsh-studio@local"];

async function gitPush(config, snapshotId) {
	const { work, fetched } = await gitEnsureWork(config);
	const src = join(snapshotsDir(), snapshotId);
	await cp(join(src, "config.tar.gz"), join(work, "config.tar.gz"));
	await cp(join(src, "manifest.json"), join(work, "manifest.json"));
	await writeFile(join(work, "LATEST"), snapshotId + "\n", "utf8");
	await git(work, ["add", "-A"]);
	const status = await git(work, ["status", "--porcelain"]);
	if (status === "") return { channel: "git", snapshotId, pushed: false, note: "远端已经是最新的" };
	await git(work, [...COMMIT_IDENTITY, "commit", "-m", `sync: ${snapshotId}`]);
	// 空仓库第一次 push 要带 -u 建上游，之后才能 pull --ff-only
	const branch = await git(work, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "master");
	await git(work, ["push", "-u", "origin", branch === "HEAD" ? "master" : branch]);
	// fetch 失败时 push 仍可能成功（远端可达但 fetch 被拒/超时）：允许降级，但必须说清楚
	return { channel: "git", snapshotId, pushed: true, ...(fetched ? {} : { note: "远端 fetch 失败，按本地副本推送（未与远端对齐）" }) };
}

async function gitPull(config) {
	const { work, fetched } = await gitEnsureWork(config);
	// fetch 没成功就没有「远端最新」这回事：拿工作副本里的旧文件当 pulled 结果
	// 会悄悄把用户回退到上一个版本（WO-FIX-4），这里必须失败。
	if (!fetched) throw new Error("git fetch 失败：拿不到远端最新状态，拒绝用本地旧副本冒充远端结果");
	const latest = (await readFile(join(work, "LATEST"), "utf8")).trim();
	return { archive: await readFile(join(work, "config.tar.gz")), manifest: JSON.parse(await readFile(join(work, "manifest.json"), "utf8")), remoteId: latest };
}

// ── Gist 通道 ─────────────────────────────────────────────────────────────

async function gistPush(config, snapshotId) {
	const token = typeof config.token === "string" ? config.token.trim() : "";
	if (token === "") throw new Error("Gist 通道需要 token");
	const src = join(snapshotsDir(), snapshotId);
	const archive = await readFile(join(src, "config.tar.gz"));
	const manifest = await readFile(join(src, "manifest.json"), "utf8");
	const files = {
		"config.tar.gz": { content: archive.toString("base64") },
		"manifest.json": { content: manifest },
		"LATEST": { content: snapshotId + "\n" }
	};
	const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
	const existing = typeof config.gistId === "string" ? config.gistId.trim() : "";
	if (existing === "") {
		const created = await httpJson("https://api.github.com/gists", {
			method: "POST",
			headers,
			body: JSON.stringify({ description: `dsh-studio 配置快照 ${snapshotId}`, public: false, files })
		});
		return { channel: "gist", snapshotId, pushed: true, gistId: created.id, created: true };
	}
	await httpJson(`https://api.github.com/gists/${existing}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ description: `dsh-studio 配置快照 ${snapshotId}`, files })
	});
	return { channel: "gist", snapshotId, pushed: true, gistId: existing, created: false };
}

/**
 * 从 Gist 元数据里读一个文件的**原文**。
 *
 * GitHub 的 Gist 只存文本：`files[].content` 是文件原文（不是 base64）。
 * 超过 ~900 KB 时 content 会被截断（`truncated: true`，实测 1.5 MB 的文件 content 只给 921600 字符），
 * 这时要走 `raw_url` —— 它返回的也是**原文文本**（content-type: text/plain），不是二进制。
 */
async function readGistText(meta, name, token) {
	const file = meta?.files?.[name];
	if (file === undefined) throw new Error(`这个 Gist 里没有 ${name}`);
	if (file.truncated === true && typeof file.raw_url === "string") {
		const response = await fetchWithTimeout(file.raw_url, { headers: { Authorization: `Bearer ${token}` } }, ARCHIVE_TIMEOUT_MS);
		if (!response.ok) throw new Error(`读取 ${name} 的 raw_url 失败（HTTP ${response.status}）`);
		return await response.text();
	}
	return String(file.content ?? "");
}

async function gistPull(config) {
	const token = typeof config.token === "string" ? config.token.trim() : "";
	const gistId = typeof config.gistId === "string" ? config.gistId.trim() : "";
	if (token === "" || gistId === "") throw new Error("Gist 通道需要 token 与 gistId");
	const meta = await httpJson(`https://api.github.com/gists/${gistId}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
	});
	// config.tar.gz 是二进制，push 时编成了 base64 存进去，读回来要解回去
	const archiveB64 = await readGistText(meta, "config.tar.gz", token);
	const archive = Buffer.from(archiveB64, "base64");
	// manifest.json 与 LATEST 是纯文本，直接读，不做 base64 解码
	const manifestRaw = await readGistText(meta, "manifest.json", token);
	let manifest;
	try {
		manifest = JSON.parse(manifestRaw);
	} catch {
		throw new Error("Gist 里的 manifest.json 不是合法 JSON（可能是空文件或损坏）");
	}
	const remoteId = (await readGistText(meta, "LATEST", token)).trim();
	return { archive, manifest, remoteId };
}

// ── WebDAV 通道 ───────────────────────────────────────────────────────────

export function webdavHeaders(config) {
	const headers = {};
	if (typeof config.username === "string" && config.username !== "") {
		const pair = `${config.username}:${config.password ?? ""}`;
		headers.Authorization = "Basic " + Buffer.from(pair, "utf8").toString("base64");
	}
	return headers;
}

export async function webdavBase(config) {
	const base = typeof config.url === "string" ? config.url.trim().replace(/\/+$/, "") : "";
	if (base === "") throw new Error("WebDAV 通道需要 url（例如 https://dav.example.com/dsh）");
	return base;
}

/**
 * 保证远端目录存在。WebDAV 的 PUT 在父集合不存在时返回 409，所以推之前先 MKCOL。
 * 201 = 新建成功，405 = 已存在（RFC 4918 规定对已存在的集合 MKCOL 返回 405），
 * 301/302 是有些服务端把「已存在」重定向过去，这几种都算成功。
 */
export async function webdavEnsureDir(base, headers) {
	const response = await fetchWithTimeout(`${base}/`, { method: "MKCOL", headers });
	if (response.ok || response.status === 405 || response.status === 301 || response.status === 302) return;
	throw new Error(`创建远端目录失败（MKCOL → HTTP ${response.status}）`);
}

/**
 * 远端布局：每个快照用带版本号的文件名 `config-<id>.tar.gz` / `manifest-<id>.json`，
 * `LATEST` 是唯一指针、最后才切；`PREVIOUS` 记上一版，远端只留这两版。
 * 旧写法原地覆盖唯一一份 `config.tar.gz` 再改 `LATEST`：中途断掉，远端就是半份包，指针还指着旧版或对不上。
 * 现在中途断掉只会多几个没被指向的版本文件，`LATEST` 指的那一版始终完整。
 *
 * 兼容旧版拉取方（只认 `config.tar.gz` / `manifest.json`）：切完指针后照旧更新这两个旧名，
 * 先 PUT 到 `.part` 再 MOVE 覆盖；服务端不支持 MOVE 才退回直接 PUT（只影响旧版读者，新版不读它们）。
 */
const webdavArchiveName = (id) => `config-${id}.tar.gz`;
const webdavManifestName = (id) => `manifest-${id}.json`;

async function webdavPut(url, headers, body, timeoutMs) {
	const response = await fetchWithTimeout(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body }, timeoutMs);
	if (!response.ok) throw new Error(`PUT ${url.slice(url.lastIndexOf("/") + 1)} → HTTP ${response.status}`);
}

async function webdavGetText(url, headers) {
	const response = await fetchWithTimeout(url, { headers });
	return response.ok ? (await response.text()).trim() : null;
}

/** 旧名字：先传到 .part，再 MOVE 覆盖；MOVE 不被支持就直接 PUT。 */
async function webdavPutLegacy(base, headers, name, body) {
	const part = `${base}/${name}.part`;
	await webdavPut(part, headers, body, ARCHIVE_TIMEOUT_MS);
	const moved = await fetchWithTimeout(part, { method: "MOVE", headers: { ...headers, Destination: `${base}/${name}`, Overwrite: "T" } });
	if (moved.ok) return;
	await fetchWithTimeout(part, { method: "DELETE", headers }).catch(() => {});
	await webdavPut(`${base}/${name}`, headers, body, ARCHIVE_TIMEOUT_MS);
}

async function webdavPush(config, snapshotId) {
	const base = await webdavBase(config);
	const headers = webdavHeaders(config);
	await webdavEnsureDir(base, headers);
	const src = join(snapshotsDir(), snapshotId);
	const archive = await readFile(join(src, "config.tar.gz"));
	const manifest = await readFile(join(src, "manifest.json"));
	const prevId = await webdavGetText(`${base}/LATEST`, headers);
	// 1. 新版本文件：新名字，传到一半断了也碰不到任何正在被指向的东西
	await webdavPut(`${base}/${webdavArchiveName(snapshotId)}`, headers, archive, ARCHIVE_TIMEOUT_MS);
	await webdavPut(`${base}/${webdavManifestName(snapshotId)}`, headers, manifest, ARCHIVE_TIMEOUT_MS);
	// 2. 切指针。LATEST 是「远端当前版本」的唯一指针，写失败就不能报成功（WO-FIX-4）
	const latestRes = await fetchWithTimeout(`${base}/LATEST`, { method: "PUT", headers, body: snapshotId + "\n" });
	if (!latestRes.ok) throw new Error(`PUT LATEST → HTTP ${latestRes.status}`);
	// 3. 旧版拉取方用的旧名字
	await webdavPutLegacy(base, headers, "config.tar.gz", archive);
	await webdavPutLegacy(base, headers, "manifest.json", manifest);
	// 4. 远端只留当前 + 上一版：上一版记进 PREVIOUS，再往前那版删掉（尽力而为，失败不影响本次推送）
	if (prevId !== null && prevId !== "" && prevId !== snapshotId) {
		const older = await webdavGetText(`${base}/PREVIOUS`, headers).catch(() => null);
		const prevRes = await fetchWithTimeout(`${base}/PREVIOUS`, { method: "PUT", headers, body: prevId + "\n" }).catch(() => null);
		if (prevRes?.ok && older !== null && older !== "" && older !== snapshotId && older !== prevId && /^[\w.-]+$/.test(older)) {
			for (const name of [webdavArchiveName(older), webdavManifestName(older)]) {
				await fetchWithTimeout(`${base}/${name}`, { method: "DELETE", headers }).catch(() => {});
			}
		}
	}
	return { channel: "webdav", snapshotId, pushed: true };
}

/**
 * 拉下来的包按清单逐条校验：清单里的快照 id 要与 LATEST 一致、包的字节数对得上，
 * 解包后每个条目都在清单里且字节数与 sha256 一致，清单里的条目一个不少。任何一项不过就不落盘。
 */
export async function verifyPulledArchive(archive, manifest, remoteId) {
	const fail = (why) => {
		throw new Error(`远端快照校验未通过，未落盘：${why}`);
	};
	if (manifest === null || typeof manifest !== "object" || !Array.isArray(manifest.files) || manifest.files.length === 0) fail("manifest.json 缺失或没有逐文件清单，无法校验");
	if (typeof manifest.id === "string" && remoteId !== "" && manifest.id !== remoteId) fail(`清单是 ${manifest.id}，LATEST 指的是 ${remoteId}（推送中途断过？）`);
	if (Number.isFinite(manifest.archiveBytes) && manifest.archiveBytes !== archive.length) fail(`包 ${archive.length} 字节，清单记的是 ${manifest.archiveBytes}`);
	const { unpackTarGz } = await import("./snapshot.js");
	let entries;
	try {
		entries = unpackTarGz(archive);
	} catch (error) {
		fail("包解不开：" + (error instanceof Error ? error.message : String(error)));
	}
	const listed = new Map(manifest.files.filter((f) => f && typeof f.rel === "string").map((f) => [f.rel, f]));
	const bad = [];
	for (const entry of entries) {
		const want = listed.get(entry.rel);
		if (want === undefined) {
			bad.push(`${entry.rel}（清单外）`);
			continue;
		}
		listed.delete(entry.rel);
		const sha = createHash("sha256").update(entry.data).digest("hex");
		if (want.bytes !== entry.data.length || want.sha !== sha) bad.push(`${entry.rel}（内容与清单不符）`);
	}
	for (const rel of listed.keys()) bad.push(`${rel}（包里缺）`);
	if (bad.length > 0) fail(`${bad.length} 条对不上：${bad.slice(0, 5).join("、")}${bad.length > 5 ? "…" : ""}`);
}

async function webdavPull(config) {
	const base = await webdavBase(config);
	const headers = webdavHeaders(config);
	const latestRes = await fetchWithTimeout(`${base}/LATEST`, { headers });
	if (!latestRes.ok) throw new Error(`远端没有 LATEST（HTTP ${latestRes.status}）`);
	const remoteId = (await latestRes.text()).trim();
	// 先找带版本号的文件；旧版推上去的远端只有旧名字，退回去读
	const safeId = /^[\w.-]+$/.test(remoteId) ? remoteId : "";
	let archiveRes = safeId === "" ? null : await fetchWithTimeout(`${base}/${webdavArchiveName(safeId)}`, { headers }, ARCHIVE_TIMEOUT_MS);
	let manifestName = webdavManifestName(safeId);
	if (archiveRes === null || archiveRes.status === 404) {
		archiveRes = await fetchWithTimeout(`${base}/config.tar.gz`, { headers }, ARCHIVE_TIMEOUT_MS);
		manifestName = "manifest.json";
	}
	if (!archiveRes.ok) throw new Error(`读取远端快照包失败（HTTP ${archiveRes.status}）`);
	const archive = Buffer.from(await archiveRes.arrayBuffer());
	const manifestRes = await fetchWithTimeout(`${base}/${manifestName}`, { headers });
	let manifest = null;
	if (manifestRes.ok) {
		try {
			manifest = JSON.parse(await manifestRes.text());
		} catch {
			manifest = null;
		}
	}
	await verifyPulledArchive(archive, manifest, remoteId);
	return { archive, manifest, remoteId };
}

function s3Endpoint(config) {
	const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim().replace(/\/+$/, "") : "";
	const bucket = typeof config.bucket === "string" ? config.bucket.trim() : "";
	if (endpoint === "" || bucket === "") throw new Error("S3 通道需要 endpoint 与 bucket");
	return { endpoint, bucket };
}

/**
 * 生成 SigV4 签名的请求头。
 * 只实现 PUT/GET 两种方法 + 无 query 的 path-style 请求，够本插件用。
 */
function s3SignedHeaders(config, method, key, body, region) {
	const { endpoint, bucket } = s3Endpoint(config);
	const accessKey = String(config.accessKey ?? "");
	const secretKey = String(config.secretKey ?? "");
	if (accessKey === "" || secretKey === "") throw new Error("S3 通道需要 accessKey 与 secretKey");

	const url = new URL(`${endpoint}/${bucket}/${encodeKey(key)}`);
	const host = url.host;
	const path = url.pathname;
	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

	const headers = {
		host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate
	};
	const sortedKeys = Object.keys(headers).sort();
	const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join("");
	const signedHeaders = sortedKeys.join(";");
	const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
	const scope = `${dateStamp}/${region}/s3/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
	const kDate = hmac("AWS4" + secretKey, dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, "s3");
	const kSigning = hmac(kService, "aws4_request");
	const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

	return {
		url: url.toString(),
		headers: {
			...headers,
			Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
		}
	};
}

async function s3Request(config, method, key, body) {
	const region = typeof config.region === "string" && config.region !== "" ? config.region : "us-east-1";
	const signed = s3SignedHeaders(config, method, key, body, region);
	const response = await fetchWithTimeout(signed.url, { method, headers: signed.headers, body }, ARCHIVE_TIMEOUT_MS);
	return response;
}

async function s3Push(config, snapshotId) {
	const src = join(snapshotsDir(), snapshotId);
	for (const name of ["config.tar.gz", "manifest.json"]) {
		const data = await readFile(join(src, name));
		const response = await s3Request(config, "PUT", name, data);
		if (!response.ok) throw new Error(`PUT ${name} → HTTP ${response.status} · ${(await response.text()).slice(0, 160)}`);
	}
	// LATEST 写失败等于远端版本指针没更新，不能报 push 成功（WO-FIX-4）
	const latestPut = await s3Request(config, "PUT", "LATEST", Buffer.from(snapshotId + "\n", "utf8"));
	if (!latestPut.ok) throw new Error(`PUT LATEST → HTTP ${latestPut.status}`);
	return { channel: "s3", snapshotId, pushed: true };
}

async function s3Pull(config) {
	const latestRes = await s3Request(config, "GET", "LATEST");
	if (!latestRes.ok) throw new Error(`远端没有 LATEST（HTTP ${latestRes.status}）`);
	const remoteId = (await latestRes.text()).trim();
	const archiveRes = await s3Request(config, "GET", "config.tar.gz");
	if (!archiveRes.ok) throw new Error(`读取 config.tar.gz 失败（HTTP ${archiveRes.status}）`);
	const manifestRes = await s3Request(config, "GET", "manifest.json");
	const manifest = manifestRes.ok ? JSON.parse(await manifestRes.text()) : { files: [] };
	return { archive: Buffer.from(await archiveRes.arrayBuffer()), manifest, remoteId };
}

// ── 统一入口 ──────────────────────────────────────────────────────────────

/** 把一份本地快照推到当前通道。 */
export async function pushSnapshot(channel, config, snapshotId) {
	if (!CHANNELS.includes(channel)) throw new Error(`未知通道：${channel}`);
	// snapshotId 来自面板/工具入参，直接拼路径能被 `../` 带到外面（S-10）
	const safeId = assertSnapshotId(snapshotId);
	if (!(await pathExists(join(snapshotsDir(), safeId, "config.tar.gz")))) throw new Error(`快照不存在：${snapshotId}`);
	if (channel === "git") return gitPush(config, safeId);
	if (channel === "gist") return gistPush(config, safeId);
	if (channel === "webdav") return webdavPush(config, safeId);
	if (channel === "s3") return s3Push(config, safeId);
	throw new Error(`未知通道：${channel}`);
}

/** 从当前通道取回，落成一份本地快照（不写配置）。 */
export async function pullSnapshot(channel, config, label = "pulled") {
	if (!CHANNELS.includes(channel)) throw new Error(`未知通道：${channel}`);
	let result;
	if (channel === "git") result = await gitPull(config);
	else if (channel === "gist") result = await gistPull(config);
	else if (channel === "webdav") result = await webdavPull(config);
	else if (channel === "s3") result = await s3Pull(config);
	else throw new Error(`未知通道：${channel}`);

	const stamp = (() => {
		const d = new Date();
		const p = (n) => String(n).padStart(2, "0");
		return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
	})();
	const safeLabel = String(label).replace(/[^\w.-]+/g, "_").slice(0, 60) || "pulled";
	const id = `${stamp}-${safeLabel}`;
	const dir = join(snapshotsDir(), id);
	await mkdir(dir, { recursive: true });
	await atomicWriteFile(join(dir, "config.tar.gz"), result.archive);
	const files = Array.isArray(result.manifest?.files) ? result.manifest.files : [];
	await writeFile(join(dir, "manifest.json"), JSON.stringify({ id, label, at: Date.now(), archiveBytes: result.archive.length, files, pulled: true }, null, 2), "utf8");
	return { channel, id, files: files.length, bytes: result.archive.length, remoteId: result.remoteId ?? "" };
}
