import { historicalSource } from "../helpers/historical-source.mjs";
// N-07 fixture：digest 路径「先排序截断、再解压」。全部在伪 HOME 里跑，不读真机会话日志、不联网。
//
// 三个伪 sessions 根：
//   1) sessions/        主根：47 个窗口内 .zstd（40 有消息 + 5 空消息 + 2 损坏）+ 1 个未压缩 .jsonl
//                       + 3 个窗口外 .zstd；有效组里第 20~22 个共享同一 mtime（并列稳定序证据）。
//   2) sessions-fill/   补位根：最新 3 个为空/坏，第 4~15 个有内容，后面还有 5 个更老的有效会话。
//   3) sessions-verdict/ shouldExtract 的 worth 判定根：1 个有效 + 1 个空。
//
// 解压次数怎么数：拦截 node:child_process 的 execFile（CJS exports 上换一个转发包装，
// 再 syncBuiltinESMExports() 把改动同步到 ESM 具名导入）—— lib 顶层 `promisify(execFile)`
// 拿到的就是包装版，包装里只对 argv 形如 ["-d","-c","<*.zstd>"] 的调用记一次，然后原样转发。
// 数到的就是**真实发生的 zstd 子进程**（转发给真 zstd，解压结果照常返回）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const BASELINE = "af7daae";
const dsh = path.join(home, ".dsh");

// ---- 0. 三件套确认：只许在伪目录里跑（不通过就以非零退出，让套件红）----
{
	const bad = [];
	if (!home) bad.push("USERPROFILE/HOME 都为空");
	for (const [name, want] of [
		["USERPROFILE", home],
		["HOME", home],
		["DSH_HOME", dsh]
	]) {
		const got = process.env[name];
		if (got !== want) bad.push(`${name}=${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`);
	}
	if (/^(C:\\Users\\realuser|\/Users\/realuser|\/home\/realuser)$/i.test(String(home))) bad.push(`伪 HOME 指向真实家目录：${home}`);
	if (bad.length > 0) {
		console.error("三件套不合规，拒绝运行：" + bad.join("；"));
		process.exit(2);
	}
}

const env = {
	USERPROFILE: process.env.USERPROFILE,
	HOME: process.env.HOME,
	DSH_HOME: process.env.DSH_HOME,
	zstdPath: "",
	pluginRoot,
	baseline: BASELINE
};

// ---- 1. 基线版 lib（整个 lib 先拷过去，再按基线覆盖 extractor.js —— 相对 import 要能解析）----
function buildBaselineLib() {
	const source = historicalSource(BASELINE, "lib/extractor.js");
	if (source === null) return null;
	const dir = path.join(home, "baseline-lib");
	fs.cpSync(path.join(pluginRoot, "lib"), dir, { recursive: true, filter: (src) => !src.endsWith(".bak-mcp-20261102") });
	fs.writeFileSync(
		path.join(dir, "extractor.js"),
		source,
		"utf8"
	);
	return dir;
}

// ---- 2. 解压计数：拦截 execFile，转发真调用 ----
const req = createRequire(import.meta.url);
const cp = req("node:child_process");
const originalExecFile = cp.execFile;
let calls = [];
const countingExecFile = function (...a) {
	const argv = a[1];
	if (Array.isArray(argv) && argv[0] === "-d" && argv[1] === "-c" && typeof argv[2] === "string" && argv[2].endsWith(".zstd")) {
		calls.push(argv[2]);
	}
	return originalExecFile.apply(this, a);
};
// lib 里是 promisify(execFile)：自定义 promisify 必须也走包装，否则计数被绕过
countingExecFile[promisify.custom] = (...a) =>
	new Promise((res, rej) => {
		countingExecFile(...a, (err, stdout, stderr) => (err ? rej(err) : res({ stdout, stderr })));
	});
cp.execFile = countingExecFile;
syncBuiltinESMExports();
const take = async (fn) => {
	calls = [];
	// B2：当前版有进程内的会话解析缓存；这里量的是「冷」路径的解压次数，每次量之前清空
	current?.resetSessionScanCache?.();
	const v = await fn();
	return { n: calls.length, files: calls.map((f) => path.relative(home, f)), v };
};

