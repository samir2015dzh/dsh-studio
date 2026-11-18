#!/usr/bin/env node
/**
 * 给 package.json 的 prepack / postpack 用：打包前去掉生命周期构建脚本，打包后还原。
 * 单独也可跑：node scripts/strip-lifecycle-for-pack.mjs --strip|--restore
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { restorePackManifest, stripPackManifest } from './lib/publish-manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv.includes('--restore') ? 'restore' : process.argv.includes('--strip') ? 'strip' : ''

if (mode === '') {
  console.error('用法：node scripts/strip-lifecycle-for-pack.mjs --strip|--restore')
  process.exit(2)
}

if (mode === 'restore') {
  const restored = restorePackManifest(root)
  if (restored) console.log('✔ 已还原 package.json（打包用的生命周期脚本剥离已撤销）')
  process.exit(0)
}

const stripped = stripPackManifest(root)
if (stripped.length === 0) console.log('✔ 发布清单无需剥离（没有 preinstall/install/postinstall）')
else console.log(`✔ 已从发布清单去掉 ${stripped.join('、')}（仓库内 package.json 在 postpack 还原）`)
