# MCP 按需加载（studio 内置）

`dsh-studio` 0.6.0 起自带 MCP 管理，参照 MCP-cell（luohui1/MCP-cell）的进程思路和
dsh-skill-mcp-manager 的目录化思路：**会话开头只列工具名，连描述都不给，完整 schema 等真正要用再取**。

0.8.0 起目录段把工具描述也砍掉了：craft-anything 一个大服务器列全描述要 75,918 字符
（≈19K token），只给名字后是 4,878 字符（≈1.35K）。名字足够判断该不该 load。

## 三档

| 档位 | 工具注册 | 进目录 | 用途 |
|---|---|---|---|
| **启用**（`eager`） | 注册成 `mcp__<server>__<tool>` | 是（名字） | 高频、schema 小，或需要模型无条件看见的 |
| **按需启用**（`on-demand`，默认） | 不注册 | 是（只给名字） | 工具多、schema 大的，按需 `mcp_call` / `mcp_load` |
| **停用**（`disabled`） | 不注册 | 否 | 临时关掉 |

省的是**每轮系统提示里的工具 schema**。实测：一个 95 工具的 MCP 走 eager 大约 33K token/轮，
走 on-demand 只剩十几行目录。

## 八个工具

- `mcp_list` — 档位、连接状态、工具数与截断描述；还带验证状态（`verify`）、试运行（`trial`）、
  读写分级计数（`access`）、目录条目（`catalog`）、健康与熔断（`health`），以及内建 MCP 管理的只读镜像（`builtin`）。
- `mcp_register {name, tier, transport, command|url, args, env, headers, notes, catalog?, toolAccess?, trial?, verify?}` — 新增或修改，
  **唯一注册入口**（写入即出版本记录 + 遥测 `mcp.registry`）。**先入册、再验证**：试连失败也照样登记
  （`verify.status = failed` + 失败原因），稍后 `mcp_verify` 重试；`verify: false` 只登记不试连。
  新 server 默认 `trial: true`（试运行：只放握手、工具列表与只读工具）。改已有条目可以只给要改的字段。
- `mcp_unregister {name, reason?}` — 注销：断连接、移出注册表、出 `registry-remove` 版本记录；凭据原值进本机暂存
  （`mcp-credential-stash.json`，0600，不进快照）。返回 `restoreVersionId`，`skillmgr_rollback {target:"mcp-registry", versionId}`
  即可恢复，凭据按 server 名补回。
- `mcp_verify {name, reset?, promote?}` — 重新验证（真实握手 + 工具列表）。成功顺带复位熔断；`reset: true` 无论成败都复位；
  `promote: true` 在验证通过时结束试运行（出一条 `registry-edit` 记录）。
- `mcp_load {name, filter?, limit?, peek?, refresh?}` — 返回完整 `inputSchema`。
  `peek` 只读缓存不连接；`filter` 按名字/描述子串过滤（工具多的服务器先过滤再取）。
  **默认用内存缓存**——换 `filter` / `limit` 不会重连；只有 `refresh: true` 才重连重拉。
  缓存为空时自动连。
- `mcp_call {name, tool, args}` 或 `mcp_call {name, calls: [{tool, args}, …]}` — 调用。
  - 单个用 `tool` + `args`；一批用 `calls`，按顺序执行，**某个失败不中断后面的**
  - **直接执行即可，不需要先 `mcp_load`**——它自己会连接
  - on-demand 会按需连接，被回收过的会先重连
  - 批量模式下每个结果前面带 `### <工具名>`；单个模式直接返回原结果
- `mcp_takeover {name}` — 接管 profile 里已有的原生 MCP：关掉 `cordis.patch.yml` 里那条行，
  改由本插件按需加载。需要重启 DSH 才生效。详见下一节。
