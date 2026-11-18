/**
 * 跨进程文件锁：wx 互斥 + 僵死回收。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { withFsLock, withFileLock } from '../lib/state-lock.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('FAIL', msg) }
  else console.log('PASS', msg)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-flock-'))
const target = join(dir, 'state.json')
writeFileSync(target, '{}')

try {
  const order = []
  await withFsLock(target + '.lock', async () => {
    order.push('a-start')
    const nested = withFsLock(target + '.lock', async () => {
      order.push('b')
    }, { timeoutMs: 300, pollMs: 20 })
    await new Promise((r) => setTimeout(r, 80))
    order.push('a-end')
    await nested.catch((error) => {
      order.push(error?.code === 'DSH_STUDIO_LOCK_TIMEOUT' ? 'b-timeout' : 'b-other')
    })
  }, { timeoutMs: 2000 })
  assert(order.includes('a-start') && order.includes('a-end'), '持锁期间顺序正确')
  assert(order.includes('b-timeout'), '互斥下第二把锁超时')

  // 僵死锁：写入不存在的 pid，应被回收
  const lockPath = target + '.lock'
  writeFileSync(lockPath, JSON.stringify({ pid: 99999999, at: Date.now() - 120_000 }))
  let ran = false
  await withFsLock(lockPath, async () => { ran = true }, { timeoutMs: 2000, staleMs: 1000 })
  assert(ran === true, '僵死锁可回收')
  assert(!existsSync(lockPath), '释放后锁文件删除')

  // withFileLock 一体化
  let n = 0
  await Promise.all([
    withFileLock(target, async () => { const v = n; await new Promise((r) => setTimeout(r, 30)); n = v + 1 }),
    withFileLock(target, async () => { const v = n; await new Promise((r) => setTimeout(r, 30)); n = v + 1 }),
  ])
  assert(n === 2, 'withFileLock 串行后 n=2')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failed) { console.error(failed, 'failed'); process.exit(1) }
console.log('\n=== ALL PASS (state-lock-fs) ===')
