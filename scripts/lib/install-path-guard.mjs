/**
 * 安装路径守卫：拒绝通过指向仓库外的 junction / symlink 安装依赖。
 *
 * 背景（2026-11-09 ALEXWORK 验证事故）：仓库里的
 * `node_modules/@deepseek-ai` 曾是指向 DSH 安装目录的 Junction，
 * `pnpm install` 顺着它往宿主写了 7 个断链，导致 DSH 核心包被改成
 * `.ignored_*`、宿主起不来。本守卫在 install / 验证脚本入口挡住这种情况。
 *
 * 借鉴思路（自用适配）：
 * - pnpm 对 symlink 目标做「必须留在预期根内」的 containment
 *   https://github.com/pnpm/pnpm/pull/11954
 *   https://github.com/pnpm/pnpm/security/advisories/GHSA-hwx4-2j3j-g496
 * - 本仓库事故：junction 指向 DSH install dir → 禁止任何 realpath 逃出 repoRoot
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** @param {string} target @param {string} root */
export function isPathInside(target, root) {
  const rootResolved = resolve(root)
  const targetResolved = resolve(target)
  if (targetResolved === rootResolved) return true
  const prefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep
  return targetResolved.startsWith(prefix)
}

/**
 * 若 path 是 symlink/junction，返回 realpath；否则返回 resolve(path)。
 * 不存在则返回 null。
 * @param {string} target
 */
export function readLinkTarget(target) {
  if (!existsSync(target)) return null
  let st
  try {
    st = lstatSync(target)
  } catch {
    return null
  }
  if (st.isSymbolicLink()) {
    try {
      return realpathSync(target)
    } catch (error) {
      return { broken: true, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return resolve(target)
}

/**
 * 检查仓库内关键路径是否有「链出仓库」的 junction/symlink。
 * @param {string} repoRoot
 * @param {{ scopePackages?: string[] }} [opts]
 * @returns {{ ok: boolean, violations: Array<{ path: string, real: string, reason: string }> }}
 */
export function checkInstallPaths(repoRoot, opts = {}) {
  const root = resolve(repoRoot)
  const violations = []
  const scope = join(root, 'node_modules', '@deepseek-ai')
  const watchList = [
    join(root, 'node_modules'),
    scope,
  ]

  const pushIfEscape = (relOrAbs, label) => {
    const abs = resolve(root, relOrAbs)
    if (!existsSync(abs)) return
    let st
    try {
      st = lstatSync(abs)
    } catch {
      return
    }
    if (!st.isSymbolicLink()) return
    let real
    try {
      real = realpathSync(abs)
    } catch (error) {
      violations.push({
        path: abs,
        real: '',
        reason: `${label} 是损坏的 junction/symlink：${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    if (!isPathInside(real, root)) {
      violations.push({
        path: abs,
        real,
        reason: `${label} 指向仓库外（${real}）。pnpm/npm 会顺着它写入宿主，可能破坏 DSH 安装目录。请删掉该 junction，改用仓库内真实目录后再装依赖。`,
      })
    }
  }

  for (const p of watchList) pushIfEscape(p, p.replace(root + sep, ''))

  // 作用域目录本身是真目录时，仍要检查每个包入口是否链出仓库
  if (existsSync(scope)) {
    let st
    try {
      st = lstatSync(scope)
    } catch {
      st = null
    }
    if (st && st.isDirectory() && !st.isSymbolicLink()) {
      for (const name of readdirSync(scope)) {
        if (name === '.' || name === '..') continue
        pushIfEscape(join(scope, name), `node_modules/@deepseek-ai/${name}`)
      }
    }
  }

  // 可选：额外点名检查（默认空；测试可注入）
  for (const name of opts.scopePackages ?? []) {
    pushIfEscape(join(scope, name), `node_modules/@deepseek-ai/${name}`)
  }

  return { ok: violations.length === 0, violations }
}

/**
 * 有违规就抛错，供 preinstall / CLI 使用。
 * @param {string} repoRoot
 */
export function assertInstallPathsSafe(repoRoot) {
  const result = checkInstallPaths(repoRoot)
  if (result.ok) return result
  const lines = result.violations.map((v) => `- ${v.path}\n  ${v.reason}`).join('\n')
  const err = new Error(
    `安装路径守卫拒绝继续：发现指向仓库外的 junction/symlink。\n${lines}\n` +
      `修复：删除上述链接后重试（Windows: rmdir <path>；Unix: rm <path>），` +
      `再在本仓库内执行 pnpm install / npm install。禁止对 DSH 安装目录建 junction。`,
  )
  err.code = 'DSH_STUDIO_INSTALL_PATH_ESCAPE'
  throw err
}
