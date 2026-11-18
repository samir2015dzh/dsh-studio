/**
 * ：main CI 在 windows + node 24 上 [C1] 报 `EPERM: open ...state.json.lock`。
 *
 * 根因：Windows 上删一个仍被别人开着的文件，文件进入「删除挂起」——目录项留到最后一个句柄关掉为止，
 * 这期间 `wx` 建同名文件拿到 EPERM / EACCES 而不是 EEXIST。withFsLock 的抢锁循环以前只把 EEXIST 当「被占着」，
 * 其余一律抛出，于是「一个等待者正在读锁文件、另一个刚把它删掉」的瞬间，抢锁直接失败（[C1] 的两个回收者正好撞上）。
 *
 * 真实环境里「删除挂起」要靠外部句柄（杀毒软件 / 索引服务）的时序才撞得上：较新的 Windows + node 默认按 POSIX 语义删，
 * 自己开着的句柄挡不住（CI 实测 win32 / node 24.22.2 上 deletePending() 报 false），所以 CI 上时有时无。
 * 稳定复现走测试钩子 _lockTestHooks.beforeCreate 注入 EPERM / EACCES（任何平台都跑）；
 * 文末两条仍按真实句柄造挂起态，在会进入挂起态的机器上走真实路径，不会的机器上只验证普通路径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { open, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = await import(pathToFileURL(join(pluginRoot, "lib", "state-lock.js")).href);
const home = mkdtempSync(join(tmpdir(), "dsh-wo18-"));
test.after(() => rmSync(home, { recursive: true, force: true }));

/** 造一个「删除挂起」的锁文件：建好、开着句柄、删掉。返回句柄，以及本机是否真的进入了挂起态。 */
async function deletePending(lockPath) {
	await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: "other" }));
	const fh = await open(lockPath, "r");
	await unlink(lockPath);
	let pending = false;
	try {
		const probe = await open(lockPath, "wx");
		await probe.close();
		await unlink(lockPath);
	} catch (error) {
		pending = lock.isTransientLockCreateError(error?.code);
		if (!pending) throw error;
	}
	return { fh, pending };
}

test("[#18] 只有 Windows 上的 EPERM / EACCES 算暂时性建锁失败", () => {
	assert.equal(lock.isTransientLockCreateError("EPERM", "win32"), true);
	assert.equal(lock.isTransientLockCreateError("EACCES", "win32"), true);
	assert.equal(lock.isTransientLockCreateError("EEXIST", "win32"), false, "EEXIST 走原来的「被占着」分支");
	assert.equal(lock.isTransientLockCreateError("ENOENT", "win32"), false, "目录没了之类的真错误照样抛");
	assert.equal(lock.isTransientLockCreateError("EPERM", "linux"), false, "POSIX 上 EPERM 是真的没权限，不吞");
	assert.equal(lock.isTransientLockCreateError("EACCES", "darwin"), false);
	assert.equal(lock.isTransientLockCreateError(undefined, "win32"), false);
});

/** 让下一次（或前 n 次）`wx` 建锁抛出给定错误码。 */
function failCreate(code, times) {
	let calls = 0;
	lock._lockTestHooks.beforeCreate = async () => {
		calls += 1;
		if (calls <= times) throw Object.assign(new Error(`${code}: operation not permitted, open (test)`), { code });
	};
	return () => calls;
}
const resetHooks = () => {
	lock._lockTestHooks.beforeCreate = null;
	lock._lockTestHooks.platform = null;
};

test("[#18] 稳定复现：Windows 上建锁先报两次 EPERM（锁正在释放）→ 重试后拿到锁、临界区照常执行", async () => {
	const lockPath = join(home, "inject-ok", "state.json.lock");
	mkdirSync(dirname(lockPath), { recursive: true });
	lock._lockTestHooks.platform = "win32";
	const calls = failCreate("EPERM", 2);
	let ran = false;
	try {
		await lock.withFsLock(lockPath, async () => (ran = true), { pollMs: 5, timeoutMs: 2000 });
	} finally {
		resetHooks();
	}
	assert.equal(ran, true, "修复前这里直接抛 EPERM（main CI 44101824384 的 [C1] 就是这样挂的）");
	assert.equal(calls(), 3, "两次暂时失败 + 一次成功");
	assert.equal(existsSync(lockPath), false);
});

