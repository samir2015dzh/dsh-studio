# 提取质量度量

自动提取流水线在真机持续产出 skill，但产出质量从未被度量。本文件是这条流水线的数据源审计（Q-1）、
只读聚合工具（Q-2）与实测记录（Q-3）。**只做度量，不改提取器行为，不新增任何定时任务。**

> **1.0.0 同步（2026-11-07）**：本文档已随 M-5 / M-6 / M-7 三批改动刷新口径 —— 裁决漏斗改按
> append-only 事件流水计数、候选接受/拒绝改由终局归档提供、lifecycle 补 `firstUsedAt` 与 `useCount`。
> Q-1 的审计结论保留为**改动前的现场记录**（用于说明当时哪些指标不可得及其原因），
> 与当前口径冲突处以本文档「Q-2 采用的定义」为准。
>
> **N-03 同步（2026-11-08）**：`useCount` 的含义换成「发生过加载的会话数」，计数源从写路径
> （`markSkillUsed`）换成 DSH 会话日志里的**真实加载事件**；原写路径计数改名 `writeCount`。
> 「skill 是否真的被模型调用过」从「不可得」变「可得」。认定口径见 §M-7 真实使用信号。

**总口径（贯穿全文）**：数据不存在时如实报不可得，不用假零充数。分母为 0、文件缺失、字段缺失时
返回 `available:false` + `reason`，比例给 `null` 而不是 0；不可得项同时进 `unavailable` 清单。
详见本文最后「总口径复述」。

## Q-1 数据源审计

### 结论

1. 三份数据都只以 skill 名字为键，没有任何记录带 candidate id 或运行 id —— join 只能走 `name`。
2. provenance 一个名字一个文件、后写覆盖前写，所以**按名文件的「全量计数」是名字的最终裁决状态数**，
   不是事件数。**M-5 起每次裁决另追加一行到 `provenance-events.jsonl`**，历史裁决可复盘；
   没有这份流水的旧数据仍只能取最终状态。
3. 没有运行日志：**「最近 10 次运行」不可恢复**；唯一可恢复的窗口是 `at` 的最近 30 天。
   事件流水按裁决记事件，不是按轮次记运行，仍不构成 run 维度。
4. lifecycle 最初只有 `lastUsedAt`。**M-7 起补 `firstUsedAt`（只写一次）与 `useCount`**，
   「首次使用距入库天数」与「平均使用次数」在两者齐备时可得；老格式条目缺这两样时仍报不可得。
   **N-03 起「被使用」的定义换成真正可观测的事件**：模型调用 `skill` 工具把某个 skill 加载进会话
   （`tool/call` + `data.name === "skill"`），`useCount` 就是「发生过加载的会话数」。写路径
   （`markSkillUsed`）证明的是「入库/保存过」，另记在 `writeCount`，不再冒充使用。详见 §M-7。
5. 真机当前（2026-11-07 14:06）provenance 目录与 `skill-lifecycle.json` **都不存在**，candidates 3 条 pending。
   原因：宿主进程 2026-11-06 10:14 启动，而这两处写入点分别在 2026-11-07 09:03 / 09:11 才提交
   （`9a24b86` lifecycle、`cb3cf71` provenance）—— 在跑的实例不含这两个写入路径。

### 1. provenance 记录字段

写入点 `lib/extractor.js:618`（`writeProvenance`），按名文件路径
`~/.dsh/dsh-studio/provenance/<name>.json`，事件流水路径
`~/.dsh/dsh-studio/provenance/provenance-events.jsonl`。

按名文件（同名覆盖，保留最新裁决）：

| 字段 | 类型 | 取值 | 可作 join 键 |
| --- | --- | --- | --- |
| `name` | string | `normalizeName()` 归一 | 是（唯一跨源键） |
| `at` | string | ISO 时间；同一轮所有记录相同（`runExtraction` 的 `now`） | 仅用于时间窗口 |
| `action` | string | `SAVE` / `FOLD_INTO` / `tombstone` | 否 |
| `into` | string \| null | FOLD_INTO 的目标名 | 是（指向另一个 skill 名） |
| `source` | string | 固定 `session-extract` | 否 |
| `sessions` | string[] | 本轮扫描到的会话 id | 否（会话日志里没有 skill 名，无对照表） |
| `digest` | string | 本轮摘要 sha256 前 16 位 | 否（只在本轮内相同，无轮次表） |
| `rationale` | string | 模型给的裁决理由 | 否 |

