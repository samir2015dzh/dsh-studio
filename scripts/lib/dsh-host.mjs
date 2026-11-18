/**
 * 定位本机 DSH 宿主：应用目录、宿主版本、CLI 入口。
 *
 * check-host-deps.mjs 与 check-host.mjs 共用，避免两份探测逻辑各自漂移。
 *
 * 布局有两代：
 *   - 老版本：`<安装目录>/resources/app/dsh` 是解开的目录，包在它的 node_modules 里；
 *   - 0.2.2-rc.3 起：只留 `<安装目录>/resources/app.asar`，包在 asar 内的 `/dsh/node_modules`。
 * 两种都要认，否则宿主一升级整套检查就直接「找不到宿主」退出。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { resolveCommand } from './resolve-command.mjs'

/** 宿主应用目录候选（解开目录布局）：环境变量 DSH_APP 优先，其次常见安装盘。 */
const APP_CANDIDATES = ['D:\\DSH\\resources\\app\\dsh', 'F:\\DSH\\resources\\app\\dsh', 'C:\\DSH\\resources\\app\\dsh']

/** 宿主 asar 候选（打包布局）：同上，只是指向 app.asar。 */
const ASAR_CANDIDATES = [
  'D:\\DSH\\resources\\app.asar',
  'F:\\DSH\\resources\\app.asar',
  'C:\\DSH\\resources\\app.asar'
]

/** asar 头部缓存：一个 200 MB 的 asar 每次读 header 都要几毫秒，检查会问好几个包。 */
const asarHeaderCache = new Map()

/**
 * 读 asar 头部索引：返回 { json, base }，base 是文件内容区起点。
 * asar 布局：u32(4) + u32(pickleSize) + [u32(jsonSize) + json] + contents。
 */
function asarHeader(file) {
  const cached = asarHeaderCache.get(file)
  if (cached !== undefined) return cached
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const pickleSize = head.readUInt32LE(4)
    if (!Number.isFinite(pickleSize) || pickleSize <= 0 || pickleSize > 64 * 1024 * 1024) return null
    const buf = Buffer.alloc(pickleSize)
    readSync(fd, buf, 0, pickleSize, 8)
    const jsonSize = buf.readUInt32LE(4)
    const json = JSON.parse(buf.subarray(8, 8 + jsonSize).toString('utf8'))
    const entry = { json, base: 8 + pickleSize }
    asarHeaderCache.set(file, entry)
    return entry
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** 从 asar 里读一个 @deepseek-ai 包的 version（短名，不带 scope）；读不到返回 null。 */
function asarPackageVersion(file, shortName) {
  const header = asarHeader(file)
  if (header === null) return null
  let node = header.json
  for (const segment of ['dsh', 'node_modules', '@deepseek-ai', shortName, 'package.json']) {
    node = node?.files?.[segment]
    if (node === undefined || node === null) return null
  }
  if (node.offset === undefined || node.size === undefined) return null
  const fd = openSync(file, 'r')
  try {
    const content = Buffer.alloc(Number(node.size))
    readSync(fd, content, 0, Number(node.size), header.base + Number(node.offset))
    return JSON.parse(content.toString('utf8')).version ?? null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * 找到宿主：解开目录返回目录，打包布局返回 app.asar 路径；找不到返回 null。
 * 调用方拿到路径后统一用 hostPackageVersion / hostVersion 取版本，不必关心是哪种布局。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function findHostApp(env = process.env) {
  const explicit = env.DSH_APP
  if (explicit && explicit.toLowerCase().endsWith('.asar')) {
    if (existsSync(explicit) && asarPackageVersion(explicit, 'dsh') !== null) return resolve(explicit)
  }
  for (const dir of [explicit, ...APP_CANDIDATES].filter(Boolean)) {
    if (existsSync(join(dir, 'node_modules', '@deepseek-ai'))) return resolve(dir)
  }
  for (const file of ASAR_CANDIDATES) {
    if (!existsSync(file)) continue
    if (asarPackageVersion(file, 'dsh') !== null) return resolve(file)
  }
  return null
}

/** 读包目录的 version；读不到返回 null。 */
export function versionOf(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * 读宿主里一个 @deepseek-ai 包的版本。app 可以是解开的目录，也可以是 app.asar。
 * @param {string|null} app
 * @param {string} shortName 例如 'dsh' / 'dsh-tools'（不带 @deepseek-ai/ 前缀）
 */
export function hostPackageVersion(app, shortName) {
  if (app === null) return null
  if (app.toLowerCase().endsWith('.asar')) return asarPackageVersion(app, shortName)
  return versionOf(join(app, 'node_modules', '@deepseek-ai', shortName))
}

/** 宿主版本：以宿主里 @deepseek-ai/dsh 的版本为准。 */
export function hostVersion(app) {
  return hostPackageVersion(app, 'dsh')
}

/**
 * 找 dsh CLI：DSH_BIN → PATH 上的 dsh → 宿主自带的 runtime/cli/bin。
 * 解开的目录形如 <安装目录>/resources/app/dsh（上两级是 resources）；
 * asar 布局里 app.asar 的父级就是 resources，只需上一级。
 * @param {string|null} app
 * @param {NodeJS.ProcessEnv} [env]
 */
export function findDshCli(app, env = process.env) {
  if (env.DSH_BIN) return resolveCommand(env.DSH_BIN, env)
  const onPath = resolveCommand('dsh', env)
  if (onPath !== '') return onPath
  if (app === null) return ''
  const resources = app.toLowerCase().endsWith('.asar') ? dirname(app) : join(app, '..', '..')
  const bin = join(resources, 'runtime', 'cli', 'bin')
  for (const name of process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh']) {
    if (existsSync(join(bin, name))) return resolve(bin, name)
  }
  return ''
}