test("[#18] EACCES 同样按暂时失败重试", async () => {
	const lockPath = join(home, "inject-eacces", "state.json.lock");
	mkdirSync(dirname(lockPath), { recursive: true });
	lock._lockTestHooks.platform = "win32";
	failCreate("EACCES", 1);
	let ran = false;
	try {
		await lock.withFsLock(lockPath, async () => (ran = true), { pollMs: 5, timeoutMs: 2000 });
	} finally {
		resetHooks();
	}
	assert.equal(ran, true);
});

test("[#18] 非 Windows 上的 EPERM 是真的没权限：原样抛出、不重试", async () => {
	const lockPath = join(home, "inject-posix", "state.json.lock");
	mkdirSync(dirname(lockPath), { recursive: true });
	lock._lockTestHooks.platform = "linux";
	const calls = failCreate("EPERM", 99);
	try {
		await assert.rejects(lock.withFsLock(lockPath, async () => assert.fail("不该进临界区"), { pollMs: 5, timeoutMs: 500 }), (e) => e.code === "EPERM");
	} finally {
		resetHooks();
	}
	assert.equal(calls(), 1, "只试一次");
});

test("[#18] Windows 上 EPERM 一直不消失：按 deadline 报锁超时并带上原始错误码，不无限等", async () => {
	const lockPath = join(home, "inject-stuck", "state.json.lock");
	mkdirSync(dirname(lockPath), { recursive: true });
	lock._lockTestHooks.platform = "win32";
	failCreate("EPERM", Infinity);
	const started = Date.now();
	try {
		await assert.rejects(
			lock.withFsLock(lockPath, async () => assert.fail("不该进临界区"), { pollMs: 5, timeoutMs: 200 }),
			(e) => e.code === "DSH_STUDIO_LOCK_TIMEOUT" && e.cause?.code === "EPERM" && /EPERM/.test(e.message)
		);
	} finally {
		resetHooks();
	}
	assert.ok(Date.now() - started < 2000, "按 timeoutMs 收手");
});

test("[#18] 锁文件「删除挂起」期间抢锁：等句柄关掉后正常拿到锁，不抛 EPERM", async (t) => {
	const lockPath = join(home, "pending", "state.json.lock");
	mkdirSync(dirname(lockPath), { recursive: true });
	const { fh, pending } = await deletePending(lockPath);
	t.diagnostic(`本机是否进入删除挂起：${pending}（${process.platform} / node ${process.versions.node}）`);
	// 120ms 后关掉句柄——挂起态随之结束，锁文件真正消失
	const closer = setTimeout(() => void fh.close(), 120);
	let ran = false;
	try {
		await lock.withFsLock(lockPath, async () => {
			ran = true;
		}, { pollMs: 5, timeoutMs: 3000 });
	} finally {
		clearTimeout(closer);
		await fh.close().catch(() => {});
	}
	assert.equal(ran, true, "临界区执行了");
	assert.equal(existsSync(lockPath), false, "释放后锁文件删掉了");
});

test("[#18] 挂起一直不结束：按 deadline 报锁超时（带上原始错误码），不会无限等", async (t) => {
	const lockPath = join(home, "stuck", "state.json.lock");
	mkdirSync(dirname(lockPath), { recursive: true });
	const { fh, pending } = await deletePending(lockPath);
	try {
		if (!pending) {
			// 本机不会进入挂起态：同样的步骤就是一次普通抢锁
			t.diagnostic("本机不进入删除挂起，这一条只验证普通路径");
			let ran = false;
			await lock.withFsLock(lockPath, async () => (ran = true), { pollMs: 5, timeoutMs: 300 });
			assert.equal(ran, true);
			return;
		}
		await assert.rejects(
			lock.withFsLock(lockPath, async () => assert.fail("挂起期间不该进临界区"), { pollMs: 5, timeoutMs: 200 }),
			(error) => error.code === "DSH_STUDIO_LOCK_TIMEOUT" && lock.isTransientLockCreateError(error.cause?.code)
		);
	} finally {
		await fh.close().catch(() => {});
	}
});
