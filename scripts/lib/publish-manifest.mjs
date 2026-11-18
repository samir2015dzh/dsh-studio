/**
 * 发布包的 package.json 里不要带 preinstall / install / postinstall。
 *
 * 仓库里的 `preinstall` 只做本仓库的安装路径守卫（防止 pnpm 顺着
 * junction 写到 DSH 安装目录）。守卫脚本不在 `files` 白名单里，对
 * 干净 tarball 安装没有任何作用，却会让 pnpm 10+ 把本包当成「未批准
 * 的依赖构建脚本」：默认不跑，并且在 strictDepBuilds 下以
 * ERR_PNPM_IGNORED_BUILDS 让安装失败。ALEXWORK 真机第二轮第 4 项
 * 即此（aaca34f，pnpm 12.4.2）。
 *
 * 为什么不在本包写 `pnpm.onlyBuiltDependencies` / `allowBuilds`：
 * 那是**安装方**（DSH 隔离 profile）的配置，插件自己写了也不生效。
 *   https://github.com/pnpm/pnpm/releases/tag/v10.0.0
 *   https://github.com/pnpm/pnpm/issues/8897
 *   https://pnpm.io/settings/build
 *
 * 做法借鉴 clean-publish / clean-publish-scripts：打包前改清单、打包后还原。
 *   https://github.com/shashkovdanil/clean-publish
 *   https://github.com/heiwa4126/clean-publish-scripts
 *
 * `npm pack --ignore-scripts`（portability.mjs 为避免脚本输出污染 --json）
 * 不会跑 prepack，所以打包路径必须显式调用下面的 withStrippedManifest。
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { resolveCommand } from './resolve-command.mjs'

/** pnpm 认定「需要构建」、从而可能触发 ERR_PNPM_IGNORED_BUILDS 的脚本名。 */
export const LIFECYCLE_BUILD_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall'])

export const PACK_BACKUP_NAME = '.package.json.pack-backup'

export const PNPM_MISSING_HINT =
  'PATH 上没有 pnpm。DSH 用 pnpm 把 tarball 装进隔离 profile，本机没找到这条命令。请把 pnpm 加入 PATH 后再跑（可用 corepack enable pnpm）。这不是打包失败，也不必改本仓库。'

export const IGNORED_BUILDS_HINT =
  'pnpm 10+ 默认不跑依赖的 preinstall/install/postinstall，未批准时会报 ERR_PNPM_IGNORED_BUILDS。发布包不应再带这些脚本；若仍看到这条，说明打出来的 tarball 里 package.json 还留着它们。'

/**
 * @param {object} pkg
 * @returns {string[]}
 */
export function lifecycleBuildScriptsOf(pkg) {
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
  return LIFECYCLE_BUILD_SCRIPTS.filter((name) => Object.prototype.hasOwnProperty.call(scripts, name))
}

/**
 * 去掉会触发依赖构建的生命周期脚本，其它 scripts 保留。
 * @param {object} pkg
 * @returns {{ pkg: object, stripped: string[] }}
 */
export function stripLifecycleScripts(pkg) {
  const stripped = lifecycleBuildScriptsOf(pkg)
  if (stripped.length === 0) {
    return { pkg, stripped }
  }
  const scripts = { ...pkg.scripts }
  for (const name of stripped) delete scripts[name]
  const next = { ...pkg, scripts }
  if (Object.keys(scripts).length === 0) delete next.scripts
  return { pkg: next, stripped }
}

/** @param {string} root */
export function packBackupPath(root) {
  return join(root, PACK_BACKUP_NAME)
}

/**
 * 若上次打包中断留下了备份，先把 package.json 还原，避免在已剥离的清单上再备份。
 * @param {string} root
 * @returns {boolean} 是否做了还原
 */