事件流水（M-5，append-only，一行一条 JSON，0600 落盘）：

| 字段 | 说明 |
| --- | --- |
| `at` | 与按名文件同一次裁决的时间，ISO |
| `name` | 归一后的 skill 名 |
| `action` | `SAVE` / `FOLD_INTO` / `tombstone` |
| `rationale` | 裁决理由 |

`into` / `sessions` / `digest` 只留在按名文件里，流水只记四个字段 —— 复盘「谁被合并进谁、什么时候、
为什么」够用，不需要在流水里重复整份记录。

写侧事实：`lib/extractor.js:632` 覆盖同名文件，`:635` 追加一行事件。
三条裁决路径的写入见 `lib/extractor.js:1308-1316`：`accepted` → SAVE、`merged` → FOLD_INTO、
`dropped`（已归档同名且合并不进去）→ tombstone，即 DROP。

### 2. candidates 记录字段

写入点 `lib/extractor.js:1279`，路径 `~/.dsh/dsh-studio/candidates.json`（一个数组）。

| 字段 | 类型 | 取值 | 可作 join 键 |
| --- | --- | --- | --- |
| `id` | string | `${now}-${i}`，前缀是本轮开始毫秒 | 弱轮标识（只覆盖入队项） |
| `status` | string | 队列内实际只会是 `pending` | 否 |
| `created` | number | 毫秒 | 等待时长可算 |
| `sourceCount` | number | 本轮会话数 | 否 |
| `name` / `description` / `rationale` / `group` / `body` | string | 草稿字段 | `name` 是 |
| `guard` | object? | 守门命中的 `hits` | 否 |

`status` 只有一种取值：接受（`lib/index.js:1498`）与拒绝（`lib/index.js:1529`）都会把条目从主数组
移走。**M-6 起不再直接丢弃，而是追加进终局归档 `candidates-archive.json`**，所以「接受/拒绝」历史
可从归档复盘；主表仍然只有 pending。

终局归档（`lib/extractor.js:682` `archiveCandidates`）：

| 字段 | 说明 |
| --- | --- |
| 原候选字段 | `id` / `name` / `description` / `rationale` / `group` / `body` 等原样保留 |
| `decision` | `accepted` / `rejected` |
| `decidedAt` | 裁决时间，ISO |

滚动上限 `CANDIDATE_ARCHIVE_LIMIT = 500`：写入后超过 500 条就丢最旧的那几条
（`next.slice(dropped)`），所以归档条数到顶时，更早的历史已被丢弃 —— 度量侧用 `atCap`
如实标出这一状态，不当作「全部历史」。

### 3. lifecycle 记录字段

路径 `~/.dsh/dsh-studio/skill-lifecycle.json`（`lifecycle.js` 的 `lifecyclePath()`），键是 skill 名
（`stateKeyOf` 口径：`normalizeName` 归一后的名字；归一后为空的名字保留原名）。

| 字段 | 类型 | 写入点 |
| --- | --- | --- |
| `lastUsedAt` | number（毫秒） | `markSkillUsed`（写路径）与 `recordSkillLoads`（加载信号）；两侧都取 `max`，只往前走 |
| `firstUsedAt` | number（毫秒） | 同上（M-7）：**只写最早一次**（任何信号源），之后不覆盖 |
| `useCount` | number | 只由 `recordSkillLoads` 写 = `loadSessions.length`：发生过加载的会话数（N-03） |
| `loadSessions` | string[] | 同上：已计入的会话 id 集合 —— `useCount` 的存放形态，也是幂等依据 |
| `writeCount` | number | 只由 `markSkillUsed` 写：写路径（入库/保存）次数；旧 `useCount` 迁移到这里 |
| `status` | `active` / `stale` / `archived` | `scanLifecycle` |
| `lastCheckAt` | number（毫秒） | 同上 |

顶层另有一个 `__usageModel: "load-sessions"` 口径版本标记。`normalizeName` 会把下划线归一成连字符，
技能名撞不上这个键。

三者语义分工：`firstUsedAt` 用于「首次使用距入库」，`useCount` 用于「平均使用次数」（单位是会话），
`lastUsedAt` 仍是「距今多久没用」的判据（stale / archive 用），语义不变。

**入库时间**：lifecycle 本身不记入库时间，取 `provenance` 里同名**最早一次 SAVE** 的 `at`
（有事件流水时按流水算，无流水时按名文件算）。这样被再次裁决过的名字也不会把入库时间算晚。

