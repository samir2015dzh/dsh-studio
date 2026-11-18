/**
 * 最小 semver：只够判断「宿主版本是否落在 peerDependencies 范围里」。零依赖。
 *
 * 支持：`a || b`、`^x.y.z[-pre]`、`~x.y.z[-pre]`、精确版本、`>= > <= <` 及空格连接的交集。
 * 预发布规则与 npm semver 一致：带预发布号的版本，只有当范围里某个比较符的
 * [major, minor, patch] 与它完全相同且也带预发布号时才可能匹配。正因如此，
 * 每出一个新 rc（如 0.2.3-rc.1）都必须在 peer 范围里显式追加一段——这正是本检查要拦的。
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** @returns {{ major: number, minor: number, patch: number, pre: string[] } | null} */
export function parseVersion(text) {
  const m = VERSION.exec(String(text).trim())
  if (m === null) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const an = /^\d+$/.test(a[i])
    const bn = /^\d+$/.test(b[i])
    if (an && bn && +a[i] !== +b[i]) return +a[i] < +b[i] ? -1 : 1
    if (an !== bn) return an ? -1 : 1
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

export function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  return comparePre(a.pre, b.pre)
}

const sameTuple = (a, b) => a.major === b.major && a.minor === b.minor && a.patch === b.patch

/** 把一个比较符展开成若干 [op, version]。 */
function expand(token) {
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)
  if (m === null) return null
  const op = m[1] ?? '='
  const v = parseVersion(m[2])
  if (v === null) return null
  const floor = (major, minor, patch) => ({ major, minor, patch, pre: ['0'] })
  if (op === '^') {
    const upper = v.major > 0 ? floor(v.major + 1, 0, 0) : v.minor > 0 ? floor(0, v.minor + 1, 0) : floor(0, 0, v.patch + 1)
    return [['>=', v], ['<', upper]]
  }
  if (op === '~') return [['>=', v], ['<', floor(v.major, v.minor + 1, 0)]]
  return [[op, v]]
}

function test(op, v, c) {
  const r = compare(v, c)
  if (op === '=') return r === 0
  if (op === '>=') return r >= 0
  if (op === '>') return r > 0
  if (op === '<=') return r <= 0
  return r < 0
}

/**
 * @param {string} version
 * @param {string} range
 */
export function satisfies(version, range) {
  const v = parseVersion(version)
  if (v === null) return false
  return String(range)
    .split('||')
    .some((part) => {
      const tokens = part.trim().split(/\s+/).filter(Boolean)
      if (tokens.length === 0) return false
      const comparators = []
      for (const token of tokens) {
        const items = expand(token)
        if (items === null) return false
        comparators.push(...items)
      }
      if (!comparators.every(([op, c]) => test(op, v, c))) return false
      if (v.pre.length === 0) return true
      // 预发布版本：必须有同一 [major,minor,patch] 且带预发布号的比较符（npm semver 规则）
      return comparators.some(([, c]) => c.pre.length > 0 && sameTuple(c, v))
    })
}