export function restorePackManifest(root) {
  const pkgPath = join(root, 'package.json')
  const bakPath = packBackupPath(root)
  if (!existsSync(bakPath)) return false
  copyFileSync(bakPath, pkgPath)
  rmSync(bakPath)
  return true
}

/**
 * 把当前 package.json 的生命周期构建脚本剥掉，原文备份到 .package.json.pack-backup。
 * @param {string} root
 * @returns {string[]} 去掉的脚本名
 */
export function stripPackManifest(root) {
  restorePackManifest(root)
  const pkgPath = join(root, 'package.json')
  const original = readFileSync(pkgPath, 'utf8')
  const { pkg, stripped } = stripLifecycleScripts(JSON.parse(original))
  if (stripped.length === 0) return stripped
  writeFileSync(packBackupPath(root), original)
  const trailing = original.endsWith('\n') ? '\n' : ''
  const indent = original.includes('\t') && !original.includes('\n  ') ? '\t' : 2
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}${trailing}`)
  return stripped
}

/**
 * 同步版：打包路径（portability / release）用。
 * @template T
 * @param {string} root
 * @param {() => T} fn
 * @returns {T}
 */
export function withStrippedManifestSync(root, fn) {
  stripPackManifest(root)
  try {
    return fn()
  } finally {
    restorePackManifest(root)
  }
}

/**
 * 在 fn 期间使用去掉生命周期脚本的 package.json，结束后（含抛错）一定还原。
 * @template T
 * @param {string} root
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withStrippedManifest(root, fn) {
  stripPackManifest(root)
  try {
    return await fn()
  } finally {
    restorePackManifest(root)
  }
}

/**
 * 从 .tgz（gzip + ustar）里读出一个文本文件。用于核对打出来的 package.json。
 * @param {string} tgzPath
 * @param {string} entryName 例如 package/package.json
 * @returns {string | null}
 */
export function readTarballText(tgzPath, entryName) {
  const buf = gunzipSync(readFileSync(tgzPath))
  let offset = 0
  const want = entryName.replace(/^\.\//, '')
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '')
    if (name === '') break
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0+$/, '')
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0+$/, '').trim()
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8) || 0
    offset += 512
    if (full === want) return buf.subarray(offset, offset + size).toString('utf8')
    offset += Math.ceil(size / 512) * 512
  }
  return null
}

const PNPM_MISSING_RE =
  /(?:spawn(?:Sync)?\s+)?pnpm(?:\.cmd|\.exe)?(?:\s+ENOENT|\s+not found)|'pnpm'[\s\S]{0,40}不是内部或外部命令|不能将[\s\S]{0,20}pnpm[\s\S]{0,20}项识别|Cannot find[\s\S]{0,40}pnpm|pnpm[:\s][\s\S]{0,80}ENOENT|command not found:\s*pnpm/i

/**
 * 给 verify 脚本把 tarball 安装失败转成可读说明。
 * @param {string} output stderr + stdout
 * @param {{ env?: NodeJS.ProcessEnv, pnpmResolved?: string }} [opts]
 * @returns {string}
 */
export function explainTarballInstallFailure(output, opts = {}) {
  const text = String(output ?? '')
  const pnpmResolved =
    opts.pnpmResolved !== undefined ? opts.pnpmResolved : resolveCommand('pnpm', opts.env ?? process.env)
  const hints = []
  const mentionsPnpmMissing = PNPM_MISSING_RE.test(text)
  const mentionsPnpm = /pnpm/i.test(text)
  if (mentionsPnpmMissing || (pnpmResolved === '' && (mentionsPnpm || /ENOENT/i.test(text)))) {
    hints.push(PNPM_MISSING_HINT)
  }
  if (/ERR_PNPM_IGNORED_BUILDS/i.test(text)) hints.push(IGNORED_BUILDS_HINT)
  const raw = text.trim().slice(0, 400)
  if (hints.length === 0) return raw
  return raw ? `${hints.join(' ')} 原文：${raw}` : hints.join(' ')
}