### 4. join 键汇总

| 键 | 覆盖 | 说明 |
| --- | --- | --- |
| `name`（`normalizeName`） | provenance / 事件流水 / candidates / 归档 / lifecycle / skill 根 / 归档目录 | 唯一跨源键 |
| `candidates.id` 前缀 | candidates / 归档 | 归档里保留原 `id`，可回溯到入队轮次 |
| `provenance.into` | provenance ↔ skill 名 | FOLD_INTO 的目标 |
| `provenance.sessions` / `digest` | 仅 provenance 按名文件 | 无外部对照表 |
| 归档目录名（去 `-vN` / `.orig`） | 归档 ↔ skill 名 | 与 `archivedNames()`（`lib/extractor.js:1030`）同口径 |

### 5. 可得性一览（逐条给条件）

| 指标 | 状态 | 条件 / 原因 |
| --- | --- | --- |
| 每个 skill 被使用次数 | 可得 | `useCount` = 发生过加载的会话数（N-03）；旧格式条目没有 `loadSessions` 时不参与平均 |
| 首次使用时间 | 可得 | `firstUsedAt`；只有旧格式条目的名字不可得 |
| 首次使用距入库天数（中位数） | 可得 | 需要 `firstUsedAt` **且** 同名有 `SAVE` 的 `at`，且首次使用不早于该入库时间 |
| 每个 skill 的裁决历史 | 可得 | `provenance-events.jsonl`；无流水时只能取最终裁决 |
| 轮次日志 / 最近 N 次运行 | 不可得 | 无 run 维度记录；事件流水是「裁决事件」，不是「运行」 |
| 接受率 / 拒绝率 | 可得（有上限） | `candidates-archive.json`；滚动上限 500，超出丢最旧，历史被截断时不算全量 |
| skill 是否真的被模型调用过 | 可得（N-03） | DSH 会话日志里的加载事件（`tool/call` + `data.name === "skill"`），按会话去重后落 `loadSessions`；口径见 §M-7 |
| 入库时间 | 条件可得 | 有 SAVE 事件即可得（取最早一次）；该名字只有 FOLD/DROP 记录时不可得 |

### 6. 窗口口径裁定

- **采用**：最近 30 天，按 `provenance.at >= now - 30d`。
- **不采用**：最近 10 次运行。没有 run 维度记录；用 `at` 去重只能近似轮次，且被覆盖的记录缺项，
  属估算，不进入指标。事件流水补的是「裁决历史」，不是「运行历史」。

### 7. Q-2 采用的严格定义

| 指标 | 定义 | 分母 |
| --- | --- | --- |
| 漏斗 SAVE / FOLD / DROP | **有 `provenance-events.jsonl` 时按事件计数**（一条裁决 = 一个事件，同名的多次裁决都计入）；**无流水时回退**为按名文件的最新 `action` 计数 | 事件数 / 文件数（= 名字数） |
| 窗口计数 | 同上，仅 `at` 落在最近 30 天 | 窗口内事件数 / 文件数 |
| cohort | 最新裁决为 `SAVE` 的名字（口径不变，仍按名文件） | — |
| used | cohort 中 lifecycle 有有限 `lastUsedAt` 的名字 | cohort N |
| active | cohort 中仍存在于 skill 根（`agentSkillDir` / `mirrorDir`）且 lifecycle 状态不是 `archived` 的名字 | cohort N |
| archived | cohort 中命中归档目录名或 lifecycle `status=archived` 的名字 | cohort N |
| 首次使用距入库（中位数） | cohort 中同时有 `firstUsedAt` 与更早（或相等）的 `SAVE` 时间的样本，取天数的中位数 | 样本数 |
| 平均使用次数 | cohort 中 lifecycle 有 `loadSessions` 的名字，取 `loadSessions.length` 的算术平均（单位：会话；N-03） | 样本数 |
| 候选积压 | `status=pending` 条数；最老一条 `created` 起的等待天数 | — |
| 历史接受 / 拒绝 | `candidates-archive.json` 里 `decision` 为 `accepted` / `rejected` 的条数 | — |

**两种漏斗口径的区别**（输出里 `funnel.source` 与 `funnel.all.note` 会写明）：

| 口径 | 触发条件 | 一条记录代表 | 同名多次裁决 | 适用 |
| --- | --- | --- | --- | --- |
| `events` | 存在 `provenance-events.jsonl` | 一次裁决事件 | 都计入 | 新数据，历史可复盘 |
| `by-name` | 无流水（旧数据） | 一个名字的最终状态 | 只算最后一次 | 只能看终态分布 |