- `mcp_update_check {name?, timeoutMs?}` — 只读检查已登记 server 有没有新版，按来源自动判定：

  | 来源 | 怎么判 |
  | --- | --- |
  | npm 包（`args` 落在 `node_modules/<pkg>/`） | 本地 `package.json` 版本 vs `registry.npmjs.org` 的 `latest` |
  | 本地 `.git`（`cwd` 或脚本路径向上找到 `.git`） | `origin` 的 `HEAD` vs 本地 `HEAD`（`git ls-remote`，不 fetch 不 clone） |
  | 备注里的 `owner/repo@sha` | 远端 `HEAD` 与备注 sha 前缀比较（inline launcher 型没有 `.git` 也没有包名） |
  | 远程 HTTP / 纯本地目录 | 落 `unknown-source`，注明原因 |

  只报「相同/不同」并把两端版本号一起给出——本地领先上游是开发中的正常态，排大小反而容易误判。
  不下载、不更新、不改注册表；应用新版仍然要手动（`npm i -g <pkg>` 或 `git -C <dir> pull`）。

## 接管与对账

「接管」不是一次性动作，是**持续约束**。插件在注册表里记下意图（`desiredNative: "disabled"`），
每次启动回文件验一遍，发现原生条目又活了就补回去。

为什么需要：原生条目不是插件能锁住的。`pnpm install`、插件升级、换 profile 都会把 patch 文件
重写成原样，那时原生 `dsh-mcp-client` 又会把该 server 的全部工具注册一遍——和本插件的按需加载
同时存在，两份都注入。旧实现只在启动时「补缺失条目」，已经登记的直接跳过，于是注册表里的
`nativeDisabled` 永远停在旧的 `true`，面板照样显示「已接管」，屏幕上写着一切正常。

### 三条写入路径

| 原生条目在哪 | 怎么禁用 | 为什么 |
| --- | --- | --- |
| profile 自己的 `cordis.patch.yml` | 原地插一行 `disabled: true` | 逐字节可回滚，profile 文件不在升级范围 |
| bundle 的 patch（`node_modules/<bundle>/`） | 写 profile 层的**按 id 覆盖** | 那份文件 `pnpm install` / 插件升级会整份重写，改它等于改一次丢一次 |
| 插件自挂 bridge（如 `dsh-computer-use-win`） | 认不出来，只能写覆盖改它的 `config` | `serverName` 在插件 JS 里，静态扫描看不见 |

按 id 覆盖能成立，是因为 DSH 的 loader 先应用 bundle patch、后应用 profile patch，
非 insert 的 patch 会拿 id 找目标条目逐个 `target[key] = value`（`dsh-app-boot/lib/index.js`
的 `applyPatches`）。所以 profile 里写：

```yaml
# dsh-studio: native mcp overrides (auto-managed)
- id: mcp-memory-bank
  disabled: true
- id: mcp-dsh-computer-use-win
  config:
    mode: full
    toolPreset: lite
```

**`config` 是整键替换**，不是深合并——写它必须写全量，只写要改的子键会把别的键一起抹掉。
这一段由插件维护，同 id 的块会被整块替换，重复写不会越来越长。

### 对账结果

每次启动的三类结果：

| 结果 | 含义 | 行为 |
| --- | --- | --- |
| `imported` | 新发现的原生 MCP | 抄进注册表，停用档 |
| `reasserted` | 接管过、原生又活了 | 按上表写回禁用，**下次重启生效** |
| `drifted` | 漂移但没自动修 | 只报，不动文件 |

`autoReassert`（profile 配置项，默认开）关掉后只报漂移、不写文件。
改回文件对**本次**启动无效——loader 在插件启动前就读完 patch 了——所以补回总是「下次重启生效」，
面板上的红点也会一直留到重启为止。

### 状态怎么读

`mcp_list` 与面板里每个条目的接管状态来自**回文件现算**，不是注册表缓存：

| `nativeState` | 含义 |
| --- | --- |
| `disabled` | 原生行存在且已禁用 = 真接管 |
| `active` | 原生行活着 = 漂移，现在有两份在跑 |
| `missing` | 原生行整个没了（patch 被换掉或行被删） |

`desiredNative === "disabled" && nativeState === "active"` 就是面板上那个红点。

## 空闲回收

`idleTimeoutMinutes`（默认 5，`0` 关闭）内没有任何工具调用就断开上游：stdio 子进程退出 /
HTTP 会话关闭。**工具缓存与注册表保留**，下次调用透明重连——冷启动只发生在真正用到的时候。

- 活跃时间取「最近一次工具调用」，不是 UI 轮询。
- 单条服务器可用 `idleTimeout` 覆盖（单位分钟，支持小数）。

## 唯一注册表、验证、试运行、熔断

