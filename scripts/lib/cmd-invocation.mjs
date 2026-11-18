/**
 * 跨平台调用一个可执行文件，Windows 上能调 `.cmd` / `.bat`。
 *
 * Node 18.20.2 / 20.12.2 起（CVE-2024-27980），不带 shell 直接 spawn `.cmd`/`.bat` 会抛 EINVAL。
 * DSH 在 Windows 上的 CLI 入口就是 `resources/runtime/cli/bin/dsh.cmd`，所以 portability
 * 的安装/启动段在 Windows 上一直走不到。这里改成经 `cmd.exe /d /s /c "..."` 调用，
 * 每个参数都加引号，避免 `shell: true` 按空格拼接导致带空格的路径断开。
 */
import process from 'node:process'

/** @param {string} value */
function quoteForCmd(value) {
  const text = String(value)
  // cmd 的引号内没有可靠的转义办法：参数里带 " 或换行就拒绝，而不是拼出一条会被误解的命令
  if (/["\r\n]/.test(text)) throw new Error(`参数里不能有引号或换行：${text}`)
  return `"${text}"`
}

/**
 * @param {string} bin 可执行文件路径
 * @param {string[]} args
 * @param {{ platform?: string, comspec?: string }} [deps]
 * @returns {{ command: string, args: string[], options: { windowsVerbatimArguments?: boolean } }}
 */
export function commandInvocation(bin, args, deps = {}) {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) {
    return { command: bin, args: [...args], options: {} }
  }
  const comspec = deps.comspec ?? process.env.ComSpec ?? 'cmd.exe'
  const line = [bin, ...args].map(quoteForCmd).join(' ')
  // /s：去掉最外层一对引号后原样执行，内层每个参数的引号得以保留
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } }
}
