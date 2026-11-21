import { historicalSource } from "./helpers/historical-source.mjs";
// PULL-3 测试：伪 HOME 全矩阵。快照 → 恢复（真实产出 PENDING_PULLS.json）→ 一键拉取，
// 四种结局各一条，断言逐条状态、lock 落盘、清单消项与保留规则、二次运行只重试未完成条目。
// 实网小拉取由 DSH_STUDIO_LIVE=1 开启（默认跳过，常态跑测试不联网）。
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let fails = 0;
const ok = (cond, msg) => {
	if (cond) console.log("  ok   " + msg);
	else {
		console.log("  FAIL " + msg);
		fails += 1;
	}
};

const home = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-pull-"));
const run = spawnSync(process.execPath, [path.join(here, "fixtures", "pull-home.mjs")], {
	env: { ...process.env, USERPROFILE: home, HOME: home },
	encoding: "utf8",
});
if (run.status !== 0) {
	console.error(run.stderr || run.stdout);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const out = JSON.parse(run.stdout);
const byName = (list) => Object.fromEntries(list.map((item) => [item.name, item]));

// ---- 1. 快照：大 skill 只记链接，内容不进包
{
	const names = out.externalNote.skills.map((s) => s.name);
	ok(names.length === 5 && ["pull-a", "pull-aa", "pull-b", "pull-c", "pull-d"].every((n) => names.includes(n)), "包内 EXTERNAL_SKILLS 记 5 条链接: " + names.join(","));
	ok(out.packedContentCount === 0, "被链接化的 skill 内容没进包（agents-skills/ 下 0 个文件）");
	ok(out.externalNote.thresholdBytes === 5 * 1024 * 1024, "链接化门槛 5 MB 原样记在包里");
}

// ---- 2. 恢复：清单是 restore 真实产出的，不是手写
{
	ok(out.restored.dryRun === false, "restore 真跑了一次（不是 dry-run）");
	ok(out.afterRestore.length === 5, "restore 写出 5 条待拉项: " + out.afterRestore.length);
	const a = byName(out.afterRestore)["pull-a"];
	ok(a !== undefined && typeof a.source === "string" && a.source === out.sources.a, "清单条目的 source 是 lock 里的本地 tarball 路径");
	ok(a !== undefined && a.ref === "" && a.subdir === "" && /^[0-9a-f]{64}$/.test(a.sha), "ref/subdir 字段形态稳定、sha 是 64 位内容哈希");
	ok(out.pendingFile === path.join(home, ".agents", "skills", "PENDING_PULLS.json"), "清单位置 = 外部 skill 根: " + out.pendingFile);
	ok(out.restored.pendingPulls.length === 5, "restore 的 summary 同步给出 pendingPulls");
}

// ---- 3. 逐条结局
{
	const first = out.first;
	const r = byName(first.results);
	ok(first.results.length === 5, "5 条全部处理（单条失败不中断其余条目）: " + first.results.map((x) => x.name + "=" + x.status).join(","));
	ok(r["pull-a"]?.status === "pulled", "pull-a 成功拉取（目标目录原本不存在）");
	ok(r["pull-a"]?.files === 2, "pull-a 落地 2 个文件: " + r["pull-a"]?.files);
	ok(out.dirs.aSkill && out.dirs.aBig, "pull-a 的 SKILL.md 与 big.bin 都在磁盘上");
	ok(r["pull-b"]?.status === "satisfied", "pull-b 已存在且内容一致 → satisfied");
	ok(r["pull-b"]?.relocked === false, "pull-b 的 lock 本来就对，不重写");
	ok(r["pull-c"]?.status === "conflict", "pull-c 同名异内容 → conflict");
	ok(r["pull-c"]?.lockedSha256 === "0".repeat(64) && r["pull-c"]?.incomingSha256 !== undefined, "conflict 同时给出锁里的与本次的 sha256");
	ok(out.dirs.cSkill.includes("上游 C v1"), "conflict 绝不覆盖：pull-c 仍是最初的内容");
	ok(r["pull-aa"]?.status === "failed" && /ENOENT|no such file/i.test(r["pull-aa"]?.reason ?? ""), "pull-aa 坏源 → failed（排在中间）");
	ok(r["pull-d"]?.status === "failed" && /ENOENT|no such file/i.test(r["pull-d"]?.reason ?? ""), "pull-d 坏源 → failed 并记下原因");
}

// ---- 4. 汇总计数
{
	const f = out.first;
	ok(f.ok === true && f.total === 5, "总条数 5");
	ok(f.pulled === 1 && f.satisfied === 1 && f.conflict === 1 && f.failed === 2, "计数 pulled1/satisfied1/conflict1/failed2");
	ok(f.remaining === 3, "剩余 3 条留在清单里");
	ok(typeof f.message === "string" && f.message.includes("3 条留在清单里"), "汇总文案: " + f.message);
}

// ---- 5. lock 落盘
{
	const a = out.lock["pull-a"];
	ok(a !== undefined && a.sha256 === out.hashes.a, "pull-a 的 lock 记下本次内容 sha256");
	ok(a !== undefined && a.source === out.sources.a && a.ref === "" && a.subPath === "", "lock 的 source/ref/subPath 形态与 U-3 一致");
	ok(out.lock["pull-b"]?.sha256 === out.hashes.b, "satisfied 的 pull-b 锁记录不变");
	ok(out.lock["pull-c"]?.sha256 === "0".repeat(64), "conflict 不改写 pull-c 的锁");
	// N-02：拉取路径也经 importSkill/relock 写 lock。本地 tarball 没有 git ref，commit 必须缺省，
	// 且 U-3 的五个字段一个不少 —— 纯增字段不许破坏旧形态。
	ok(a !== undefined && a.commit === undefined, "本地 tarball 拉取不写 commit（实际 " + JSON.stringify(a?.commit ?? null) + "）");
	ok(
		a !== undefined && ["source", "ref", "sha256", "at", "subPath"].every((key) => key in a),
		"补记字段后 U-3 形态仍是五字段俱全"
	);
}

// ---- 6. 清单消项与保留规则
{
	ok(out.listAfterFirst.join(",") === "pull-aa,pull-c,pull-d", "成功与已满足的消项，冲突与失败保留: " + out.listAfterFirst.join(","));
	ok(out.leftovers.length === 0, "写回没有留下半截 .tmp 文件");
}

// ---- 7. 二次运行只重试未完成条目
{
	const s = out.second;
	ok(s.total === 3 && s.pulled === 0 && s.satisfied === 0 && s.conflict === 1 && s.failed === 2, "二次运行只处理剩下的 3 条");
	ok(out.listAfterSecond.join(",") === "pull-aa,pull-c,pull-d", "未完成的条目仍原样保留");
	ok(out.second.remaining === 3, "二次运行后剩余仍是 3");
}

// ---- 8. 清单不存在：空结果、不报错
{
	ok(out.empty.ok === true && out.empty.total === 0, "清单不存在时返回空结果");
	ok(String(out.empty.message).includes("无待拉项"), "空结果明示「无待拉项」: " + out.empty.message);
}

rmSync(home, { recursive: true, force: true });

// ---- 9. 实网小拉取（DSH_STUDIO_LIVE=1 才跑）
if (process.env.DSH_STUDIO_LIVE === "1") {
	console.log("\n[9] 实网小拉取 huashu-proofreading");
	const liveHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-live-"));
	const live = spawnSync(process.execPath, [path.join(here, "fixtures", "live-pull-home.mjs")], {
		env: { ...process.env, USERPROFILE: liveHome, HOME: liveHome },
		encoding: "utf8",
		timeout: 600_000
	});
	if (live.status !== 0) {
		console.log("  FAIL 实网 fixture 退出码 " + live.status + "：" + (live.stderr || live.stdout).slice(0, 800));
		fails += 1;
	} else {
		const l = JSON.parse(live.stdout);
		ok(l.result.pulled === 1 && l.result.total === 1, "实网条目 pulled=1");
		ok(l.landed === true, "huashu-proofreading 的 SKILL.md 落到磁盘");
		ok(l.lock?.source === "https://github.com/alchaincyf/huashu-skills", "lock 的 source 是仓库根: " + l.lock?.source);
		ok(l.lock?.ref === "master" && l.lock?.subPath === "huashu-proofreading", "lock 的 ref / subPath 结构化正确");
		ok(/^[0-9a-f]{64}$/.test(l.lock?.sha256 ?? ""), "lock 记下内容 sha256");
		ok(l.pendingExists === false, "拉取成功后清单清空（文件消失 = 无待拉项）");
		ok(l.head.some((line) => line.includes("name: huashu-proofreading")), "落地文件是正的 huashu-proofreading");
	}
	rmSync(liveHome, { recursive: true, force: true });
} else {
	console.log("\n[9] 跳过实网拉取（DSH_STUDIO_LIVE=1 才跑）");
}

// ---- 10. N-12：createSnapshot 流式打包 —— 等价性 / 长名 / 超限 / 中途失败
console.log("\n[10] N-12 流式打包");
{
	const streamHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-stream-"));
	const streamRun = spawnSync(process.execPath, [path.join(here, "fixtures", "snapshot-stream-home.mjs")], {
		env: {
			...process.env,
			USERPROFILE: streamHome,
			HOME: streamHome,
			DSH_HOME: path.join(streamHome, ".dsh"),
			DSH_AGENTS_HOME: "",
			DSH_SKILL_EXTRACTOR_CANDIDATES: ""
		},
		encoding: "utf8",
		timeout: 180000
	});
	if (streamRun.status !== 0) {
		console.log("  FAIL N-12 fixture 退出码 " + streamRun.status + "：" + (streamRun.stderr || streamRun.stdout).slice(0, 1200));
		fails += 1;
		rmSync(streamHome, { recursive: true, force: true });
	} else {
		const s = JSON.parse(streamRun.stdout);
		const e = s.equivalence;
		ok(
			s.env.userprofile === s.env.home && s.env.homeVar === s.env.home && s.env.dshHomeVar === s.env.dshHome,
			`伪 HOME 三件套全部指向临时目录（USERPROFILE=${s.env.userprofile}）`
		);
		if (s.baselineId !== null) {
			ok(e.entryDiff.length === 0, `基线版与新版解包后逐条 (rel, data) 全等（${e.collectCount} 条，差异 ${JSON.stringify(e.entryDiff.slice(0, 3))}）`);
			ok(e.filesDiff.length === 0, `manifest.files 逐项全等（rel/bytes/sha，差异 ${JSON.stringify(e.filesDiff.slice(0, 3))}）`);
			ok(e.skippedEqual === true, "skipped/excluded/redacted 三个口径与基线一致");
			ok(
				e.notes.redacted.equal && e.notes.external.equal && e.notes.skipped.equal,
				`三份说明文件（脱敏/链接化/跳过）都在包内且逐字节相同：${JSON.stringify(e.notes)}`
			);
			// gzip 压缩结果在 Node 24 上偶发差 1 字节（CI 两次都是 1451 vs 基线），
			// 解包内容与 manifest 已在上面逐条全等；这里只拦明显的体积回归。
			// B5：gzip 由 9 级改 6 级（基线版仍是 9 级），压缩结果本来就会差几十字节；仍只拦明显的体积回归（> 5% 且 > 16 字节）
			const archiveDelta = Math.abs(e.archiveBytes.baseline - e.archiveBytes.current);
			ok(
				archiveDelta <= Math.max(16, e.archiveBytes.baseline * 0.05),
				`归档体积与基线接近（基线 ${e.archiveBytes.baseline}，当前 ${e.archiveBytes.current}，差 ${archiveDelta}；解包内容已逐条全等）`
			);
			ok(s.cross.crossDiff.length === 0, `新版包用基线 unpackTarGz 解完全等（差异 ${JSON.stringify(s.cross.crossDiff.slice(0, 3))}）`);
		} else console.log("SKIP snapshot 历史内容对拍：af7daae 不可用；当前恢复与失败断言继续");
		ok(e.notes.redacted.inCurrent && e.notes.external.inCurrent && e.notes.skipped.inCurrent, "当前包保留三份说明文件");
		ok(
			s.cross.restoreDiff.length === 0 && s.cross.restore.failed.length === 0,
			`新版包走新版 restoreSnapshot 恢复到空 HOME 逐项一致（期望 ${s.cross.restore.expected} 项，写入 ${s.cross.restore.written}，失败 ${s.cross.restore.failed.length}）`
		);
		ok(s.cross.mcpHasPlaceholder === false && s.cross.mcpHasSecret === false, "凭据文件恢复后既无占位符也无明文（N-04 合并语义照旧）");
		ok(s.longName.longnameOk === true && s.longName.longnameLen > 100, `GNU longname（'L'）路径往返一致（rel ${s.longName.longnameLen} 字节）`);
		ok(s.longName.prefixOk === true && s.longName.prefixLen > 100, `ustar prefix 可拆长名往返一致（rel ${s.longName.prefixLen} 字节）`);
		if (s.overlimit.skipped === true) {
			console.log(`  skip 超硬上限场景（rel ${s.overlimit.relLen} 字节）：${s.overlimit.reason}`);
		} else {
			ok(
				s.overlimit.threw === true && s.overlimit.message.includes("4096"),
				`超硬上限（rel ${s.overlimit.relLen} 字节）仍报错拒绝：${s.overlimit.message.slice(0, 60)}`
			);
			ok(s.overlimit.dirsUnchanged === true && s.overlimit.strayTmps === 0, "超限时不留快照目录、不留临时文件（不写坏包）");
		}
		ok(s.midFail.throw === true && s.midFail.tmpSeen === true, `打包中途源文件消失会抛错（观察到临时文件后删除，${String(s.midFail.message).slice(0, 60)}）`);
		ok(
			s.midFail.dirGone === true && s.midFail.officialArchive === false && s.midFail.strayTmps === 0,
			`失败后不留正式包、不留临时文件、不留快照目录（新增目录 ${JSON.stringify(s.midFail.dirsAdded)}）`
		);
		rmSync(streamHome, { recursive: true, force: true });
	}
}

// ---- 11. N-12：峰值内存 —— 基线版 vs 流式版（独立子进程，伪 HOME，各 3 次取中位）
console.log("\n[11] N-12 峰值内存");
const memoryBaseline = historicalSource("af7daae", "lib/snapshot.js");
if (memoryBaseline !== null) {
	const memHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-mem-"));
	const probe = path.join(here, "fixtures", "snapshot-mem-probe.mjs");
	const memEnv = {
		...process.env,
		USERPROFILE: memHome,
		HOME: memHome,
		DSH_HOME: path.join(memHome, ".dsh"),
		DSH_AGENTS_HOME: "",
		DSH_SKILL_EXTRACTOR_CANDIDATES: ""
	};
	const runProbe = (args) => {
		const r = spawnSync(process.execPath, [probe, ...args], { env: memEnv, encoding: "utf8", timeout: 300000 });
		if (r.status !== 0) return { error: (r.stderr || r.stdout).slice(0, 800) };
		return JSON.parse(r.stdout.trim().split("\n").pop());
	};
	const buildBig = runProbe(["build", `--home=${memHome}`, "--mb=108", "--files=120"]);
	// 基线版：整目录 cp 后覆盖 af7daae 的 snapshot.js（相对 import 才解析得开）
	const baselineDir = path.join(memHome, "baseline-lib");
	cpSync(path.join(here, "..", "lib"), baselineDir, { recursive: true, filter: (src) => !src.includes(".bak-mcp-") });
	writeFileSync(
		path.join(baselineDir, "snapshot.js"),
		memoryBaseline,
		"utf8"
	);
	const baselineLib = path.join(baselineDir, "snapshot.js");
	const baseRuns = [];
	const curRuns = [];
	for (let i = 0; i < 3; i += 1) baseRuns.push(runProbe(["run", `--home=${memHome}`, `--lib=${baselineLib}`]));
	for (let i = 0; i < 3; i += 1) curRuns.push(runProbe(["run", `--home=${memHome}`]));
	const buildSmall = runProbe(["build", `--home=${memHome}`, "--mb=36", "--files=40"]);
	const smallRuns = [runProbe(["run", `--home=${memHome}`]), runProbe(["run", `--home=${memHome}`])];
	const median = (runs) => runs.map((r) => r.deltaKB ?? NaN).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
	const fmt = (runs) => runs.map((r) => (r.error ? `err:${r.error.slice(0, 40)}` : `${r.deltaKB}KB/${r.ms}ms`)).join(", ");
	const healthy = [buildBig, buildSmall, ...baseRuns, ...curRuns, ...smallRuns].every((r) => r.error === undefined);
	ok(
		healthy,
		`6 次 108 MB + 2 次 36 MB 全部跑完：基线 ${fmt(baseRuns)}｜新版 ${fmt(curRuns)}｜36 MB ${fmt(smallRuns)}`
	);
	const baseMed = median(baseRuns);
	const curMed = median(curRuns);
	const smallMed = median(smallRuns);
	ok(curRuns[0]?.libSha256 !== baseRuns[0]?.libSha256, "两次测量确实跑的是两份不同的 snapshot.js（基线副本 vs 当前 lib）");
	ok(
		Number.isFinite(baseMed) && Number.isFinite(curMed) && curMed * 3 <= baseMed,
		`新版峰值增量 ≤ 基线 1/3：基线中位 ${baseMed} KB，新版中位 ${curMed} KB（比值 ${(curMed / baseMed).toFixed(3)}）`
	);
	ok(
		Number.isFinite(smallMed) && curMed < 24 * 1024 && Math.abs(curMed - smallMed) < 16 * 1024,
		`增量与最大单文件（${curRuns[0]?.maxFileBytes ?? "?"} 字节）同量级、与总体积脱钩：108 MB→${curMed} KB，36 MB→${smallMed} KB`
	);
	// 机器无关：旧版绝对值只记录（不同 V8 / 平台 / RSS 口径差异大），判定交给上面的 1/3 比例
	console.log(`  NOTE 基线版增量（仅记录）：${baseMed} KB；新版 ${curMed} KB；比值 ${(curMed / baseMed).toFixed(3)}`);
	rmSync(memHome, { recursive: true, force: true });
} else console.log("SKIP 历史内存对拍：af7daae 不可用；保留此前的失败汇总");

console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