lifecycle 文件整体缺失时，`used` 报 `available:false`（不是 0/0 假比例）；provenance 目录缺失时漏斗同理；
`candidates-archive.json` 缺失时历史接受/拒绝报不可得。`firstUsedAt` 缺失、或条目没有 `loadSessions`
（N-03 之前的旧口径）时，对应指标报不可得并给出缺哪个字段 —— 旧 `useCount` 是写路径计数，
不拿来顶替新口径。

### 8. 真机现状（2026-11-07 14:06，只读，改动前现场）

| 数据源 | 现状 |
| --- | --- |
| `~/.dsh/dsh-studio/provenance/` | 目录不存在（0 条记录，也就没有事件流水） |
| `~/.dsh/dsh-studio/candidates.json` | 3 条，全部 `pending`，`created` = 1794010013675（等待 0.25 天） |
| `~/.dsh/dsh-studio/candidates-archive.json` | 不存在（该批次之前接受/拒绝无归档） |
| `~/.dsh/dsh-studio/skill-lifecycle.json` | 文件不存在 |
| `~/.dsh/skill-archive-*` | 6 个批次，去重后 189 个名字 |
| `~/.agents/skills` | 420 个名字（目录 + 平铺 `.md`） |

所以 Q-3 真机实测里 provenance 侧 N=0、cohort 为空、比例全部分母为 0 → 报不可得。这是数据现状，
不是工具缺陷；宿主重启加载新代码后才有数据。

## Q-2 只读聚合工具 `skillmgr_quality`

实现：`lib/quality.js`（聚合）+ `lib/index.js`（工具注册）。无参数，只读，不写任何文件。

数据源与 join：`provenance/` 下按名 JSON + `provenance-events.jsonl` + `candidates.json` +
`candidates-archive.json` + `skill-lifecycle.json` + 归档目录名 + `agentSkillDir` / `mirrorDir`
下的现存名字，全部按 `normalizeName` 归一后 join。

### 输出结构

```
{
  ok, message,                       // message = 一行摘要
  summary,                           // 同上（结构化字段里再给一次）
  funnel: {
    available, reason, source,       // source = "events" | "by-name"
    eventsFile, eventsSkipped,
    skippedFiles,
    all:    { save, fold, drop, total, other, note },
    window: { days, since, save, fold, drop, total, other }
  },
  cohort: {                          // cohort = 最新裁决为 SAVE 的名字
    n,
    used:     { count, denominator, ratio, available, reason },
    active:   { count, denominator, ratio, available, reason },
    archived: { count, denominator, ratio, available, reason },
    medianDaysToFirstUse: { available, value, samples, reason },
    avgUseCount:          { available, value, samples, reason }
  },
  backlog: { available, reason, pending, oldestCreatedAt, oldestWaitDays },
  history: {                         // M-6：候选终局归档
    available, reason, accepted, rejected, total, cap, atCap
  },
  unavailable: [ { metric, reason } ],
  sources: {
    provenanceDir, provenanceEventsPath, candidatesPath, candidateArchivePath,
    lifecyclePath, skillRoots, windowDays
  }
}
```

规则：比例一律带 `count` 与 `denominator`；分母为 0、文件缺失、字段缺失时 `available:false` +
`reason`，`ratio` 为 `null`，不填 0。

- `funnel.source` / `funnel.all.note` 明示本次用的是哪种口径（见 Q-1 第 7 节的对照表）。
- `active` = 名字仍在 skill 根里且 lifecycle 状态不是 `archived`。
- `archived` = 名字命中归档目录（`archivedNames()` 口径）或 lifecycle 状态为 `archived`。
- 窗口固定最近 30 天（Q-1 裁定），落在 `funnel.window`。
- `history.atCap` 为真表示归档已达 500 条上限、更早的终局已被丢弃，此时计数不是全量历史。

## M-7 真实使用信号（N-03）

lifecycle 的「使用」原先只来自写路径（`markSkillUsed`：自动提取落库/合并、面板保存、darwin 回收、
import），它证明的是「这个 skill 被写进库里过」，不证明「模型或人真的加载过它」。N-03 把信号源换成
会话日志里的真实加载事件 —— 一个每天被会话加载、却从不被写入的 skill，不再因为「180 天没写入」被判归档。

### 加载事件的认定

