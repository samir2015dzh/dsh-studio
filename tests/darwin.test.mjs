// darwin 调度器冒烟测试：同族折叠、静默闸、扫描隔离
// 每个场景独立的 stateFile，避免 mtime 基线互相串扰。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { applyDarwin, localStamp } from "../lib/darwin.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-test-"));
const skills = path.join(root, "skills");

const HOST = "parallel-subagent-file-ownership";
const MEMBERS = [
	"parallel-fix-file-ownership",
	"parallel-port-file-ownership",
	"exclusive-file-partition-parallel-port",
	"scoped-subagent-delegation",
	"parallel-agent-build-isolation",
];

for (const name of [HOST, ...MEMBERS]) {
	fs.mkdirSync(path.join(skills, name), { recursive: true });
	fs.writeFileSync(path.join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: 同一个职责\n---\nbody`);
}

// darwin-skill 本体：注入逻辑先查它装没装（WO-EVO-5），装了才给评估步骤
fs.mkdirSync(path.join(skills, "darwin-skill"), { recursive: true });
fs.writeFileSync(path.join(skills, "darwin-skill", "SKILL.md"), "---\nname: darwin-skill\ndescription: 本体\n---\nbody");

let fails = 0;
const ok = (cond, msg) => {
	if (cond) console.log("  ok   " + msg);
	else {
		console.log("  FAIL " + msg);
		fails += 1;
	}
};

let seq = 0;
const scene = (cfg = {}) => {
	seq += 1;
	const h = new Map();
	const ctx = { on: (ev, fn) => h.set(ev, fn), logger: { info: () => {}, warn: () => {} } };
	const stateFile = path.join(root, `state-${seq}.json`);
	const familyFile = path.join(root, `families-${seq}.json`);
	// 预设 lastSweep：否则首次挂载会立刻跑一轮巡检，把 stale 项塞进输出，干扰断言
	fs.writeFileSync(stateFile, JSON.stringify({ scores: {}, lastSweep: Date.now() }));
	applyDarwin(ctx, { roots: [skills], stateFile, familyFile, familyRefreshDays: 0, sweepHours: 999, ...cfg }, {});
	return { h, stateFile, familyFile };
};

const writeSkill = (h, name) =>
	h.get("tools/post-execute")({ name: "write", arguments: { file_path: path.join(skills, name, "SKILL.md") } }, {}, async () => {});

const sectionText = async (h) => {
	const out = await h.get("system-prompt/assemble")({}, {}, async () => ({ sections: [] }));
	const sec = (out.sections ?? []).find((s) => s.name === "darwin");
	return sec ? sec.text : "";
};

/** 只取「待评估清单」那一段，避开折叠行里的同名路径。 */
const pendingBlock = (text) => {
	const i = text.indexOf("本轮检测到下列 skill 文件被改写");
	if (i < 0) return "";
	const j = text.indexOf("步骤：", i);
	return text.slice(i, j < 0 ? undefined : j);
};

// ---- 1. 没有 families.json：全部进体检
{
	const { h } = scene();
	ok(h.has("tools/post-execute") && h.has("system-prompt/assemble"), "两个事件都注册");
	for (const n of [HOST, ...MEMBERS]) await writeSkill(h, n);
	const text = await sectionText(h);
	const block = pendingBlock(text);
	ok(MEMBERS.every((m) => block.includes(m)), "无 families.json 时成员全部进体检");
	ok(block.includes(HOST), "宿主也进体检");
	ok(text.includes("9 维 rubric"), "提示文本完整");
	ok(!text.includes("上游已有新版"), "无上游信息时不提示上游（U-1）");
}

// ---- 2. 有 families.json：成员折叠，只留宿主
{
	const { h, stateFile, familyFile } = scene();
	fs.writeFileSync(
		familyFile,
		JSON.stringify({
			version: 1,
			updatedAt: localStamp().slice(0, 10),
			families: [{ id: "fam", host: HOST, members: MEMBERS, reason: "test" }],
		}),
	);
	for (const n of [HOST, ...MEMBERS]) await writeSkill(h, n);
	const text = await sectionText(h);
	const block = pendingBlock(text);
	ok(block.includes(HOST), "有 families.json 时宿主仍进体检");
	ok(MEMBERS.every((m) => !block.includes(m)), "成员不进待评估清单");
	ok(text.includes("已按 families.json 折叠"), "输出标明已折叠");
	const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	const key = (m) => path.resolve(path.join(skills, m, "SKILL.md")).toLowerCase();
	ok(MEMBERS.every((m) => st.scores[key(m)] > 0), "成员记入 scores，下轮不重送");
	ok(!(st.scores[key(HOST)] > 0), "宿主未被标记为已处理");
}

// ---- 3. 加载 darwin-skill 后静默
{
	const { h } = scene();
	await writeSkill(h, HOST);
	await h.get("tools/post-execute")({ name: "skill", arguments: { name: "darwin-skill" } }, {}, async () => {});
	ok((await sectionText(h)) === "", "加载 darwin-skill 后进入静默期");
}

// ---- 3b. 读类工具读 SKILL.md 不记 pending（WO-EVO-3）
{
	const { h } = scene();
	await h.get("tools/post-execute")(
		{ name: "read", arguments: { file_path: path.join(skills, HOST, "SKILL.md") } },
		{},
		async () => {},
	);
	ok((await sectionText(h)) === "", "read 工具读 SKILL.md 不产生 pending");
	await h.get("tools/post-execute")(
		{ name: "grep", arguments: { path: path.join(skills, MEMBERS[0], "SKILL.md") } },
		{},
		async () => {},
	);
	ok((await sectionText(h)) === "", "grep 工具读 SKILL.md 不产生 pending");
	// 同一个文件换成写类工具，仍要能记上
	await writeSkill(h, MEMBERS[0]);
	ok(pendingBlock(await sectionText(h)).includes(MEMBERS[0]), "写类工具仍能记 pending");
}

// ---- 4. roots 外的 SKILL.md 不触发
{
	const { h } = scene();
	await h.get("tools/post-execute")(
		{ name: "write", arguments: { file_path: path.join(root, "other", "SKILL.md") } },
		{},
		async () => {},
	);
	ok((await sectionText(h)) === "", "roots 外的 SKILL.md 不触发");
}

// ---- 6. results.tsv 回收：回写了结果才算评过（WO-EVO-5）
{
	const resultsFile = path.join(root, `results-${seq + 1}.tsv`);
	const { h, stateFile } = scene({ resultsFile });
	await writeSkill(h, HOST);
	fs.writeFileSync(
		resultsFile,
		[
			"timestamp\tcommit\t" + "skill\told_score\tnew_score\tstatus\tdimension\tnote\teval_mode",
			// 时间戳按本机时区产生（与插件解析同一基准；所有者裁定 2026-11-17：不固定到任何单一时区）
			`${localStamp()}\tabc1234\t${HOST}\t58\t82\tkeep\tstructure\t结构补全\tpaired`,
		].join("\n") + "\n",
	);
	await sectionText(h);
	const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	const key = path.resolve(path.join(skills, HOST, "SKILL.md")).toLowerCase();
	ok(st.scores[key] > 0, "results.tsv 回收后 state.scores 记分");
	ok(st.results?.[HOST]?.newScore === "82", "state.results 记下分数");
	ok(st.results?.[HOST]?.status === "keep", "state.results 记下结论");
	ok(st.results?.[HOST]?.evalMode === "paired", "state.results 记下 eval_mode");
	ok((await sectionText(h)) === "", "回收后 pending 清空，下轮不再提");
}

// ---- 6b. 结果行带时区标记：标记不作数，按字面钟点作本机时间（所有者裁定 2026-11-17，）
//      模型照本机钟点写、却顺手带了标记。旧码按绝对时刻算：本机偏移小于标记偏移时（如 +14:00 在任何常见时区，
//      Z 在 UTC 以西）新鲜结果被当成几小时前的旧行拒收，pending 永不清。
for (const mark of [":00Z", "+14:00"]) {
	const resultsFile = path.join(root, `results-${seq + 1}.tsv`);
	const { h, stateFile } = scene({ resultsFile });
	await writeSkill(h, HOST);
	fs.writeFileSync(
		resultsFile,
		[
			"timestamp\tcommit\t" + "skill\told_score\tnew_score\tstatus\tdimension\tnote\teval_mode",
			`${localStamp()}${mark}\tdef5678\t${HOST}\t60\t85\tkeep\tstructure\t带时区标记\tpaired`,
		].join("\n") + "\n",
	);
	await sectionText(h);
	const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	const tz = process.env.TZ ?? "本机默认";
	ok(st.results?.[HOST]?.newScore === "85", `带 ${mark} 的本机钟点结果行被回收（TZ=${tz}）`);
	ok((await sectionText(h)) === "", `带 ${mark} 的结果回收后 pending 清空（TZ=${tz}）`);
}

// ---- 6c. ：无人值守体检的改写一律经 skillmgr_darwin_submit；体检期间直接写被点名的 SKILL.md 被拒，交互流程放行
{
	const { h } = scene({ suppressMs: 0 });
	await writeSkill(h, HOST);
	const text = await sectionText(h);
	ok(text.includes("skillmgr_darwin_submit"), "无人值守提示要求经 skillmgr_darwin_submit 提交");
	ok(!text.includes("直接落地改进"), "不再让模型直接落地改写");
	ok(text.includes("不要直接改写 SKILL.md"), "明确禁止直接改写");
	const pre = h.get("tools/pre-execute");
	ok(typeof pre === "function", "注册了 tools/pre-execute 守护");
	let passed = 0;
	const next = async () => {
		passed += 1;
		return { kind: "allow" };
	};
	const target = path.join(skills, HOST, "SKILL.md");
	const denied = await pre({ name: "write", arguments: { file_path: target, content: "x" } }, next);
	ok(denied?.kind === "deny" && /skillmgr_darwin_submit/.test(denied.reason) && passed === 0, "体检期间直接写被点名的 SKILL.md：拒绝并指向提交工具");
	const other = await pre({ name: "write", arguments: { file_path: path.join(skills, MEMBERS[0], "SKILL.md"), content: "x" } }, next);
	ok(other?.kind === "allow" && passed === 1, "没被点名的 skill 不拦");
	const read = await pre({ name: "read", arguments: { file_path: target } }, next);
	ok(read?.kind === "allow" && passed === 2, "读类工具不拦");
	// 有人在场：用户显式调用 darwin-skill → 交互流程不受影响
	h.get("agent/inbox/claimed")({ message: { source: { kind: "skill-invocation", name: "darwin-skill" } } });
	const interactive = await pre({ name: "edit", arguments: { file_path: target } }, next);
	ok(interactive?.kind === "allow" && passed === 3, "用户显式调用 darwin-skill 的交互流程不拦");
}

// ---- 7. 只加载 darwin-skill 不写结果：pending 保留，下轮再提
{
	const { h, stateFile } = scene({ suppressMs: 0 });
	await writeSkill(h, HOST);
	await h.get("tools/post-execute")({ name: "skill", arguments: { name: "darwin-skill" } }, {}, async () => {});
	const text = await sectionText(h);
	ok(pendingBlock(text).includes(HOST), "只加载未回写结果时 pending 保留，下轮仍提");
	const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	ok(st.unfinished?.[HOST] >= 1, "未完成次数记入 state.unfinished");
}

// ---- 8. darwin-skill 本体未安装：告警而非空转（WO-EVO-5）
{
	seq += 1;
	const bare = path.join(root, `bare-${seq}`);
	fs.mkdirSync(path.join(bare, "lonely"), { recursive: true });
	fs.writeFileSync(path.join(bare, "lonely", "SKILL.md"), "---\nname: lonely\ndescription: d\n---\nbody");
	const warns = [];
	const h = new Map();
	const ctx = { on: (ev, fn) => h.set(ev, fn), logger: { info: () => {}, warn: (m) => warns.push(String(m)) } };
	const stateFile = path.join(root, `state-bare-${seq}.json`);
	fs.writeFileSync(stateFile, JSON.stringify({ scores: {}, lastSweep: Date.now() }));
	applyDarwin(ctx, { roots: [bare], stateFile, familyFile: path.join(root, "families-bare.json"), familyRefreshDays: 0, sweepHours: 999 }, {});
	await h.get("tools/post-execute")({ name: "write", arguments: { file_path: path.join(bare, "lonely", "SKILL.md") } }, {}, async () => {});
	const text = await sectionText(h);
	ok(text.includes("darwin-skill 本体未安装"), "未装本体时注入告警段");
	ok(!text.includes("9 维 rubric"), "未装本体时不再给评估步骤");
	ok(warns.some((w) => w.includes("darwin-skill 本体未安装")), "未装本体时打 warning 日志");
}

// ---- 5. enabled:false 完全不挂
{
	seq += 1;
	const h = new Map();
	const ctx = { on: (ev, fn) => h.set(ev, fn), logger: { info: () => {}, warn: () => {} } };
	applyDarwin(ctx, { enabled: false, roots: [skills] }, {});
	ok(h.size === 0, "enabled:false 时不注册任何事件");
}

// ---- 9. 上游提示（U-1）：本地 bare 仓库充当 origin ----
{
	seq += 1;
	const base = path.join(root, `up-${seq}`);
	const origin = path.join(base, "upstream.git");
	const work = path.join(base, "git-skill");
	fs.mkdirSync(work, { recursive: true });
	fs.mkdirSync(path.join(base, "darwin-skill"), { recursive: true });
	fs.writeFileSync(path.join(base, "darwin-skill", "SKILL.md"), "---\nname: darwin-skill\ndescription: 本体\n---\nbody");
	fs.writeFileSync(path.join(work, "SKILL.md"), "---\nname: git-skill\ndescription: d\n---\nbody");

	const git = (dir, args) =>
		execFileSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
			encoding: "utf8",
			stdio: "pipe",
		}).trim();
	git(base, ["init", "--bare", "-b", "main", origin]);
	git(work, ["init", "-b", "main"]);
	git(work, ["add", "-A"]);
	git(work, ["commit", "--no-verify", "-m", "init"]);
	git(work, ["remote", "add", "origin", origin]);
	git(work, ["push", "-u", "origin", "main"]);

	// 空 lock：本场景只走 .git 定源，不受真机 skill-lock.json 影响
	const lockFile = path.join(base, "lock.json");
	fs.writeFileSync(lockFile, "{}");
	const cfg = () => ({ roots: [base], lockFile, upstreamTtlMs: 0 });
	const touch = (h) =>
		h.get("tools/post-execute")({ name: "write", arguments: { file_path: path.join(work, "SKILL.md") } }, {}, async () => {});

	// 9a. 本地与上游一致：静默，待评估清单照常
	{
		const { h } = scene(cfg());
		await touch(h);
		const text = await sectionText(h);
		ok(!text.includes("上游已有新版"), "上游无新提交时不提示（U-1）");
		ok(pendingBlock(text).includes("git-skill"), "无差异时优化清单不受影响（U-1）");
	}

	// 9b. 上游推了新提交：给出短 sha 提示
	{
		const other = path.join(base, "clone");
		git(base, ["clone", origin, other]);
		fs.writeFileSync(path.join(other, "NEW.md"), "new\n");
		git(other, ["add", "-A"]);
		git(other, ["commit", "--no-verify", "-m", "upstream new"]);
		git(other, ["push", "origin", "main"]);
		const short = git(other, ["rev-parse", "HEAD"]).slice(0, 7);

		const { h } = scene(cfg());
		await touch(h);
		const text = await sectionText(h);
		ok(text.includes(`上游已有新版（${short}）`), "上游有新提交时提示短 sha: " + short);
		ok(text.includes("本次优化仍基于本地版本"), "提示带「仍基于本地版本」（U-1）");
		ok(pendingBlock(text).includes("git-skill"), "提示不挤掉待评估清单（U-1）");
	}

	// 9c. 有上游但远端不可达：静默跳过，主流程不中断
	{
		git(work, ["remote", "set-url", "origin", path.join(base, "missing.git")]);
		const { h } = scene({ ...cfg(), upstreamTimeoutMs: 3000 });
		await touch(h);
		const text = await sectionText(h);
		ok(!text.includes("上游已有新版"), "网络/远端失败时静默（U-1）");
		ok(text.includes("9 维 rubric"), "失败时优化主流程照旧（U-1）");
	}
}

fs.rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
