/**
 * 找出在某个 TCP 端口上监听的进程，并按进程树杀掉。
 *
 * 给 portability.mjs 的 cleanup 用：`dsh web` 会 fork 出真正的服务进程，杀 wrapper
 * 杀不到它。原来写死 `/usr/sbin/lsof`，Windows 上没有这个命令、错误又被吞掉，
 * 服务进程就一直占着端口和临时 DSH_HOME。
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { resolveCommand } from './resolve-command.mjs'

const isWin = process.platform === 'win32'

/** 同步跑一条命令，失败返回空串（不抛）。 */
function capture(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch (error) {
    return typeof error?.stdout === 'string' ? error.stdout : ''
  }
}

/**
 * 解析 Windows `netstat -ano` 的输出，返回在 `port` 上监听的 PID。
 *
 * 不认状态列的 LISTENING 字样（部分语言的 Windows 会本地化它），改用「外部地址端口为 0」
 * 判断监听：TCP 的监听行外部地址固定是 `0.0.0.0:0` 或 `[::]:0`。
 *
 * @param {string} text
 * @param {number} port
 * @returns {number[]}
 */
export function parseNetstatListeningPids(text, port) {
  const pids = new Set()
  for (const raw of String(text).split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/)
    // 协议  本地地址  外部地址  状态  PID
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue
    const local = cols[1]
    const foreign = cols[2]
    const pid = Number(cols[cols.length - 1])
    if (Number(local.slice(local.lastIndexOf(':') + 1)) !== port) continue
    if (foreign.slice(foreign.lastIndexOf(':') + 1) !== '0') continue
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/**
 * 在 `port` 上监听的 PID（找不到或工具不可用时返回空数组）。
 * @param {number} port
 * @returns {number[]}
 */
export function listeningPids(port) {
  if (!Number.isInteger(port) || port <= 0) return []
  if (isWin) return parseNetstatListeningPids(capture('netstat', ['-ano']), port)
  const lsof = resolveCommand('lsof') || ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => resolveCommand(p) !== '') || ''
  if (lsof === '') return []
  return capture(lsof, ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/**
 * 连同子进程一起强杀。Windows 用 `taskkill /T /F`；其他平台 SIGKILL。
 * 不会杀当前进程自己。
 * @param {number} pid
 */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
  if (isWin) {
    capture('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* 已经退了 */
  }
}
