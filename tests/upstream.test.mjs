// U-2 检查能力测试：伪 HOME 里三种上游来源（.git / lock / meta）各一例 + 一例不可达上游，
// 验证 structured 结果、强制双数字汇总，以及「失败不中断全量」。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-home-"));

let fails = 0;
const ok = (cond, msg) => {
	if (cond) console.log("  ok   " + msg);
	else {
		console.log("  FAIL " + msg);
		fails += 1;
	}
};

const run = spawnSync(process.execPath, [path.join(here, "fixtures", "update-check-home.mjs")], {
	env: { ...process.env, USERPROFILE: home, HOME: home },
	encoding: "utf8",
});
if (run.status !== 0) {
	console.error(run.stderr || run.stdout);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const { result, upstreamShort, linked } = JSON.parse(run.stdout);
const byName = (name) => (result.skills ?? []).find((s) => s.name === name);

// ---- 汇总：强制双数字（已查 N / 全库 M，可判定 K）
ok(result.ok === true, "检查返回 ok");
ok(result.totals.total === 5, "全库 M = 5（同一 skill 挂两棵树只算一次）: " + result.totals.total + (linked ? "（junction 已建）" : "（junction 未建）"));
ok(result.totals.determinable === 4, "可判定 K = 4: " + result.totals.determinable);
ok(result.totals.checked === 4, "已查 N = 4: " + result.totals.checked);
ok(String(result.message).startsWith("已查 4 / 全库 5（可判定 4）"), "汇总行是双数字口径: " + result.message);

// ---- 三种来源各一例
const gitCase = byName("git-behind");
ok(gitCase?.via === "git", ".git origin 定源被识别: " + JSON.stringify(gitCase?.via));
ok(gitCase?.status === "behind", "上游推了新提交 → 判「有新版」: " + gitCase?.status);
ok(String(gitCase?.upstreamSha ?? "").startsWith(upstreamShort), "上游 sha 与远端一致: " + upstreamShort);
ok(String(gitCase?.localSha ?? "").length === 40 && gitCase.localSha !== gitCase.upstreamSha, "本地与上游 sha 不同");

const lockCase = byName("lock-unknown");
ok(lockCase?.via === "lock", "lock 记录定源被识别");
ok(lockCase?.status === "unknown-version", "lock 的 sha256 对不齐 commit → 「无法比对」");
ok(lockCase?.repo === "https://github.com/example-org/example-repo", "旧 tree URL 的 source 归一成仓库根: " + lockCase?.repo);
ok(lockCase?.ref === "main" && lockCase?.subPath === "skills/lock-unknown", "旧 tree URL 的 ref/subPath 仍能读出");

const metaCase = byName("meta-latest");
ok(metaCase?.via === "meta", ".huashu-skill-meta.json 定源被识别");
ok(metaCase?.status === "latest", "meta 的 commit 与上游一致 → 「最新」: " + metaCase?.status);

// ---- 失败逐条标注、不中断全量
const failedCase = byName("meta-failed");
ok(failedCase?.status === "failed", "不可达上游 → 「检查失败」");
ok(typeof failedCase?.note === "string" && failedCase.note !== "", "失败项带原因: " + failedCase?.note);
ok(gitCase?.status === "behind" && lockCase?.status === "unknown-version" && metaCase?.status === "latest", "一例失败不影响其余三例");

// ---- 无上游的不算可判定
ok(!(result.skills ?? []).some((s) => s.name === "plain"), "无上游线索的 skill 不进结果列表");
ok((result.skills ?? []).length === 4, "结果只列可判定的 4 个: " + (result.skills ?? []).length);

rmSync(home, { recursive: true, force: true });

// ---- M-1 每轮联网上限：4 个不同上游只发 3 次 ls-remote，第 4 个静默；缓存命中不计次
const budgetHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-budget-"));
const budgetRun = spawnSync(process.execPath, [path.join(here, "fixtures", "upstream-budget-home.mjs")], {
	env: { ...process.env, USERPROFILE: budgetHome, HOME: budgetHome },
	encoding: "utf8",
});
if (budgetRun.status !== 0) {
	console.error(budgetRun.stderr || budgetRun.stdout);
	rmSync(budgetHome, { recursive: true, force: true });
	process.exit(1);
}
const budget = JSON.parse(budgetRun.stdout);
ok(budget.seqUsed === 3, "4 个不同上游顺序检查只联网 3 次（budget.used = " + budget.seqUsed + "）");
ok(budget.seq.slice(0, 3).every((h) => h.includes("上游已有新版")), "前 3 个都给出上游提示");
ok(budget.seq[3] === "", "第 4 个被预算挡下 → 静默无提示: " + JSON.stringify(budget.seq[3]));
ok(budget.parUsed === 3, "并发（darwin 真实形态）下总量仍是 3 次联网（budget.used = " + budget.parUsed + "）");
ok(budget.par.filter((h) => h !== "").length === 3, "并发下恰好 3 个有提示、1 个静默");
ok(budget.cacheUsed === 0 && budget.cached.every((h) => h.includes("上游已有新版")), "10 分钟 TTL 缓存命中不计次（再次检查 3 个仓库仍出提示，budget.used = " + budget.cacheUsed + "）");
rmSync(budgetHome, { recursive: true, force: true });

// ---- N-10：update_check 接 upstreamTtlMs 缓存（与 darwin 同口径）
const ttlHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-ttl-"));
const ttlRun = spawnSync(process.execPath, [path.join(here, "fixtures", "update-check-ttl-home.mjs")], {
	env: { ...process.env, USERPROFILE: ttlHome, HOME: ttlHome },
	encoding: "utf8",
});
if (ttlRun.status !== 0) {
	console.error(ttlRun.stderr || ttlRun.stdout);
	rmSync(ttlHome, { recursive: true, force: true });
	process.exit(1);
}
const ttl = JSON.parse(ttlRun.stdout);
ok(
	ttl.first?.status === "latest" && ttl.first?.upstreamSha === ttl.shaV1,
	"首次查询对齐上游 HEAD（" + String(ttl.first?.status) + " / " + String(ttl.first?.upstreamSha).slice(0, 7) + "）"
);
ok(
	ttl.second?.upstreamSha === ttl.shaV1,
	"TTL 内第二次查询仍返回缓存的旧 sha（实际 " + String(ttl.second?.upstreamSha).slice(0, 7) + "，新 sha 是 " + String(ttl.shaV2).slice(0, 7) + "）"
);
ok(ttl.second?.status === "latest", "TTL 内第二次查询没有因上游下线而 failed —— 证明那次 ls-remote 真的没发生");
ok(
	ttl.fresh?.upstreamSha === ttl.shaV2 && ttl.fresh?.status === "behind",
	"ttl=0 的对照实例查得到新提交（" + String(ttl.fresh?.status) + " / " + String(ttl.fresh?.upstreamSha).slice(0, 7) + "），说明上面的不变是缓存造成的"
);
ok(/缓存|TTL/.test(String(ttl.second?.message ?? "")), "工具输出里注明 TTL 窗口内可能来自缓存: " + String(ttl.second?.message ?? "").slice(0, 120));
rmSync(ttlHome, { recursive: true, force: true });

// ---- N-01：skillmgr_update_apply 的七个场景 + 备份不变式（lib 层真跑，离线）
const applyHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-apply-"));
const applyRun = spawnSync(process.execPath, [path.join(here, "fixtures", "update-apply-home.mjs")], {
	env: { ...process.env, USERPROFILE: applyHome, HOME: applyHome },
	encoding: "utf8",
	timeout: 120000
});
if (applyRun.status !== 0) {
	console.error(applyRun.stderr || applyRun.stdout);
	rmSync(applyHome, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const ap = JSON.parse(applyRun.stdout);
const scenes = ap.scenes;
const stripGroup = (text) => text.replace(/^[ \t]+group\s*:.*(?:\r?\n|$)/m, "");
const hex64 = (value) => /^[0-9a-f]{64}$/.test(String(value));

// ---- 场景 1：普通直升（独立仓库形态）+ 已是最新短路
ok(scenes.one.apply.ok === true && scenes.one.apply.changed === true, "直升：ok 且 changed");
ok(scenes.one.apply.oldCommit === scenes.one.shaOld, "直升：oldCommit 取 lock 里的旧 commit（" + String(scenes.one.shaOld).slice(0, 7) + "）");
ok(scenes.one.apply.newCommit === scenes.one.shaNew, "直升：newCommit 是上游新提交（" + String(scenes.one.shaNew).slice(0, 7) + "）");
ok(scenes.one.after["SKILL.md"] !== scenes.one.before["SKILL.md"], "直升：安装目录的 SKILL.md 已换成新版");
ok(hex64(scenes.one.lock.sha256) && scenes.one.lock.sha256 !== "0".repeat(64), "直升：lock.sha256 写成新包的 tarball 哈希");
ok(scenes.one.lock.commit === scenes.one.shaNew, "直升：lock.commit 记成上游新提交");
ok(scenes.one.check.status === "latest", "直升：应用后 checkUpstream 同口径复验为 latest（" + scenes.one.check.status + "）");
ok(
	scenes.one.apply.added === 0 && scenes.one.apply.deleted === 0 && scenes.one.apply.modified === 1,
	`直升：文件计数 +0/-0/~1（实际 +${scenes.one.apply.added}/-${scenes.one.apply.deleted}/~${scenes.one.apply.modified}）`
);
ok(
	JSON.stringify(scenes.one.apply.lockUpdated) === JSON.stringify(["at", "commit", "sha256"]),
	"直升：lockUpdated 是实际变化的字段名（" + JSON.stringify(scenes.one.apply.lockUpdated) + "）"
);
ok(scenes.one.again.changed === false && scenes.one.again.ok === true, "已是最新：changed=false 而不是报错");
ok(scenes.one.again.backupPath === "", "已是最新：没有备份路径（不备份、不拉取）");
ok(JSON.stringify(scenes.one.lock) === JSON.stringify(scenes.one.lockAgain), "已是最新：lock 逐字段未变");

// ---- 场景 2：monorepo 子目录（huashu-slides 形态）
ok(
	JSON.stringify(Object.keys(scenes.two.after).sort()) === JSON.stringify(["SKILL.md", "notes.txt"]),
	"子目录：只取 subPath 下的树，不带 README/other（实际 " + Object.keys(scenes.two.after).join(", ") + "）"
);
ok(scenes.two.apply.name === "sub-skill" && scenes.two.apply.ok === true, "子目录：技能名按安装目录定名 sub-skill");
ok(scenes.two.check.status === "latest" && scenes.two.apply.newCommit === scenes.two.shaNew, "子目录：lock 与复验都对齐新提交");
ok(scenes.two.apply.preservedFiles.length === 0, "子目录：上游覆盖了全部旧文件，没有本地独有文件");

// ---- 场景 3：独立仓库（subPath 空，整仓即技能）
ok(
	Object.keys(scenes.three.after).includes(".github/workflows/ci.yml") && Object.keys(scenes.three.after).includes("docs/a.md"),
	"独立仓库：整仓带入（含 .github 与 docs）"
);
ok(scenes.three.apply.added === 2, "独立仓库：内容计数 +2（实际 +" + scenes.three.apply.added + "）");
ok(scenes.three.check.status === "latest", "独立仓库：复验 latest");

// ---- 场景 4：标注重打（旧有 metadata.group，上游没有）
ok(scenes.four.apply.annotationReapplied === true, "标注：annotationReapplied=true");
ok(scenes.four.bak === scenes.four.upstream, "标注：SKILL.md.bak-group 与上游原件逐字节相等");
ok(stripGroup(scenes.four.skill) === scenes.four.upstream, "标注：剥掉 group 行后与上游原件逐字节相等");
ok(
	/^[ ]{2}group: 花叔$/m.test(scenes.four.skill) && scenes.four.skill.indexOf("  group: 花叔") > scenes.four.skill.indexOf("metadata:"),
	"标注：group 按旧值补回，两空格缩进且落在 metadata 块内（与 extractor 同款）"
);

// ---- 场景 5：本地独有文件保留 + commit 标记更新
ok(
	JSON.stringify(scenes.five.apply.preservedFiles) === JSON.stringify([".huashu-skill-meta.json", "local-only.md"]),
	"保留：preservedFiles 列出两个本地独有文件（" + scenes.five.apply.preservedFiles.join(", ") + "）"
);
ok(scenes.five.meta.commit === scenes.five.shaNew, "保留：.huashu-skill-meta.json 的 commit 换成新提交");
ok(scenes.five.localOnly === "只有本地有\n", "保留：任意本地独有文件原样带入");
ok(JSON.stringify(scenes.five.apply.lockUpdated) === JSON.stringify(["at", "commit", "sha256"]), "保留：lock 照常更新三字段");

// ---- 场景 6：无来源拒绝（零写入）
ok(scenes.six.apply1.ok === false && scenes.six.apply1.stage === "source", "无来源：stage=source（" + scenes.six.apply1.message + "）");
ok(/skill-lock\.json/.test(scenes.six.apply1.message), "无来源：原因写明缺 lock 记录");
ok(scenes.six.apply2.ok === false && scenes.six.apply2.stage === "source" && /tarball/.test(scenes.six.apply2.message), "无来源：本地 tarball 来源被拒（" + scenes.six.apply2.message + "）");
ok(JSON.stringify(scenes.six.before.files) === JSON.stringify(scenes.six.after.files), "无来源：安装目录逐文件哈希零改动");
ok(scenes.six.before.lock === scenes.six.after.lock, "无来源：skill-lock.json 逐字节零写入");

// ---- 场景 7：拉取失败零改动
ok(scenes.seven.apply1.ok === false && scenes.seven.apply1.stage === "fetch", "拉取失败：上游不可达 → stage=fetch（" + String(scenes.seven.apply1.message).slice(0, 60) + "…）");
ok(scenes.seven.apply1.oldCommit === "d".repeat(40), "拉取失败：oldCommit 照实回报");
ok(scenes.seven.apply2.ok === false && scenes.seven.apply2.stage === "fetch" && /SKILL\.md/.test(scenes.seven.apply2.message), "拉取失败：包内无 SKILL.md → stage=fetch（" + scenes.seven.apply2.message + "）");
ok(JSON.stringify(scenes.seven.before) === JSON.stringify(scenes.seven.after), "拉取失败：两个安装目录逐文件哈希与应用前完全一致");
ok(scenes.seven.lockSame === true, "拉取失败：lock 不变");
ok(scenes.seven.apply1.backupPath === "" && scenes.seven.apply2.backupPath === "", "拉取失败：没有留下备份目录");

// ---- 备份不变式
ok(ap.backup.outsideRoots === true, "备份：路径不在两棵扫描根之内（" + ap.backup.path + "）");
ok(ap.backup.underDataDir === true, "备份：落在插件数据目录的 skill-backups 下");
ok(JSON.stringify(scenes.one.backup) === JSON.stringify(scenes.one.before), "备份：备份内容与旧目录逐文件一致");
rmSync(applyHome, { recursive: true, force: true });

console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
