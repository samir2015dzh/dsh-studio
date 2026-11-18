# 贡献说明（个人仓库）

## 开发

```bash
pnpm install --frozen-lockfile   # 或 npm ci；禁止把 node_modules/@deepseek-ai junction 到 DSH 安装目录
npm run guard:install            # 安装路径守卫
npm test                         # windows/ubuntu CI 同源；自动跑 tests/ 下所有 *.test.mjs
node scripts/release.mjs --check
```

## DSH 升级后（必做）

dsh 主程序迭代很快，`@deepseek-ai/*` 的运行时形状随版本变化。本仓库在 profile 里以 link 方式安装时，
插件内部的 bare import（`import { defineTool } from "@deepseek-ai/dsh-tools"` 等）解析的是
**本仓库自己的 `node_modules`**，不是宿主那份。版本落后于宿主会让插件在宿主上装不起来，
现象是「重启后 profile 里的插件全没了」，profile 目录里还会冒出 `*.factory-<时间戳>` 骨架归档。

```bash
node scripts/check-host-deps.mjs   # 对比宿主版本；exit 1 = 有不一致
```

不一致时按输出里给的 `pnpm add -D ...` 把 `devDependencies` 钉到宿主版本，再 `npm test` 确认插件在新 core 下仍能装配。
宿主路径探测顺序：`$DSH_APP` → `D:\DSH\resources\app\dsh` → `F:\` / `C:\` 同名路径；探测不到就跳过，不影响其它机器。

实例：2026-11-11 宿主升到 `0.2.2-rc.1`（cordis `4.1.0`），本仓库仍钉 `0.1.5-rc.1`（cordis `4.0.2`），
`dsh-tools` 的 exports 与 `defineTool` 契约都已不同，装配失败后宿主退回 base+web-app 骨架。

## 代码布局

- 服务端在 `lib/`，没有构建步骤，直接改。`lib/index.js` 只做装配（`apply()`），其余按职责分文件：
  `skill-core.js`（技能读写）、`skill-tools.js`（`skillmgr_*` 工具）、`routes.js`（面板基础路由）、
  `extractor-api.js`（提取的工具与路由）、`route-util.js`、`plugin-meta.js`、`plugin-state.js`、`remember.js`。
- 面板在 `src/client/`，每个面板一个文件。**不要直接改 `lib/client.js`**：改完源码运行 `npm run build:client` 重新生成，
  两者不一致时 `npm test`（`tests/client-build.test.mjs`）会失败。
- 面板源文件的约定：开头是 `import … from "…";`，结尾一行 `export { … };`，新文件要加进
  `scripts/build-client.mjs` 的 `CLIENT_FILES`，并排在依赖它的文件之前。所有文件最终拼进同一个作用域，顶层名字不能重复。
- 新增测试只要放进 `tests/` 并以 `.test.mjs` 结尾即可，不用再改 `package.json`。测试默认逐个文件串行跑
  （有几项在量耗时）；本地想快一点可以用 `npm run test:parallel`。

- 仓库内 `preinstall` 只做安装路径守卫；打进 tarball 的 `package.json` 会去掉 `preinstall`/`install`/`postinstall`，避免 pnpm 10+ 报 `ERR_PNPM_IGNORED_BUILDS`。`onlyBuiltDependencies` / `allowBuilds` 是安装方（DSH profile）的配置，写在本包里不生效。
- 一次性历史补丁在 `scripts/archive/`，不要当日常工具改主树。
- 发布默认 `--skip-npm`（npm 上的 `dsh-studio` 名不属于本仓库），走 GitHub。
- 真机 / Windows + 真实 DSH 验证：见工作笔记清单；**禁止**往仓库外写（尤其 DSH 安装目录）。

## PR

- 从 `main` 拉分支；CI（windows + ubuntu × Node 22/24）必须绿。
- 合并用 merge commit；不 force-push `main`。
