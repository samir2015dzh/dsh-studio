/**
 * 在 PATH 上解析一条命令（不真正执行它）。
 * 给 portability.mjs 用来判断本机有没有 `dsh`：没有就跳过安装/启动，而不是 exit 1。
 */
import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * @param {string} cmd 命令名或可执行文件路径（如 `dsh` 或 `--dsh` 传入的绝对路径）
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 找到的路径；找不到则返回空字符串
 */
export function resolveCommand(cmd, env = process.env) {
  if (cmd == null || String(cmd).trim() === '') return ''
  const name = String(cmd)
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return existsSync(name) ? name : ''
  }
  const pathEnv = env.PATH ?? env.Path ?? ''
  const isWin = process.platform === 'win32'
  const exts = isWin
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : []
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidates = [path.join(dir, name)]
    if (isWin) {
      const lower = name.toLowerCase()
      const hasExt = exts.some((ext) => lower.endsWith(ext.toLowerCase()))
      if (!hasExt) {
        for (const ext of exts) candidates.push(path.join(dir, name + ext))
      }
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      if (isWin) return candidate
      try {
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        /* 没有执行权限，继续找 */
      }
    }
  }
  return ''
}
