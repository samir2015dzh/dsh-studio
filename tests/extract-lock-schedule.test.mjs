/**
 * 提取单飞锁 + 定时备份失败会记到配置里。
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-extract-lock-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");

const { withExtractLock, isExtractRunning } = await import(pathToFileURL(join(pluginRoot, "lib/extractor.js")).href);
const { loadSchedule, saveSchedule, runScheduledBackup } = await import(pathToFileURL(join(pluginRoot, "lib/snapshot.js")).href);
const { UserError } = await import(pathToFileURL(join(pluginRoot, "lib/errors.js")).href);

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	console.log("\n[1] withExtractLock");
	{
		let started = 0;
		let finished = 0;
		const first = withExtractLock(async () => {
			started += 1;
			assert(isExtractRunning() === true, "第一轮进行中 isExtractRunning");
			await wait(40);
			finished += 1;
			return "ok";
		});
		let busyMsg = "";
		let busyCode = "";
		try {
			await withExtractLock(async () => "second");
		} catch (error) {
			busyMsg = error.message;
			busyCode = error.code;
			assert(error instanceof UserError, "并发第二轮是 UserError");
		}
		assert(/正在提取/.test(busyMsg), "并发提示: " + busyMsg);
		assert(busyCode === "EXTRACT_BUSY", "EXTRACT_BUSY code: " + busyCode);
		assert((await first) === "ok" && started === 1 && finished === 1, "第一轮正常完成");
		assert(isExtractRunning() === false, "结束后锁已释放");
		const again = await withExtractLock(async () => "again");
		assert(again === "again", "结束后可以再跑");

		let released = false;
		try {
			await withExtractLock(async () => {
				throw new Error("boom");
			});
		} catch (error) {
			released = error.message === "boom";
		}
		assert(released && isExtractRunning() === false, "失败也会释放锁");
	}

	console.log("\n[2] 定时备份 lastError");
	{
		mkdirSync(join(fakeHome, ".dsh", "dsh-studio"), { recursive: true });
		const skipped = await runScheduledBackup();
		assert(skipped.skipped === "disabled", "默认关闭时跳过");
		let cfg = await loadSchedule();
		assert(cfg.lastError === "" && cfg.lastErrorAt === 0, "默认没有错误");

		cfg = await saveSchedule({ lastError: "磁盘已满", lastErrorAt: 123 });
		assert(cfg.lastError === "磁盘已满" && cfg.lastErrorAt === 123, "写入 lastError");
		cfg = await loadSchedule();
		assert(cfg.lastError === "磁盘已满" && cfg.lastErrorAt === 123, "读回 lastError");

		cfg = await saveSchedule({ enabled: true, intervalHours: 24 });
		assert(cfg.enabled === true && cfg.lastError === "磁盘已满", "改开关不丢上次错误");

		cfg = await saveSchedule({ lastError: "", lastErrorAt: 0 });
		assert(cfg.lastError === "" && cfg.lastErrorAt === 0, "成功后可清空错误");
		assert(readFileSync(join(fakeHome, ".dsh", "dsh-studio", "snapshot.json"), "utf8").includes('"lastError": ""'), "已写进 snapshot.json");
	}
} finally {
	rmSync(fakeHome, { recursive: true, force: true });
}

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (extract-lock-schedule) ===");
