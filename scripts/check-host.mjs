#!/usr/bin/env node
/**
 * 宿主升级后的一条龙检查：DSH 一升级，就把「能不能在新宿主上装起来、跑起来」重新验一遍。
 *
 *   npm run check:host                  # 总是完整跑
 *   npm run check:host -- --if-changed  # 宿主版本和上次通过时一样就直接跳过（给 AGENTS.md 规则用）
 *
 * 步骤：
 *   1. 定位本机宿主与 dsh CLI（DSH_APP / DSH_BIN 可覆盖，见 scripts/lib/dsh-host.mjs）
 *   2. peer 范围覆盖：peerDependencies 里的 @deepseek-ai/* 范围必须包含宿主当前版本
 *      （预发布版本按 npm 规则只匹配同号段，新 rc 不追加范围会让 pnpm frozen-lockfile 失败）
 *   3. 开发依赖对齐：scripts/check-host-deps.mjs（本地 node_modules 与宿主同版本）
 *   4. 完整可移植性验证：scripts/portability.mjs，用找到的 dsh CLI 真装真起
 *
 * 全部通过后把宿主版本记进 .host-verified.json（已 gitignore，按机器记）。
 * 退出码：0 通过或跳过；1 有检查未通过；2 找不到宿主 / dsh CLI。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { findDshCli, findHostApp, hostPackageVersion, hostVersion } from './lib/dsh-host.mjs'
import { satisfies } from './lib/semver-lite.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stateFile = join(root, '.host-verified.json')
const ifChanged = process.argv.includes('--if-changed')

const readState = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}

const app = findHostApp()
const version = hostVersion(app)
if (app === null || version === null) {
  console.error('✘ 找不到本机 DSH 宿主（可用环境变量 DSH_APP 指向 <安装目录>/resources/app/dsh 或 app.asar）')
  process.exit(2)
}
const dshBin = findDshCli(app)
console.log(`▸ 宿主：${app}${app.toLowerCase().endsWith('.asar') ? '（打包布局）' : ''}　版本 ${version}`)
console.log(`▸ dsh CLI：${dshBin === '' ? '(未找到)' : dshBin}`)

const last = readState()
if (ifChanged && last?.hostVersion === version) {
  console.log(`✓ 宿主版本与上次通过时相同（${version}，${last.verifiedAt}），跳过。升级 DSH 后会自动重跑。`)
  process.exit(0)
}
if (last?.hostVersion !== undefined && last.hostVersion !== version) {
  console.log(`! 宿主版本变了：上次通过时 ${last.hostVersion} → 现在 ${version}，开始完整验证`)
}
if (dshBin === '') {
  console.error('✘ 找不到 dsh CLI，无法做安装/启动验证（可用环境变量 DSH_BIN 指定）')
  process.exit(2)
}

let failed = 0
const step = (title) => console.log(`\n── ${title}`)

// 2. peer 范围覆盖
step('peer 范围是否覆盖宿主版本')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const uncovered = []
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/')) continue
  const hv = hostPackageVersion(app, name.slice('@deepseek-ai/'.length))
  if (hv === null) continue
  if (satisfies(hv, range)) console.log(`  ✓ ${name} ${hv}`)
  else uncovered.push({ name, hv })
}
if (uncovered.length > 0) {
  failed++
  for (const { name, hv } of uncovered) console.log(`  ✗ ${name} 宿主 ${hv} 不在 peer 范围内`)
  console.log(`  修法：在 package.json 的 peerDependencies 里给这些包追加 \`|| ^${uncovered[0].hv}\`，再用 pnpm 10 重新生成 lockfile。`)
}

const runNode = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status ?? 1

// 3. 开发依赖对齐
step('开发依赖与宿主对齐（check-host-deps）')
if (runNode([join(root, 'scripts', 'check-host-deps.mjs')]) !== 0) failed++

// 4. 完整可移植性验证
step('完整可移植性验证（portability，用本机 dsh 真装真起）')
const health = pkg.name === undefined ? [] : ['--health', `/api/${pkg.name}/list`]
if (runNode([join(root, 'scripts', 'portability.mjs'), ...health, '--dsh', dshBin]) !== 0) failed++

console.log('')
if (failed === 0) {
  writeFileSync(stateFile, JSON.stringify({ hostVersion: version, verifiedAt: new Date().toISOString(), dshBin }, null, 2) + '\n')
  console.log(`✅ 宿主 ${version} 验证通过，已记录（.host-verified.json）`)
  process.exit(0)
}
console.error(`❌ 宿主 ${version} 上有 ${failed} 项检查未通过 —— 修好再继续开发或发布`)
if (existsSync(stateFile)) console.error(`  （.host-verified.json 仍记着上次通过的版本 ${last?.hostVersion ?? '?'}，未更新）`)
process.exit(1)
