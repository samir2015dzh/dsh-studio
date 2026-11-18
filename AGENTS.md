# dsh-studio 仓库规则

本文件由 DSH（`dsh-agent-instructions`）在本仓库工作时作为基础指令加载，其他兼容 AGENTS.md 的 agent 同样适用。

## 宿主升级检查（每次会话开始先做）

DSH 迭代很快，宿主一升级，本插件的依赖、peer 范围和安装/启动行为都可能失效（表现常常是「重启后 profile 里的插件没了」）。所以：

1. 在本仓库开始任何改动、测试或发布之前，先运行：

   ```
   npm run check:host -- --if-changed
   ```

   宿主版本与上次通过时相同会立即跳过；宿主升级过则自动跑完整验证（peer 范围覆盖 → 开发依赖对齐 → 用本机 dsh 真装真起的可移植性验证）。

2. 退出码不是 0 时：**先停下，把失败项原样告诉用户**，再按输出里的修法处理（常见是给 `peerDependencies` 追加新 rc 的范围、`npx pnpm add -D` 同步开发依赖、重新生成 lockfile）。修好并重跑通过之前，不要继续开发或发布。

3. 退出码 2 表示找不到宿主或 dsh CLI：告诉用户，并提示可用环境变量 `DSH_APP`（指向 `<安装目录>/resources/app/dsh`）或 `DSH_BIN`（指向 dsh CLI）指定。

## 安全约束

- 跑 `portability.mjs` / `verify` 时**不要加 `--no-isolate`**：默认隔离在临时 DSH_HOME 里，加了会动本机真实的 `~/.dsh`。
- 不要删除或改写 `~/.dsh/profiles` 下的任何内容；验证脚本只允许清理自己创建的 `verify-*` profile 和 `dsh-verify-home-*` 临时目录。
- 宿主依赖只升级到本机宿主实际的版本（`check:host-deps` 输出的那个），不要自行挑别的版本。
