/**
 * 定时备份失败必须把「[dsh-studio] 定时备份失败：」写到 stderr，
 * 不能只靠 ctx.logger?.warn?（真机第 9 项：EPERM 抛了，隔离实例标准流里没有这行）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-backup-warn-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");

const { runScheduledBackup, saveSchedule, loadSchedule, SCHEDULED_BACKUP_FAIL_PREFIX, snapshotsDir } = await import(
	pathToFileURL(join(pluginRoot, "lib/snapshot.js")).href
);

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

function captureWarn(fn) {
	const lines = [];
	const original = console.warn;
	console.warn = (...args) => {
		lines.push(args.map((value) => String(value)).join(" "));
	};
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			console.warn = original;
		})
		.then((result) => ({ result, lines }));
}

try {
	mkdirSync(join(fakeHome, ".dsh", "dsh-studio"), { recursive: true });
	await saveSchedule({ enabled: true, intervalHours: 24, lastError: "", lastErrorAt: 0 });
	// 把快照目录做成普通文件，mkdir 必然失败（Windows / Linux 都成立，不必 chmod）。
	writeFileSync(snapshotsDir(), "not-a-directory");

	console.log("\n[1] 写拒绝时 stderr 出现固定前缀");
	{
		let thrown;
		const { lines } = await captureWarn(async () => {
			try {
				await runScheduledBackup();
			} catch (error) {
				thrown = error;
			}
		});
		assert(thrown !== undefined, "runScheduledBackup 应抛出");
		const hit = lines.find((line) => line.includes(SCHEDULED_BACKUP_FAIL_PREFIX));
		assert(Boolean(hit), `stderr 应含「${SCHEDULED_BACKUP_FAIL_PREFIX}」，实际：${JSON.stringify(lines)}`);
		assert(hit.includes(String(thrown.message ?? thrown)), "warn 应带上原始错误信息");
		const cfg = await loadSchedule();
		assert(cfg.lastError.length > 0, "失败原因已记入 lastError: " + cfg.lastError);
	}

	console.log("\n[2] logger 没有 warn（函数形态 / 缺方法）时仍打 stderr");
	{
		const fnLogger = () => {};
		let thrown;
		const { lines } = await captureWarn(async () => {
			try {
				await runScheduledBackup(Date.now(), { logger: fnLogger });
			} catch (error) {
				thrown = error;
			}
		});
		assert(thrown !== undefined, "函数形态 logger 时仍应抛出");
		assert(
			lines.some((line) => line.includes(SCHEDULED_BACKUP_FAIL_PREFIX)),
			"logger 无 warn 时 stderr 仍有前缀，实际：" + JSON.stringify(lines),
		);
	}

	console.log("\n[3] 有 logger.warn 时两边都写，且仍打 stderr");
	{
		const logged = [];
		const logger = { warn: (message) => logged.push(String(message)) };
		const { lines } = await captureWarn(async () => {
			try {
				await runScheduledBackup(Date.now(), { logger });
			} catch {
				/* 预期失败 */
			}
		});
		assert(
			logged.some((line) => line.includes(SCHEDULED_BACKUP_FAIL_PREFIX)),
			"应转发到 logger.warn：" + JSON.stringify(logged),
		);
		assert(
			lines.some((line) => line.includes(SCHEDULED_BACKUP_FAIL_PREFIX)),
			"即使有 logger.warn 也必须写 stderr：" + JSON.stringify(lines),
		);
	}
} finally {
	rmSync(fakeHome, { recursive: true, force: true });
}

if (failed) {
	console.error(failed, "failed");
	process.exit(1);
}
console.log("\n=== ALL PASS (scheduled-backup-warn) ===");
