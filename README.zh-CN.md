<div align="center">

  # DSH Studio

  **技能工作台 + MCP 按需加载，一个插件管完**

  [English](README.md) · [功能](#功能) · [安装](#安装) · [上手](#五分钟上手) · [进阶](#进阶) · [附录](#附录)

  ![License](https://img.shields.io/badge/License-MIT-blue.svg)
  ![DSH](https://img.shields.io/badge/DSH-Plugin-0f766e.svg)
  ![Version](https://img.shields.io/github/package-json/v/samir2015dzh/dsh-studio?label=Version&color=2563eb)
</div>

> 上游提供技能的查看、编辑和手动提取；本插件再加上自动判断、自动入库、语义合并、模型跟随 DSH，以及 MCP 按需加载、筛选、回收站和按用途分类。

## 功能

在 DSH 里装好后，它会自己判断这一轮值不值得记、该并进哪个技能，并尽量避免重复。

- **先判断再提取**：一轮对话结束几秒后，先问一句「要不要记」；只有值得才做完整提取，并有间隔限制，避免频繁调用。
- **能写入就直接入库**：新技能默认写到 `~/.agents/skills`，DSH 马上就能用。只有写入失败（比如重名）时，才会留在待确认列表里。
- **能合并就合并**：先把新内容和已有技能比对，能并进旧的就并，只有确实是新主题才新建。细节见 [进阶](#合并怎么工作)。
- **模型跟随 DSH**：面板下列出你在 DSH 里配置的模型；留空就跟当前对话一致。插件自己不保存 API 密钥。
- **面板里能看到最近改动**：技能工作台会列出最近改过的技能，方便确认它刚学了什么。
- **写入前会做清理**：合并时去掉重复章节和协议残渣，并拒绝明显变短的覆盖。
- **技能体检**：写出 `SKILL.md` 后，下一轮会按 darwin-skill 的标准检查一遍。细节见 [进阶](#技能体检与分类)。
- **三层筛选**：可按来源、启用状态和用途一起筛选。
- **按用途分组**：提取时会从 8 个固定类别里选一个；旧技能可用脚本批量归类，见 [进阶](#技能体检与分类)。
- **回收站**：点「删除」只是移到回收站，之后还可以恢复或彻底删掉。
- **多来源扫描**：默认只扫 DSH 和 `~/.agents`。若要扫其它 Agent 的技能目录，见 [配置](#配置)。
- **名称检查**：名称不规范时会标出来，避免宿主加载不了；同名冲突时也会标明实际生效的是哪一份。

## 安装

> **不要**把本仓库的 `node_modules` 或 `node_modules/@deepseek-ai` 链接到 DSH 的安装目录。
> 在本仓库里跑 `pnpm install` / `npm install` 会先检查路径；链出仓库会失败。这个检查**不会**打进发布包（否则 pnpm 10+ 会报 `ERR_PNPM_IGNORED_BUILDS`）。请只在本仓库目录里安装依赖。

用 `link:` 把插件指到本目录，改代码后不用重新发布。

1. 把仓库克隆到本地任意位置：

```bash
git clone <this-repo> D:/dsh-plugins/dsh-studio
```

2. 在 profile 的 `package.json` 里登记：

```json
{
  "dependencies": { "dsh-studio": "link:D:/dsh-plugins/dsh-studio" },
  "dsh": { "profile": { "bundles": ["dsh-studio"] } }
}
```

3. 建目录联接，让 `node_modules` 能解析到本目录：

```powershell
New-Item -ItemType Junction `
  -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-studio" `
  -Target "D:\dsh-plugins\dsh-studio"
```

4. 装 `zstd` 命令（**自动提取要用**）：DSH 的会话日志是 `session.v4.jsonl.zstd`，提取器靠 `zstd -d -c` 解压。没装时读不到任何会话，也不报错——只是永远提取不出东西。`winget install Meta.Zstandard` / `brew install zstd` / `apt install zstd` 任选，装完确认 `zstd --version` 能跑。

5. 重启 DSH，打开 **设置 → Skill 工作台**。

## 五分钟上手

如果只是想先看看或改改技能，不必打开全部自动功能：

1. 按上一节把插件加进 profile，然后重启 DSH。
2. 打开设置里的「Skill 工作台」，即可浏览、编辑和开关技能。
3. **先关上自动入库**：在配置里设 `autoAccept: false`。出厂默认是 `true`，打开后会直接改技能库。
4. 需要自动提取时，再打开 `autoPerTurn` / `autoAccept`，并确认 `agentSkillDir` 指向你真正想写入的目录。

装依赖请只在本仓库目录进行，可先运行 `npm run guard:install`。

## 配置

> 其它 Agent 的技能目录（如 `~/.claude`、`~/.cursor`）**默认不扫描**。需要时请设置 `DSH_STUDIO_SCAN_ALL_AGENTS=1`，或为单个来源设置 `DSH_CLAUDE_HOME` / `DSH_CURSOR_HOME` 等。

配置文件在 `~/.dsh/dsh-studio/extractor.json`（权限 0600）。下面是出厂默认值：

```json
{
  "enabled": true,
  "autoPerTurn": true,
  "intervalMinutes": 1440,
  "windowDays": 7,
  "maxCandidatesPerRun": 3,
  "autoAccept": true,
  "mergeThreshold": 0.2,
  "skillLanguage": "zh",
  "agentSkillDir": "C:\\Users\\<you>\\.agents\\skills",
  "provider": "",
  "model": ""
}
```

| 键 | 作用 |
| --- | --- |
| `autoPerTurn` | 每轮结束时，要不要先判断值不值得记 |
| `intervalMinutes` | 兜底扫描间隔，默认一天一次；填 `0` 表示只靠每轮判断 |
| `autoAccept` | 为 `true` 时直接写入技能库，不进待确认列表 |
| `mergeThreshold` | 本地相似度的粗筛阈值（最终仍由模型判断） |
| `skillLanguage` | `zh`（默认）/ `en` / `auto`；代码和命令不会被翻译 |
| `provider` / `model` | 留空就跟随当前对话；也可在面板里选 |

旧字段 `llmBaseUrl` / `llmApiKey` / `llmModel` 仍然兼容，但一般不用填。

## 进阶

### dsh 升级后要同步本地依赖

dsh 主程序迭代很快，`@deepseek-ai/*` 的运行时结构随版本变化。插件以 link 方式装进 profile 时，
内部 import 解析的是**仓库自己的 `node_modules`**，落后于宿主就会装配失败——表现为重启后插件全没了。

```bash
node scripts/check-host-deps.mjs   # 与宿主比对，exit 1 = 有不一致
```

每次 dsh 升级后跑一次；不一致时按输出里给的 `pnpm add -D ...` 命令同步，再重启 dsh。

更省事的是一条龙检查 `npm run check:host`：peer 范围覆盖 → 开发依赖对齐 → 用本机 dsh 真装真起的可移植性验证，
通过后记下宿主版本。加 `-- --if-changed` 时宿主没升级就直接跳过——仓库的 `AGENTS.md` 要求 DSH 每次会话先跑这一条。

### 合并怎么工作

一个候选要过四道检查才会写进库。任何一道认为不该合并，它就会变成新技能，或按规则丢弃。

```
新候选
  │
  ├─ ① 墓碑：这个名字以前被合并过
  │     → 强制并入同类里正文最长的那份；合不进就丢弃
  │
  ├─ ② 类别标签：模型先看类别，再看描述
  │     → 类别不同且描述不像，通常不会选它
  │
  ├─ ③ 本地复核：模型建议合并后，再验一次
  │     → 同类直接放行；跨类需达到相似度门槛，否则改为新建
  │
  └─ ④ 合并本身：把新经验写进主技能的已有章节
        → 去掉重复章节和残渣；正文明显变短则拒绝
```

类别从名字推导（例如 `gui-*` → gui），可在 `lib/extractor.js` 的 `CATEGORY_ALIASES` 里扩展。

### MCP 按需加载

设置页「MCP 服务器」可以把 DSH 里已有的 MCP 收进面板：按需加载、空闲时断开，并选择对外可见的工具。

- 三档：**启用**（工具直接交给模型） / **按需启用**（先只出现在目录里，用时再加载） / **停用**
- 空闲一段时间没有任何调用，就会断开上游；下次用到时再自动连上
- 启动时会扫描已有配置，点「接管」后由本插件管理
- 密钥类字段默认遮盖，不会把普通环境变量都列出来

工具：`mcp_list` / `mcp_register` / `mcp_load` / `mcp_call` / `mcp_takeover` / `mcp_catalog_eval`（目录评测巡检，只报告）。
配置在 `~/.dsh/dsh-studio/mcp.json`。更细的字段和限制见 [MCP.md](./MCP.md)。

### 配置快照

设置页「配置快照」可以把 `~/.dsh` 里该备份的配置打成一份压缩包，随时回到某个时间点。

- 会备份配置和技能相关文件；**不会**备份密钥、会话日志和 `node_modules`
- **立即备份**可加标签；真恢复前会自动先留一份，方便回退。这一份留不成（比如有文件被占用）而本次又要覆盖现有文件时，恢复会中止、什么都不写
- 可以导出或导入 `.tar.gz`，换机器时可用路径替换
- 定时备份只清理自动生成的那几份，手动备份不受影响

配置在 `~/.dsh/dsh-studio/snapshot.json`，快照文件在 `~/.dsh/dsh-studio/snapshots/`。

### 多机同步

在配置快照下方，可以把最新备份推到远端，或在另一台机器取回来。

支持 Git、Gist、WebDAV 和 S3。拉取后会先落成本地快照，不会直接覆盖当前配置。

同步配置在 `~/.dsh/dsh-studio/sync.json`，**凭据不会进入快照**。

### 技能体检与分类

写出一个 `SKILL.md` 后，下一轮会请 `darwin-skill` 按 9 个维度检查。同族重复项会折叠到一个宿主。

存量技能可用 `node scripts/classify-skills.mjs --write` 按关键词批量归类。建议先用 `--limit` 查看明细；每个文件写入前会备份为 `.bak-group`。

### 遥测与版本史（进化地基）

插件在本机记两样东西，给后续「自动优化技能 / MCP」打底，本身不改任何行为：

- **遥测**：skill 被触发 / 注入、MCP 工具调用（server、工具、耗时、成功失败、错误类）、每轮给模型看的 MCP 目录里哪些用了哪些没用。只记名称、计数、耗时和错误类，**不记对话正文和参数**。按天写在 `~/.dsh/dsh-studio/telemetry/events-YYYY-MM-DD.jsonl`，保留 90 天，不进快照。`skillmgr_stats` 看最近 7 天的统计。写不进去只丢统计，不影响正常使用。
- **版本史**：两个技能库和 MCP 注册表每次写入（蒸馏新建、语义合并、改写、分组变更、闲置回收、回收站、注册表增删改）各记一条：时间、谁写的、diff 摘要、来源会话、评测结果空位。存在 `.dsh` 之外的 `~/.dsh-studio/history/`，随配置快照一起备份与同步；注册表里的凭据不进版本史。`skillmgr_history` 查，`skillmgr_rollback` 把单个技能或整份注册表回到任意版本，回滚本身也记一条。

可用环境变量 `DSH_STUDIO_TELEMETRY_DIR` / `DSH_STUDIO_HISTORY_DIR` 改目录；配置里 `telemetry.enabled: false` 关遥测。

### 技能自动优化回路

在遥测与版本史之上，插件能自己优化常用技能：按遥测挑候选（高频、高失败率优先；**没有遥测数据的技能不进自动优化**）→ 达尔文式迭代（变异 → 评估 → 留最优）→ 过评估门 → 按风险分级处理 → 每轮写一份变更报告。

- **评估门**：每个技能一份回归评估集（典型触发场景 + 期望行为，第一次优化时由模型依据当前版本生成，存 `~/.dsh-studio/optimizer/evals/<技能>.json`，之后冻结复用，可手工编辑）。候选平均分不得低于基线，关键场景零回退；不过就丢弃并记原因（`discards.jsonl`）。没有旁路开关；只有所有者在面板上点名放行个案（`POST /api/dsh-studio/optimizer/override`，必须写理由，留记录）。
- **分级**：措辞 / 示例 / 顺序 / 排版这类低风险改动过门后自动应用（出 `optimize` 版本记录，可 `skillmgr_rollback`）；增删步骤、改触发条件、改工具调用这类结构性改动只出提案，`skillmgr_optimize_decide` 批准后才写入。分级规则在配置 `optimizer.autonomy` 里。
- **红线**：权限 / 安全段落永不自动修改，清单写在 `lib/skill-redlines.js`（内置项不可删，配置 `optimizer.redlines.extra*` 只能追加）；碰红线的候选直接丢弃，不可放行。
- **冲突**：同名技能多处存在、本轮期间文件被改、模型报告与相邻技能职责冲突——都立即停轮报告，不裁决。
- **节奏与成本**：自动轮次**默认关**。打开后只在闲时窗口（默认 02:00–06:00、空闲 ≥ 30 分钟、两轮间隔 ≥ 20 小时）跑；每轮默认最多 1 个技能、2 代 × 2 个变异、12 次模型调用、4 万 token、5 分钟，任何一项超了立即停轮并写进报告。

打开方式：在插件配置行里加 `optimizer: { enabled: true }`，或写 `~/.dsh-studio/optimizer/config.json`（`{"enabled": true}`，其它字段同 `lib/optimizer-config.js` 的默认值，可逐项覆盖）。不打开也可以手动跑：`skillmgr_optimize_run`（可带 `skill` 指定一个）。`skillmgr_optimize_status` 看当前配置、红线清单、待批准提案和最近报告；报告在 `~/.dsh-studio/optimizer/reports/`。可用环境变量 `DSH_STUDIO_OPTIMIZER_DIR` 改目录。

### 技能库治理

治理只**出提案和报告**，从不自己合并或改技能；一切写入都走版本记录 + 所有者批准。

- **合并提案（R6）**：候选来自遥测（同会话共触发、同名多处、使用量）+ 内容相似（触发条件、步骤骨架、工具集合），附证据。每个提案带合并稿、diff、过优化回路评估门的预览（两个来源各自得分 + 合并稿得分）。批准后保留方写一个新版本（`governance-merge`，记录两个来源），另一方进回收站（`merge-archive`，可恢复）；`skillmgr_governance_status skill=<名字>` 能查到它被并到了哪里。权限 / 安全段落合并后必须原样保留，否则提案直接拦下。
- **冲突报告（G7）**：同名多处、触发重叠、指令矛盾、工具冲突，每条带原文证据和建议动作。闲时轮次全量跑，技能新增 / 出新版本时增量检查。所有者裁决（`rule` / `dismiss`）。
- **经验教训（G8）**：来源只限遥测失败、优化回路的丢弃 / 放行记录、所有者已裁决的冲突；每条都引用来源事件，重复的合并计数（次数决定优先级），产出是补丁提案。教训有版本，可撤回（留痕）。
- **看了没用**：窗口内一次没触发过的库内技能，加 MCP 目录「看了没用」（按 server、按会话）。
- **节奏**：自动轮次**默认关**（`governance: { enabled: true }` 打开）；闲时 02:00–06:00、两轮间隔 ≥ 7 天，每轮最多 1 个合并提案、2 个教训提案、8 次模型调用、4 万 token、5 分钟。报告在 `~/.dsh-studio/governance/reports/`（环境变量 `DSH_STUDIO_GOVERNANCE_DIR`）。

### 蒸馏硬化

提取（逐轮、定时、面板、工具）不再直接写库，也不再直接并进已有技能。每个候选先成**草稿**，存在 `~/.dsh-studio/distill/drafts/`，不在任何技能根里，模型调不到。草稿带出处：会话 id、时间、每个来源会话里定位到的关键轮次。

- **先查重**：与库里某份技能高度相似（治理的相似度 ≥ `distill.dedupe.minScore`）的不新建，转成治理合并提案，草稿作来源；批准后，合并版本的溯源里记着这份草稿。
- **评估门**：其余草稿用「来源会话里的真实请求 + 草稿」生成的评估集打分（冻结在优化回路的评估集目录），用优化回路的 `gateVerdict` 对照绝对线判定（均分 ≥ 7、关键场景 ≥ 6）。过门的走版本化写入，版本记录 actor 为 `distill:gate-pass`，带 `distill` 出处；不过门的淘汰并记原因（`discards.jsonl`）。没有旁路：所有者只能对草稿 `discard` 或 `requeue`。
- **节奏**：手动 `skillmgr_distill_run`（可点名会话），加一个**默认关**的闲时批量（`distill: { enabled: true }` 打开）。每批最多 3 份草稿、12 次模型调用、4 万 token、5 分钟。每批写一份报告：处理条数、过门率、合并去向。
- **来源跳转**：`GET /api/dsh-studio/distill/source?id=<草稿>` 返回每个关键轮次前后的消息。

### studio 备份包（跨机恢复）

换机器、或把两台 DSH 的进化成果合到一起，用 studio 备份包：一个 `.tar.gz` 装下 MCP 注册表、优化器 / 治理 / 蒸馏 / 提取器配置、两个技能库、版本史与进化数据，带清单和逐条目 sha256，凭据一律脱敏。

- **恢复按对象合并**：版本史按 id 取并集；技能按版本链判断——本机没有就新建、本机是包内版本的祖先就快进、本机更新就保留；版本分叉、同名 server 配置不同、配置文件不同一律列为**待裁冲突、不覆盖**，所有者用 `resolutions` 裁定后重跑。默认只预演；真写前自动打保护包；预演与真恢复都留恢复报告。来源机路径自动改成本机；缺的凭据逐条列出。
- **节奏**：手动 `skillmgr_studio_backup {action:"export"}`；闲时自动打包**默认关**（`studioBackup: { enabled: true }`），保留份数可配；WebDAV 推拉复用「同步」里的 webdav 配置。
- **与配置快照 / 每日备份的分工**：快照与每日备份是同机灾备（原样覆盖），备份包是可移植的对象级合并，两者不互相替代。详见 [STUDIO-BACKUP.md](./STUDIO-BACKUP.md)。

## 附录

### 提供的工具

| 工具 | 作用 |
| --- | --- |
| `skillmgr_list` | 列出技能（来源、启用状态、分组） |
| `skillmgr_get` | 查看某个技能的完整内容 |
| `skillmgr_save` | 把全文写回 `SKILL.md` |
| `skillmgr_policy` | 启用或禁用调用 |
| `skillmgr_extract_run` | 立即提取一次 |
| `skillmgr_extract_status` | 查看开关、间隔、队列和上次运行时间 |
| `skillmgr_extract_config` | 修改提取配置 |
| `skillmgr_extract_list` / `_accept` / `_reject` | 处理待确认列表（自动入库打开时通常是空的） |
| `skillmgr_trash` / `_list` / `skillmgr_restore` / `skillmgr_purge` | 移入回收站、查看、恢复或彻底删除 |
| `skillmgr_snapshot` / `_list` / `_restore` / `_transfer` | 备份、查看、恢复、导出或导入配置 |
| `skillmgr_sync` | 多机同步：查看配置、推送或拉取 |
| `skillmgr_stats` | 遥测周统计：每个 skill、每个 MCP server / 工具的调用、失败率、耗时，目录「看了没用」 |
| `skillmgr_history` | 查技能 / MCP 注册表的版本史 |
| `skillmgr_rollback` | 把单个技能或整份注册表回滚到某个版本（回滚本身也记版本） |
| `skillmgr_optimize_status` | 优化回路的配置、红线清单、待批准提案、最近报告 |
| `skillmgr_optimize_run` | 手动跑一轮技能优化，返回变更报告 |
| `skillmgr_optimize_decide` | 批准或拒绝一个优化提案 |
| `skillmgr_governance_status` | 治理配置、待批准的合并 / 教训提案、未裁决冲突、单个技能的去向、最近报告 |
| `skillmgr_governance_run` | 手动跑一轮治理（conflicts / merge / lessons / unused 可选） |
| `skillmgr_governance_decide` | 批准 / 拒绝提案，裁决 / 驳回冲突，撤回教训 |
| `skillmgr_distill_status` | 蒸馏队列、草稿、过门 / 淘汰记录、报告；可看单份草稿与出处 |
| `skillmgr_distill_run` | 手动跑一批蒸馏（可先点名蒸馏某个会话） |
| `skillmgr_distill_decide` | 淘汰或重排草稿（没有直接放行：进库只能过评估门） |
| `skillmgr_studio_backup` | studio 备份包：状态 / 导出 / 校验 / 推到或取自 WebDAV / 删除 / 看恢复报告 |
| `skillmgr_studio_restore` | 从备份包恢复（默认预演；冲突待裁，按 resolutions 裁定） |

面板使用的 HTTP 路由在 `/api/dsh-studio/*`。

### 调试

#### 已知限制

- 状态文件有跨进程锁，但锁是建议性的；绕过它的外部脚本仍可能冲突。
- 面板源码在 `src/client/`，是普通 JavaScript 模块；`lib/client.js` 由它生成（`npm run build:client`）。最初的 TypeScript 类型没有恢复。
- 其它 Agent 的技能目录默认不扫，见上面的配置说明。

一次性历史补丁在 `scripts/archive/`，不是日常工具。

每次调用模型的原始输出会留在 `~/.dsh/dsh-studio/last-llm-raw.txt`，解析出错时可以先看这个文件。

两个回归脚本不会改你的真实目录：

```bash
node scripts/e2e-preview.mjs    # 提取到入库的完整链路
node scripts/e2e-tombstone.mjs  # 验证墓碑规则
```

### 与上游的差异

基于 [zhengjy01/dsh-skill-studio](https://github.com/zhengjy01/dsh-skill-studio)（MIT 许可）二次开发，主要增补如下。

主要多了：模型走 DSH 通道、每轮先判断再入库、语义合并，以及面板里的最近改动和模型选择。

### 许可

MIT。
