// U-3 测试：lock 写结构化（仓库根 + subPath），旧 tree URL 形态读侧不变，子目录导入 + 幂等回归。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-import-"));

let fails = 0;
const ok = (cond, msg) => {
	if (cond) console.log("  ok   " + msg);
	else {
		console.log("  FAIL " + msg);
		fails += 1;
	}
};

const modUrl = (rel) => pathToFileURL(path.join(here, "..", rel)).href;
const { lockRecordFor, parseSkillSource } = await import(modUrl("lib/skillsrc.js"));
const { splitSourceUrl } = await import(modUrl("lib/paths.js"));

// ---- 1. 新写出的 lock：source 是仓库根，ref / subPath 各自结构化
{
	const parsed = parseSkillSource("https://github.com/o/r/tree/v1.2.3/skills/foo");
	const rec = lockRecordFor(parsed, { sha256: "c".repeat(64), now: 0 });
	ok(rec.source === "https://github.com/o/r", "source 存仓库根 URL: " + rec.source);
	ok(rec.ref === "v1.2.3", "ref 结构化: " + rec.ref);
	ok(rec.subPath === "skills/foo", "subPath 结构化: " + rec.subPath);
	ok(rec.sha256 === "c".repeat(64) && typeof rec.at === "string", "sha256 / at 字段保留");
}
{
	const parsed = parseSkillSource("https://github.com/o/r");
	const rec = lockRecordFor(parsed, { sha256: "d".repeat(64), now: 0 });
	ok(rec.source === "https://github.com/o/r" && rec.ref === "HEAD" && rec.subPath === "", "仓库根导入：ref 为 HEAD、subPath 为空");
}

// ---- 2. 旧形态（source 是完整 tree URL）读侧解析不变
{
	const parsed = parseSkillSource("https://github.com/o/r/tree/v1.2.3/skills/foo");
	const fresh = lockRecordFor(parsed, { sha256: "e".repeat(64), now: 0 });
	const oldShape = { source: "https://github.com/o/r/tree/v1.2.3/skills/foo", ref: "v1.2.3", sha256: "e".repeat(64), at: "2026-01-01T00:00:00.000Z", subPath: "skills/foo" };
	const fromOld = splitSourceUrl(oldShape.source);
	const fromNew = splitSourceUrl(fresh.source);
	ok(fromOld.repo === fresh.source, "旧 tree URL 归一成同一个仓库根: " + fromOld.repo);
	ok(fromOld.ref === fresh.ref && fromOld.subdir === fresh.subPath, "旧形态的 ref/subdir 与结构化字段一致");
	ok(fromNew.repo === fresh.source && fromNew.ref === "" && fromNew.subdir === "", "新形态（裸仓库 URL）解析不额外造 ref");
}

// ---- 3. 子目录导入 + 幂等（伪 HOME，本地 tarball，不联网）
const run = spawnSync(process.execPath, [path.join(here, "fixtures", "import-lock-home.mjs")], {
	env: { ...process.env, USERPROFILE: home, HOME: home },
	encoding: "utf8",
});
if (run.status !== 0) {
	console.error(run.stderr || run.stdout);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
}
const { first, second, lock, tgz, targetDir } = JSON.parse(run.stdout);
ok(first.ok === true && first.changed === true, "子目录导入首次写出: " + first.name);
ok(first.files === 2, "导入落地子目录里的 2 个文件: " + first.files);
ok(existsSync(path.join(targetDir, "demo-sub", "SKILL.md")), "SKILL.md 落到 <targetDir>/demo-sub/");
ok(existsSync(path.join(targetDir, "demo-sub", "extra.md")), "子目录里的其他文件一并落地");
ok(second.ok === true && second.changed === false, "同 ref 同内容再导入是幂等的");

const rec = lock["demo-sub"];
ok(rec !== undefined && rec.source === tgz, "本地 tarball 的 source 记原路径而不是伪造仓库地址");
ok(rec !== undefined && rec.ref === "" && rec.subPath === "", "本地 tarball 的 ref / subPath 为空");
ok(rec !== undefined && rec.sha256 === first.sha256, "lock 记下内容 sha256: " + String(rec?.sha256).slice(0, 12));
ok(lockFileHasStructuredField(lock, "demo-sub"), "lock 记录字段形态稳定（source/ref/sha256/at/subPath）");