**唯一真相**：`~/.dsh/dsh-studio/mcp.json`。宿主里另外两条能加 MCP 的写路径都让位：

| 写路径 | 处理 | 边界 |
| --- | --- | --- |
| 原生 `dsh-mcp-client` 行（cordis.patch.yml） | 启动对账：**新出现的活行自动接管**（导入成 on-demand + 原生行写 `disabled`，`mcp.autoTakeover` 默认开）；已登记为停用档、原生仍活着的只报告（`nativeOwned`），建议 `mcp_takeover` | 原生行改动下次重启才生效 |
| `dsh-mcp-manager`（Settings → MCP） | **禁用写路径**：挂 `internal/config` 瀑布钩子，拦下 manager 配置里「新增 / 修改 / 启用」server 的写入并提示改用 `mcp_register`；删除与停用放行（`mcp.lockBuiltinManager` 默认开）。**只读镜像**：`mcp_list.builtin` / `GET /mcp/catalog` 报内建那边的 server 与同名冲突 | 修复真机失效：`ctx.get("mcpManager")` 是 cordis traced proxy，`.ctx` 指向调用方，旧实现把本插件自己的 fiber 当成 manager，写入一律放行；现剥 proxy（`Symbol.for("cordis.original")`）认 owner fiber，再按类 / 名字兜底，真 cordis 回归测试覆盖。Settings 按钮不会变灰（保存时才报错）；其它插件经 `mcpManager.register()` 贡献的 server 拦不到，只进镜像；本插件晚于 manager 加载且拿不到实例时第一份配置只能当基线 |

**schema v2**：启动时一次性迁移 v1 → v2——每个 server 只新增 `catalog`（用 notes 播种 summary）与 `trial: false`，
其余字段逐项原样（迁移直接读写原文，不经规范化）；迁移出一条 `registry-migrate` 版本记录。
对照表：`node scripts/mcp-migration-table.mjs [mcp.json]`（干跑）/ `--history`（从版本史取迁移那一刻）。

**验证状态**：`verify: {status: unverified|verified|failed, checkedAt, error?, toolCount?, via}`。`verified` 只来自真实握手 + 工具列表
（登记试连 / 手动重验 / 任意一次真实加载）；属运行时观测，不出版本记录。

**读写分级**：`toolAccess` 手工覆盖 > MCP 工具注解（`readOnlyHint` / `destructiveHint`）> 工具名动词 > 拿不准按可写。
**试运行**：`trial: true` 或尚未 verified → 只放只读工具（`mcp_call` 拦可写工具，遥测 `err=trial-readonly`）。

**熔断**：连接 / 超时类失败连续 `breaker.threshold`（默认 3）次 → 熔断，从目录候选摘除（目录末尾「暂时摘除」写原因与预计恢复时间），
冷却 `breaker.cooldownMs`（默认 5 分钟）后半开试探一次，成功复位、失败再熔断；`mcp_verify` 手动复位。工具自己报错（`isError`）
与 JSON-RPC 错误说明上游活着，不计失败。只在内存里，重启即复位。**健康检查**：30 秒扫描只 `ping` 已连接的 server。

**按需加载**：未被调用的 server 不建连接。启动预热只给「还没有工具缓存」的条目做一次验证握手（`mcp.prefetchOnBoot: "off"` 一个都不连）；
定期复核默认关（`mcp.revalidateIdle: true` 才开，开了就会有「没被选中却建连接」）。遥测 `mcp.load`（via call/load/eager/panel…）/
`mcp.unload`（cause idle/reload/config/unregister/shutdown/closed）；`skillmgr_stats` 出每个 server 的加载次数与闲置项。

**目录条目**：`catalog: {summary, useWhen[], avoidWhen[], tools: {名字: {use, avoid}}}` 存在注册表里（随版本史走），
目录段每个 server 给：是什么 / 何时用 / 何时别用 / 只读 n / 可写 m / 验证状态 / 试运行。
G5 评测：`node scripts/catalog-eval.mjs`（场景集 `lib/catalog-scenarios.json`；`--registry` 用真实注册表的目录条目）。
评测器是词面代理，衡量目录条目的区分度，不是模型准确率。

