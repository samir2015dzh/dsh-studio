# studio 备份包与跨机恢复

换机器、或把两台 DSH 的进化成果合到一起时，用 studio 备份包：一个文件装下 studio 管的全部对象，在另一台机器上导入后注册表、配置、技能与版本史就位可用；同名对象两边都改过时**报告待裁，不静默覆盖**。

## 与 `.dsh` 快照、每日备份的分工

三样东西各管一摊，**互不替代**：

| | studio 备份包（本文） | 配置快照（面板「配置快照」） | 每日备份（本机计划任务 03:00） |
|---|---|---|---|
| 目的 | 可移植：换机器 / 跨机合并 | 同机回到某个时间点 | 灾备：`.dsh` 被整个毁掉时兜底 |
| 范围 | studio 管的对象：MCP 注册表、优化器 / 治理 / 蒸馏 / 提取器 / 备份配置、两个技能库、版本史、进化数据 | `~/.dsh` 白名单（AGENTS.md、cordis.patch.yml、profiles 的两份文件、`~/.dsh/dsh-studio/`、技能库）+ 版本史 | `.dsh` 整目录 |
| 恢复方式 | **按对象合并**：版本史按 id 取并集；技能按版本链判断谁新；判断不了的报告待裁 | 逐文件覆盖（SHA 不同就覆盖） | 整目录拷回 |
| 冲突 | 列成待裁冲突，所有者用 `resolutions` 裁定后才动 | 不判冲突 | 不判冲突 |
| 凭据 | 不出机（占位符），恢复报告列出要补的字段 | 不出机（占位符） | 原样（本机 D 盘 + WebDAV） |
| 插件配置行 / profile | 只作参考记进清单，**不写回** | 管 | 管 |
| 会话日志 / 遥测 | 不管 | 不管 | 管 |

一句话：**`.dsh` 没了用灾备；同机想回退用快照；换机器或合并两台机器的技能 / 注册表 / 版本史用备份包。** 开工前「先确认当日 `.dsh` 备份存在」的规矩不变，备份包不是它的替代品。

## 包里有什么

单个 `studio-<时间>-<标签>.tar.gz`（默认在 `~/.dsh-studio/studio-backup/packages/`，环境变量 `DSH_STUDIO_BACKUP_DIR` 可改；旁边的 `<id>.json` 是列表用的索引）：

| 包内路径 | 内容 | 来源 |
|---|---|---|
| `MANIFEST.json` | 清单：格式、schema、时间、来源机的 home / 平台、每类对象的摘要、**每个条目的字节数与 sha256**、脱敏字段表、插件配置行（参考） | — |
| `MANIFEST.sha256` | 清单本身的 sha256 | — |
| `registry/mcp.json` | MCP 注册表 v2 全量（含目录条目、试运行、验证状态），凭据字段换成占位符 | `~/.dsh/dsh-studio/mcp.json` |
| `config/<id>.json` | 配置文件层：`optimizer` `governance` `distill` `studio-backup` `extractor`（`llmApiKey` 脱敏） | 各自的 `config.json` / `extractor.json` |
| `skills/<根>/<技能>/…` | 两个技能库的当前内容；根 id：`dsh` = `$DSH_HOME/skills`，`agents` = `~/.agents/skills`（与优化回路同一组根） | 技能根 |
| `history/versions.jsonl`、`history/objects/xx/<sha>.gz` | 版本史全量（内容寻址对象原样） | `~/.dsh-studio/history/` |
| `data/<区>/…` | 进化数据：`optimizer`（评估集 / 提案 / 报告 / 丢弃记录）、`governance`（合并提案 / 冲突报告 / 教训）、`distill`（草稿 / 报告 / 淘汰记录）、`catalog-eval`（目录评测归档） | `~/.dsh-studio/<区>/` |

不进包：`.git` / `node_modules`、锁与临时文件、各区根上的 `config.json`（已在配置层）、技能根上的非技能文件（如 `PENDING_PULLS.json`）、`sync.json`、MCP 凭据暂存、遥测。超过 `maxSkillFileBytes`（默认 5 MB）的技能文件只记 sha，恢复报告里逐个列出。

## 校验

`skillmgr_studio_backup {action:"verify", id}`（或外部包 `file`）逐项核对：gzip 可解；清单 sha 对得上；每个清单条目都在、字节数与 sha256 一致；没有清单外的条目；所有路径都在已知前缀下、没有 `..` / 绝对路径；版本史对象的内容 sha 与文件名一致；schema 不比插件新。**任何一项不过，恢复一个字节都不写。**

## 恢复

`skillmgr_studio_restore {id 或 file}` **默认只预演**（不写盘，出一份预演报告）；`dryRun:false` 才真写。真写前先给本机打一份 `pre-restore` 保护包（打不成就整次不做）；外部包先收进本地包目录。

