# Changelog

> `dsh-studio` 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
> 说明：0.2.0 及更早的条目依据 git 历史与 npm 发布时间回填。

## [Unreleased]

### 新增 (Added)

- feat(evolution): 进化地基——遥测（skill 触发 / 注入、MCP 调用耗时与错误类、目录候选看了没用；按天 JSONL、保留 90 天）与版本溯源（两个技能库 + MCP 注册表每次写入出版本记录，可回滚到任意版本，版本史随快照走）；新工具 `skillmgr_stats` / `skillmgr_history` / `skillmgr_rollback` 与对应面板路由
- feat(mcp): MCP 接管——唯一注册表（v1→v2 迁移逐项等价并出版本记录；原生新行自动接管；拦截 Settings→MCP 的新增 / 修改 / 启用并做只读镜像）、按需加载（未选中 server 零连接，`mcp.load` / `mcp.unload` 遥测与周统计闲置项）、工具目录（是什么 / 何时用 / 何时别用 / 读写 / 验证状态，随版本史走；G5 场景集基线 94.3%）、未验证可登记、熔断与健康检查、读写分级与试运行；新工具 `mcp_unregister` / `mcp_verify`（33→35），新路由 `/mcp/unregister` `/mcp/verify` `/mcp/catalog`（37→40）；注册表整份消失 / 损坏留显式版本记录
- feat(optimizer): 技能自动优化回路——按遥测挑候选（无遥测不进），达尔文式迭代（变异 → 评估 → 留最优），G1 评估门（平均分不低于基线 + 关键场景零回退，不过即丢弃留记录；仅所有者可在面板点名放行个案），G3 分级（低风险自动应用并出 `optimize` 版本记录、结构性只出提案），红线清单（权限 / 安全段落永不自动修改），冲突迹象停轮报告，闲时窗口与每轮成本 / 时长上限（自动轮次默认关），每轮变更报告；新工具 `skillmgr_optimize_status` / `skillmgr_optimize_run` / `skillmgr_optimize_decide`（35→38），新路由 `/optimizer/status` `/run` `/decide` `/override` `/report`（40→45）；版本记录的 `eval` 字段落地
- feat(optimizer): 自动应用后的回归监测——自动应用落地时记下应用前的评估结果与版本指针（`~/.dsh-studio/optimizer/watches.json`），之后每轮优化开头按 G1 评估门同一口径（gate）跟应用前复评，不过门判为退化 → 自动回滚到应用前那一版（rollback 版本记录 actor=optimizer:regression，原因写明三段分数与回退场景；`regressions.jsonl` 留痕；报告与 `skillmgr_optimize_status` / 状态路由可见），该技能此后不再自动应用、只出提案；连续 `regression.checks`（默认 2）轮不退化即结束观察；应用后文件被别处改过的不复评、不回滚
- feat(darwin): Darwin 无人值守改写与优化回路统一口径——无人值守体检不再让模型直接落地改写，改为经新工具 `skillmgr_darwin_submit`（47→48）提交完整正文：先过 G1 评估门（不过门不落地、记丢弃），再按 G3 分级——最低风险档自动应用（版本记录 actor=darwin:unattended、eval.source=darwin、进回归监测），其余进待批；体检点名的 SKILL.md 在体检期间（默认 60 分钟或回收到结果行）被模型直接写入时由 `tools/pre-execute` 拒绝；用户显式调用 darwin-skill 的交互流程不受影响
- feat(mcp): 跟进——G5 场景集按真实能力修正（docbase = 电气维修资料库：位号 / 图纸页 / 程序包日志；原「头脑风暴」三条改判反例，新写真实用途正例；web-research 补 read_url / github_*；场景集移到随包 `lib/catalog-scenarios.json`，38/40）；`mcp_list` 文本恒有内建 MCP 管理状态行；闲时目录评测巡检（真实注册表 × 场景集，归档 + 掉超阈值写回退报告，只报告，`mcp.catalogEval` 默认关）；新工具 `mcp_catalog_eval`（38→39），新路由 `/mcp/catalog-eval` `/mcp/catalog-eval/run`（45→47）
- feat(governance): 技能库治理——合并提案（遥测 + 内容相似挑候选、附证据、合并稿 + diff + 评估门预览，批准后新版本溯源两个来源、被并方进回收站可恢复并可查去向）、冲突报告（同名多处 / 触发重叠 / 指令矛盾 / 工具冲突，闲时全量 + 新版本增量）、有来源的经验教训（遥测失败 / 丢弃与放行记录 / 已裁决冲突，重复计数、出补丁提案、有版本可撤回）、「看了没用」报告；只出提案不自动写，自动轮次默认关；新工具 `skillmgr_governance_status` / `run` / `decide`（39→42），新路由 `/governance/status` `/run` `/decide` `/report`（47→51）
- feat(distill): 蒸馏硬化——提取候选一律先成草稿（带会话 id / 时间 / 关键轮次出处，不在技能根里），先用 #4 的相似度查重（高度相似 → 合并提案，草稿作来源），其余过 #3 评估门才按版本化入库（版本记录带 distill 出处），不过门淘汰留记录；手动（可点名会话）+ 闲时批量（默认关）两路，每批报告含处理条数、过门率、合并去向；来源跳转路由；新工具 `skillmgr_distill_status` / `run` / `decide`（42→45），新路由 `/distill/status` `/run` `/decide` `/source`（51→55）
- feat(backup): studio 级备份包与跨机恢复——单文件包（清单 + 每条目 sha256 + 清单 sha）装 MCP 注册表 v2 全量、优化器 / 治理 / 蒸馏 / 提取器 / 备份配置、两个技能库、版本史、进化数据，凭据一律脱敏；逐项校验不过零改动；恢复按对象合并（版本史按 id 并集、技能按版本链快进 / 保留本机，分叉与同名不同配置报告待裁，`resolutions` 裁定后才动），自动改写来源机路径，缺的凭据逐条列出，写前打 pre-restore 保护包，预演与真恢复都落恢复报告；手动导出 + 闲时自动打包（默认关）、保留份数可配；WebDAV 推拉复用 sync.json；与 .dsh 快照 / 每日备份的分工见 STUDIO-BACKUP.md；新工具 `skillmgr_studio_backup` / `skillmgr_studio_restore`（45→47），新路由 `/studio-backup/status` `/export` `/verify` `/restore` `/remote` `/report`（55→61）；版本记录新增 `studio-restore` 动作与 `restoreOf` 字段

- feat(history): 版本史保留口径（所有者 2026-11-16 拍板）——每 key 保留最近 200 条，更早的移进 `archive/versions-<时间>.jsonl.gz`（不再被读回），`objects/` 按「仍被保留记录引用」GC（1 小时宽限防写入窗口）；启动 2 分钟后跑一次、之后每天至多一次；`scripts/history-retention.mjs --dir <副本>` 在真机历史副本上预演 / 执行 / 自检 + 回滚抽验
- feat(mcp): 目录自检配置通道 `~/.dsh-studio/catalog-eval/config.json`（三层合并与其他四个子系统同构，状态注明生效来源，改了不用重启）；面板 MCP 页内建守卫徽标（armed / unavailable + 累计拦截数，unavailable 主动提示）与注册表损坏横幅；新路由 `/mcp/registry-corrupt`（61→62）

### 变更 (Changed)