**目录评测巡检**：`mcp_catalog_eval {action: "status" | "run"}`，面板 `GET /api/dsh-studio/mcp/catalog-eval`、
`POST /api/dsh-studio/mcp/catalog-eval/run`。用真实注册表的目录条目（与 `--registry` 同口径）跑场景集，归档到
`~/.dsh-studio/catalog-eval/runs/`（`DSH_STUDIO_CATALOG_EVAL_DIR` 可改）；同一份场景集下总命中率比上一份归档掉了超过
`dropThreshold` 才写回退报告 `alerts/<runId>.md`（列出由好变坏的场景）。场景集换了不比较。**只报告**，不改注册表 / 目录条目，不调模型。
配置 `mcp.catalogEval`：`enabled`（默认 `false`）、`idleWindow`（`02:00–06:00`）、`idleMinutes`（30）、`minIntervalHours`（168）、
`checkEveryMinutes`（30）、`dropThreshold`（0.05）、`keep`（30）、`scenariosFile`（空 = 随包 `lib/catalog-scenarios.json`）。
另有文件通道 `~/.dsh-studio/catalog-eval/config.json`（与优化 / 治理 / 蒸馏 / 备份包四处同构：默认值 → 插件配置 → config.json，
后者逐字段覆盖，类型不对的值忽略；每次 tick / status 现读，改了不用重启）。`mcp_catalog_eval` 状态文案注明开关与闲时窗口各自生效于哪一层。
开启示例：`{"enabled": true, "idleWindow": {"start": "19:00", "end": "07:00"}}`（窗口可跨午夜）。

**mcp_list 文本**末尾恒有一行「内建 MCP 管理：守卫状态；已拒绝次数；内建条目数；同名冲突」，守卫没装 / 被关 / 没挂上都看得见。

**尾巴①**：注册表文件整份消失 / 无法解析时（启动体检或下一次写入前），版本史先落一条 `registry-missing` / `registry-corrupt`
（损坏只记 sha256 与字节数，不存原文），缺口记录不能当回滚目标。

**损坏保护**（审计 1）：`load()` 区分「不存在」（全新安装，空注册表）与「存在但解析失败」。后者先落 `registry-corrupt` 缺口记录，
再把坏文件改名留档为 `mcp.json.corrupt-<时间>`、写损坏闸 `mcp.json.corrupt-hold.json`、大声记日志；之后所有注册表写入（register / edit /
unregister / 设置）一律 409 拒绝（`code: MCP_REGISTRY_CORRUPT`），重启后依然闸住。解闸：`skillmgr_rollback`（name=mcp-registry）回到损坏前
的版本（下一次 load 读到可解析的文件自动解闸），或所有者确认 `POST /api/dsh-studio/mcp/registry-corrupt {confirm:true}` / 面板「确认并重新开始」。
`*.corrupt-*` 留档可能含明文凭据，一律不进快照。mcp.json 与 sync.json / 凭据暂存的落盘都改为原子写（同目录 tmp + rename）。

## 存储

`~/.dsh/dsh-studio/mcp.json`

```json
{
  "version": 2,
  "idleTimeoutMinutes": 5,
  "toolDescriptionMaxLength": 150,
  "servers": [
    { "name": "context7", "tier": "on-demand", "transport": "stdio",
      "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
  ]
}
```

## HTTP 面（设置页用，仅 loopback）

设置页入口：**设置 → MCP 服务器**（独立一页，不放在 Skill 工作台里——两者渲染树分开，
skill 列表刷新不会带着 MCP 面板重建）。布局照 MCP-cell：统计条 → 设置行 → 一行一个服务器，
档位用可点的胶囊切换。工具列表**跟随各自卡片**展开，不再堆在整个列表末尾。

**状态四态**（0.8.0 修正，之前「空闲」和「未连接」混用）：

| 状态 | 含义 |
|---|---|
| 已连接 | `status === "connected"`，或 studio 自建条目（没有原生行、不需要接管）——显示为绿 |
| 空闲（未连接） | `status === "idle"`，还没有调用过 |
| 连接错误 | 单独一档，`error` 有内容；没有错误时不占位 |
| 已停用（不连接） | `tier === "disabled"`，不冒充空闲 |

筛选按 `status` 精确匹配：点「未连接」不会把已停用和出错的服务器一起翻出来。