// ---- 3. 造会话日志（真 zstd 压缩，窗口的截止时间按运行时算，避免受固定时间戳漂移影响）----
const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
let ZSTD = "zstd";
search: for (const dir of [...String(process.env.PATH ?? "").split(path.delimiter), path.join(home, ".local", "bin")]) {
	if (dir === "") continue;
	for (const s of suffixes) {
		const c = path.join(dir, "zstd" + s);
		if (fs.existsSync(c)) {
			ZSTD = c;
			break search;
		}
	}
}
env.zstdPath = ZSTD;
const CREATED = "2026-11-07T02:00:00.000Z";
const BASE = Math.floor(Date.now() / 1000) * 1000 - 60000;

function sessionJsonl(id, cwd, userText, assistantText) {
	const lines = [{ type: "session", id, createdAt: CREATED, cwd }];
	if (userText) lines.push({ type: "agent/inbox/spliced", data: { inserted: [{ role: "user", content: [{ type: "text", text: userText }] }] } });
	if (assistantText) lines.push({ type: "agent/inbox/spliced", data: { inserted: [{ role: "assistant", content: [{ type: "text", text: assistantText }] }] } });
	lines.push({ type: "tool/call", data: { name: "skill", arguments: { name: "fixture-skill" } } });
	lines.push({ type: "tool/result", data: {} });
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function put(file, text, mtime) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const src = file + ".src";
	fs.writeFileSync(src, text, "utf8");
	execFileSync(ZSTD, ["-q", "-f", "-o", file, src], { stdio: "pipe" });
	fs.rmSync(src, { force: true });
	const t = new Date(mtime);
	fs.utimesSync(file, t, t);
}
function putBroken(file, mtime) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, Buffer.from("这不是 zstd 帧：N-07 损坏样本"));
	const t = new Date(mtime);
	fs.utimesSync(file, t, t);
}

const sessionsRoot = path.join(dsh, "sessions");
const fillRoot = path.join(dsh, "sessions-fill");
const verdictRoot = path.join(dsh, "sessions-verdict");
const rel = (f) => path.relative(home, f);