- style(ui): 三个设置页视觉重做——统一设计变量（强调色 / 线 / 面，只用 currentColor 混色，亮暗主题都成立）；统计改成卡片；标题带图标与说明；筛选收进一张卡、零计数项淡化；页签 / 档位 / 工具过滤 / 同步通道改成分段控件；启用开关改成拨动开关；行内删除按钮悬停才显；状态 / 错误改成提示条；快照页按「备份 / 远端同步 / 导入导出」分卡；编辑页隐藏筛选、显示「未保存」标记。行为与接口不变；无动画库、无持续动画（仅 hover / 开关 120ms 过渡，减少动态偏好下关闭）、无模糊阴影、无外链字体；`lib/client.js` gzip +7%（以 main `cc8b1bd9` 为基线 31.2→33.5 KB，阈值 20%）
- perf(#8): 治理增量冲突检查一批只读一次技能库（逐 key 结果与单查对拍一致）；遥测统计按日预聚合（键 = 文件名 + mtime + size，跨窗口边界的日子读原文，与直读口径逐字节对拍）；版本捕获大文件流式 sha256 + (size, mtimeMs) 复用；快照恢复 / 导入 / 导出流式解包（createGunzip 逐条，pre-restore 修剪挪到写完之后）；五个闲时子系统的 tick 节流判断提到读配置之前
- change(extract): 插件内的提取不再直接写库或直接并进已有技能（含 autoAccept 与旧的语义合并 / tombstone 强并路径），统一交给蒸馏草稿；`autoAccept` 配置项保留但不再生效
- perf(#12): 全库审查遗留性能 B1–B7——版本日志常驻轻量索引 + 尾巴增量读（60 MB 量级改一行 ~700 ms → ~3 ms）；提取会话按 (mtime,size) 指纹缓存、只为最新 12 份留完整消息（945 份会话每轮 ~5 s → ~80 ms）；提示词与上一轮相同 / 草稿队列已满时不调提取模型；eager MCP 并行握手、新的一组就绪后再替换旧工具；快照不再打包 `skill-tmp/` `exports/` `skill-backups/`、回收站套单文件上限、gzip 9→6 级，更新前备份每技能只留 3 份；技能库读取按 stat 缓存、registry 摘要 60 s TTL、写入只作废那一条；零散十条（patch 解析复用、mcp_load 不重复列工具、登记少写两次注册表、ping 并行防重入、ls-remote 在途去重、版本捕获复用 sha、Darwin 组装改异步、恢复不重写相同文件、提取面板展开才挂、POST /snapshot 只回摘要）；量测脚本在 `scripts/perf/`

### 修复 (Fixed)

- fix(state-lock): ——Windows 上锁文件处于「删除挂起」（别的句柄还开着时被删，常见于杀毒软件 / 索引服务扫新文件）时，`wx` 建锁报 EPERM / EACCES 而不是 EEXIST，抢锁循环把它当致命错误抛出（main CI windows+node24 的 [C1] 即此）；现在 Windows 上按「锁正在释放」重试，仍受 timeoutMs 约束，超时错误带原始错误码；POSIX 平台不变
- fix(#13): 全库审查遗留较小项 C 组——过期锁回收串行化（`<lock>.reclaim`）；回收站先写 manifest 再搬目录；原子写跟随符号链接；guard-content 补 sk-proj- / sk-ant- / github_pat_、`rm -fr /` / `rm -rf /*`、`| sudo bash`、`irm | iex`；优化 / 治理 / 蒸馏工作目录每轮收尾做保留（未决与被引用的永远留，其余 90 天）；请求体超 1 MB 返回 413 与真实原因；ExtractorPanel 缺 key 警告

- fix(mcp): 第 0 项——内建 MCP 守卫真机没拦住：`ctx.get("mcpManager")` 返回 cordis traced proxy，`.ctx` 指向调用方，守卫把本插件自己的 fiber 当成 manager，Settings 写路径一律放行（rejected 恒 0）；改为剥 proxy 认 owner fiber（再按类 / 名字兜底），真 cordis 回归测试复现并覆盖；状态多报识别方式与判定次数
- fix(mcp): 审计 1/2——mcp.json 原子写；解析失败不再静默当空注册表（改名留档 + 损坏闸 + 拒绝覆盖，回滚或所有者确认解闸）；sync.json / 凭据暂存（读-改-写套 withFileLock）/ darwin 状态同族修复：原子写，解析失败原文件保留并留档、报错，不回默认值；`*.corrupt-*` 不进快照
- fix(mcp): 审计 6——Windows 上 stdio server 的命令按 PATHEXT 解析，命中 .cmd / .bat 经 `cmd.exe /d /s /c` 起并按 cross-spawn 口径转义参数（含空格 / 引号）；spawn 阶段错误原文带进 verify 失败信息
- fix(mcp): ——Windows 命令解析候选顺序：先在所有 PATH 目录里按 PATHEXT 补扩展名，无扩展名同名文件只作最后兜底。此前 nodejs 目录里 npm 自带的无扩展名 `npx`（sh 脚本）先于 `npx.cmd` 命中，直接 spawn → ENOENT（真机 verify 实录）；`uvx` / `pnpm` 等同受益
- fix(optimizer): 的 MCP 重挂（`mountMcp`）会顺手拆掉优化回路定时器，启动异步挂完 MCP 后自动轮次永远不跑；改为只在插件重同步时拆
- docs(telemetry): 头注释与实现对齐——`mcp.unload` 没有 `breaker` 这个 cause（熔断不断开连接），补 `closed`；`mcp.breaker` 补 `cooldown-elapsed`；`mcp.load` / `mcp.call` 补 `studio`；`mcp.registry` 补 `setting`
- fix(data-safety): 全库审查第一批 · 丢数据类——原子写在 Windows 上改名持续失败时不再「先删目标再重试」（会把 mcp.json / SKILL.md / versions.jsonl 的唯一一份删掉），只重试改名，到期仍失败则目标保持原样；临时文件名加随机段。快照恢复前的保护快照打不成且本次要覆盖现有文件时中止、零写入（此前吞掉失败照写；`force:true` 是所有者明确放弃保护的口子）。git 同步通道不再对没有 `.git` 的自定义 `workDir` 做 `rm -rf`（非空即拒绝）。extractor.json / candidates.json / mcp.json 读坏或一时读不到不再当「没配置」并被默认值覆盖（extractor.json 带 BOM 能读；坏文件原地保留并留档、读出来是关闭态、写入被拒）。闲置归档落点改用目录名（frontmatter 的 `name: ../x` 曾能写到归档根之外，同名技能在归档里互相覆盖），已存在则加序号。回滚 / studio 恢复不再删除或覆盖两张安全网都不接的大文件（版本史只存 ≤2 MB、保护包跳过 >5 MB），保留并在结果里报出（`skippedLarge` / `keptLargeFiles`，会被覆盖的整项拒绝）。带 BOM 的 SKILL.md 切换启用不再多塞一段 frontmatter 把技能改没；别名键 `disable-model-invocable` 能被「启用」清掉并纳入红线键；带 BOM 的 mcp.json 照常进快照，本机凭据文件读不懂时拒绝被快照覆盖
- fix(security): 全库审查第一批 · 安全类——「记住」只认 `role === "user"` 的消息本身（此前按行前缀切渲染好的摘要，助手 / 网页内容里夹一行 `- 用户：…记住` 即可冒充用户、下一轮被当成「直接落位」的指令），摘要里一条消息折成一行；优化器只接受单段技能名（`../../Documents/notes` 曾能把技能根之外的 .md 读给模型并改写）；技能导入 / 待拉清单 / 原地更新拒收包内越界路径；原子写残留临时文件（`.mcp.json.<pid>.<ms>.tmp`，凭据文件的明文副本）与插件数据目录里的 `*.tmp` / `*.lock` 不进快照；`GET/POST /api/dsh-studio/sync` 只回脱敏视图，原样回传的掩码按「没改」处理；`mcp_list` 的 endpoint 抹掉 args / URL 里的凭据，验证失败原因里的 `Bearer <token>` 整体抹掉，上游来源抹掉 userinfo；凭据键名口径补 `*_PAT` / `*_KEY` / `*_PWD` / `private-key` / `passwd` / `passphrase` / `auth` / `dsn`，另按值识别厂商 token 前缀、`Bearer …`、带口令的 URL；会话原文里凭据形态的片段在读日志入口抹掉（不再进发给提取模型的摘要与草稿出处摘录）；护栏「无条件删除」正则两处无界间隔加上限（一行 42 KB 的 `Remove-Item -Recurse …` 曾让宿主事件循环卡死两分钟以上）
- fix(scanner): `DSH_SKILL_MANAGER_SKILL_DIRS` 按平台 `path.delimiter` 切分（Windows 上按 `:` 会把 `C:\…` 切成两个错根）
- fix(panel): 全库审查第二批 · 面板硬伤——「导入 skill」路由引用了未定义的 `store`，面板导入必报 "store is not defined"（`makeRoutes` 现在接收提取器配置）；配置快照页的 `changeSchedule` 从未定义，勾选「定时备份」或改间隔 / 份数即抛 ReferenceError、什么都存不上（补上实现，数字框失焦 / 回车才提交）；提取配置的模型下拉保存与回填用字面 NUL 分隔、选项值用空格，选了模型存出去是 `provider="prov model"`、`model=""`，服务端回落到会话模型（统一成 `MODEL_SEP` 常量）；MCP 工具过滤「去掉勾选」模式下每次点击都是空操作（两种模式统一为「勾选 = 在名单里」）；技能详情页切换启用后只更新 mtime、不更新正文，下一次保存用旧 frontmatter 把开关悄悄写回去（开关后取回磁盘内容，草稿有改动时不许切）；点「技能 / 回收站」页签绕过未保存确认（改走确认）。定时快照保留份数下限 1（0.5 曾被 floor 成 0）。新增 `scripts/e2e-panels.mjs`：真实路由 + 临时 HOME + 无头 Chromium 实点这几处（需 playwright，手动跑）
- fix(evolution): 全库审查第三批 · 进化回路护栏——评估门要求基线完整：基线评分被截断 / 不是 JSON 时 `scoreSkill` 给的是「均分 0、各场景 null」，此前每个场景只得 1 分的候选也能过门并被自动应用（优化回路重问一次，仍不完整则跳过该技能；合并预演同口径；蒸馏的绝对线不受影响）。评估集文件名不再把非 ASCII 折成 `_`（「数据分析」与「周报生成」曾共用 `evals/_.json`），文件里记的技能名对不上就当没有。自动应用 / 批准应用必须出版本记录：写前状态取不到不写，写后没出记录就还原并报错（此前照写并报「已应用」，无从回滚）。冲突 / 合并扫描：增量检查不再吃 `maxPairs` 上限（约 200 个技能时库尾的技能一对相关的都比不到），全量超上限时按窗口逐轮轮转、报告写明覆盖面，没比到的冲突不再被标成「已消失」；二元组集合按原文记忆（约 200 个技能的全量扫描 22 秒 → 3 秒）。分级：shell 围栏里任何命令行变化算 tools、步骤被改写（原句保留率过低）算 steps、指令性否定 / 条件词增减算 polarity（按未知从严），「补充细节」仍是措辞。蒸馏：同批近似草稿不再双双入库；必错草稿连错 3 次判失败出队、不再卡住队首；所有者丢弃 / 没过门 / 已入库的草稿，同内容或同名且无新出处会话的不再回来（用户点名的不受限）。Darwin：聚类回复不是 JSON 时不再把家族表覆盖成空；results.tsv 里早于改动的旧行不再把新改动记成已评（时间戳的产生与解析全程跟随本机时区：提示词里给出本机时间戳让模型照写，不带时区的串按本机时区理解，不写死 UTC 或固定偏移——所有者裁定 2026-11-17）；巡检清单逐轮往后推。「记住」请求按「会话 + 原话」留指纹，处理过一次不再每轮重复挂起并短路逐轮提取
- fix(mcp): 全库审查第三批 · MCP 稳定性——`child.stdin` 补 error 监听（子进程不再读 stdin 时的 EPIPE 曾是宿主进程的未捕获异常）；stdout 超限后回收子进程（此前只标记关闭，进程一直活着），Windows 上经 cmd.exe 垫片起的 server 按进程树终止；握手途中注销 / 插件卸载 / 改端点时作废并关掉在途连接（此前握手完成后装到没人管的 slot 上，子进程既不被空闲回收也不被 closeAll 关掉），取消不计熔断；空闲扫描顺带断开已不在注册表 / 已停用的 server；streamable-HTTP 会话被服务端丢弃（404）后标记关闭、下次调用重新握手（此前一直 404 到熔断）；系统提示里的目录段登记为 `interpolate: false`（备注 / 工具名里出现 `{{…}}` 曾让提示词渲染抛错），熔断开合与验证结论变化时防抖重建目录段；profile 导入只在未闭合的双引号标量里折叠续行（`cwd: D:\tools\alpha\` 曾吞掉下一行）、去掉值后的行内注释、名字不合规或没有 command / url 的行不再「先禁用原生行再丢条目」、行里已有 `disabled: false` 时改值而不是再插一个同名键；stdout 分帧只扫新到的块
- fix(misc): 文件锁持有期间用修改时间续期、释放时只删自己的锁（超过 60 秒的导出 / 恢复曾被另一进程当僵死锁收走）；内容读不懂的锁（建锁写到一半）不再立刻被当成僵死锁收走，只按「pid 已死」或「超过 staleMs 没动静」回收；快照包上传下载的超时 30 秒 → 10 分钟；使用信号按文件指纹判断「处理过」（同一会话后来加载的技能曾漏计，闲置判定偏早）；frontmatter 带引号的值里 ` #` 不再被当注释截断，双引号值按 JSON 转义解码
- fix(darwin): ——results.tsv 等处带时区标记的时间戳（`…Z` / `…+08:00` / `…+0800` / `…+09`）标记不作数，按字面钟点作本机时间理解，与不带标记的串同一口径（所有者裁定 2026-11-17）。此前按绝对时刻算：模型照本机钟点写却带了标记时，本机偏移小于标记偏移会把新鲜结果当成几小时前的旧行拒收、pending 永不清，大于时又会把旧行当成新行放过
- fix(security): 快照内嵌凭据脱敏——MCP 配置 `args` 里的 `--api-key xxx` / `--token=xxx` / 裸 token、任意字符串里 URL 的 userinfo 与像凭据的查询参数（`?exaApiKey=…`），此前展示侧已抹、快照 / studio 备份包 / 版本史里仍是原值；现在只把那一段换成占位符，识别与展示侧 `maskArgs` / `maskUrlSecrets` 共用 `lib/redact.js` 同一份实现。恢复 / 回滚时按「同名 server + 同键」从目标机现值补回，补不回的占位符原样留着并逐项列进报告（快照 `missingCredentials`、备份包 `needsCredentials`、回滚 `missingCredentials`），带占位符的端点运行时拒绝连接；`mergeRedacted` 对带 name 的数组元素不再退回按下标配对。兼容：旧快照照常恢复；含内嵌占位符的快照把凭据文件挂在 `needs-newer-dsh-studio/` 前缀下（旧版恢复时跳过并在 skippedPaths 里点名），含内嵌占位符的备份包标 schema 2（旧版校验即拒收并提示先升级）。展示串唯一变化：带口令的 URL 参数由整段 `***` 改为只遮 userinfo（`https://***@host/…`）。升级前写下的注册表版本对象由 `redactRegistryHistory` 按新口径一次性重新脱敏（启动 2 分钟后随版本史保留自动跑、幂等；`scripts/history-redact.mjs --dir <副本>` 可先在真机历史副本上预演 / 执行 / 自检）
- fix(audit): A1–A4——A1 bundle 级接管的原生状态叠上 profile 层覆盖块（`refreshNativeStates` / 启动对账 / `readRowDisabled` 同口径），已接管的 bundle MCP 不再每次启动报漂移、面板红点不再常亮；A2 `McpStore.load()` 交出副本、`save` 失败作废缓存，写失败不再留下会被下一次写入落盘的「幽灵」改动，`POST /mcp/tools`、注册表瘦身、启动对账的读-改-写走串行链；A3 同名技能合并时评估集按集里记的 key 认主，被并方不再拿保留方那份过门（自己那份不落盘、不覆盖对方冻结的）；A4 WebDAV 推送改用带版本号的文件名、最后才切 `LATEST`（远端留当前 + 上一版，旧名字经 `.part` + MOVE 更新给旧版拉取方），拉取按清单校验快照 id / 包字节数 / 逐条 sha，对不上不落盘
- fix(audit): A5–A7——A5 HTTP 会话被服务端丢弃（带会话 id 的请求答 404）时，撞上的那一次调用重新握手并重试一次（只认这一种错误，重试仍失败照常报），`verify` 成功后丢掉 slot 上已失效的连接；A6 蒸馏批次与治理轮次收尾写报告失败也放锁（release 进内层 finally），蒸馏批次处理每份草稿前、写回前各重读一次，处理期间被所有者 `decide()` 过的以那次决定为准（本批结果只记进历史）；A7 会话日志 `createdAt` 读不懂时摘要退回文件 mtime、`type` 不是字符串的行跳过，一份坏日志不再让整轮提取失败
- fix(audit): A8–A10——A8 同一个目录名出现在 3 个以上的根里时，消歧名还撞就带上根的来源标识（再撞追加序号），每一份都按名字找得到，前两份的名字不变；A9 未保存草稿记下基线 mtime，磁盘在那之后被改过时恢复提示说明、保存带草稿自己的基线走 409 冲突比对，不再悄悄盖掉磁盘上的新内容（没记基线的旧草稿同样走比对）；A10 快照白名单的排除类判定（skip 集、凭据文件）按 Windows 规则归一（不分大小写、去尾点与空格），`SYNC.JSON` / `sync.json.` / `MCP.JSON` 这类变体不再绕过 sync.json 闸与凭据合并，含 `:`（备用数据流）的段与归一后成为 `..` 的段一律不收

## [1.2.0] - 2026-11-12

### 新增 (Added)

- feat(mcp): 接管改为启动对账，bundle 条目绕过 node_modules，加上游版本检查
- feat(check): 宿主升级一条龙检查 check:host，并写进 AGENTS.md 让 DSH 每次会话先跑

### 修复 (Fixed)

- fix(mcp): 第 0 项——内建 MCP 守卫真机没拦住：`ctx.get("mcpManager")` 返回 cordis traced proxy，`.ctx` 指向调用方，守卫把本插件自己的 fiber 当成 manager，Settings 写路径一律放行（rejected 恒 0）；改为剥 proxy 认 owner fiber（再按类 / 名字兜底），真 cordis 回归测试复现并覆盖；状态多报识别方式与判定次数
- fix(mcp): 审计 1/2——mcp.json 原子写；解析失败不再静默当空注册表（改名留档 + 损坏闸 + 拒绝覆盖，回滚或所有者确认解闸）；sync.json / 凭据暂存（读-改-写套 withFileLock）/ darwin 状态同族修复：原子写，解析失败原文件保留并留档、报错，不回默认值；`*.corrupt-*` 不进快照
- fix(mcp): 审计 6——Windows 上 stdio server 的命令按 PATHEXT 解析，命中 .cmd / .bat 经 `cmd.exe /d /s /c` 起并按 cross-spawn 口径转义参数（含空格 / 引号）；spawn 阶段错误原文带进 verify 失败信息
- fix(test): 时间基准改用运行时刻，修 quality 会话窗口漂移
- fix(portability): 静态体检跳过 .gitignore 忽略的本机脚本
- fix(portability): Windows 上能调 dsh.cmd；隔离模式收尾真正删掉临时 DSH_HOME
- fix(portability): Windows 上收尾能杀掉 dsh web fork 出的服务进程
- fix(ci): 补齐 peer 范围到 0.2.2-rc.1，修复冻结安装校验
- fix(portability): 清理时不再删除 home 下的 profiles 根
- fix(deps): 开发依赖对齐宿主 0.2.2-rc.1，修 link 模式下加载旧 core 导致 profile 回退

### 其它 (Changed)

- test(portability): 补 profile 误删回归测试，HOME 缺省改用 os.homedir()
- docs(deps): 注明 dsh 升级后必须同步本地依赖，并加 check:host-deps 自检

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1 || ^0.2.0-rc.2 || ^0.2.2-rc.1

## [1.1.0] - 2026-11-11

### 新增 (Added)

- feat: 编辑中途离开会先确认，避免丢掉没保存的修改
- feat: 筛选后没有技能时提示并可清除筛选
- feat: 可以把单个技能导出成 tar.gz
- feat: 面板加上保存、返回和搜索的快捷键
- feat: 保存前检查磁盘是否已改，避免覆盖别人刚写的内容
- feat: 列表出错提示更清楚，搜索可按标签，提取不会叠跑
- feat(ui): 面板轻量美化，控制体积与空闲 CPU
- feat(lifecycle): M-7 补 firstUsedAt / useCount，解锁首次使用距入库中位数与平均使用次数
- feat(candidates): M-6 接受/拒绝的候选移入归档（滚动上限 500），quality 报历史接受/拒绝
- feat(provenance): M-5 追加 append-only 裁决事件流水，quality 漏斗改按事件计数
- feat(skillsrc): M-3 codeload 下载对网络类错误退避重试 2 次，4xx 不重试
- feat(upstream): M-1 每轮联网上限 3 次 ls-remote，超出静默跳过（缓存命中不计次）
- feat(skillmgr): R-2 新增消费待拉清单的 skillmgr_pull_pending
- feat(skillmgr): Q-2 新增只读的提取质量度量工具
- feat(skillmgr): U-2 新增只读的上游更新检查工具
- feat(darwin): U-1 优化前查上游是否已有新提交
- feat(LINK-3): subdir 做成来源链上的结构化字段
- feat(LINK-2): 恢复时给出待拉取清单，不替恢复端联网
- feat(LINK-1): 大 skill 来源可确定时只记仓库链接，不打包内容
- feat(BORROW-6): 从 GitHub / tarball 导入 skill 并写安装锁
- feat(BORROW-7): 自动生成的 skill 落 provenance 证据链
- feat(BORROW-5): 整行命令切分 + 只读感知删除
- feat(BORROW-4): judgePlacement 加 no-op 快路
- feat(BORROW-3): 提取判定引入五条准入标准
- feat(BORROW-2): 自动落库前的写前守门
- feat(BORROW-1): skill 生命周期 active → stale → archived，永不硬删
- feat(C-2): 快照过滤 skill 根下的大文件并记入 SKIPPED.json
- feat(snapshot): 面板接上同步区
- feat(sync): 四条同步通道 + skillmgr_sync 工具
- feat(snapshot): 定时备份 + 保留策略
- feat(snapshot): 跨机路径重映射
- feat(snapshot): 面板拆成三个小组件接上 UI
- feat(snapshot): 配置快照的路由与工具
- feat(snapshot): 配置快照——备份 / 恢复 / 导出 / 导入
- feat(mcp): 凭据默认掩码，点显示/隐藏、可复制
- feat(ui): 三层筛选、MCP 面板对齐、registry 缓存、按用途分类
- feat(skill-studio): 回收站入口、行内删除、分页与分组改造
- feat(skill-studio): MCP 按需加载、空闲回收与接管 (0.6.0)
- feat(skill-studio): 「记住」通道改为对话内确认并按类型分流 (0.5.1)
- feat(skill-studio): 并入 darwin 体检调度器并支持同族折叠 (0.5.0)
- feat: self-improving skill pipeline (per-turn judgement, auto-accept, semantic merge, DSH-native models)
- feat(skills): 按 SKILL.md metadata.group 分组展示（第一期，只读）
- feat(client): Skill manager settings panel (list, edit, enable/disable)
- feat(host): skillmgr tools, loopback routes and system prompt announcement
- feat(scan): filesystem skill scanner with frontmatter parsing and nested bundle expansion

### 修复 (Fixed)

- fix(mcp): 第 0 项——内建 MCP 守卫真机没拦住：`ctx.get("mcpManager")` 返回 cordis traced proxy，`.ctx` 指向调用方，守卫把本插件自己的 fiber 当成 manager，Settings 写路径一律放行（rejected 恒 0）；改为剥 proxy 认 owner fiber（再按类 / 名字兜底），真 cordis 回归测试复现并覆盖；状态多报识别方式与判定次数
- fix(mcp): 审计 1/2——mcp.json 原子写；解析失败不再静默当空注册表（改名留档 + 损坏闸 + 拒绝覆盖，回滚或所有者确认解闸）；sync.json / 凭据暂存（读-改-写套 withFileLock）/ darwin 状态同族修复：原子写，解析失败原文件保留并留档、报错，不回默认值；`*.corrupt-*` 不进快照
- fix(mcp): 审计 6——Windows 上 stdio server 的命令按 PATHEXT 解析，命中 .cmd / .bat 经 `cmd.exe /d /s /c` 起并按 cross-spawn 口径转义参数（含空格 / 引号）；spawn 阶段错误原文带进 verify 失败信息
- fix: 捕获阶段拦截 Esc，避免宿主先关掉设置层丢掉修改
- fix: 发布包去掉 preinstall，避免 pnpm 10+ 干净安装失败
- fix: skillmgr_policy 的输出声明补上 mtimeMs
- fix: 定时备份失败写入 stderr，verify:quick 在没有 dsh 时跳过启动
- fix: 原子保存技能、校验 frontmatter，并修好回收站根目录保护
- fix: 跨进程文件锁 + 默认只扫 DSH/agents 技能根
- fix: 写路径失效扫描缓存、吞错改 warn，并补上手文档
- fix: 安装路径守卫 + Windows 稳健解析 npm，并修路由错误分级
- fix(test): relative tar paths in home helpers; N-12 ratio-only threshold; changelog Unreleased
- fix(restore): F-4 补 skillmgr_snapshot_restore 的 pendingPulls 输出声明
- fix(restore): F-3 修 skillmgr_snapshot_restore 的 preSnapshot 允许 null
- fix(get): F-2 skillmgr_get 查不到 skill 时不再返回 skill:null
- fix(quality): F-2 补齐 skillmgr_quality output schema 的 history 键
- fix(skillsrc): F-1 lock 短路以目标目录真实存在为前提，删除消费端 force
- fix(W-6): countFiles 与 collectFiles 的计数口径统一
- fix(W-5): tombstone 的 provenance 也带上 rationale
- fix(W-4): FOLD_INTO 的 provenance 记录补上 rationale
- fix(C-7): 快照收集跳过 .git/.svn/.hg 等 VCS 目录
- fix(C-4): last-llm-raw.txt 按 0600 落盘
- fix(C-3): 凭据文件 JSON 解析失败时整份排除并记入 REDACTED.json
- fix(C-1): 快照恢复落点跟随 agentSkillDir
- fix(FIX-10): 性能项（扫描缓存 / 轻量计数 / 复用 Buffer / load 缓存）
- fix(FIX-9): S 级小修打包（分隔符/强杀/超时/原子写/解析顺序/文案）
- fix(FIX-7): mcp_call 在冷缓存下不再放过白名单外的工具
- fix(FIX-6): MCP 死连接自知并在下次调用时重连
- fix(FIX-5): 路径与 id 校验全仓统一，回收站 stamp 加毫秒
- fix(FIX-4): sync 的 LATEST 写入与 git pull 不再假装成功
- fix(FIX-3): eager 工具保留 inputSchema 的 required 等约束
- fix(FIX-2): scanner 容忍引号布尔与 BOM
- fix(FIX-1): tar 长路径双向校验，装不下改用 GNU longname
- fix(FIX-8): 快照白名单跟随 agentSkillDir，主 skill 库不再漏备
- fix(EVO-7): autoAccept 默认值改为 true
- fix(EVO-6): 记住请求先本地分类，明确型直接落位不再提问
- fix(EVO-5): darwin 闭环补结果回收、paired 判据与本体缺失告警
- fix(EVO-4): darwin 挂载纳入插件总开关
- fix(EVO-3): darwin 只在写类工具改动 SKILL.md 时记 pending
- fix(EVO-2): 提取候选保留 group 并按 8 类校验
- fix(SEC-3): 快照恢复写盘对凭据文件补 0600 与 hardenPermissions
- fix(SEC-3): sync.json / mcp.json 落盘统一 0600
- fix(SEC-2): MCP 路由统一补 loopback + 同源守卫
- fix(SEC-1): 凭据在构造处脱敏，明文只走单点 loopback 路由
- fix(SEC-4): 快照打包时字段级脱敏凭据，恢复不覆盖本机现值
- fix(EVO-1): 合并重写保留原 frontmatter，索引补解析 group/tags
- fix(sync): WebDAV 推送前先 MKCOL 建目录
- fix(sync): Gist 的 content 是原文不是 base64，manifest 不能再解一次
- fix(sync): Gist 走 raw_url 时不该再 base64 解码
- fix(mcp): 修正状态口径、目录段体积与工具面板布局
- fix(sync): 工具渲染文案取错字段
- fix(snapshot): 补 13 处缺陷，含两条路径穿越
- fix(snapshot): 凭据与 git 工作副本不再进快照
- fix(snapshot): 定时清理只动 scheduled、快照 id 加毫秒
- fix(sync): Git 通道改用 init + remote add，支持空仓库
- fix(snapshot): Api 类补回 5 个 snapshot 方法
- fix(snapshot): 三个组件搬进 factory 作用域，补回 inputStyle
- fix(tools): skillmgr_list 的输出 schema 补回 dir 字段
- fix(mcp): 注册表只存工具名与截断描述，完整 schema 留在连接里
- fix(mcp): 凭据行布局——标签与按钮不再被挤换行
- fix(skill-studio): 连接超时与工具调用超时分离，面板忙状态按服务器隔离
- fix(skill-studio): 自动导入扫三层 patch 并修复块式 args 丢失
- fix(skill-studio): 补 pending 目录创建并修正 CHANGELOG 转义损坏
- fix(session-scan): 会话日志判据覆盖 v3/v4，并解析 zstd 绝对路径
- fix(release): dry-run 不再触发真实 registry 校验；CHANGELOG peer 摘要只列 dsh 包
- fix(tools): normalize null fields to empty values so skillmgr output schemas validate

### 其它 (Changed)

- chore(repo): 加 .gitattributes 统一 LF，避免 Windows 检出把源码变 CRLF
- refactor(engine): 拆分 lib/index.js、面板源码进 src/client、测试改用 node --test
- Remove remaining upstream fork references.
- Remove upstream copyright lines from README and LICENSE.
- test: 更新历史改写后的基线 commit SHA
- test: boot 夹具的 React stub 补上 useRef
- test: 流式打包体积与基线允许少量字节差
- test: quality 历史夹具的工具计数改为 29
- test: 路由计数改为 33（新增 skill-export）
- test: Windows 上比较 dsh 路径时忽略大小写（PATHEXT 为 .CMD）
- perf: 扫描缓存只留摘要，打开技能时再读正文
- docs: 面板和 README 文案改为更短、好懂的说法
- docs: CONTRIBUTING 与已知限制说明
- ci: checkout 取完整历史（测试用 git show 旧提交做基线对拍）
- chore: 对齐版本与发布面、加 CI、修正 README 默认值
- N-06: 新 fixture 的 spawn 环境补上 DSH_HOME，三件套齐指伪 HOME
- N-06: 并发与顺序等价六场景断言（基线版对拍）
- N-06: candidates / archive / extractor.json / snapshot.json 的 RMW 收口
- N-06: skill-lock.json 的三个写入口收进同一把文件锁
- N-06: 按文件粒度的进程内串行器，收编 lifecycle 与水位线的周期
- N-04: 五场景断言（恶意包凭据覆盖 / 白名单外路径 / round-trip / dryRun / schema）
- N-04: 恢复侧补白名单镜像，堵住构造包覆盖本机同步凭据
- N-03: QUALITY-METRICS.md 记录真实使用信号口径
- N-03: 合成会话日志 fixture 与真实使用信号场景断言
- N-03: quality 平均使用次数按加载会话数出数，消费侧对齐新口径
- N-03: 新增 usage-signals 模块：会话级水位线 + 增量幂等采集
- N-03: lifecycle 使用计数改为加载会话数，旧 useCount 迁移到 writeCount
- N-03: 会话日志解析出 skill 加载事件，提取与信号采集共用一轮扫描
- N-01: 注明同卷改名的跨卷限制
- N-01: QUALITY-METRICS 补 update_apply 的语义与口径
- N-01: 补 update_apply 的七个场景与备份不变式测试（upstream 套件 +41 断言）
- N-01: 注册 skillmgr_update_apply（参数 name，返回字段全部声明）
- N-01: 新增 lib/update-apply.js，把技能更新的应用环节写成代码闭环
- N-14: mock MCP 服务端补分页与 list_changed 覆盖（纯测试侧）
- N-10: update_check 接 upstreamTtlMs 缓存，与 darwin 同口径
- N-09: setRowDisabled 保留文件 EOL，rowId 按字面匹配
- N-08: MCP 目录段挂载补代次守卫，迟到构建不再覆盖新一代 disposer
- N-05: HTTP MCP 通道的 fetch 与 SSE 消费改用请求预算
- N-02: lock 记录补记来源 ref 的 commit sha
- release: v1.0.1 —— 修复三工具输出与注册 schema 脱节 + 全工具注册层校验常驻化
- test(quality): F-4 全 27 个工具注册层 schema 校验常驻化
- test(quality): F-3 补 restore 的 preSnapshot=null 回归
- test(quality): F-2 用注册层 output schema 校验返回体
- release: v1.0.0 —— 安全加固、自动进化修复、跨机迁移、质量度量与测试现代化
- test(boot): M-4 全程在临时 HOME 下跑，不再写真实 registry-cache.json
- docs(skillmgr): M-2 update_check 描述与 summary 注明全库口径
- test(pull): R-3 伪 HOME 全矩阵 fixture + 实网小拉取自证
- docs(pull): R-1 审计待拉清单的落盘位置、字段与导入复用点
- test(quality): Q-3 伪 HOME fixture + 真机只读实测数字
- docs(quality): Q-1 审计 provenance/candidates/lifecycle 字段与 join 键
- docs(upstream): U-2 修正版本字段取值的注释
- refactor(skillsrc): U-3 lock 的 source 拆成仓库根 + subPath 结构化
- test(W-7): collapsed 场景改为平铺口径（headers 0 / rows 3）
- test(W-7): [5] 段分组视图断言改为平铺口径
- test(W-7): 工具数与路由数对齐现状（24 工具 / 32 路由）
- test(W-7): P3 runtime skill 断言与 registry 摘要缓存解耦
- test(W-7): P2 useState 队列按 16 个 state 重排，删 groupView 槽位
- test(W-7): P1 register 桩按 meta.id 存面板，[5] 取 skill-manager
- chore(W-3): npm test 串联 darwin 与 boot 两套测试
- test(W-2): boot 测试的路径断言改成按分隔符比对
- test(W-1): boot 测试的 ctx 桩补上 on 成员
- docs(C-6): 修正 judgeThenExtract 上方与 EVO-6 行为不符的旧注释
- refactor(C-5): SENSITIVE_KEY 收敛到 lib/redact.js 单一来源
- chore(OPT-12): 测试脚本改用相对路径，package.json 补 test script
- test(sync): S3 真机往返测试
- docs: 补记 131e5b5 的 10 条改动，清 31 个历史备份
- chore(release): 0.8.0
- chore: 加客户端静态自检 scripts/check-client.mjs
- chore: 移出误提交的 client.js.broken-20261105
- chore: 取消跟踪 _classify-preview.txt
- chore: 分类 dry-run 清单加入 .gitignore
- docs: README 与 CHANGELOG 更新到 0.7.0
- style(ui): 中性灰换成 color-mix(currentColor)，跟随深色/浅色主题
- refactor: 插件改名为 dsh-studio
- docs: changelog 0.4.0, drop duplicate README.zh.md
- chore(release): 0.3.1 — 声明兼容 DSH 0.2.0-rc.2
- chore(release): 0.3.0
- chore(changelog): 把 Unreleased 的分组展示内容搬进 [0.3.0] 段落
- docs(readme): 按发布说明规范补编号操作步骤与截图位
- chore(release): 0.2.2
- chore(verify): 接入可移植性验证与统一发布脚本
- chore(release): 0.2.1
- chore(release): 版本纪律工具链（release.mjs / RELEASE.md / CHANGELOG）+ 补 dsh.engines.dsh
- DSH 0.1.5-rc.1 对齐：devDeps 升级 + 客户端类型改由 cordis/renderer 提供
- release: bump to 0.2.0 (session extraction) + update description/keywords
- dedupe panel: drop custom/mirror duplicates of higher-priority roots
- add per-user mirror dir to the panel scanner (Obsidian skill library)
- portability: resolve agent skill root per-user, drop hardcoded user paths
- semantics: agent root is the mandatory default store; mirror is optional
- dual-write accepted skills to agent loadable root + Obsidian mirror
- move extraction candidates card to the top of the Skill 工作台 panel
- rename settings panel display label to Skill 工作台
- merge skill extraction into dsh-skill-studio
- chore: bump version to 0.1.2 (schema validation fix)
- test: boot simulation, scanner and read-write coverage
- docs: add Chinese README
- docs: add English README
- chore: add cordis bundle patch row
- chore: add pnpm lockfile
- chore: add package.json manifest with dsh bundle/client metadata
- chore: add .gitignore and MIT license

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1 || ^0.2.0-rc.2

### 易用性

- **Esc 不再误关整个设置层**：编辑中有未保存修改时，在捕获阶段拦住 Escape，先问一句，并阻止事件传到宿主设置面板。若设置层仍被关掉（点关闭等），会把未保存内容存成草稿，下次打开同一技能时提示是否恢复
- **编辑中返回或关闭前会先确认**：有没保存的修改时，点返回、Esc 或重新加载会先问一句；关标签或刷新由浏览器提示。保存成功后不会再拦
- **筛选后没有结果时不再留下空白**：提示「没有符合条件的技能。」，并可以一键「清除筛选」（搜索、来源、启用、分类一起清掉）
- **常用快捷键**：编辑时 Ctrl/Cmd+S 保存、Esc 返回列表；列表里按 `/` 聚焦搜索，Esc 清空搜索
- **可以导出单个技能**：打成 `.tar.gz`，目录技能会带上附属文件。默认写到 `~/.dsh/dsh-studio/exports/`，面板编辑页有「导出」按钮
- **保存时如果磁盘上的文件已经改过，会先拦住**：提示重新加载或覆盖，并列出和磁盘内容的差别，避免把别人刚改的内容盖掉
- **列表出错不再像一直在加载**：读失败时显示原因，并提示点「刷新」再试
- **搜索也能搜标签和「何时使用」**
- **正在提取时再点一次会明确提示**「正在提取，请稍后再点」，不会叠跑两轮
- 定时备份失败会把原因记在配置里，设置页直接显示「上次定时备份失败：…」

### 性能

- **扫描缓存不再保存全文**：`scanSkills` 默认只返回名称、说明、分组等摘要，打开技能时再读 `SKILL.md`。列表在技能很多时少占内存、少做复制。借鉴 [hermes-agent skills_list / skill_view](https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py) 与 [dexter metadata cache](https://github.com/virattt/dexter/blob/7419deb7/src/skills/registry.ts)

### 工程

- **`lib/index.js` 拆开了**：原来 2800 行，现在只留装配（约 560 行），技能读写、`skillmgr_*` 工具、路由、提取接口各自成文件。纯搬运，对外导出不变
- **面板有源码了**：`src/client/` 下每个面板一个文件，`lib/client.js` 由 `npm run build:client` 生成，内容与之前逐字节一致（只有区域注释行不同）。直接改 `lib/client.js` 而没改源码会被 `tests/client-build.test.mjs` 拦下
- **测试不用再手工登记**：`npm test` 改用 `node --test`，自动跑 `tests/` 下所有 `*.test.mjs`，一次报出全部失败
- 客户端自检脚本 `scripts/check-client.mjs` 不再把 CSS 类名 `dshs-stat` 误报成未定义变量
- **`install-path-guard` 测试在 Windows 上不再需要管理员权限**：目录链接改用 junction（`symlinkSync(..., 'junction')`），非提权 shell 与 CI runner 都能跑；对 `lstat().isSymbolicLink()` / `readlink()` 的判定与 symlink 一致，路径逃逸的断言强度不变

### 稳定性

- **提取失败后不再每分钟重试**：定时提取出错（模型超时、报错、返回解析不了）时按连续失败次数等待，5 分钟起、每次翻倍、最长 6 小时，成功一次就恢复。以前失败不记时间，下一分钟又会把 7 天内的会话全部解压、再发一次大请求
- **没有会话可提取时也会记下运行时间**，不再每分钟重扫一遍会话目录
- **每轮判定的准入条件改对了**：以前要求五条全部满足，其中一条是「用户明确要求记住」，而这类话在到模型之前就被单独处理了，等于几乎总是判「不值得」。现在是四条通用条件全部满足，或用户点名要求，二者有一即可
- **判定失败不再被当成「不值得」**：模型没答上来（超时、空内容）会在日志里写明原因；判定的输出上限从 16 提到 512，避免推理模型还没给出答案就用完额度
- **停用或重载插件时会收干净**：断开所有 MCP 连接（包括子进程），清掉定时备份和预热的定时器。总开关关闭时也不再跑定时备份
- **排查用的模型原始输出不再互相覆盖**：提取、归属判断、合并各写一份（`last-llm-raw.txt` / `last-llm-raw-placement.txt` / `last-llm-raw-merge.txt`），每轮的 YES/NO 判定不落盘
- **干净安装不再被 pnpm 10+ 拦住**：打进 tarball 的 package.json 会去掉 `preinstall`/`install`/`postinstall`（仓库里的安装路径守卫仍保留，只在本仓库 `pnpm install` 时跑）。避免 `ERR_PNPM_IGNORED_BUILDS`。`verify:quick --dsh` 在 PATH 没有 pnpm 时给出说明，而不是只回一句安装失败
- **定时备份失败会打到 stderr**：`runScheduledBackup` 失败时写出 `[dsh-studio] 定时备份失败：…`，不再只靠 `ctx.logger?.warn?`（Cordis 默认 logger 只进内存 buffer，隔离实例的标准流里看不到）
- **`verify:quick` 在 PATH 上没有 dsh 时不再 exit 1**：跳过安装/启动/健康检查并给出说明，静态打包检查照常；装好 DSH CLI 或用 `--dsh <路径>` 后再跑这一段
- **保存技能改为原子写入**：先写同目录临时文件再改名，避免写到一半留下半份 `SKILL.md`。Windows 上对 `EPERM`/`EEXIST` 做短回退重试（借鉴 write-file-atomic / graceful-fs）
- **保存时检查 frontmatter 的 name**：缺 name、格式不对、或和技能名不一致时拒绝保存，原文件不动
- **回收站不再误伤技能根**：根目录上的单个 `.md` 只搬走该文件；禁止把整个技能根扔进回收站。项目级技能写入 manifest 的 `root`，恢复时按当前扫描根或记下的根校验（以前只认 `~/.dsh/skills` 与 `~/.agents/skills`，项目技能恢复会失败）
- 提取入库（`writeSkill`）和提取配置保存也改为同一套原子写入

### 文案

- 面板说明、设置提示、错误信息和 README 改为更短、口语的写法；合并、MCP、快照等细节移到「进阶 / 附录」。行为不变

### 界面

- 面板轻量美化：系统字体、筛选芯片/行 hover 与 focus-visible、主按钮与标题 SVG 标记。无新框架、无动画库、无持续动画、无模糊/重阴影、无外链字体或 CDN、不增加轮询。`lib/client.js` gzip +4.8%（阈值 20%），headless 空闲 60s CPU 未升高

### 文档

- 新增 `CONTRIBUTING.md`（测试 / 守卫 / 发布约定）
- README 补充「已知限制 / Known limitations」
- README（中英）安装步骤补 **`zstd` 是自动提取的硬前提**：DSH 会话日志是 `session.v4.jsonl.zstd`，缺 `zstd` 时既读不到会话也不报错，表现为「永远提取不出东西」；「已知限制」里关于面板源码的说法同步改成 `src/client/`

### 稳定性 / 性能（续）

- **跨进程文件锁**：`withFileLock` 在进程内队列之外，再对 `<file>.lock` 做 `wx` 原子锁（僵死 PID / 超时可回收）。借鉴 babysitter / cairn / gossipcat 的零依赖锁写法
- **默认扫描根收窄**：出厂只扫 DSH + `~/.agents`（及项目级）；其它 Agent（claude/cursor/…）需 `DSH_STUDIO_SCAN_ALL_AGENTS=1` 或设置对应 `DSH_*_HOME` 才加入，减少家目录无谓 stat

### 稳定性 / 性能

- 写路径（save / policy / 回收站 / 快照恢复）显式 `invalidateScanCache()`，避免同秒内读到旧正文（借鉴 agent-skill-manager mutation 后重扫、hermes-agent skills 缓存失效）
- MCP 工具刷新、registry 摘要预热失败改为 `logger.warn`，不再空吞
- 快照用户可见错误改为 `UserError` / `notFound`（与路由 4xx/500 分级一致）

### 文档

- README 中英增加「五分钟上手 / 5-minute start」：先浏览编辑、默认关掉 autoAccept 风险说明
- `RELEASE.md` 非历史段落的旧包名 / `README.zh.md` 改为现行口径

### 安全 / 工程化

- **安装路径守卫**：`scripts/lib/install-path-guard.mjs` + `preinstall` / `npm run guard:install`。若 `node_modules` 或 `node_modules/@deepseek-ai`（及其包入口）是指向仓库外的 junction/symlink，直接拒绝安装——防止再现 ALEXWORK 上 pnpm 顺着 junction 写坏 DSH 安装目录的事故
- **Windows 下稳健解析 npm**：`scripts/lib/resolve-npm.mjs`；`portability.mjs` / `release.mjs` 用 `process.execPath` + `npm-cli.js`（或 `npm_execpath`）调用 npm，不再 `spawnSync('npm')`（修复 verify:quick 的 `spawnSync npm ENOENT`）
- 一次性补丁脚本迁到 `scripts/archive/`（`add-remember-*` / `remember-*`），避免和新手工具混在一起
- `dsh.client.inject` 去掉已退役的 `@deepseek-ai/dsh-client-runtime`（与 RELEASE.md 口径一致）

### 稳定性

- HTTP `handle()` 区分 `UserError`（4xx）与内部错误（500 + `logger.error`）；回收站等用户可见抛错改为 `UserError` / `notFound`
- 定时备份失败不再空吞，改为 `logger.warn`

本批（此前）：快照打包改流式、扫描器加缓存与并发、提取器按 mtime 选文件，并修掉一批在 Windows 上必红的测试。


### 变更

- **快照打包改为流式**：`createSnapshot` 不再把整包缓冲在内存里，改为边写边 gzip；落盘先写临时文件再重命名，失败不留半成品
- **扫描器加扫描缓存与 32 并发**：重复扫描命中缓存，目录遍历按 32 路上限并发
- **提取器按 mtime 选文件**：候选会话日志按修改时间挑选，不再按目录序取到旧文件

### 测试

- 三个 fixture（`import-lock-home` / `state-race-home` / `pull-home`）调用 `tar` 时改用 `cwd` + 相对路径：Windows 的 bsdtar 会把 `C:\...` 当 host:path 解析，Linux 行为不变
- N-12 峰值内存测试的「旧版必须 > 100 MB」绝对阈值改为与机器无关的判断：只校验新/旧比值 ≤ 1/3，旧版绝对值只做记录
- N-12「超硬上限」场景在 Linux/macOS 上记为跳过：>4096 字节的相对路径必然让绝对路径超过 PATH_MAX，文件本身就建不出来；Windows 上照常验证

### 修复

- **Linux/macOS 上强制删除目录会失败**：`removeDirForcibly` 清只读位时把目录也 chmod 成 `0o666`，抹掉了 x 位，目录随即无法进入、`rm` 反而报 EACCES（回收站清理、快照/MCP 目录清理受影响）。现在只补属主可写位（目录再补可进入位），其余权限位保留；Windows 只认只读位，行为不变
- `skillmgr_extract_config` 工具说明里 `autoAccept` 写成「默认关」，与代码默认 `true` 不符，改为「默认开」

### 工程化

- 新增 GitHub Actions CI（`.github/workflows/ci.yml`）：windows-latest + ubuntu-latest × Node 22 / 24，跑 `npm test` 与 `release.mjs --check`，并校验测试没有在 runner 真实 HOME 下写出 `.dsh` / `.agents`；只读权限，不发布、不打 tag
- `pnpm-lock.yaml` 的 importer specifier 与 `package.json` 的 peer 范围（新增 `^0.2.0-rc.2`）对齐，解析出的版本不变；CI 用 `--frozen-lockfile` 安装
- 版本与发布面对齐：README 徽章改为直接读 `package.json` 版本（不再停在 0.7.0）；`files` 里不存在的 `README.zh.md` 改为 `README.zh-CN.md`；`release.config.json` / `cordis.patch.yml` 的旧包名、旧仓库坐标改成 `dsh-studio` / `samir2015dzh/dsh-studio`
- `npm run release` 默认带 `--skip-npm`：npm 上的 `dsh-studio` 包名属于别人，本插件走 GitHub 分发；发布流程写进 `RELEASE.md` §12

### 文档

- README（中英）配置示例改成真实出厂默认值：`intervalMinutes` 60 → `1440`，`skillLanguage` `"auto"` → `"zh"`，并注明 `agentSkillDir` 的默认路径

## [1.0.1] - 2026-11-07

补丁版。修掉三个工具的「返回体与注册 output schema 脱节、被宿主整包拒收」缺陷，并把这类
检查变成常驻回归，防止同类问题再次溜进发版。

### 修复

- **`skillmgr_quality` 此前在宿主里不可用**：返回体带 `history` 字段而注册 schema 未声明，
  宿主按 `additionalProperties: false` 整包打回，连 summary 都出不来。逐键核对返回体后补齐
  唯一缺失的 `history` 声明
- **`skillmgr_get` 查询不存在的技能**：handler 返回 `skill: null`，而 schema 只允许对象，
  同样整包打回。改为查不到时省略该键——渲染侧本来就有「skill 不存在」分支，不影响输出
- **`skillmgr_snapshot_restore` 此前每一次调用都被宿主拒收，现已修复**。两处脱节：①
  `preSnapshot` 在拍前置快照失败时可为 `null`，schema 只允许 string，已改为
  `oneOf: [string, null]`（宿主的 `@deepseek-ai/dsh-tools` 明确拒绝 type 数组，也不认
  `anyOf`，`oneOf` 是其支持子集里的唯一等价写法）；②返回体恒带 `pendingPulls` 而 schema
  未声明，`dry-run` 与真恢复都会被整包打回。两处补齐后恢复工具恢复正常
- 以上改动只落在 schema 与 handler 的返回形状上：`snapshot.js` 的返回体、Web 路由与面板的
  消费代码一行未动

### 测试

- **新增常驻回归：全部 27 个工具经注册层真实调用 + 宿主校验**。测试从注册表取出每个工具的
  schema，跑 handler 后把真实返回体交给宿主自身的 `validateJsonSchemaValue` 校验，
  **0 豁免、0 违规**，没有静默跳过。写类工具各走自己的最小场景（建快照 → dry-run → 真恢复、
  trash → restore → trash → purge、快照导出导入、候选接受/拒绝），git 同步用伪 HOME 里的
  bare 仓库当远端，MCP 三件套用 mock stdio 对端真连，LLM 用内存假 provider，全程离线、
  全程 `mkdtemp` 伪 HOME
- 27 个 schema 另过一遍 `assertSupportedJsonSchema`，确认每个都落在宿主支持的子集内

## [1.0.0] - 2026-11-07

首个稳定版。0.8.0 之后的一整轮改进计划全部落地：安全、自动进化、跨机迁移、上游检查、
质量度量、导入来源、测试七条线，工具集与数据格式按此版本定稿。

### 安全加固

- **快照字段级脱敏**：打包时把凭据文件里的敏感字段（token / secretKey / password 等）值换成
  `__dsh_studio_redacted__` 占位符，命中清单写进包内 `REDACTED.json`；JSON 解析失败的文件整份
  排除并同样记录。**恢复时占位符绝不写回**——目标机该字段已有值时保留本机现值，没有才落空，
  所以快照推到 git / gist / s3 也不会把别处凭据带过来
- **凭据只在构造处出现一次**：面板 state、HTTP JSON、工具返回值、日志一律只拿掩码（中间打点 +
  尾 4 位），明文只走单个回环路由；敏感键名收敛到 `lib/redact.js` 一处，快照、MCP、工具三处共用同一份
- **MCP 路由回环与同源守卫**：所有 MCP 写路由统一校验来源为回环地址 + 同源 Origin，
  跨站页面构造的请求不再能改注册表
- **敏感文件 0600 落盘**：`sync.json`、`mcp.json`、`skill-lifecycle.json`、provenance 文件、
  `last-llm-raw.txt` 以及恢复写盘的凭据文件统一 0600 并走 `hardenPermissions()`
- **运行期信息掩码**：中间态里的凭据值同样只以掩码出现——同步通道配置视图、MCP 服务器条目描述、
  工具渲染文案都走 `maskSecret()`，日志与返回值里不留原文

### 技能自动进化修复

- **frontmatter 原地改写**：合并与优化改写 `SKILL.md` 时保留原 frontmatter，用户手写的
  `disable-model-invocation`、`user-invocable`、`protected`、`metadata.*` 不再被整份覆盖；
  索引补解析 `group` / `tags`
- **Darwin 触发条件收窄**：只在写类工具（write / edit / apply_patch / write_file / multi_edit）
  真正改动 SKILL.md 时记 pending，读操作与无关写入不再触发；范围限两棵 skill 根
  （`~/.agents/skills`、`~/.dsh/skills`）
- **Darwin 总开关**：`enabled` 默认开，关掉即不注入任何提示；加载 darwin-skill 后静默 15 分钟
  防自激，pending 6 小时过期，24 小时巡检一次、每次最多 5 条
- **评测硬性两条**：① 评估前先建/查同目录 `test-prompts.json`，没有就先生成 2–3 条能验证该
  skill 的测试提示词再打分；② keep/revert 只认 paired 多数决（同一 judge 成对比较 + 奇数 N
  多数票），绝对分有 ±8 噪音，只用来排序、不当判据
- **闭环补全**：待办项处理后能回收结果，配对判据与「本体缺失」告警都给出明确状态，不再静默丢结果
- **autoAccept 默认开启**：提取候选默认直接落库，不必每次点确认
- **优化路径去掉确认门**：记住/优化类请求先本地分类，能判定唯一类别就直接落位
  （含整行命令切分、只读感知删除、no-op 快路），不再先问一遍
- **候选保留分组**：提取候选带 `group` 并按 8 类校验，落库后不再全部堆进「未分组」

### 快照瘦身与跨机迁移

- **大 skill 只记链接**：skill 体积超过阈值且来源可确定时，快照只记仓库链接（含子目录来源）到
  `EXTERNAL_SKILLS.json`，不再把内容打进包
- **恢复只出清单、不替你联网**：恢复后生成 `PENDING_PULLS.json`，列出「只记了链接」的那些 skill，
  恢复端自己决定何时拉
- **一键拉取**：新增工具 `skillmgr_pull_pending`，消费清单逐条拉取并写回 lock；逐条独立成败，
  已存在且内容一致的记 `satisfied` 跳过，同名但内容不一致的记 `conflict` 且不覆盖
- **大文件跳过清单**：skill 根下的超大文件（GIF / PNG 之类）不进包，改记进 `SKIPPED.json` 并写明
  原因；`.git` / `.svn` / `.hg` 直接跳过、不占清单
- **恢复落点跟随配置**：快照白名单与恢复落点都取 `agentSkillDir`，改过 skill 根也不再漏备主库
- **计数口径统一**：`countFiles` 与 `collectFiles` 对跳过项按同一口径计数，manifest 里的数字不再
  自相矛盾

### 上游更新检查

- **新增 `skillmgr_update_check`**：只读比对已装 skill 与其来源仓库的最新提交，双口径计数——
  「已查」是本次真正比过的条数，「全库」是锁文件里的全部条数，两者分别报，不混成一个百分比
- **每轮最多联网 3 次**：`ls-remote` 一轮对话上限 3 次，超出静默跳过、不报错；结果缓存 10 分钟，
  缓存命中不计次
- **Darwin 优化前先看上游**：有新版就在评测提示里点出来，避免白改一遍
- **下载退避**：codeload 拉包对网络类错误退避重试 2 次，4xx 直接失败不重试
- **lock 短路更严**：同 ref 同内容跳过的前提是目标目录真实存在，删掉目录后不会再假跳过

### 提取质量指标与数据地基

- **新增 `skillmgr_quality`**：只读聚合提取漏斗、SAVE 队列的使用 / 活跃 / 归档比例、候选积压与
  历史接受 / 拒绝。分母为 0、数据缺失时报 `available:false` + 原因，比例给 `null` 而不是 0
- **裁决事件流水**：provenance 除按名覆盖的最新裁决外，另追加 append-only 的
  `provenance-events.jsonl`（一行一条 `at` / `name` / `action` / `rationale`）。漏斗改按事件计数，
  同一个名字先 SAVE 后 FOLD_INTO 的历史可以复盘；没有这份流水的旧数据自动回退「按名最新裁决」
  口径，两种口径在输出里标明
- **候选终局归档**：接受 / 拒绝的候选不再直接删掉，写进 `candidates-archive.json`（带 `decision`
  与 `decidedAt`），滚动上限 500 条、超出丢最旧；质量度量据此报历史接受 / 拒绝，无归档时报不可得
- **首次使用与使用次数**：lifecycle 补 `firstUsedAt`（首次使用，只写一次）与 `useCount`
  （每次 +1），据此给出「首次使用距入库中位数」（入库时间口径 = 同名最早一次 SAVE 事件的 `at`）
  与「平均使用次数」；老状态文件缺这两个字段时如实报不可得

### 技能导入与来源锁

- **从仓库导入**：支持 `https://github.com/<owner>/<repo>[/tree/<ref>[/<subPath>]]` 与本地
  `.tar.gz`，按子目录收窄后取 SKILL.md，导入完成写 `~/.dsh/dsh-studio/skill-lock.json`
- **来源锁结构化**：lock 记录 `source`（仓库根）/ `ref` / `subPath` / `sha256` / `at`，子目录不再是
  拼在 URL 里的字符串；旧记录里的 tree URL 读侧照样能归一
- **跳过判据**：同 ref、内容 sha256 相同、且目标目录确实存在时才跳过，否则重装并更新 lock

### 测试现代化

- **六套测试串联**：`npm test` = darwin / boot / upstream / skillsrc / quality / pull，
  任一失败即整体非 0 退出
- **boot 套件按平铺视图重写**：分组视图折叠态的场景改为平铺口径断言（headers 0 / rows 3），
  工具数 24、路由数 32 与现状对齐；`ctx` 桩补 `on`，路径断言按分隔符比对
- **临时 HOME 隔离**：boot 全程在 `mkdtemp` 出的临时 HOME 下跑，预热轮询不再写真实
  `registry-cache.json`；quality / pull 各自带伪 HOME fixture，真机路径只读

## [0.8.0] - 2026-11-05

### 改进（2026-11-06 补记）

- **目录段只给工具名**：MCP 目录从「工具名 + 截断描述」改成只列名字，craft-anything
  那种大服务器实测 75,918 → 4,878 字符（≈19K → 1.35K token）。名字足够判断该不该
  load，描述等 `mcp_load` 再取
- **`mcp_load` 缓存优先**：默认用内存缓存，换 `filter` / `limit` 不再重连重拉；
  新增 `refresh: true` 显式刷新。缓存为空时仍然自动连
- **`mcp_call` 支持批量**：`calls: [{tool, args}, ...]` 按顺序执行，某个失败不中断后面的；
  单个仍用 `tool` + `args`。工具之间没有依赖时用它省往返
- **用法段纠正**：`mcp_call` 直接执行即可，不需要先 `mcp_load`

### 修复（2026-11-06 补记）

- **状态点在自建条目上恒灰**：studio 自己建的条目（没有原生 `cordis.patch.yml` 行）
  也按「已接管」显示为绿，不再永远灰着
- **状态文案分四态**：停用档显示「已停用（不连接）」，不再冒充「空闲（未连接）」
- **「未连接」只数 `status === "idle"`**：连接错误单独一档，没有错误时不占位
- **筛选按 status 精确匹配**：点「未连接」不再把已停用和出错的服务器一起翻出来
- **reclaim 时清旧 error**：切档位后不再永久卡在「连接错误」
- **面板删除改二次确认**：点一下变「确认删除」（4 秒后自动恢复），提示会一并丢掉
  备注、工具白名单和空闲阈值
- **工具列表跟随各自卡片**：不再堆在整个列表末尾，展开哪个服务器的工具就贴在哪个卡片下面

### 新增

- **配置快照**：把 `~/.dsh` 的配置按白名单打成 tar.gz 存到
  `~/.dsh/dsh-studio/snapshots/<时间戳>-<标签>/`，附 `manifest.json`（每个文件的相对路径、
  SHA-256、字节数）。白名单收 `cordis.patch.yml`、`AGENTS.md`、`skills/`、`dsh-studio/`、
  各 profile 的 `package.json` 与 `cordis.patch.yml`，实测 248 个文件 3.6 MB → 1.2 MB。
  密钥（`.credentials.yaml`、`sync.json`）、会话日志（`sessions/`）、`node_modules/`、
  `sync-work/` 一律跳过
- **恢复**：`dryRun` 逐文件比 SHA 报 create / overwrite / same，真恢复前自动打一份
  `pre-restore` 快照，恢复后可回退
- **导出 / 导入**：tar.gz 往返，导出的包在另一台机器上导入后 SHA 全部一致
- **跨机路径重映射**：`restoreSnapshot` 收 `pathMap: [{from, to}]`，写盘前替换文本里的绝对
  路径前缀；JSON 里的转义写法（`C:\\Users\\a`）与纯文本原样写法都处理，二进制文件按
  `isProbablyText` 判定后跳过
- **定时备份**：`~/.dsh/dsh-studio/snapshot.json` 存 `{ enabled, intervalHours, keep }`，
  插件每 30 分钟问一次「该不该跑」，到点建 `scheduled` 快照并按 `keep` 清理旧的那几份；
  清理只动 `scheduled` 标签，不碰手动备份
- **四条同步通道**：Git（init + remote add + fetch + checkout，支持空仓库）、
  Gist（GitHub Gist API，tar.gz 走 base64，超大回退 `raw_url`）、
  WebDAV（PUT/GET + 可选 Basic auth）、S3（手写 SigV4，path-style，PUT/GET）。
  配置在 `~/.dsh/dsh-studio/sync.json`，凭据不进快照
- **设置页「配置快照」**（order 302）：统计条、立即备份、保留最近 N 份、导出/导入、
  逐行预览与恢复、定时备份开关、同步通道胶囊与推送/拉取
- 4 条新路由：`/snapshot`、`/snapshot/restore`、`/snapshot/prune`、`/snapshot/transfer`、
  `/snapshot/schedule`、`/sync`、`/sync/push`、`/sync/pull`
- 4 个新工具：`skillmgr_snapshot`、`skillmgr_snapshot_list`、`skillmgr_snapshot_restore`、
  `skillmgr_snapshot_transfer`、`skillmgr_sync`

### 修复

- MCP 注册表瘦身：工具缓存落盘只留 `name` + 截断描述（200 字），完整 `inputSchema` 不再写进
  `mcp.json`。此前 `warmCatalog` / `prefetchTools` / `mcp_register` / `mcp_load` 都把
  `listTools()` 的原始返回整体 upsert，229 个 REA 工具能把注册表撑到 10.4 MB，等于每次面板
  操作都解析一遍 10 MB JSON（实测 28 ms/次）。实测压缩后 10.42 MB → 0.07 MB，工具数不变
- 启动时若注册表超过 2 MB，`warmCatalog` 顺手压一次（兼容旧版本写进去的胖缓存）
- eager 档改为以活连接为数据源：`buildEagerTools` 用 `runtime.cachedTools()` 判空而不是
  `visibleTools()`，否则注册表里的瘦缓存一旦非空就不会去连，`inputSchema` 缺失导致 eager
  工具参数全部退化成 `{}`；同理 `warmCatalog` 不再把瘦缓存塞进 `runtime.slot`
- `skillmgr_list` 补回 `dir` 字段：`fsToSummary()` 从 0.7.0 起带上技能目录，但输出 schema 的
  `items` 是 `additionalProperties: false` 且没声明 `dir`，宿主校验直接判整个调用失败
  （`value.skills[0].dir is not a declared property`），插件最常用的列表工具全线不可用
- 定时备份的保留策略原本调 `pruneSnapshots`，它按时间排「全部」快照，把手动建的那几份也算进
  「保留 N 份」里 —— 实测手动快照被删。改为 `pruneScheduled`，只对 `label === "scheduled"`
  排序清理
- 快照 id 原本精确到秒，同一秒内连建两份会撞 id，后一份直接覆盖前一份。`stamp()` 补毫秒
- 白名单 `dsh-studio/` 原本只跳过 `snapshots`，漏了 `sync.json`（gist token / s3 secretKey
  明文，一进快照等于导出即泄露）与 `sync-work/`（git 工作副本含 `.git`）
- Git 通道原本用 `git clone --depth 1`，对空仓库（bare 但无 commit）clone 出来没有 HEAD，
  之后的 `git pull --ff-only` 报 "no tracking information"。改为 init → remote add → fetch →
  有分支才 checkout，空仓库停在未跟踪状态等首次 `push -u`

## [0.7.0] - 2026-11-04

### 改名

- 包名 `dsh-skill-studio` → `dsh-studio`，GitHub 仓库同改。API 路径 `/api/dsh-studio/*`，
  数据目录 `~/.dsh/dsh-studio`，客户端模块 id 与日志前缀一并更新；工具名 `skillmgr_*` 保持不变

### 新增

- **技能工作台三层筛选**：来源（全部 / 用户 / 内置）、启用状态（已启用 / 已停用）、
  用途分类（逆向分析 / 安全测试 / 代码工程 / 文档写作 / 环境运维 / 数据检索 / 流程协作 / 其他），
  三者是「与」的关系；状态与分类组再点一次已选中的胶囊即取消
- **回收站**：技能行右侧「删除」把目录移进 `~/.dsh/dsh-studio/trash/<时间戳>-<名>/`，
  面板「回收站」页可整批或单项恢复、永久删除；跨盘 rename 失败自动退 copy + rm
- **按用途自动分类**：会话提取时模型必须从固定 8 类里选一个写进 `metadata.group`；
  合并旧 skill 时保留原分类。`scripts/classify-skills.mjs` 可按关键词把存量技能批量归类
  （`--write` 写入，每个文件先备 `.bak-group`）
- **多来源扫描**：除 DSH 与公共 Agent 目录外，补上 Codex / Claude / Cursor / Gemini /
  Windsurf / Trae / Qoder / Lingma / OpenCode / Copilot / Roo / CodeBuddy / WorkBuddy /
  OpenClaw / CC-Switch 等 15 个 Agent 的技能根，目录存在才扫描
- **技能诊断**：frontmatter 的 `name` 不是 kebab-case 时标「宿主不认这个名」（这类技能
  面板看得见、宿主加载不了）；跨来源同名时标出「被 X 盖住」与「盖住 N 个」
- **分页**：每页 6 条，底部居中翻页条，中间的页码可点开输入后回车跳转
- **MCP 面板对齐**：工具栏加服务器搜索、档位筛选（全部 / 启用 / 按需 / 停用）与
  状态筛选（已连接 / 未连接），筛选无结果时给提示
- **MCP 凭据掩码**：`authorization` / `api_key` / `token` / `secret` / `password` / `cookie`
  这类头与环境变量默认显示为 `••••••••` + 尾 4 位，点「显示」看明文、点「复制」写剪贴板；
  非凭据类环境变量（`GHIDRA_INSTALL_DIR`、`PATH` 等）不进面板，避免行卡被撑长

### 改进

- `listSkills` 用磁盘缓存 + 后台刷新 + 启动预热，不再每次请求都阻塞在 `ctx.skills.list()`
  （此前打开面板要等 4–5 秒）
- 26 处写死的中性灰 `rgba(128,128,128,a)` 换成 `color-mix(in srgb, currentColor N%, transparent)`，
  边框与底色跟随深色 / 浅色主题
- 胶囊、tab、组名标签都加 `userSelect: none`，点击时不再选中文字

### 修复

- 启动自动导入漏扫 `DSH_HOME/cordis.patch.yml`（全局层）：只扫了 profile 与 bundle 两层，
  写在这个文件里的 MCP（例如 rea）在 `mcp_list` 里看不到。现在三层都扫
- `parseMcpRows()` 丢失块式 `args`：`args:` 换行后一行一个 `- 元素` 的写法整段没被收，
  导入的条目 `args` 恒为 `[]`，按需加载时会用空参数起进程（rea 少 `mcp`、metis-reverse 少
  `mcp --transport stdio`）。现在块式与一行式都能解析
- MCP.md 与实现对齐：起始版本 0.5.1 → 0.6.0；工具数 4 → 5（补 `mcp_takeover`）；
  已知限制补「自动导入扫哪三层」与「插件自封装 MCP 不会被导入」
- 连接与列工具超时独立于工具调用超时：`McpConnection` 新增 `connectTimeoutMs`（默认 30s，
  `ensure` 里取 `min(toolCallTimeoutMs, 45s)`），握手与 `tools/list` 用它，`tools/call` 仍走
  `toolCallTimeoutMs`。此前握手沿用 900s，服务器起不来时面板会冻住十几分钟
- 面板忙状态按服务器隔离：`busy` 改为 `busyKey`（记录正在操作的服务器名），档位胶囊与
  重载 / 接管 / 删除按钮、工具过滤只在自己那台忙时禁用，一台连不上不再锁住整个面板


## [0.6.0] - 2026-11-02

### 新增

- MCP 按需加载（`lib/mcp.js`、`lib/mcp-client.js`）：三档（启用 / 按需启用 / 停用），
  目录只暴露服务器名与截断描述，完整 schema 由 `mcp_load` 现取，调用走 `mcp_call`
- 零依赖 MCP 客户端：stdio 按行 JSON-RPC、streamable-http 支持 JSON 与 SSE 两种响应
- 空闲回收：超过 `idleTimeoutMinutes`（默认 5，`0` 关闭）没有工具调用就断开上游，
  工具缓存与注册表保留，下次调用透明重连
- 工具白名单：每台服务器可设 `toolFilter`（`all` / `allow` / `deny` + 名单），
  目录与 `mcp_call` 入口同时生效
- 自动导入：启动时扫 profile 与各 bundle 的 `cordis.patch.yml`，把
  `@deepseek-ai/dsh-mcp-client` 条目抄进注册表（停用档）；「接管」才会禁用原生条目
- 设置页新增独立一页「MCP 服务器」（`settings.section`，order 301）：统计条、
  状态点（绿=已接管 / 灰=未接管）、档位胶囊、工具清单勾选

### 变更

- Skill 工作台重做成与 MCP 面板同一套语言：统计条、统一行卡、单行省略描述，
  会话提取设置折叠为一行
- 会话提取表单按「开关 / 调度 / 输出位置 / 模型」四组重排

### 修复

- `savePendingRemember()` 写 `pending-remember.json` 前补 `mkdir(dirname(...), { recursive: true })`：目标目录 `~/.dsh/dsh-studio` 不存在时，首次「记住」会静默失败
- `extractIfDue()` 调用点移除恒为 `false` 的 `forceReview` 实参（`remember` 分支已提前 return，实参永远取不到 `true`）
- 0.5.1 段落修复文字损坏：`Remember` 缺首字母、反引号丢失；`forceReview` 的 `f` 变成控制字符 U+000C（`\f` 转义），`runExtraction()` 的 `r` 被当成回车吃掉 —— 说明写 CHANGELOG 的环节做过一次 C 风格转义
- `!!js "'…' + process.env.PATH"` 这类动态 env 现在拆出字面量前缀存 `envPrefix`，
  连接时拼到父进程同名变量前，不再整条跳过
- 块式 `headers` 的子项以前被当成无关行丢弃（memory-bank 因此 401），现在按缩进收进对象
- Node 的 happy-eyeballs 会让 fetch 先试不通的 IPv6 再超时，钉成 `ipv4first`

## [0.5.1] - 2026-11-01

### 新增

- Remember 通道：用户说「记住 X」时，判定直接放行（只认 `- 用户：` 行，助手的话不算）
- 命中后不静默生成，下一轮 system-prompt 注入确认请求，主动问用户落点
- 按类型分流：方法→skill、偏好→AGENTS.md、事实→记忆库；类型明确的直接落位不问

### 变更

- shouldExtract() 返回 { worth, remember, rememberText }，调用链全程透传
- runExtraction() 新增 forceReview，可绕过 autoAccept
- 摘要窗口 10 → 20 条
- 提取 prompt 增加「用户明确要求记住的内容」为第一优先级


## [0.5.0] - 2026-10-29

### 新增

- 并入独立插件 `dsh-darwin-auto`：写入 SKILL.md 后自动把 `darwin-skill` 推到模型面前，按 9 维 rubric 体检（`lib/darwin.js`）
- 同族去重：按 `~/.dsh/darwin-auto/families.json` 把同族重复 skill 折叠到宿主，成员不再重复送审；表缺失时行为与旧版一致
- 借插件已有的 `llm` 服务自动生成族谱（`familyRefreshDays` 控制过期天数，0 关闭），不再依赖模型手工维护

### 变更

- 状态文件沿用 `~/.dsh/darwin-auto/state.json`，`seen` / `scores` 无缝继承，不会全量重扫
- 配置入口搬到 `cordis.patch.yml` 的 `config.darwin` 段
- `tests/boot.test.mjs` 改用 `pathToFileURL`，修掉 Windows 上动态 import 裸盘符路径的报错

### 移除

- profile 里的 `dsh-darwin-auto` 依赖与 bundle 条目；源目录保留作回滚点

## [0.4.0] - 2026-10-24

### 新增

- 每轮对话结束先做 YES/NO 判定（小 prompt），值得才跑完整提取；判定 90 秒节流、提取 5 分钟节流
- 提取结果自动写入 `~/.agents/skills`（`autoAccept`），写入失败才进候选队列
- 语义合并四道闸：墓碑拦截、类别标签、`FOLD_INTO` 本地复核、合并卫生
- 面板新增「最近添加的 skills」列表（名字 + 描述 + 时间）与模型下拉
- 提取输出被截断时逐个抢救完整候选（`salvageCandidates`）

### 变更

- 模型调用改走 `ctx.llm.prepareCall()`，插件不再保存 API key；`llmBaseUrl` / `llmApiKey` / `llmModel` 降级为 HTTP 回退
- 面板移除网关地址与密钥输入框，`intervalMinutes` 标注为「兜底」
- `skillLanguage` 新增 `auto`（跟随会话），三种模式都明确代码与命令不翻译
- 合并结果自动去重复章节、切 `MERGE:` 协议残渣、拦截短正文覆盖
- 提取 `maxTokens` 4000 → 8000，prompt 限制正文 600–800 字

### 移除

- `README.zh.md`（并入 `README.zh-CN.md`）


## [0.3.1] - 2026-09-29

### 兼容性

- 声明兼容 **DSH 0.2.0-rc.2**：`peerDependencies` 中官方 DSH 包的版本范围追加 `^0.2.0-rc.2`。功能与行为无变化，仅解除新版 DSH 下的兼容告警。


<!-- 下一版内容从这里开始累积；发布时把本行下方的内容整段搬到新版本段落，保留本标题 -->

## [0.3.0] - 2026-09-27

### 新增 (Added)

- **skill 分组展示（第一期，只读）**：读取 SKILL.md frontmatter 的 `metadata.group` / `metadata.tags`（DSH 官方支持的 `metadata` 载体），Web 面板「Skill 工作台」按分组折叠展示，带筛选框、「按分组 / 平铺」视图切换与未分组区；`skillmgr_list` / `skillmgr_get` 输出新增 `group` / `tags` 字段。**纯展示层，不改变模型加载哪些 skill**。
- `lib/scanner.js` 的 frontmatter 解析器支持**一层嵌套对象**（此前 `metadata:` 的缩进子键会被直接丢弃），并支持内联数组 `[a, b]` 与 `- item` 块列表；解析仍为零依赖、行级。
- 测试新增：嵌套 frontmatter 解析（含 dedent 后继续解析顶层键）、扫描器与详情的分组字段、面板分组渲染冒烟（fake React 驱动真实客户端组件：分组视图 / 平铺视图 / 折叠态）。

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- 分组数据只读：面板不会写回任何 `SKILL.md`；`metadata.group` 缺失的 skill 落「未分组」区。
- 发布前可移植性验证：✅ 通过（隔离 `DSH_HOME` + tarball 安装 + 15s 稳定性观察）

## [0.2.2] - 2026-09-27

### 修复 (Fixed)

- fix(mcp): 第 0 项——内建 MCP 守卫真机没拦住：`ctx.get("mcpManager")` 返回 cordis traced proxy，`.ctx` 指向调用方，守卫把本插件自己的 fiber 当成 manager，Settings 写路径一律放行（rejected 恒 0）；改为剥 proxy 认 owner fiber（再按类 / 名字兜底），真 cordis 回归测试复现并覆盖；状态多报识别方式与判定次数
- fix(mcp): 审计 1/2——mcp.json 原子写；解析失败不再静默当空注册表（改名留档 + 损坏闸 + 拒绝覆盖，回滚或所有者确认解闸）；sync.json / 凭据暂存（读-改-写套 withFileLock）/ darwin 状态同族修复：原子写，解析失败原文件保留并留档、报错，不回默认值；`*.corrupt-*` 不进快照
- fix(mcp): 审计 6——Windows 上 stdio server 的命令按 PATHEXT 解析，命中 .cmd / .bat 经 `cmd.exe /d /s /c` 起并按 cross-spawn 口径转义参数（含空格 / 引号）；spawn 阶段错误原文带进 verify 失败信息
- **会话扫描判据漏 v3/v4，约 60% 会话日志被静默跳过**：`lib/extractor.js` 此前只认字面量 `session.jsonl.zstd`，而 DSH 现网写入 `session.v3.jsonl.zstd`（0.1.5）/ `session.v4.jsonl.zstd`（0.1.7）——本机 945 个日志里 v3 501 + v4 75 被跳过（≈61%），「会话提取」候选系统性偏少且**不报错**。判据改为与核心 `@deepseek-ai/dsh-session-format` 同源的 `/^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/`，v0/v3/v4… 通吃，版本再升也不会失明。
- **桌面端最小 PATH 下 `zstd` spawn ENOENT**：Finder 启动的 Electron 宿主继承 launchd 的 `/usr/bin:/bin:/usr/sbin:/sbin`，裸调 `zstd` 会失败并被逐文件 catch 静默吞掉。改为 `resolveExecutable()` 解析绝对路径（PATH + `DSH_EXTRA_BIN_DIRS` + `/opt/homebrew/bin` / `/usr/local/bin` / `~/.local/bin`）。
- 非 `.zstd` 的裸 `.jsonl` 直接读，不再无条件过 zstd。

### 其它 (Changed)

- 接入发布前门禁：仓库新增 `scripts/portability.mjs` + `PORTABILITY-SOP.md`，`package.json` 新增 `verify` / `verify:full` / `verify:quick`（健康路由 `/api/dsh-studio/list`）；`scripts/release.mjs` 升级到 dsh-release-kit 版（`files` 覆盖检查改为布局自适应、npm 凭据认 `DSH_HOME`）。

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- DSH peer：`^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1`
- 发布前可移植性验证：✅ 通过（隔离 `DSH_HOME` + tarball 安装 + 15s 稳定性观察）

## [0.2.1] - 2026-09-11

### 修复 (Fixed)

- fix(mcp): 第 0 项——内建 MCP 守卫真机没拦住：`ctx.get("mcpManager")` 返回 cordis traced proxy，`.ctx` 指向调用方，守卫把本插件自己的 fiber 当成 manager，Settings 写路径一律放行（rejected 恒 0）；改为剥 proxy 认 owner fiber（再按类 / 名字兜底），真 cordis 回归测试复现并覆盖；状态多报识别方式与判定次数
- fix(mcp): 审计 1/2——mcp.json 原子写；解析失败不再静默当空注册表（改名留档 + 损坏闸 + 拒绝覆盖，回滚或所有者确认解闸）；sync.json / 凭据暂存（读-改-写套 withFileLock）/ darwin 状态同族修复：原子写，解析失败原文件保留并留档、报错，不回默认值；`*.corrupt-*` 不进快照
- fix(mcp): 审计 6——Windows 上 stdio server 的命令按 PATHEXT 解析，命中 .cmd / .bat 经 `cmd.exe /d /s /c` 起并按 cross-spawn 口径转义参数（含空格 / 引号）；spawn 阶段错误原文带进 verify 失败信息
- fix(release): dry-run 不再触发真实 registry 校验；CHANGELOG peer 摘要只列 dsh 包

### 其它 (Changed)

- chore(release): 版本纪律工具链（release.mjs / RELEASE.md / CHANGELOG）+ 补 dsh.engines.dsh
- DSH 0.1.5-rc.1 对齐：devDeps 升级 + 客户端类型改由 cordis/renderer 提供

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1

### 其它 (Changed)

- DSH 0.1.5-rc.1 对齐：devDependencies 升级，客户端类型改由 `cordis` / renderer 提供

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`

## [0.2.0] - 2026-08-29

### 新增 (Added)

- 合并「会话提取」能力：用 LLM 从会话日志提取候选 skill（`skillmgr_extract_*` 工具 + 面板待确认卡片）
- 接受的候选 skill 双写：写入 agent 自动加载根（`~/.agents/skills`）+ Obsidian 镜像目录
- 面板扫描支持 per-user 镜像目录（Obsidian skill 库）

### 其它 (Changed)

- 设置面板显示名改为「Skill 工作台」，提取候选卡片置顶
- 语义澄清：agent 根是必需的默认库，镜像目录是可选项
- 可移植性：按用户解析 agent skill 根，去掉硬编码用户路径
- 面板去重：高优先级根已收录时不再重复展示 custom/mirror 副本

### 兼容性 (Compatibility)

- Node：`^22.19.0 || >=24.0.0`
- 注：本版本尚未声明 `dsh.engines.dsh`（下一个版本补）

### 迁移说明 (Migration)

- 无破坏性变更：`0.1.x → 0.2.0` 为纯能力新增，原有 `skillmgr_*` 工具与面板行为不变。

## [0.1.2] - 2026-08-23

### 修复 (Fixed)

- fix(mcp): 第 0 项——内建 MCP 守卫真机没拦住：`ctx.get("mcpManager")` 返回 cordis traced proxy，`.ctx` 指向调用方，守卫把本插件自己的 fiber 当成 manager，Settings 写路径一律放行（rejected 恒 0）；改为剥 proxy 认 owner fiber（再按类 / 名字兜底），真 cordis 回归测试复现并覆盖；状态多报识别方式与判定次数
- fix(mcp): 审计 1/2——mcp.json 原子写；解析失败不再静默当空注册表（改名留档 + 损坏闸 + 拒绝覆盖，回滚或所有者确认解闸）；sync.json / 凭据暂存（读-改-写套 withFileLock）/ darwin 状态同族修复：原子写，解析失败原文件保留并留档、报错，不回默认值；`*.corrupt-*` 不进快照
- fix(mcp): 审计 6——Windows 上 stdio server 的命令按 PATHEXT 解析，命中 .cmd / .bat 经 `cmd.exe /d /s /c` 起并按 cross-spawn 口径转义参数（含空格 / 引号）；spawn 阶段错误原文带进 verify 失败信息
- `fix(tools)`：把 null 字段归一为空值，使 `skillmgr_*` 的输出通过 schema 校验

## [0.1.1] - 2026-08-23

### 新增 (Added)

- 首个发布
- 文件系统 skill 扫描器：frontmatter 解析 + 嵌套 bundle 展开
- `skillmgr_*` 宿主工具 + loopback 路由 + 系统提示公告
- 「Skill 工作台」设置面板：列出 / 查看 / 编辑 / 启用禁用 skill
- 测试：启动模拟 + 扫描与读写覆盖
- 双语 README（`README.md` / `README.zh.md`）

### 兼容性 (Compatibility)

- Node：`^22.19.0 || >=24.0.0`