| 项 | 口径 |
| --- | --- |
| 记录形态 | DSH 会话日志（`findSessionFiles` 发现的 `session[.vN].jsonl[.zstd]`）里 `type === "tool/call"` 的行 |
| 事件条件 | `data.name === "skill"` —— 模型调用 `skill` 工具把某个 skill 全文载入会话上下文 |
| 技能名来源 | `data.arguments`（JSON 字符串；也接受已是对象）里的 `name` 字段 |
| 事件时间 | 该行的 `time`（会话日志 envelope 的毫秒时间戳） |
| 不算加载 | 消息正文里出现技能名（`agent/inbox/spliced` 的 `inserted` 文本等）；`tool/call` 里工具名不是 `skill`；参数里没有非空 `name` |
| 计数单位 | **会话**：同一会话内同一技能重复加载只计一次；`useCount` = 加载过它的会话数 |
| 名字归一 | `normalizeName`（与 quality / provenance 同口径）→ 与 `markSkillUsed` 记的是同一条状态记录 |
| 采集窗口 | 提取器既有的 `windowDays`（默认 7 天，可配 1–365）。窗口外的历史加载不补计 |
| 时延 | 采集挂在提取周期那一轮枚举/解析上，信号最迟在下一个提取周期落库 |

### 增量与幂等

- 采集消费 `collectSessionLogs()` 那一次目录枚举 + 日志解析的结果，不另扫目录、不另解压；
  加载事件由 `readSessionLog()` 在解析同一份日志时顺带取出（`skillLoads`）。
- 水位线 `~/.dsh/dsh-studio/usage-signals.json`：`sessions["<会话 id>"] = { fingerprint, processedAt }`。
  会话 id 取日志 `session` 记录里的 `id`（缺失时回落文件路径），指纹是 `mtime:size`。已见会话不再计。
- 第二道保险在状态里：每个技能存 `loadSessions`（会话 id 集合），`useCount` 读它的长度。水位线丢了、
  同一批日志被处理第二遍，`useCount` / `lastUsedAt` / `firstUsedAt` 都不会变。
- 同一批日志跑第二遍，`skill-lifecycle.json` 逐字节不变（fixture 有专门断言）。

### 存量数据过渡

| 情况 | 处理 |
| --- | --- |
| 旧条目有 `useCount`（写路径计数） | 一次性迁移到 `writeCount`（累加），`useCount` 清空、等加载信号重写；顶层打 `__usageModel` 标记 |
| 旧条目没有 `useCount` | 原样保留，同样打标记 |
| 尚未迁移的状态文件 | `quality` 的平均使用次数报不可得（没有 `loadSessions`），不拿旧计数冒充新口径 |
| 非归一的旧键（大小写/空白不同） | 迁移时按 `stateKeyOf` 搬到归一键，旧键删除 |

迁移发生在下一次写入（`markSkillUsed` / `recordSkillLoads` / 巡检 `apply`）—— 只读的 `quality` 不写盘。

### 与指标的关系

- 「平均使用次数」= cohort 里各名字 `loadSessions.length` 的算术平均，单位是**会话**；一行摘要写作「均加载 N 会话」。
- cohort `used` 仍是「有 `lastUsedAt` 的名字占比」；加载信号也更新 `lastUsedAt`，所以这个比例现在反映真实使用。
- stale / archive 判档的输入（`lastUsedAt`）与阈值（默认 90 / 180 天）都没动；从未被加载、
  也从未被写入的技能，判档结果与旧行为逐项一致。
- 归档行为不变：只搬进 `skill-archive-<stamp>/` 墓碑目录、永不硬删；pinned / protected 豁免；
  单文件 skill 不归档。

## Q-3 校验与真机实测

### 伪 HOME fixture

`tests/fixtures/quality-home.mjs` 在伪 HOME 里手工构造数据；`quality-history-home.mjs` 构造
「同一 skill 连续裁决 + 归档 + 使用计数」的场景。`tests/quality.test.mjs` 逐项断言：

