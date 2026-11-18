/**
 * install-path-guard：指向仓库外的 junction/symlink 必须被拒绝；
 * 仓库内 pnpm 风格链接必须放行。本测在旧 main 上应失败（旧码无此模块）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkInstallPaths, isPathInside, assertInstallPathsSafe } from '../scripts/lib/install-path-guard.mjs'

// Windows 上目录 symlink 需要管理员权限或开发者模式（否则 EPERM），junction 不需要提权，
// 对 lstat().isSymbolicLink() 与 readlink() 的表现一致，够本测校验路径逃逸。
const linkDir = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    failed++
    console.error('FAIL', msg)
  } else console.log('PASS', msg)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-guard-root-'))
const outside = mkdtempSync(join(tmpdir(), 'dsh-guard-outside-'))
try {
  assert(isPathInside(join(root, 'a', 'b'), root) === true, 'isPathInside 同根内')
  assert(isPathInside(outside, root) === false, 'isPathInside 根外')

  // 干净仓库：无 node_modules → ok
  let r = checkInstallPaths(root)
  assert(r.ok === true && r.violations.length === 0, '无 node_modules 时通过')

  // 仓库内真实目录 + 内链（模拟 pnpm）→ ok
  const nm = join(root, 'node_modules')
  const scope = join(nm, '@deepseek-ai')
  const store = join(nm, '.pnpm', 'pkg', 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'package.json'), '{"name":"@deepseek-ai/dsh-tools"}')
  mkdirSync(scope, { recursive: true })
  linkDir(store, join(scope, 'dsh-tools'))
  r = checkInstallPaths(root)
  assert(r.ok === true, '仓库内 symlink 放行')

  // 作用域目录本身是外链 → 拒绝
  rmSync(scope, { recursive: true, force: true })
  const outsideScope = join(outside, '@deepseek-ai')
  mkdirSync(outsideScope, { recursive: true })
  linkDir(outsideScope, scope)
  r = checkInstallPaths(root)
  assert(r.ok === false, 'scope 外链被拒')
  assert(r.violations.some((v) => v.path === scope), '违规指向 scope')

  let threw = false
  try {
    assertInstallPathsSafe(root)
  } catch (error) {
    threw = error?.code === 'DSH_STUDIO_INSTALL_PATH_ESCAPE'
  }
  assert(threw, 'assertInstallPathsSafe 抛 DSH_STUDIO_INSTALL_PATH_ESCAPE')

  // 清掉外链，改成包级外链
  rmSync(scope, { force: true })
  mkdirSync(scope, { recursive: true })
  const outsidePkg = join(outside, 'dsh-tools')
  mkdirSync(outsidePkg, { recursive: true })
  linkDir(outsidePkg, join(scope, 'dsh-tools'))
  r = checkInstallPaths(root)
  assert(r.ok === false, '包级外链被拒')
  assert(
    r.violations.some((v) => v.path.endsWith(join('@deepseek-ai', 'dsh-tools')) || v.path.includes('dsh-tools')),
    '违规含 dsh-tools',
  )
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\n=== ALL PASS (install-path-guard) ===')