**删除要二次确认**：点一下变「确认删除」（红色），4 秒后自动恢复。因为删除会一并丢掉
备注、工具白名单（`toolFilter`）和空闲阈值（`idleTimeout`）。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/dsh-studio/mcp` | 列表（另带 `builtin` 守卫状态、`registryCorrupt` 损坏闸） |
| GET / POST | `/api/dsh-studio/mcp/registry-corrupt` | 看损坏闸 / `{confirm:true}` 所有者确认解闸 |
| POST | `/api/dsh-studio/mcp` | 新增/改（传 name + 要改的字段） |
| DELETE | `/api/dsh-studio/mcp?name=&reason=` | 注销（与 `mcp_unregister` 同一路径：版本记录 + 凭据暂存） |
| POST | `/api/dsh-studio/mcp/unregister` | 注销（`{name, reason?}`） |
| POST | `/api/dsh-studio/mcp/verify` | 重验 / 复位熔断 / 转正（`{name, reset?, promote?}`） |
| GET | `/api/dsh-studio/mcp/catalog` | 目录：候选、熔断摘除、每个 server 的目录条目 / 验证 / 读写 / 健康，本轮目录原文，内建镜像 |
| POST | `/api/dsh-studio/mcp/reload` | 断开重连 |
| POST | `/api/dsh-studio/mcp/settings` | 改空闲阈值 / 描述截断长度 |

## 已知限制

- 只桥接 tools，不桥接 resources / prompts / sampling。
- 单例连接（不是按会话隔离）：桌面版单用户，换来的复杂度不值得；要隔离请装 dsh-skill-mcp-manager。
- 无 OAuth 2.0：streamable-http 只支持静态 headers。需要 OAuth 的服务器请继续用原生 mcp-client 条目。
- 重连是「用到时重连」，没有指数退避；连不上会直接把错误抛给调用方。
- 启动时的自动导入扫三层 patch：`DSH_HOME/cordis.patch.yml`（全局层）、profile 的
  `cordis.patch.yml`、每个 bundle 的 `cordis.patch.yml`。写在前两层的手工 MCP 才会被认出来。
- 插件自己封装 MCP 的条目（如 `dsh-computer-use-win` → `mcp__wincu__*`）不会被自动导入：
  它的 patch 行 `name` 是插件包名，`serverName` 在插件 JS 里，静态扫描认不出来。
  这类要么在注册表里手动 `mcp_register`，要么继续用原生行，只能靠 profile 层写 `config`
  覆盖来收窄它注册多少工具（见上一节）。
- 补回接管要重启才生效，插件没有权限在 loader 读 patch 之前改文件。

## 验证

```powershell
# 起一个假 MCP（仅测试用）
node D:\dsh-plugins\dsh-studio\test-mcp.mjs
# 在 DSH 里：
#   mcp_register → mcp_call（直接调，不用先 load）
#   → 换 filter 再 mcp_load（不该重连，看 test-mcp.log 没有新 start）
#   → mcp_load {refresh: true}（该重连，log 多一行 start）
#   → mcp_call {calls: [{tool:"a"}, {tool:"b"}]}（批量，两个结果都回来）
#   → 等 5 分钟 → mcp_call（应自动重连）
# 假 MCP 每次被拉起都会往 test-mcp.log 追加一行 start，可用来数冷启动次数
```

## 回归检查（改 mcp 相关代码后跑一遍）

1. `node --check lib/mcp.js`、`node --check lib/profile-mcp.js`
2. `node scripts/check-client.mjs`（组件、Api 方法对账）
3. `node --test --test-concurrency=1 tests/*.test.mjs`（并行跑会让 resolve-command 的 PATH 用例互相干扰）
4. 目录段体积：`mcp_list` 之后看系统提示里那段，工具多的服务器应该只有名字、没有描述
5. 接管对账：`tests/profile-mcp-reconcile.test.mjs` 覆盖漂移检测、双向补回、幂等写、历史迁移

## 回滚

```powershell
copy lib\index.js.bak-mcp-20261102 lib\index.js
copy lib\client.js.bak-mcp-20261102 lib\client.js
```

`lib/mcp.js`、`lib/mcp-client.js` 是新增文件，删掉即可（删之前把 `index.js` 里对它们的
import 与 `mountMcp()` 一起去掉）。
