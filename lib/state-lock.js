/**
 * 按文件粒度的异步串行器（N-06）+ 跨进程文件锁。
 *
 * 进程内：同一文件的 load→改→save 周期排队，避免单进程内 RMW 覆盖。
 * 跨进程：在 `<file>.lock` 上用 `wx` 原子建锁（PID + at），僵死/超时可回收。
 *
 * 借鉴（自用适配，注释留出处）：
 * - https://github.com/a5c-ai/babysitter/blob/main/packages/adapters/hooks/core/src/session-store/lock.ts
 * - https://github.com/isaacriehm/cairn/blob/main/packages/cairn-core/src/lock.ts
 * - https://github.com/gossipcat-ai/gossipcat-ai/blob/c6f2800a/packages/orchestrator/src/file-lock.ts
 *
 * 边界：
 *   - 文件锁是建议性的（advisory）：忽略 `.lock` 的外部进程仍可能竞态。
 *   - 临界区内不许有网络等待。
 *   - 同文件嵌套 withFileLock 会自死锁（无重入）。
 */
import { mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** 持锁身份的进程内序号（与 pid、时间一起拼成 token）。 */
let lockSeq = 0;

/** 每个文件一条队列，队尾是一个只等前一个放行的 Promise。 */
const queues = new Map();

/** 同一文件的不同写法要落进同一条队列：Windows 路径大小写不敏感。 */
const keyOf = (file) => {
	const abs = resolve(String(file));
	return process.platform === "win32" ? abs.toLowerCase() : abs;
};

const DEFAULT_FS_TIMEOUT_MS = 8_000;
const DEFAULT_FS_POLL_MS = 40;
const DEFAULT_FS_STALE_MS = 60_000;

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isProcessRunning(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * 测试钩子，生产代码里恒为 null：
 * - afterStaleRecheck（C1）：回收者确认「还是那把过期锁」之后、删除之前调用。
 * - beforeCreate：每次 `wx` 建锁之前调用，可以抛错，用来稳定复现 Windows 上的 EPERM（真实环境里靠杀毒软件等外部句柄的时序才撞得上）。
 * - platform：isTransientLockCreateError 的平台口径，测试里可以按 win32 跑。
 */
export const _lockTestHooks = { afterStaleRecheck: null, beforeCreate: null, platform: null };

/**
 * ：Windows 上「建锁失败但只是暂时的」错误码。
 * 别的进程删锁文件时，若还有人开着它且删不成 POSIX 语义（典型是杀毒软件 / 索引服务刚好在扫这份新文件），
 * 文件进入「删除挂起」：目录项还在，直到最后一个句柄关掉；这段时间里 `wx` 打开同名路径拿到的是 EPERM / EACCES，不是 EEXIST。
 * 这本质上仍是「锁被占着 / 正在释放」，应当等一下再抢，而不是把错误抛给调用方。
 * POSIX 的 unlink 立即移除目录项，不会出现这种情况，所以只在 win32 上放宽。
 */
export function isTransientLockCreateError(code, platform = _lockTestHooks.platform ?? process.platform) {
	return platform === "win32" && (code === "EPERM" || code === "EACCES");
}



/** 回收锁本身的过期时间：回收只是「读一次、删一次」，持有超过这么久必是持有者崩了。 */
const RECLAIM_STALE_MS = 10_000;

/**
 * C1：过期锁的回收串行化。以前是「读 → 再读一次确认没变 → 删」，两个等待者都确认完、其中一个删掉并
 * 重建了自己的新锁之后，另一个再删，删掉的就是刚建好的那把，两边同时进临界区（窗口很小，但存在）。
 * 现在回收要先用 `wx` 建 `<lock>.reclaim`，同一时刻只有一个回收者在「确认 + 删」；别人建好的新锁内容
 * 必然与它当初判定过期的那份不同，确认那一步就会放手。回收锁自己按 RECLAIM_STALE_MS 过期（回收者崩溃的兜底）。
 * @returns {Promise<boolean>} 这次是否真的收走了过期锁
 */
async function reclaimStale(abs, raw, staleMs) {
	const guard = abs + ".reclaim";
	try {
		await writeFile(guard, String(process.pid), { flag: "wx" });
	} catch (error) {
		if (error?.code !== "EEXIST") return false;
		// 别人正在回收：等它做完。回收锁本身过期（回收者崩溃）才收走它，下一轮再来
		try {
			const info = await stat(guard);
			if (Date.now() - info.mtimeMs > Math.min(RECLAIM_STALE_MS, staleMs)) await unlink(guard).catch(() => {});
		} catch {
			/* 已经释放 */
		}
		return false;
	}
	try {
		let now;
		try {
			now = await readFile(abs, "utf8");
		} catch {
			return false; // 已经没了：直接回去抢
		}
		// 收之前再看一眼：内容已经变了 = 别的等待者刚收走并重建了，这把是活的，别删
		if (now !== raw) return false;
		if (typeof _lockTestHooks.afterStaleRecheck === "function") await _lockTestHooks.afterStaleRecheck(abs);
		await unlink(abs).catch(() => {});
		return true;
	} finally {
		await unlink(guard).catch(() => {});
	}
}

/**
 * @param {string} lockPath
 * @param {{ timeoutMs?: number, pollMs?: number, staleMs?: number }} [opts]
 */
export async function withFsLock(lockPath, fn, opts = {}) {
	const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_FS_TIMEOUT_MS;
	const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : DEFAULT_FS_POLL_MS;
	const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_FS_STALE_MS;
	const abs = resolve(lockPath);
	await mkdir(dirname(abs), { recursive: true });
	const deadline = Date.now() + timeoutMs;
	// token：这一次持锁的身份。释放时只删「还是自己的」那把锁——被别人按过期回收再重建之后，不许把人家的删掉。
	const token = `${process.pid}-${Date.now().toString(36)}-${(lockSeq += 1).toString(36)}`;
	const payload = JSON.stringify({ pid: process.pid, at: Date.now(), token });

	for (;;) {
		try {
			if (typeof _lockTestHooks.beforeCreate === "function") await _lockTestHooks.beforeCreate(abs);
			await writeFile(abs, payload, { flag: "wx" });
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") {
				if (!isTransientLockCreateError(error?.code)) throw error;
				// ：锁文件处于「删除挂起」（见 isTransientLockCreateError）——等它真的消失再抢，照常受 deadline 约束
				if (Date.now() >= deadline) {
					const err = new Error(`文件锁超时（${timeoutMs}ms，最后一次建锁报 ${error.code}）：${abs}`);
					err.code = "DSH_STUDIO_LOCK_TIMEOUT";
					err.cause = error;
					throw err;
				}
				await sleep(pollMs);
				continue;
			}
			let stale = false;
			try {
				const raw = await readFile(abs, "utf8");
				const info = await stat(abs);
				let meta = null;
				try {
					meta = JSON.parse(raw);
				} catch {
					meta = null;
				}
				// 旧格式：文件里只有一个 pid 数字
				const pid = Number(typeof meta === "number" ? meta : meta?.pid);
				// 「最近一次活着的证据」= 建锁时间与文件修改时间里较晚的那个（持有者靠 touch 续期，见下）
				const at = Math.max(Number(meta?.at) || 0, info.mtimeMs);
				const age = Date.now() - at;
				// 内容读不懂（空文件 / 写到一半）不等于僵死：建锁是「先 wx 建文件、再写内容」，等待者可能正好读到中间态。
				// 此前读不懂就当 pid 无效、立刻收走——两个进程同时进临界区。现在只有「pid 明确已死」或「超过 staleMs 没动静」才收。
				const dead = Number.isInteger(pid) && pid > 0 && !isProcessRunning(pid);
				if (dead || age > staleMs) stale = await reclaimStale(abs, raw, staleMs);
			} catch {
				/* 锁文件在检查时消失 → 立刻重试 */
			}
			if (!stale && Date.now() >= deadline) {
				const err = new Error(`文件锁超时（${timeoutMs}ms）：${abs}`);
				err.code = "DSH_STUDIO_LOCK_TIMEOUT";
				throw err;
			}
			if (!stale) await sleep(pollMs);
		}
	}

	// 绝大多数临界区是毫秒级的（读-改-写一个小状态文件），这条路要和没有续期时一样便宜：
	// 续期定时器延后到「持锁快到 staleMs 的四分之一」才起；释放时若持锁时间远小于 staleMs，
	// 不可能有人按过期把锁收走（收锁只认「pid 已死」或「超过 staleMs 没动静」，而我们还活着），直接删，不多读一次文件。
	const acquiredAt = Date.now();
	const beatEvery = Math.max(100, Math.floor(staleMs / 4));
	let beat;
	// 持锁期间定期刷新修改时间。过期判定只看「建锁时间」的话，任何超过 staleMs（默认 60 秒）的临界区——
	// studio 备份的导出 / 恢复 / 推拉动辄几分钟——都会被另一个进程当成僵死锁收走，两边同时进临界区。
	// 续期之后「age > staleMs」只会出现在持有者真的卡死 / 整机休眠的情况下。
	const starter = setTimeout(() => {
		const touch = () => {
			void (async () => {
				try {
					// 续期只动修改时间，不重写内容：重写有一个「文件被截空」的瞬间，等待者读到就是一把读不懂的锁
					const meta = JSON.parse(await readFile(abs, "utf8"));
					const stamp = new Date();
					if (meta?.token === token) await utimes(abs, stamp, stamp);
				} catch {
					/* 锁文件没了或读不出：不重建，交给释放时的身份检查 */
				}
			})();
		};
		touch();
		beat = setInterval(touch, beatEvery);
		beat.unref?.();
	}, beatEvery);
	starter.unref?.();
	try {
		return await fn();
	} finally {
		clearTimeout(starter);
		if (beat !== undefined) clearInterval(beat);
		if (Date.now() - acquiredAt < staleMs / 2) await unlink(abs).catch(() => {});
		else {
			// 持锁很久：可能已被别人按过期接管。只删「还是自己的」那把锁，不许把接管者的删掉
			try {
				const meta = JSON.parse(await readFile(abs, "utf8"));
				if (meta?.token === token) await unlink(abs);
			} catch {
				/* 已经不在了，或已是别人的锁 */
			}
		}
	}
}

/**
 * 在 file 的进程内队列 + 跨进程 `.lock` 内执行 fn。
 * @template T
 * @param {string} file 状态文件绝对路径（队列键；锁文件为 `${file}.lock`）
 * @param {() => Promise<T>} fn 完整周期：load → 改 → save
 * @param {{ timeoutMs?: number, pollMs?: number, staleMs?: number, fsLock?: boolean }} [opts]
 * @returns {Promise<T>}
 */
export function withFileLock(file, fn, opts = {}) {
	const key = keyOf(file);
	const prev = queues.get(key) ?? Promise.resolve();
	let release;
	const gate = new Promise((done) => {
		release = done;
	});
	const tail = prev.then(() => gate);
	queues.set(key, tail);
	const useFs = opts.fsLock !== false;
	return (async () => {
		await prev;
		try {
			if (!useFs) return await fn();
			return await withFsLock(`${resolve(String(file))}.lock`, fn, opts);
		} finally {
			release();
			if (queues.get(key) === tail) queues.delete(key);
		}
	})();
}
