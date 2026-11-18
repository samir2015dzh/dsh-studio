#!/usr/bin/env node
/**
 * 宿主依赖一致性检查。
 *
 * 为什么需要：dsh 主程序迭代很快，`@deepseek-ai/*` 的运行时形状随版本变化。
 * 本仓库在 profile 里以 link 方式安装时，插件内部的 bare import
 * （`import { defineTool } from "@deepseek-ai/dsh-tools"` 等）会解析到
 * **本仓库自己的 node_modules**，而不是宿主那份。版本一旦落后于宿主，
 * 插件在宿主上就装不起来，表现为「重启后 profile 里的插件全没了」。
 *
 * 所以每次宿主升级后都要跑一次，让 devDependencies 与宿主持平：
 *   node scripts/check-host-deps.mjs           # 人读
 *   node scripts/check-host-deps.mjs --json    # 机器读
 * 退出码：0 一致或未探测到宿主；1 存在不一致。
 *
 * 检查范围只取本仓库 peerDependencies 里声明的 @deepseek-ai/*，
 * 不去比对宿主全部包（宿主有三百多个，本仓库不该也不需要装）。
 *
 * 宿主定位顺序：环境变量 DSH_APP → D:\DSH\resources\app\dsh → F:\ / C:\ 同名路径。
 * 探测不到宿主时只跳过检查，不阻塞其它机器上的 CI。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findHostApp as findHost, hostPackageVersion, versionOf } from './lib/dsh-host.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const watched = Object.keys(pkg.peerDependencies || {}).filter((n) => n.startsWith('@deepseek-ai/'))
const localRequire = createRequire(join(root, 'package.json'))
const host = findHost()

const rows = watched.map((spec) => {
  let local = null
  try {
    local = versionOf(dirname(localRequire.resolve(`${spec}/package.json`)))
  } catch {
    local = null
  }
  const name = spec.slice('@deepseek-ai/'.length)
  return { name, host: hostPackageVersion(host, name), local }
})

const bad = rows.filter((r) => r.host && r.local !== r.host)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ host, rows, mismatched: bad.length }, null, 2))
} else if (!host) {
  console.log('▸ 未探测到 dsh 安装目录，跳过宿主依赖对齐检查（可用 DSH_APP 指定）')
} else {
  console.log(`▸ 宿主：${host}`)
  for (const r of rows) {
    console.log(`  ${r.local === r.host ? '✓' : '✗'} ${r.name.padEnd(32)} 宿主 ${String(r.host).padEnd(14)} 本地 ${r.local ?? '(未安装)'}`)
  }
  if (bad.length) {
    console.log(`\n✗ ${bad.length} 个包落后于宿主。dsh 升级后需要同步开发依赖：`)
    console.log(`  npx pnpm add -D ${bad.map((r) => `"@deepseek-ai/${r.name}@${r.host}"`).join(' ')}`)
    console.log('  然后重跑 npm test，确认插件在新 core 下仍能装配。')
  } else {
    console.log('\n✓ 本地依赖与宿主一致')
  }
}

process.exit(bad.length ? 1 : 0)