| 数据 / 用例 | 期望值 |
| --- | --- |
| provenance：alpha（SAVE，10 天前）、beta（SAVE，40 天前）、gamma（FOLD_INTO→alpha，5 天前）、delta（tombstone，3 天前） | 全量 SAVE/FOLD/DROP = 2/1/1，4 个文件 |
| 窗口（30 天） | 3 条：beta 被排除 |
| cohort | N=2（alpha、beta） |
| used | 1/2（beta 的 lifecycle 记录缺 `lastUsedAt`，不算 used，也不报不可得） |
| active | 1/2（只有 alpha 仍在 skill 根） |
| archived | 1/2（beta 命中 `skill-archive-*` 目录） |
| 首次使用距入库中位数 | `available:false`，原因指向缺 `firstUsedAt` |
| 平均使用次数 | `available:false`，原因指向没有加载会话记录（`loadSessions`） |
| candidates：3 条 pending（1 条缺 `created`）+ 1 条 accepted | pending 3，最老等待 2 天 |
| 删掉 provenance + lifecycle 后重跑 | 漏斗 / used 报不可得，`ratio` 为 `null` 而不是 0 |
| 两次聚合前后的伪 HOME 文件 sha256 | 完全一致（工具不写文件） |
| M-5：同一 skill 先 SAVE 再 FOLD_INTO | 按名文件保留终局（`FOLD_INTO`，`into` 与 `rationale` 为第二次的）；事件流水 2 条；有流水时 `funnel.source="events"` 且按事件计 SAVE 2 / FOLD 1（total 3） |
| M-5：删掉事件流水后重跑 | `funnel.source="by-name"`，total 回到 2 条文件，注脚仍是「按名字最新裁决」 |
| M-6：接受 1 条 + 拒绝 1 条 | 主表清空；归档 2 条，`decision` 分别为 accepted / rejected，带 `decidedAt` 与原 `id`；quality 报历史 1/1 |
| M-6：归档灌到超上限 | `dropped=2`、`total=500`，保留的是最近 500 条 |
| M-7：同一 skill 标 3 次写入 | `writeCount=3`、`useCount` 不再由写路径计数、`firstUsedAt` 停在第一次、`lastUsedAt` 跟着最后一次；状态文件打上 `__usageModel` |
| M-7：老格式 lifecycle 条目 | 读入不报错，`firstUsedAt` 仍为 `undefined`（不被补写） |
| M-7：只有写路径、没有加载事件 | 首次使用距入库中位数 = 3 天；平均使用次数报不可得（不拿旧计数冒充新口径） |
| N-03：`tests/fixtures/usage-home.mjs` 合成会话日志（加载事件、坏行、坏 `.zstd`、目录冒充、窗口外会话） | 15 组断言全过：核心救活 / 回归对照 / 会话内去重 / 跨会话累计 / 乱序取最大 / 增量幂等 / 新增会话 / best-effort / 提及不算 / firstUsedAt / 存量迁移 / 名字归一 / quality 口径 / 归档只搬不删 |
| N-03：加载 2 个会话、另一个 1 个 | 平均使用次数 = (3+1)/2 = 2 会话；摘要写「均加载 2 会话」 |

`node tests/quality.test.mjs` → 114 条断言全过；已加入 `npm test` 的六套之一。

### 真机实测（2026-11-07 14:10，只读，改动前现场）

```
漏斗 SAVE/FOLD/DROP 不可得（全量 0 条文件；近 30 天 0 条）｜cohort 0：used 不可得、active 不可得、归档 不可得｜积压 3 条，最老 0.25 天
```

| 项 | 实测 |
| --- | --- |
| provenance | 目录不存在，0 条文件 → 漏斗不可得（也就没有事件流水可回退） |
| cohort | N=0 → 三个比例分母为 0，全部不可得 |
| 首次使用距入库中位数 | 不可得（缺 `firstUsedAt`） |
| 平均使用次数 | 不可得（没有加载会话记录 `loadSessions`） |
| 历史接受 / 拒绝 | 不可得（`candidates-archive.json` 不存在） |
| 候选积压 | 3 条 pending，最老一条 `created` = 2026-11-07T00:06:53.675Z，等待 0.25 天 |

如实说明：**真机样本为 0**，不是「比例很好」。原因就是 Q-1 第 5 条 —— 当前宿主实例（2026-11-06 10:14
启动）不含 provenance / lifecycle 写入点，所以这两份数据一条都没有；工具逻辑由 fixture 证明，
真机 cohort 要等宿主重启加载新代码后才开始积累。工具在真机上是直接以 node 调用同一批只读路径跑的
（宿主里的 `skillmgr_quality` 要等重启才注册），跑完 `~/.dsh` 与 skill 根无任何改动。

## N-01 技能更新应用 `skillmgr_update_apply`