// 3.1 主根：40 个有消息的有效会话；第 20~22 个共享同一 mtime（并列组）
const TIE_FROM = 20;
const TIE_TO = 22;
for (let i = 0; i < 40; i++) {
	const file = path.join(sessionsRoot, "s" + String(i).padStart(2, "0"), "session.jsonl.zstd");
	put(file, sessionJsonl(`id-s${i}`, `/work/proj-${i}`, `第 ${i} 个会话的用户消息（N-07 fixture）`, `第 ${i} 个会话的助手回复`), BASE - (i <= TIE_TO && i >= TIE_FROM ? TIE_FROM : i) * 60000);
}
// 3.2 主根：5 个空消息（只有 session 行）
for (let k = 0; k < 5; k++) {
	put(path.join(sessionsRoot, "e" + k, "session.jsonl.zstd"), sessionJsonl(`id-e${k}`, `/work/empty-${k}`, "", ""), BASE - (40 + k) * 60000);
}
// 3.3 主根：2 个损坏（zstd 解压失败）
for (let k = 0; k < 2; k++) {
	putBroken(path.join(sessionsRoot, "x" + k, "session.jsonl.zstd"), BASE - (45 + k) * 60000);
}
// 3.4 主根：1 个未压缩 .jsonl（有效，但不产生 zstd 子进程）
{
	const file = path.join(sessionsRoot, "p0", "session.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, sessionJsonl("id-p0", "/work/plain", "未压缩会话的用户消息", "未压缩会话的助手回复"), "utf8");
	const t = new Date(BASE - 50 * 60000);
	fs.utimesSync(file, t, t);
}
// 3.5 主根：3 个窗口外（40 天前）
for (let k = 0; k < 3; k++) {
	put(path.join(sessionsRoot, "old" + k, "session.jsonl.zstd"), sessionJsonl(`id-old${k}`, `/work/old-${k}`, "窗口外的会话", "不该被解压"), BASE - 40 * 86400000);
}
env.sessionsRoot = rel(sessionsRoot);

// 3.6 记住分支根：最新会话带「记住」（shouldExtract 的 remember 分支不走 llm），末尾 1 个空消息
const rememberRoot = path.join(dsh, "sessions-remember");
put(
	path.join(rememberRoot, "r0", "session.jsonl.zstd"),
	sessionJsonl("id-remember", "/work/remember", "记住这条：N-07 之后不要再全量解压", "好"),
	BASE
);
put(path.join(rememberRoot, "r1", "session.jsonl.zstd"), sessionJsonl("id-remember-empty", "/work/remember-empty", "", ""), BASE - 60000);
env.rememberRoot = rel(rememberRoot);

// 3.7 补位根：最新 2 空 + 1 坏，第 4~15 个有内容，再 5 个更老的有效会话
for (let k = 0; k < 2; k++) {
	put(path.join(fillRoot, "f" + k, "session.jsonl.zstd"), sessionJsonl(`id-f${k}`, `/work/fill-empty-${k}`, "", ""), BASE - k * 60000);
}
putBroken(path.join(fillRoot, "f2", "session.jsonl.zstd"), BASE - 2 * 60000);
for (let i = 3; i < 20; i++) {
	put(
		path.join(fillRoot, "f" + String(i).padStart(2, "0"), "session.jsonl.zstd"),
		sessionJsonl(`id-f${i}`, `/work/fill-${i}`, `补位会话 ${i} 的用户消息`, `补位会话 ${i} 的助手回复`),
		BASE - i * 60000
	);
}
env.fillRoot = rel(fillRoot);

// 3.8 判定根：1 个有效（不含「记住」）+ 1 个空
put(path.join(verdictRoot, "v0", "session.jsonl.zstd"), sessionJsonl("id-v0", "/work/verdict", "N-07 判定用例：一段普通的会话", "收到"), BASE);
put(path.join(verdictRoot, "v1", "session.jsonl.zstd"), sessionJsonl("id-v1", "/work/verdict-empty", "", ""), BASE - 60000);
env.verdictRoot = rel(verdictRoot);

// ---- 4. 加载两套 lib ----
const baselineLib = buildBaselineLib();
const load = (root, name) => import(pathToFileURL(path.join(root, name)).href);
const baseline = baselineLib ? await load(baselineLib, "extractor.js") : null;
const takeBase = (fn) => baseline ? take(fn) : { v: [], n: null };
const current = await load(path.join(pluginRoot, "lib"), "extractor.js");

// ---- 5. 比对工具 ----
const view = (list) => list.map((e) => ({ file: rel(e.file), mtime: e.mtime, size: e.size, log: e.log }));
const json = (v) => JSON.stringify(v);
function diff(a, b) {
	const A = json(a);
	const B = json(b);
	if (A === B) return null;
	let i = 0;
	while (i < A.length && i < B.length && A[i] === B[i]) i += 1;
	return { at: i, lenA: A.length, lenB: B.length, a: A.slice(Math.max(0, i - 60), i + 60), b: B.slice(Math.max(0, i - 60), i + 60) };
}
const texts = (lib, list) => list.map((e) => lib.buildDigest(e.log));

// ---- 6. 场景：主根 maxSessions=12 / (1,1) ----
const base12 = await takeBase(() => baseline.collectSessionDigests(sessionsRoot, 30, 12));
const cur12 = await take(() => current.collectSessionDigests(sessionsRoot, 30, 12));
const base11 = await takeBase(() => baseline.collectSessionDigests(sessionsRoot, 30, 1));
const cur11 = await take(() => current.collectSessionDigests(sessionsRoot, 30, 1));
// 边界：非正整数上限沿用旧的 filter→slice 语义（slice(0,0) 为空）
const base0 = await takeBase(() => baseline.collectSessionDigests(sessionsRoot, 30, 0));
const cur0 = await take(() => current.collectSessionDigests(sessionsRoot, 30, 0));

// 并列组：mtime 相同的 3 个，结果序必须是 findSessionFiles 的枚举序
const TIE_MTIME = BASE - TIE_FROM * 60000;
const tieOrder = (list) => view(list).filter((e) => e.mtime === TIE_MTIME).map((e) => e.file);
// findSessionFiles 的枚举序：两版都不导出它，这里用 lib 内部的同款 walk 复刻（readdir 递归、只收会话日志名）
function enumOrder(root) {
	const out = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (current.isSessionLogName(e.name)) out.push(rel(p));
		}
	};
	walk(root);
	return out;
}

// ---- 7. 场景：补位根 maxSessions=12 ----
const baseFill = await takeBase(() => baseline.collectSessionDigests(fillRoot, 30, 12));
const curFill = await take(() => current.collectSessionDigests(fillRoot, 30, 12));

// ---- 8. 场景：collectSessionLogs 全量口径（N-03 承重墙）逐项比对 ----
const logsBase = await takeBase(() => baseline.collectSessionLogs(sessionsRoot, 30));
const logsCur = await take(() => current.collectSessionLogs(sessionsRoot, 30));

