/**
 * 跨平台解析 npm CLI，避免 Windows 上 spawnSync('npm') / 'npm.cmd' 的 ENOENT / EINVAL。
 *
 * 借鉴来源（自用适配，注释留出处）：
 * - https://github.com/agenticoding/pi-agenticoding/blob/4efc9cff/scripts/compat-process.mjs
 *   （npmInvocation：优先 npm_execpath，再退到 node + npm-cli.js）
 * - https://github.com/diegosouzapw/OmniRoute/blob/3c6f7177/scripts/build/resolveNpmEntry.ts
 *   （同时覆盖 Windows「node 旁 node_modules/npm」与 POSIX「../lib/node_modules/npm」布局）
 * - https://github.com/photostructure/ftfy-js/commit/f675d10b68fbe020a8be640683bd6a9bb07a663c
 *   （用 process.execPath 调 npm 的 JS 入口，不走 shell）
 */
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** @param {string|undefined} npmExecpath */
function resolveNpmExecpath(npmExecpath) {
  if (!npmExecpath) return undefined
  const resolved = isAbsolute(npmExecpath) ? npmExecpath : resolve(npmExecpath)
  let stat
  try {
    stat = statSync(resolved)
  } catch {
    return undefined
  }
  if (!stat.isFile()) return undefined
  const base = basename(resolved, '.js').toLowerCase()
  return base === 'npm-cli' || base === 'npm' ? resolved : undefined
}

/**
 * 定位 npm-cli.js。
 * @param {{ execPath?: string, npmExecPath?: string|undefined, exists?: (p: string) => boolean, platform?: string }} [deps]
 * @returns {string|null}
 */
export function resolveNpmCli(deps = {}) {
  const execPath = deps.execPath ?? process.execPath
  const exists = deps.exists ?? existsSync
  const npmExecPath = deps.npmExecPath ?? process.env.npm_execpath
  const binDir = dirname(execPath)
  const candidates = []
  const fromEnv = resolveNpmExecpath(npmExecPath)
  if (fromEnv) candidates.push(fromEnv)
  else if (npmExecPath) candidates.push(join(dirname(isAbsolute(npmExecPath) ? npmExecPath : resolve(npmExecPath)), 'npm-cli.js'))
  candidates.push(join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  candidates.push(join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * 构造不依赖 shell 的 npm 调用：{ command, args }。
 * Windows 上绝不直接 spawn npm / npm.cmd。
 * @param {string[]} args npm 子命令参数，如 ['pack', '--json']
 * @param {{ execPath?: string, npmExecPath?: string|undefined, exists?: (p: string) => boolean, platform?: string }} [deps]
 */
export function npmInvocation(args, deps = {}) {
  const platform = deps.platform ?? process.platform
  const execPath = deps.execPath ?? process.execPath
  const cli = resolveNpmCli(deps)
  if (cli) return { command: execPath, args: [cli, ...args] }
  if (platform !== 'win32') return { command: 'npm', args: [...args] }
  throw new Error(
    `无法定位 npm CLI（已试 npm_execpath 与 ${dirname(execPath)} 旁的 node_modules/npm）。` +
      `请通过 npm/pnpm 脚本调用，或把 Node 自带的 npm 装好。`,
  )
}