`skillmgr_update_check` 的口径见它的工具描述与 CHANGELOG 1.0.0 的「新增 `skillmgr_update_check`」条目：
**只读报版本**（最新 / 有新版 / 无法比对 / 检查失败），不下载、不写盘。本节写应用侧 —— 报出「有新版」
之后怎么把新版真正装上去。两个工具互相引用：check 的描述末尾指向 apply，apply 的准入条件来自 check 的
来源判定顺序。

### 准入条件（不满足就拒绝，零写入）

应用前必须能确定「从哪拉、拉哪个版本」：

| 条件 | 不满足时的返回 |
| --- | --- |
| `skill-lock.json` 里有该技能的记录 | `ok:false` · `stage:source` · 写明「没有来源记录」 |
| `source` 能解析成 GitHub 仓库地址（`parseSkillSource` 口径） | `stage:source`，写明解析失败原因 |
| `source` 不是本地 `.tar.gz` / `.tgz` 路径 | `stage:source`，写明「本地 tarball 路径，没有可比的远端仓库」 |
| `ref` 非空（缺字段时回退到 source 里 `tree/<ref>` 段） | `stage:source`，写明「没有 ref」 |
| `subPath` 是字符串（可为 `""`：独立仓库形态；缺字段时回退到 URL 里的子目录段） | 同上 |
| 技能已安装在两棵扫描根之一（`listSkillDirs` 口径） | `stage:locate` |

拉取通道复用既有实现，不新增任何东西：来源拼成 `https://github.com/<owner>/<repo>/tree/<ref>[/<subPath>]`，
交给 `resolveSkillPackage`（`parseSkillSource` + codeload + `findSkillRoot`）；新 commit 用
`resolveSourceCommit`（`git ls-remote`，40 位 hex 校验沿用现行规则）。**不新增、不修改任何代理配置**；
git 子进程只走 git 既有的 `http.proxy`，不设置任何持久化环境变量。

### 备份位置与不变式

- 默认位置：`~/.dsh/dsh-studio/skill-backups/<时间戳>/<name>/`（`<时间戳>` 是
  `toISOString()` 把 `:` `.` 换成 `-` 的形式，UTC）。工具返回值里的 `backupPath` 就是这个绝对路径。
- **不变式：备份路径必须不在任何一棵扫描根之内**。手工升级那次把备份放进了技能根，`listSkillDirs`
  把它连同 4 个兄弟目录一起当成「幽灵技能」，`update_check` 从此多报 5 个条目。工具在复制前用
  `isInside(root, backupPath)` 逐根断言，命中即 `stage:assemble` 失败、不复制、不动安装目录。
  fixture 对这条不变式单独断言（`outsideRoots` / `underDataDir` / 备份内容与旧目录逐文件一致）。
- 备份是**整份复制**（含 `.git` 与 `SKILL.md.bak-group`），恢复时可直接搬回。
- 已是最新（`changed:false`）与所有失败路径 **不产生备份**，`backupPath` 为空串。

### 文件取舍

以「新上游树」为基准，逐文件取舍：

| 情形 | 处理 |
| --- | --- |
| 上游有该文件 | 以上游为准 |
| 旧目录有、上游没有 | 保留并带入新目录，相对路径记进 `preservedFiles`（典型 `.huashu-skill-meta.json`） |
| `.git/` | 不带入（旧检出的版本库内脏；新溯源由 lock 的 `commit` 承载） |
| `SKILL.md.bak-group` | 不带入（本工具自管文件，每次按需重写） |
| 保留文件是 JSON 且顶层有 `commit` 字符串 | 把 `commit` 换成新 commit（`rebaseCommitMark`） |
| 保留文件 JSON 解析失败 | 原样保留，不升级为失败 |

`.git` 与 `SKILL.md.bak-group` 不参与 diff 计数（见下），因为它们本来就不走取舍通道。

### 标注规则（`metadata.group`）

上游新版可能丢掉旧版的 `metadata.group`（花叔那批 skill 就是手工重打的）。规则：

1. 旧 `SKILL.md` 的 frontmatter 有 `metadata.group`、新上游**没有** → 重打；
2. 新上游已有 `metadata.group`（任何值）→ 以上游为准，不重打；
3. 新上游没有 frontmatter，或 `metadata` 是内联映射（`metadata: {a: b}`）→ 不强行改，在 `message` 里注明；
4. 重打前先把上游原件**逐字节**存成新目录的 `SKILL.md.bak-group`（与手工流程一致）。