// ---- 9. 场景：shouldExtract（windowDays=1 / maxSessions=1 口径）----
const cfg = {
	enabled: true,
	windowDays: 7,
	maxCandidatesPerRun: 3,
	skillLanguage: "zh",
	llmBaseUrl: "",
	llmApiKey: "",
	llmModel: "",
	agentSkillDir: path.join(home, ".agents", "skills"),
	mirrorDir: "",
	mergeThreshold: 0.2
};
const fakeLlm = (answer) => ({
	listProviders: () => [{ id: "fixture" }],
	listModels: async () => ["fixture-model"],
	prepareCall: async (config) => ({
		config,
		stream: async function* () {
			yield { type: "text-delta", text: answer };
			yield { type: "finish", reason: { kind: "ok" } };
		}
	})
});

process.env.DSH_SKILL_EXTRACTOR_SESSIONS = rememberRoot;
const seBase = await takeBase(() => baseline.shouldExtract(cfg, { llm: fakeLlm("YES") }));
const seCur = await take(() => current.shouldExtract(cfg, { llm: fakeLlm("YES") }));

process.env.DSH_SKILL_EXTRACTOR_SESSIONS = verdictRoot;
const seNoBase = await takeBase(() => baseline.shouldExtract(cfg, { llm: fakeLlm("NO") }));
const seNoCur = await take(() => current.shouldExtract(cfg, { llm: fakeLlm("NO") }));
const seYesBase = await takeBase(() => baseline.shouldExtract(cfg, { llm: fakeLlm("YES") }));
const seYesCur = await take(() => current.shouldExtract(cfg, { llm: fakeLlm("YES") }));
delete process.env.DSH_SKILL_EXTRACTOR_SESSIONS;

// ---- 10. 输出（只输出比对结论与计数，不输出整份会话正文）----
const out = {
	env,
	baselineAvailable: baseline !== null,
	main: {
		tieGroup: tieOrder(logsCur.v),
		tieGroupEnumOrder: enumOrder(sessionsRoot).filter((f) => tieOrder(logsCur.v).includes(f)),
		tieMtime: TIE_MTIME,
		base12: { files: view(base12.v).map((e) => e.file), n: base12.v.length },
		cur12: { files: view(cur12.v).map((e) => e.file), n: cur12.v.length },
		base11: { files: view(base11.v).map((e) => e.file), n: base11.v.length },
		cur11: { files: view(cur11.v).map((e) => e.file), n: cur11.v.length },
		same12: diff(view(base12.v), view(cur12.v)),
		sameTexts12: diff(baseline ? texts(baseline, base12.v) : null, texts(current, cur12.v)),
		same11: diff(view(base11.v), view(cur11.v)),
		sameTexts11: diff(baseline ? texts(baseline, base11.v) : null, texts(current, cur11.v)),
		edge0: { base: base0.v.length, cur: cur0.v.length, same: diff(view(base0.v), view(cur0.v)) },
		counts12: { baseline: base12.n, current: cur12.n },
		counts11: { baseline: base11.n, current: cur11.n }
	},
	fill: {
		baseCount: baseFill.v.length,
		curCount: curFill.v.length,
		baseFiles: view(baseFill.v).map((e) => e.file),
		curFiles: view(curFill.v).map((e) => e.file),
		same: diff(view(baseFill.v), view(curFill.v)),
		sameTexts: diff(baseline ? texts(baseline, baseFill.v) : null, texts(current, curFill.v)),
		counts: { baseline: baseFill.n, current: curFill.n }
	},
	logs: {
		baseCount: logsBase.v.length,
		curCount: logsCur.v.length,
		same: diff(view(logsBase.v), view(logsCur.v)),
		counts: { baseline: logsBase.n, current: logsCur.n }
	},
	shouldExtract: {
		remember: { base: seBase.v, cur: seCur.v, same: diff(seBase.v, seCur.v), counts: { baseline: seBase.n, current: seCur.n } },
		no: { base: seNoBase.v, cur: seNoCur.v, same: diff(seNoBase.v, seNoCur.v), counts: { baseline: seNoBase.n, current: seNoCur.n } },
		yes: { base: seYesBase.v, cur: seYesCur.v, same: diff(seYesBase.v, seYesCur.v), counts: { baseline: seYesBase.n, current: seYesCur.n } }
	}
};
process.stdout.write(json(out));