逐对象的结论：

| 结论 | 含义 | 动不动 |
|---|---|---|
| 新建 | 本机没有 | 写 |
| 相同 | 内容一致（凭据值、运行时字段不比） | 不动 |
| 已合并 | 版本史按 id 取并集；追加型日志（`*.jsonl`）按行取并集 | 写（只增不改） |
| 快进 | 技能：本机现状是包内版本的祖先（版本链证明） | 写 |
| 保留本机 | 技能：包内版本是本机的祖先；数据区的 `state.json`（运行时节奏） | 不动 |
| **冲突·待裁** | 技能版本分叉或版本链判断不了、同名 server 配置不同、注册表全局设置不同、配置文件不同、数据文件不同 | **不动** |
| 按裁定用包内 / 保留本机 | 所有者给了 `resolutions` | 按裁定 |

冲突裁定：预演报告的「待裁冲突」里每项有 id（`skill:agents/foo`、`registry:rea`、`registry:@settings`、`config:governance`、`data:optimizer/x.json`），裁定后重跑：

```
skillmgr_studio_restore {id:"studio-…", dryRun:false, resolutions:{"skill:agents/foo":"package", "registry:rea":"local"}}
```

形态冲突（一边目录一边单文件）、本机 `mcp.json` 坏了，这两种裁定不适用，需手工处理。

其它口径：

- **路径**：来源机 home 自动换成本机 home（注册表、提取器配置、版本记录的 target；Windows 反斜杠写法一并处理）；其它前缀用 `pathMap:[{from,to}]`。
- **凭据**：占位符按 server 名 / 字段从本机现值（或注销暂存）补回，本机也没有的键**不写**，并在报告 `needsCredentials` 里逐条列出，到目标机补上即可。
- **版本留痕**：每个写入的技能出一条 `studio-restore` 版本记录，`restoreOf` 指向包内对应的那条（跨机的版本链靠它接上，之后的恢复仍能判断快进）；注册表写入同样出 `studio-restore` 记录。被覆盖的本机版本在版本史里，可 `skillmgr_rollback` 回去；要整体退回，恢复保护包即可。
- **找不回的大文件不动**：本机某个技能文件同时超过版本史上限（2 MB）和保护包单文件上限（`maxSkillFileBytes`，默认 5 MB）时，两张安全网都不接。恢复不会删它（包内没有它 → 留在原地，结果里列 `keptLargeFiles`），也不会盖它（包内有同名不同内容 → 该技能整项失败、一个字节不动，自行备份或移走后重试）。
- **幂等**：同一份包再恢复一次，没有可写项就不打保护包、不写任何东西。
- **恢复报告**：预演与真恢复都落盘 `~/.dsh-studio/studio-backup/restores/<id>.json` + `.md`（逐项结论、待裁冲突、需补凭据、保护包 id）；`skillmgr_studio_backup {action:"report", id}` 查看。
- **插件配置行**只作参考，不写回（归 DSH profile 管）；重启 DSH 后注册表 / 配置的改动才完全生效，与其它注册表改动同口径。

## 节奏与同步

- **手动导出**：`skillmgr_studio_backup {action:"export", label?, to?}`；`to` 给目录或文件名时顺手拷一份出去（U 盘 / 共享盘）。
- **闲时自动打包**（默认关）：插件配置 `studioBackup: { enabled: true }` 或 `~/.dsh-studio/studio-backup/config.json`。窗口 02:00–06:00、闲 30 分钟、至少隔 24 小时；自动包（`scheduled`）留 `keep`（默认 7）份，保护包（`pre-restore`）留 `keepPreRestore`（默认 3）份，手动包不自动删。
- **WebDAV**：复用 `sync.json` 的 webdav 段（地址与凭据，本功能不另存凭据），包放在 `<webdav.url>/<remoteDir>/`（默认 `studio-backup/`，与快照的 `config.tar.gz` / `LATEST` 分开）。`push` 写 `<id>.tar.gz`、`<id>.tar.gz.sha256`、`INDEX.json`，最后写 `LATEST`；远端按 `remoteKeep`（默认 7）清理。`pull` 取 `LATEST`（或指定 id），比对远端 sha256 并整包校验后才收进本地。`autoPush: true` 时自动包打完即推。

配置项全表见 `lib/studio-backup-config.js` 的 `STUDIO_BACKUP_DEFAULTS`。

## 内存与体量

校验与恢复把整包读进内存解开（与快照恢复同一口径）；导出是流式的。真机技能库约 200 个、百 MB 级时可用；大素材包按 `maxSkillFileBytes` 只记 sha，避免包被撑大。
