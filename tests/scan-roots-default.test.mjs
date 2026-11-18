/**
 * 默认不扫其它 Agent 根；DSH_STUDIO_SCAN_ALL_AGENTS=1 或显式 DSH_*_HOME 才扫。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skillRoots } from '../lib/scanner.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('FAIL', msg) }
  else console.log('PASS', msg)
}

const home = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DSH_HOME: process.env.DSH_HOME,
  DSH_STUDIO_SCAN_ALL_AGENTS: process.env.DSH_STUDIO_SCAN_ALL_AGENTS, DSH_CLAUDE_HOME: process.env.DSH_CLAUDE_HOME }
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, '.dsh')
delete process.env.DSH_STUDIO_SCAN_ALL_AGENTS
delete process.env.DSH_CLAUDE_HOME

try {
  mkdirSync(join(home, '.dsh', 'skills'), { recursive: true })
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
  mkdirSync(join(home, '.claude', 'skills', 'c1'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'c1', 'SKILL.md'), '---\nname: c1\ndescription: x\n---\n')

  let roots = await skillRoots(home)
  assert(!roots.some((r) => r.source === 'claude'), '默认不包含 claude 根')
  assert(roots.some((r) => r.source === 'user-dsh'), '仍有 user-dsh')
  assert(roots.some((r) => r.source === 'user-agents'), '仍有 user-agents')

  process.env.DSH_STUDIO_SCAN_ALL_AGENTS = '1'
  roots = await skillRoots(home)
  assert(roots.some((r) => r.source === 'claude'), 'SCAN_ALL 时包含 claude')

  delete process.env.DSH_STUDIO_SCAN_ALL_AGENTS
  process.env.DSH_CLAUDE_HOME = join(home, '.claude')
  roots = await skillRoots(home)
  assert(roots.some((r) => r.source === 'claude'), '显式 DSH_CLAUDE_HOME 时包含')
} finally {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
}

if (failed) { console.error(failed, 'failed'); process.exit(1) }
console.log('\n=== ALL PASS (scan-roots-default) ===')
