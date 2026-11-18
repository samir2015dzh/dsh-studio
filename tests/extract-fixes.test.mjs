/**
 * 提取链路的几处修复：
 *   1. 定时提取失败后按连续失败次数退避（lib/extract-backoff.js）
 *   2. 无会话可提取时也记运行时间（否则定时器每分钟重扫）
 *   3. 每轮判定：提示词的准入条件、输出上限、失败不再被吞成 NO
 *   4. 模型原始输出的诊断文件按用途分开，判定调用不落盘
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-extract-fixes-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
const stateDir = join(fakeHome, ".dsh", "dsh-studio");
mkdirSync(stateDir, { recursive: true });
const sessionsRoot = join(fakeHome, "sessions");
const emptyRoot = join(fakeHome, "sessions-empty");
mkdirSync(join(sessionsRoot, "s1"), { recursive: true });
mkdirSync(emptyRoot, { recursive: true });
process.env.DSH_SKILL_EXTRACTOR_SESSIONS = sessionsRoot;

const load = (file) => import(pathToFileURL(join(pluginRoot, file)).href);
const { extractBackoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS } = await load("lib/extract-backoff.js");
const { shouldExtract, callLLM, runExtraction, defaults, VERDICT_MAX_TOKENS, RAW_FILE_EXTRACT, RAW_FILE_MERGE } = await load("lib/extractor.js");

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

/** 一份带一问一答的会话日志（不含「记住」类说法，判定会走到模型）。 */
const writeSession = () => {
	const rows = [
		{ type: "session", id: "s1", createdAt: new Date().toISOString(), cwd: join(fakeHome, "proj") },
		{ type: "agent/inbox/spliced", data: { inserted: [{ role: "user", content: [{ type: "text", text: "帮我看看这个构建为什么失败" }] }] } },
		{ type: "agent/inbox/spliced", data: { inserted: [{ role: "assistant", content: [{ type: "text", text: "原因是锁文件和依赖不同步" }] }] } }
	];
	writeFileSync(join(sessionsRoot, "s1", "session.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
};

/** 记录每次调用参数的假模型；answer 为 Error 时在流里抛出。 */
const fakeLlm = (answer, seen = []) => ({
	seen,
	listProviders: () => [{ id: "fixture" }],
	listModels: async () => ["fixture-model"],
	prepareCall: async (config) => ({
		config,
		stream: async function* (options) {
			seen.push({ config, options });
			if (answer instanceof Error) throw answer;
			yield { type: "text-delta", text: answer };
			yield { type: "finish", reason: { kind: "ok" } };
		}
	})
});

const cfg = { ...defaults(), agentSkillDir: join(fakeHome, ".agents", "skills"), mirrorDir: "" };
const rawPath = (name) => join(stateDir, name);

try {
	console.log("\n[1] 失败退避");
	{
		assert(extractBackoffMs(0) === 0, "没失败过不用等");
		assert(extractBackoffMs(1) === BACKOFF_BASE_MS, "第一次失败等 5 分钟");
		assert(extractBackoffMs(2) === BACKOFF_BASE_MS * 2 && extractBackoffMs(3) === BACKOFF_BASE_MS * 4, "之后每次翻倍");
		assert(extractBackoffMs(50) === BACKOFF_MAX_MS && extractBackoffMs(1e9) === BACKOFF_MAX_MS, "封顶 6 小时，次数很大也不溢出");
		assert(extractBackoffMs(NaN) === 0 && extractBackoffMs(-3) === 0, "非法入参按没失败处理");
		let monotonic = true;
		for (let i = 1; i < 30; i++) if (extractBackoffMs(i + 1) < extractBackoffMs(i)) monotonic = false;
		assert(monotonic, "等待时间随失败次数单调不减");
	}

	console.log("\n[2] 无会话也记运行时间");
	{
		const now = Date.now();
		const result = await runExtraction(cfg, emptyRoot, { now, llm: fakeLlm("{}") });
		assert(result.ok === true && result.message === "近期无会话可提取", "空目录返回「近期无会话可提取」");
		assert(result.site?.lastRunAt === new Date(now).toISOString(), "带 site.lastRunAt，定时器不会每分钟重扫");
	}

	console.log("\n[3] 每轮判定");
	{
		writeSession();
		const seenYes = [];
		const yes = await shouldExtract(cfg, { llm: fakeLlm("YES", seenYes) });
		assert(yes.worth === true && yes.remember === false && yes.error === undefined, "模型答 YES → worth:true，不带 error");
		const no = await shouldExtract(cfg, { llm: fakeLlm("NO") });
		assert(no.worth === false && no.remember === false && no.error === undefined, "模型答 NO → worth:false，不带 error");

		const call = seenYes[0];
		assert(call?.config?.maxTokens === VERDICT_MAX_TOKENS && VERDICT_MAX_TOKENS >= 256, `判定的输出上限是 ${VERDICT_MAX_TOKENS}（给推理模型留余量）`);
		const prompt = call?.options?.messages?.[0]?.content?.[0]?.text ?? "";
		assert(prompt.includes("【A】") && prompt.includes("【B】") && prompt.includes("任意一组"), "提示词：A（四条全满足）或 B（用户点名）任一即可");
		assert(!prompt.includes("全部满足才答 YES"), "提示词不再要求五条全部满足");

		const boom = await shouldExtract(cfg, { llm: fakeLlm(new Error("upstream 503")) });
		assert(boom !== false && typeof boom === "object", "模型抛错时返回的仍是对象，不是 false");
		assert(boom.worth === false && boom.remember === false && /upstream 503/.test(boom.error ?? ""), "失败带出 error 原因，由调用方记日志");
		const empty = await shouldExtract(cfg, { llm: fakeLlm("") });
		assert(empty.worth === false && typeof empty.error === "string" && empty.error !== "", "模型返回空内容也算失败并带原因");
	}

	console.log("\n[4] 诊断文件");
	{
		for (const f of [RAW_FILE_EXTRACT, RAW_FILE_MERGE]) rmSync(rawPath(f), { force: true });
		await callLLM(cfg, "p", { llm: fakeLlm('{"candidates":[]}') });
		assert(readFileSync(rawPath(RAW_FILE_EXTRACT), "utf8") === '{"candidates":[]}', "默认（提取）写 last-llm-raw.txt");
		await shouldExtract(cfg, { llm: fakeLlm("NO") });
		assert(readFileSync(rawPath(RAW_FILE_EXTRACT), "utf8") === '{"candidates":[]}', "之后的 YES/NO 判定不覆盖提取的原始输出");
		await callLLM(cfg, "p", { llm: fakeLlm("KEEP"), rawFile: RAW_FILE_MERGE });
		assert(readFileSync(rawPath(RAW_FILE_MERGE), "utf8") === "KEEP", "合并调用写自己的文件");
		assert(readFileSync(rawPath(RAW_FILE_EXTRACT), "utf8") === '{"candidates":[]}', "合并调用也不动提取的那份");
		rmSync(rawPath(RAW_FILE_MERGE), { force: true });
		await callLLM(cfg, "p", { llm: fakeLlm("x"), rawFile: null });
		assert(!existsSync(rawPath(RAW_FILE_MERGE)), "rawFile:null 不落盘");
	}
} finally {
	rmSync(fakeHome, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`\n${failed} 项失败`);
	process.exit(1);
}
console.log("\n全部通过");
