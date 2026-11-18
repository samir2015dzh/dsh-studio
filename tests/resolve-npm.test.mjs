/**
 * resolve-npm：Windows 上不得直接 spawn 'npm'；优先 npm_execpath / 旁路 npm-cli.js。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { npmInvocation, resolveNpmCli } from '../scripts/lib/resolve-npm.mjs'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed++
    console.error('FAIL', msg)
  } else console.log('PASS', msg)
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-resolve-npm-'))
try {
  const binDir = join(tmp, 'bin')
  const npmBin = join(binDir, 'node_modules', 'npm', 'bin')
  mkdirSync(npmBin, { recursive: true })
  const cli = join(npmBin, 'npm-cli.js')
  writeFileSync(cli, '#!/usr/bin/env node\n', 'utf8')
  const execPath = join(binDir, 'node')

  // 1) env npm_execpath 优先
  const fromEnv = resolveNpmCli({
    execPath,
    npmExecPath: cli,
    exists: (p) => p === cli,
  })
  assert(fromEnv === cli, 'resolveNpmCli 使用 npm_execpath')

  // 2) Windows 布局：node 旁 node_modules/npm
  const beside = resolveNpmCli({
    execPath,
    npmExecPath: undefined,
    exists: (p) => p === cli,
  })
  assert(beside === cli, 'resolveNpmCli 找到 node 旁的 npm-cli.js')

  // 3) win32 无 cli 时必须抛，不能退回 'npm'
  let threw = false
  try {
    npmInvocation(['pack'], {
      platform: 'win32',
      execPath: join(tmp, 'missing', 'node'),
      npmExecPath: undefined,
      exists: () => false,
    })
  } catch {
    threw = true
  }
  assert(threw, 'win32 找不到 cli 时抛错（不退回 npm.cmd）')

  // 4) 有 cli 时 command === execPath
  const inv = npmInvocation(['pack', '--json'], {
    platform: 'win32',
    execPath,
    npmExecPath: undefined,
    exists: (p) => p === cli,
  })
  assert(inv.command === execPath, 'command 是 process.execPath')
  assert(inv.args[0] === cli && inv.args[1] === 'pack', 'args 以 npm-cli.js 开头')

  // 5) 非 Windows 无 cli 时可退回 'npm'
  const posix = npmInvocation(['-v'], {
    platform: 'linux',
    execPath: join(tmp, 'missing', 'node'),
    npmExecPath: undefined,
    exists: () => false,
  })
  assert(posix.command === 'npm' && posix.args[0] === '-v', 'linux 可退回 npm')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\n=== ALL PASS (resolve-npm) ===')
