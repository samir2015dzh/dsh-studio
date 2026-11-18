#!/usr/bin/env node
/**
 * 安装前路径守卫入口。也可单独跑：node scripts/guard-install.mjs
 * 被 package.json 的 preinstall 调用，防止顺着仓库外 junction 写入 DSH 安装目录。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertInstallPathsSafe, checkInstallPaths } from './lib/install-path-guard.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const soft = process.argv.includes('--check')

try {
  if (soft) {
    const result = checkInstallPaths(root)
    if (result.ok) {
      console.log(`✔ install-path-guard: ${root} 安全`)
      process.exit(0)
    }
    console.error(`✘ install-path-guard: ${result.violations.length} 处违规`)
    for (const v of result.violations) console.error(`  - ${v.path}\n    ${v.reason}`)
    process.exit(1)
  }
  assertInstallPathsSafe(root)
  console.log('✔ install-path-guard: ok')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
