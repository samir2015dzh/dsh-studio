/**
 * invalidateScanCache：清空后下一次扫描必须重新读文件。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkills, invalidateScanCache, readSkillText } from '../lib/scanner.js'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('FAIL', msg) }
  else console.log('PASS', msg)
}

const home = mkdtempSync(join(tmpdir(), 'dsh-inv-'))
const prev = { ...process.env }
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, '.dsh')
try {
  const skillDir = join(home, '.dsh', 'skills', 'inv-demo')
  mkdirSync(skillDir, { recursive: true })
  const skillFile = join(skillDir, 'SKILL.md')
  writeFileSync(skillFile, '---\nname: inv-demo\ndescription: v1\n---\n# v1\n')
  const first = await scanSkills(home)
  const hit = first.find((s) => s.name === 'inv-demo')
  assert(!!hit && hit.description === 'v1', '首次扫描读到 v1')

  writeFileSync(skillFile, '---\nname: inv-demo\ndescription: v2\n---\n# v2\n')
  // 同 size 不同内容时，若不失效且 mtime 碰巧相同可能旧；强制失效后必读新
  invalidateScanCache()
  const second = await scanSkills(home)
  const hit2 = second.find((s) => s.name === 'inv-demo')
  const body2 = await readSkillText(skillFile)
  assert(!!hit2 && hit2.description === 'v2' && !('content' in hit2), '列表扫描不再带正文')
  assert(body2.includes('# v2'), '按需读取仍是 v2')
} finally {
  for (const k of Object.keys(process.env)) {
    if (!(k in prev)) delete process.env[k]
  }
  Object.assign(process.env, prev)
  rmSync(home, { recursive: true, force: true })
}

if (failed) { console.error(failed, 'failed'); process.exit(1) }
console.log('\n=== ALL PASS (invalidate-scan-cache) ===')