实现只插入一行 `  group: <旧值>`（`metadata:` 块内末尾；没有该块时补 `metadata:` + 该行），
其余字节一行不动 —— 变换手法与 `extractor.js` 的 `rewriteFrontmatterBlock` 同款（`metadata:` + 两空格
缩进 `group:`），但**不用**它的整块重写，因为那会重写 `name` / `description` 的引号形态，破坏验收口径：
**剥掉 group 行后，安装后的 `SKILL.md` 与上游原件逐字节相等**。fixture 直接断言
`stripGroup(after) === upstream` 与 `bak-group === upstream`。

### lock 字段

文件就位**之后**才写 lock，记录由 `lockRecordFor` 生成：

| 字段 | 值 |
| --- | --- |
| `source` | 仓库根 URL（`https://github.com/<owner>/<repo>`） |
| `ref` | 上游 ref |
| `subPath` | 子目录（独立仓库为 `""`） |
| `sha256` | 新 tarball 字节的 sha256（与导入同源，都是 `resolveSkillPackage` 的产物） |
| `at` | 本次应用时间（ISO） |
| `commit` | `resolveSourceCommit` 的结果；取不到时写 `""`（不删字段、不伪造），此时 `update_check` 按既有优先级落到 `.git` / `meta`，两处都没有就报「无法比对」——**不许谎报 latest** |

`lockUpdated` 是「本次相对旧记录真正变了的字段名」排序后的清单（通常 `["at","commit","sha256"]`）；
已是最新与失败路径为空数组。写 lock 失败时 `stage:lock` 并如实报告「文件已更新、lock 未更新」。

### 计数口径（`added` / `deleted` / `modified`）

按「旧安装目录 → 新安装目录」的**文件级** diff 计数：

- `added`：新目录有、旧目录没有的文件数（含本工具新造的 `SKILL.md.bak-group`）；
- `deleted`：旧目录有、新目录没有的文件数；
- `modified`：两边都有但字节不同的文件数（含被改写 `commit` 的保留文件）。

参与比较的集合**排除** `.git/` 与旧的 `SKILL.md.bak-group`（二者明确不参与取舍，计入 `deleted`
会得出「一次升级删了几十个文件」的噪音）。逐文件以 Buffer 字节比较，不比 mtime。

### 失败原子性

取包、组装新树、校验（必须含 `SKILL.md`）、备份、写临时区全部在安装目录之外完成；**全部成功后才动
安装目录**，替换用同卷两步改名（旧目录 → 临时区，临时区新树 → 安装目录），中途失败尝试把旧目录搬回。
失败点用 `stage` 标明，取值固定为 `locate` / `source` / `fetch` / `assemble` / `swap` / `lock`：

| stage | 含义 | 安装目录 |
| --- | --- | --- |
| `locate` | 没装这个技能 / 没给名字 / 没有扫描根 | 零改动 |
| `source` | 准入条件不满足（无记录、tarball 来源、取不出 ref） | 零改动 |
| `fetch` | 取上游 commit 失败 / 下载失败 / 包里没有 `SKILL.md` | 零改动 |
| `assemble` | 备份失败、备份路径落在扫描根内、组装或校验失败 | 零改动 |
| `swap` | 旧目录移出或新树就位失败 | 已搬回则零改动，搬不回则按 `backupPath` 恢复 |
| `lock` | 文件已就位但写 lock 失败 | 已更新（如实报告，不回滚） |

### 与 `update_check` 的分工

| | `skillmgr_update_check` | `skillmgr_update_apply` |
| --- | --- | --- |
| 动作 | 只读：`git ls-remote` 比对 commit | 写入：取包、换位、写 lock |
| 范围 | 全库（两棵扫描根，可判定项逐个报） | **只处理参数里点名的那一个技能** |
| 触发 | 可被面板 / 轮次提示复用 | 只由显式调用触发：无定时、无批量、无「全部/通配」入口 |
| 上游缓存 | `upstreamTtlMs`（N-10 口径） | 同一份 `upstreamTtlMs`，比较阶段与 check 同源 |
| 失败语义 | 单条标注、不中断全量 | 结构化失败 + `stage` + 零改动 |
| 事后 | 什么都不变 | lock 更新后，同口径复验应为 `latest` |

## 总口径复述

- 缺数据 = 报不可得 + 原因，**不给 0、不给空比例、不给「大概」**。
- 有数据但有上限（归档 500 条）= 报出计数并标明已达上限。
- 口径有两种（按事件 / 按名）时，永远连同口径名一起报，不静默替换。
- 工具只读：不改任何数据源文件，fixture 用前后 sha256 比对证明这一点。