function lockFileHasStructuredField(table, name) {
	const keys = Object.keys(table[name] ?? {});
	return ["source", "ref", "sha256", "at", "subPath"].every((key) => keys.includes(key));
}

rmSync(home, { recursive: true, force: true });

// ---- 4. M-3：codeload 下载的网络类重试（替身 fetch，伪 HOME）
const retryHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-retry-"));
const retryRun = spawnSync(process.execPath, [path.join(here, "fixtures", "import-retry-home.mjs")], {
	env: { ...process.env, USERPROFILE: retryHome, HOME: retryHome },
	encoding: "utf8"
});
if (retryRun.status !== 0) {
	console.error(retryRun.stderr || retryRun.stdout);
	rmSync(retryHome, { recursive: true, force: true });
	process.exit(1);
}
const retry = JSON.parse(retryRun.stdout);
ok(retry.flakyResult?.ok === true && retry.flakyResult?.changed === true, "首次 ECONNRESET 后重试导入成功: " + retry.flakyResult?.name);
ok(retry.flakyCalls === 2, "网络错只重试一次就成功，fetch 恰好调用 2 次（实际 " + retry.flakyCalls + "）");
ok(retry.imported === true, "重试成功后文件真的落地");
ok(retry.serverResult?.ok === true && retry.serverCalls === 2, "首次 503 也重试（调用 " + retry.serverCalls + " 次）");
ok(retry.missingCalls === 1, "404 不重试，只调用 1 次（实际 " + retry.missingCalls + "）");
ok(/HTTP 404/.test(retry.missingMessage), "404 的报错原文保留: " + retry.missingMessage);
rmSync(retryHome, { recursive: true, force: true });

// ---- 5. N-02：导入时 lock 补记来源 ref 的 commit（本地 bare 仓库当上游，insteadOf 重写，离线）
const commitHome = mkdtempSync(path.join(os.tmpdir(), "dsh-studio-commit-"));
const commitRun = spawnSync(process.execPath, [path.join(here, "fixtures", "import-commit-home.mjs")], {
	env: { ...process.env, USERPROFILE: commitHome, HOME: commitHome },
	encoding: "utf8"
});
if (commitRun.status !== 0) {
	console.error(commitRun.stderr || commitRun.stdout);
	rmSync(commitHome, { recursive: true, force: true });
	process.exit(1);
}
const commitFixture = JSON.parse(commitRun.stdout);
const commitRec = commitFixture.recOk ?? {};
ok(/^[0-9a-f]{40}$/.test(String(commitFixture.headSha ?? "")), "bare 上游有可读的 HEAD commit: " + String(commitFixture.headSha).slice(0, 7));
ok(commitRec.commit === commitFixture.headSha, "lock 记录补记 commit 且等于上游 ref 的 HEAD sha（实际 " + JSON.stringify(commitRec.commit ?? null) + "）");
ok(
	commitRec.source === "https://github.com/commit-fixture/repo" && commitRec.ref === "HEAD" && commitRec.subPath === "",
	"补记 commit 不改 U-3 的 source/ref/subPath 形态"
);
ok(
	typeof commitRec.sha256 === "string" && commitRec.sha256.length === 64 && typeof commitRec.at === "string",
	"补记 commit 后内容哈希与时间戳仍在"
);
ok(
	commitFixture.check?.status === "latest" && commitFixture.check?.localSha === commitFixture.headSha,
	"经 resolveUpstream/update_check 口径可比对（status=" + String(commitFixture.check?.status) + "），不再是 unknown-version"
);
ok(
	commitFixture.importedBad?.ok === true && commitFixture.importedBad?.changed === true,
	"ls-remote 不可达时导入照常成功: " + JSON.stringify(commitFixture.importedBad?.changed)
);
ok(
	(commitFixture.recBad ?? {}).commit === undefined,
	"ls-remote 不可达时 commit 缺省（实际 " + JSON.stringify((commitFixture.recBad ?? {}).commit ?? null) + "）"
);
ok(commitFixture.badCommit === "", "查不到 commit 的解析结果为空串，不抛错（实际 " + JSON.stringify(commitFixture.badCommit) + "）");
ok(commitFixture.tarballCommit === "", "本地 tarball 来源不伪造 commit（实际 " + JSON.stringify(commitFixture.tarballCommit) + "）");
rmSync(commitHome, { recursive: true, force: true });

console.log(fails === 0 ? "\n=== ALL PASS" : `\n=== ${fails} FAILED`);
process.exitCode = fails ? 1 : 0;
