// 模拟 boot 加载测试 + 扫描器/合并/编辑逻辑单测（检查清单第 2 条）
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
// Windows 上 import() 不接受裸盘符路径，必须转成 file:// URL
const modUrl = (rel) => pathToFileURL(path.join(pluginRoot, rel)).href;

// M-4：全程在临时 HOME 下跑 —— 预热轮询会写 registry-cache.json，
// 绝不能落到真实 ~/.dsh/dsh-studio/ 上去。必须在 import lib/index.js 之前设好。
const realHome = homedir();
const fakeHome = mkdtempSync(path.join(tmpdir(), "dsh-sm-home-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const m = await import(modUrl("lib/index.js"));
const scanner = await import(modUrl("lib/scanner.js"));

const { splitFrontmatter, applyPolicy, assembleFile, saveSkill, savePolicy, listSkills, getSkillDetail } = m;
const { parseSkillFile, scanSkills, findSkillByName } = scanner;

let failures = 0;
const assert = (cond, label) => {
  if (cond) console.log("  ✅", label);
  else { console.error("  ❌", label); failures++; }
};

// ---------- 1. frontmatter 解析与行编辑 ----------
console.log("\n[1] frontmatter 解析与行编辑");
{
  const p = parseSkillFile("---\ntype: skill\nname: demo-skill\ndescription: 演示\n# 注释\n---\n# 正文\n内容");
  assert(p.fields.name === "demo-skill", "解析 name");
  assert(p.fields.description === "演示", "解析 description");
  assert(p.body.startsWith("# 正文"), "正文分离");
  assert(p.fields.disableModelInvocation === null && p.fields.userInvocable === null, "默认策略为空");
}
{
  const p = parseSkillFile("---\nname: x\nuser-invocable: false\ndisable-model-invocation: true\n---\nbody");
  assert(p.fields.userInvocable === false && p.fields.disableModelInvocation === true, "解析调用策略布尔");
}
{
  const p = parseSkillFile("---\ndescription: |\n  多行\n  描述\nname: block-skill\n---\nbody");
  assert(p.fields.description === "多行\n描述", "解析块值描述: " + JSON.stringify(p.fields.description));
}
{
  const p = parseSkillFile("---\nname: g\nmetadata:\n  group: 内容创作\n  tags: [a, b]\nuser-invocable: false\n---\nbody");
  assert(p.fields.metadata && p.fields.metadata.group === "内容创作", "解析嵌套 metadata.group");
  assert(p.fields.metadata.tags.join(",") === "a,b", "解析嵌套 metadata.tags（内联数组）");
  assert(p.fields.userInvocable === false, "嵌套块结束后继续解析顶层键");
}
{
  const p = parseSkillFile("---\nname: g2\nmetadata:\n  tags:\n    - 一\n    - 二\nuser-invocable: false\n---\nbody");
  assert(p.fields.metadata.tags.join(",") === "一,二", "解析嵌套 metadata.tags（多行列表）");
  assert(p.fields.userInvocable === false, "多行列表后继续解析顶层键");
}
{
  const p = parseSkillFile("---\nname: g3\n---\nbody");
  assert(p.fields.metadata === null, "无 metadata 时为 null");
}
{
  const src = "---\ntype: skill\nname: demo-skill\ndescription: 演示\n# 用户注释\n---\n# 正文\n内容";
  const fm = splitFrontmatter(src).frontmatter;
  const out = assembleFile(src, applyPolicy(fm, { modelInvocable: false, userInvocable: false }));
  assert(out.includes("disable-model-invocation: true") && out.includes("user-invocable: false"), "禁用 → 写入两个键");
  assert(out.includes("# 用户注释") && out.includes("type: skill"), "其他行保留");
  const out2 = assembleFile(out, applyPolicy(splitFrontmatter(out).frontmatter, { modelInvocable: true, userInvocable: true }));
  assert(!out2.includes("disable-model-invocation") && !out2.includes("user-invocable"), "启用 → 移除两个键");
}
{
  const src = "# 平铺 skill";
  const out = assembleFile(src, applyPolicy(null, { userInvocable: false }));
  assert(out.startsWith("---\nuser-invocable: false\n---\n"), "无 frontmatter 时创建块");
}

// ---------- 2. 扫描器（临时目录：顶层 + 嵌套展开） ----------
console.log("\n[2] 扫描器");
const tmp = mkdtempSync(path.join(tmpdir(), "dsh-sm-test-"));
const agentsRoot = path.join(tmp, ".agents", "skills");
const projDshRoot = path.join(tmp, ".dsh", "skills");
// 顶层 skill（project-agents 源）
mkdirSync(path.join(agentsRoot, "demo-skill"), { recursive: true });
writeFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 演示技能\n---\n# 正文\n你好", "utf8");
// 嵌套 skill（模拟 superpowers）
mkdirSync(path.join(agentsRoot, "superpowers", "brainstorming"), { recursive: true });
writeFileSync(path.join(agentsRoot, "superpowers", "brainstorming", "SKILL.md"), "---\nname: brainstorming\ndescription: 头脑风暴\n---\n# 风暴", "utf8");
mkdirSync(path.join(agentsRoot, "superpowers", "writing-plans"), { recursive: true });
writeFileSync(path.join(agentsRoot, "superpowers", "writing-plans", "SKILL.md"), "---\nname: writing-plans\ndescription: 写计划\n---\n# 计划", "utf8");
// 平铺 .md skill（project-dsh 源）
mkdirSync(projDshRoot, { recursive: true });
writeFileSync(path.join(projDshRoot, "flat-skill.md"), "---\nname: flat-skill\ndescription: 平铺\n---\n# 平铺", "utf8");
// 带分组元数据的 skill（metadata.group / metadata.tags）
mkdirSync(path.join(agentsRoot, "grouped-skill"), { recursive: true });
writeFileSync(
  path.join(agentsRoot, "grouped-skill", "SKILL.md"),
  "---\nname: grouped-skill\ndescription: 分组演示\nmetadata:\n  group: 内容创作\n  tags: [小红书, 配图]\n---\n# 分组",
  "utf8"
);

const scanned = await scanSkills(tmp);
const names = scanned.map((s) => s.name);
assert(names.includes("demo-skill"), "顶层 skill 被发现: " + names.join(","));
assert(names.includes("brainstorming") && names.includes("writing-plans"), "嵌套 skill 被发现");
const nested = scanned.find((s) => s.name === "brainstorming");
assert(nested && nested.nested === true && nested.parent === "superpowers", "嵌套标记 + parent 正确");
assert(scanned.find((s) => s.name === "flat-skill").source === "project-dsh", "平铺 .md 发现 + 来源 project-dsh");
// ---- 分组元数据（SKILL.md 的 metadata.group / metadata.tags） ----
const grouped = scanned.find((s) => s.name === "grouped-skill");
assert(grouped && grouped.group === "内容创作", "扫描器读出 metadata.group: " + JSON.stringify(grouped && grouped.group));
assert(grouped && grouped.tags.join(",") === "小红书,配图", "扫描器读出 metadata.tags: " + JSON.stringify(grouped && grouped.tags));
assert(grouped && grouped.metadata && grouped.metadata.group === "内容创作", "扫描器保留 metadata 对象");
assert(scanned.find((s) => s.name === "demo-skill").group === "", "无 metadata 的 skill 分组为空字符串");
assert(scanned.find((s) => s.name === "demo-skill").tags.length === 0, "无 metadata 的 skill tags 为空数组");
const found = await findSkillByName("brainstorming", tmp);
assert(found && found.path.endsWith(path.join("brainstorming", "SKILL.md")), "findSkillByName 命中嵌套");

// ---------- 3. 模拟 boot apply + 合并 ----------
console.log("\n[3] 模拟 boot apply + 合并");
const registered = { tools: [], routes: [], sections: [], defs: {} };
const intervals = new Set();
const ctx = {
  skills: {
    // registry 视角：一个 runtime skill；无 filesystem provider
    list: async () => [
      { name: "vision-tools", description: "视觉工具", whenToUse: null, source: "runtime", provider: "runtime",
        invocation: { modelInvocable: true, userInvocable: true } }
    ],
    get: async () => undefined
  },
  tools: { register: (t) => { registered.tools.push(t.name); registered.defs[t.name] = t; return () => {}; } },
  webServer: { register: (r) => { registered.routes.push(r.path); return () => {}; } },
  systemPrompt: { section: (s) => { registered.sections.push(s.name); return () => {}; } },
  effect: (fn) => { const d = fn(); return () => (typeof d === "function" ? d() : undefined); },
  get: () => null,
  logger: { info: () => {} },
  interval: (fn) => { const h = { src: String(fn) }; intervals.add(h); return () => { intervals.delete(h); }; },

  on: () => () => {}
};
m.apply(ctx, {});
assert(registered.tools.length === 48 && registered.tools.slice(0, 4).join(",") === "skillmgr_list,skillmgr_get,skillmgr_save,skillmgr_policy", "48 个工具注册（24 skillmgr + 9 mcp + 3 进化地基 + 4 优化回路（新增 skillmgr_darwin_submit）+ 3 治理 + 3 蒸馏 + 2 备份包；新增 skillmgr_studio_backup / restore；新增 skillmgr_optimize_*；新增 mcp_catalog_eval；新增 skillmgr_governance_status / run / decide；新增 skillmgr_distill_status / run / decide），首四名不变");
assert(["skillmgr_governance_status", "skillmgr_governance_run", "skillmgr_governance_decide"].every((n) => registered.tools.includes(n)), "：治理三个工具已注册");
assert(["skillmgr_distill_status", "skillmgr_distill_run", "skillmgr_distill_decide"].every((n) => registered.tools.includes(n)), "：蒸馏三个工具已注册");
assert(["skillmgr_studio_backup", "skillmgr_studio_restore"].every((n) => registered.tools.includes(n)), "：备份包两个工具已注册");
assert(registered.tools.includes("mcp_catalog_eval"), "：目录评测巡检工具已注册");
assert(["skillmgr_optimize_status", "skillmgr_optimize_run", "skillmgr_optimize_decide"].every((n) => registered.tools.includes(n)), "：优化回路三个工具已注册");
assert(["skillmgr_stats", "skillmgr_history", "skillmgr_rollback"].every((n) => registered.tools.includes(n)), "：遥测统计 / 版本史 / 回滚三个工具已注册");
assert(registered.tools.includes("skillmgr_extract_run") && registered.tools.includes("skillmgr_extract_accept"), "提取工具已注册");
assert(registered.tools.includes("skillmgr_update_check"), "只读上游检查工具已注册（U-2）");
assert(registered.tools.includes("skillmgr_update_apply"), "更新应用工具已注册（N-01）");
assert(registered.tools.includes("skillmgr_quality"), "只读质量度量工具已注册（Q-2）");
assert(registered.tools.includes("skillmgr_pull_pending"), "消费待拉清单的工具已注册（PULL-2）");

// M-2：全库口径（含 SKILL.md 的目录 / 跟随符号链接 / 按真实路径去重）必须写进工具描述
const updateCheckDesc = String(registered.defs.skillmgr_update_check?.description ?? "");
assert(
  ["含 SKILL.md 的目录", "跟随符号链接", "按真实路径去重"].every((key) => updateCheckDesc.includes(key)),
  "update_check 描述注明全库口径"
);
console.log("  ℹ skillmgr_update_check.description（注册原文）= " + updateCheckDesc);
assert(registered.routes.length === 62, "62 条路由注册（17 基础 + 9 提取 + 14 MCP + 3 进化地基 + 5 优化回路 + 4 治理 + 4 蒸馏 + 6 备份包；新增 /studio-backup/status /export /verify /restore /remote /report；新增 /optimizer/*；新增 /mcp/catalog-eval*；新增 /governance/status /run /decide /report；新增 /distill/status /run /decide /source；新增 /mcp/registry-corrupt）");
// 顺手修：#3 的 mountMcp 会把优化回路的定时器一起拆掉（boot 异步挂 MCP 之后自动轮次永远不跑）
for (let i = 0; i < 300 && ![...intervals].some((h) => h.src.includes("sweep")); i++) await new Promise((resolve) => setTimeout(resolve, 10));
assert([...intervals].some((h) => h.src.includes("sweep")), "MCP 已异步挂载（空闲扫描定时器在）");
assert([...intervals].some((h) => h.src.includes("optimizer.tick")), "MCP 挂载之后优化回路定时器仍在");
assert([...intervals].some((h) => h.src.includes("catalogWatch.tick")), "MCP 挂载之后目录评测巡检定时器仍在");
assert([...intervals].some((h) => h.src.includes("governance.tick")), "MCP 挂载之后治理定时器仍在");
assert([...intervals].some((h) => h.src.includes("distill.tick")), "MCP 挂载之后蒸馏定时器仍在");
assert(registered.sections.length === 1, "系统提示段落注册");

// runtime skill 走 registry 摘要缓存（index.js:381-415）：首次 listSkills 只触发后台预热，
// 结果下一次调用才可见，且不能依赖上次运行留下的磁盘缓存——这里显式等预热落地。
let merged = await listSkills(ctx, tmp);
for (let i = 0; i < 200 && !merged.some((s) => s.name === "vision-tools"); i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  merged = await listSkills(ctx, tmp);
}
const mergedNames = merged.map((s) => s.name);
assert(mergedNames.includes("demo-skill") && mergedNames.includes("brainstorming"), "合并含文件系统 skill");
assert(mergedNames.includes("vision-tools"), "合并含 runtime skill");
const vt = merged.find((s) => s.name === "vision-tools");
assert(vt && vt.editable === false && vt.provider === "runtime", "runtime skill 只读标记");
assert(merged.find((s) => s.name === "grouped-skill").group === "内容创作", "listSkills 透出分组（面板与工具可见）");
assert(merged.find((s) => s.name === "grouped-skill").tags.length === 2, "listSkills 透出标签");

// M-4：预热写出的 registry 缓存必须落在临时 HOME 里
const fakeCache = path.join(fakeHome, ".dsh", "dsh-studio", "registry-cache.json");
for (let i = 0; i < 200 && !existsSync(fakeCache); i++) await new Promise((resolve) => setTimeout(resolve, 10));
assert(fakeHome !== realHome, "临时 HOME 与真实 HOME 不是同一路径");
assert(existsSync(fakeCache), "registry 缓存写到临时 HOME: " + fakeCache);

// M-2 的输出口径：临时 HOME 下没有 skill 根，execute 不发任何 ls-remote
const emptyRoot = path.join(fakeHome, "empty-root");
mkdirSync(emptyRoot, { recursive: true });
const updateCheckRun = await registered.defs.skillmgr_update_check.execute({ root: emptyRoot });
assert(
  /含 SKILL\.md 的目录，跟随符号链接，按真实路径去重/.test(String(updateCheckRun.message)),
  "update_check 汇总带全库口径注脚: " + updateCheckRun.message
);

// ---------- 4. 真实文件读写（编辑 + 开关） ----------
console.log("\n[4] 真实文件读写");
const detail = await getSkillDetail(ctx, "demo-skill", tmp);
assert(detail && detail.editable === true && detail.content.includes("# 正文"), "getSkillDetail 返回正文 + editable");
const detailGrouped = await getSkillDetail(ctx, "grouped-skill", tmp);
assert(detailGrouped && detailGrouped.group === "内容创作" && detailGrouped.tags.length === 2, "getSkillDetail 带分组与标签");

const saved = await saveSkill(ctx, { name: "demo-skill", content: "---\nname: demo-skill\ndescription: 改过的描述\n---\n# 新正文" }, tmp);
assert(saved.ok && readFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "utf8").includes("# 新正文"), "saveSkill 写回文件");

const pol = await savePolicy(ctx, { name: "demo-skill", enabled: false }, tmp);
const after = readFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "utf8");
assert(pol.ok && pol.modelInvocable === false && after.includes("disable-model-invocation: true"), "savePolicy 禁用（模型侧）");

const pol2 = await savePolicy(ctx, { name: "demo-skill", enabled: true }, tmp);
const after2 = readFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "utf8");
assert(!after2.includes("disable-model-invocation") && !after2.includes("user-invocable"), "重新启用后键被移除");

const pol3 = await savePolicy(ctx, { name: "brainstorming", userInvocable: false }, tmp);
const after3 = readFileSync(path.join(agentsRoot, "superpowers", "brainstorming", "SKILL.md"), "utf8");
assert(pol3.ok && after3.includes("user-invocable: false"), "嵌套 skill 开关写入");

// 只读 skill（runtime）拒绝编辑
let threw = false;
try { await saveSkill(ctx, { name: "vision-tools", content: "x" }, tmp); } catch (e) { threw = true; }
assert(threw, "runtime 只读 skill 拒绝编辑");

// ---------- 5. 客户端面板分组渲染冒烟（fake React 驱动真实组件） ----------
console.log("\n[5] 客户端面板分组渲染");
{
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (mod) => { captured = mod; } } };
  await import(modUrl("lib/client.js"));
  assert(captured && typeof captured.factory === "function", "client bundle 经 window.__ModuleLoader__.load 注册");

  const sampleSkills = [
    { name: "a-skill", description: "甲", group: "内容创作", tags: ["x"], source: "user-agents", provider: "filesystem", modelInvocable: true, userInvocable: true, editable: true },
    { name: "b-skill", description: "乙", group: "内容创作", tags: [], source: "user-agents", provider: "filesystem", modelInvocable: true, userInvocable: true, editable: true },
    { name: "c-skill", description: "丙", group: "", tags: [], source: "runtime", provider: "runtime", modelInvocable: true, userInvocable: true, editable: false }
  ];
  // 依次对应 SkillManagerPanel 的 17 个 useState：
  // skills/cwd/selected/draft/busy/msg/err/page/pageInput/view/
  // sourceFilter/activeFilter/trash/query/groupFilter/collapsed/conflict
  const stateQueue = [sampleSkills, "/tmp/ws", null, "", false, "", "", 0, "1", "skills", "all", "all", null, "", "all", {}, null];
  let stateIndex = 0;
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (init) => [
      stateIndex < stateQueue.length ? stateQueue[stateIndex++] : typeof init === "function" ? init() : init,
      () => {}
    ],
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: (init) => ({ current: typeof init === "function" ? init() : init })
  };
  // 三个设置页都会注册（client.js:2484/2499/2514），按 meta.id 存，
  // 取面板按 id 而不是注册顺序——顺序取到的是最后注册的 SnapshotPanel。
  const panels = new Map();
  const clientExports = captured.factory((name) => (name === "react" ? fakeReact : undefined));
  clientExports.apply({
    slots: {
      inject: (_name, callback) => { callback(); return () => {}; },
      register: (meta, component) => { panels.set(meta.id, component); return () => {}; }
    }
  });
  const Panel = panels.get("skill-manager");
  assert(typeof Panel === "function", "面板组件注册到 settings.section");

  /** Walk a fake element tree and collect GroupHeader / SkillRow element props. */
  const collect = (tree) => {
    const found = { headers: [], rows: [] };
    const walk = (node) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== "object") return;
      if (typeof node.type === "function") {
        if (node.type.name === "GroupHeader") found.headers.push(node.props);
        else if (node.type.name === "SkillRow") found.rows.push(node.props);
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(tree);
    return found;
  };

  // 默认渲染：分类只是筛选维度，列表恒平铺（client.js:1971-1972），groups 恒为单个 __all__（:2116）
  const defaultView = collect(Panel());
  assert(defaultView.headers.length === 0, "默认渲染不渲染组标题: " + defaultView.headers.map((p) => p.label).join(","));
  assert(defaultView.rows.filter((p) => p.skill.group === "内容创作").length === 2, "「内容创作」的 2 个 skill 平铺成行");
  assert(defaultView.rows.filter((p) => p.skill.group === "").length === 1, "「未分组」的 1 个 skill 平铺成行");

  // 平铺视图（groupView=false 恒成立，见 client.js:1972）
  stateIndex = 0;
  const flatView = collect(Panel());
  assert(flatView.headers.length === 0, "平铺视图不渲染组标题");
  assert(flatView.rows.length === 3 && flatView.rows.every((p) => p.showGroup === true), "平铺视图给每行加分组徽章");

  // 折叠状态（collapsed 非空）：只有 groupView 才读 collapsed（client.js:2366），平铺下无效果
  stateIndex = 0;
  stateQueue[15] = { "内容创作": true };
  const foldedView = collect(Panel());
  assert(foldedView.headers.length === 0, "collapsed 非空时仍不渲染组标题");
  assert(foldedView.rows.length === 3, "collapsed 非空时行数不变");
}

// ---------- 6. N-05：HTTP 通道的超时由请求预算决定，不是写死的 30 秒
console.log("\n[6] MCP HTTP 通道：请求预算说了算");
{
  const http = await import("node:http");
  const { McpConnection } = await import(modUrl("lib/mcp-client.js"));
  const { DEFAULT_HTTP_TIMEOUT_MS } = await import(modUrl("lib/http.js"));

  const listen = (handler) =>
    new Promise((resolve) => {
      const server = http.createServer(handler);
      server.on("clientError", () => {});
      server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
  const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));
  const delayedJson = (delayMs) => (req, res) => {
    res.on("error", () => {});
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");
    }, delayMs);
  };
  const delayedSse = (delayMs) => (req, res) => {
    res.on("error", () => {});
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": keepalive\n\n");
    setTimeout(() => {
      res.write('data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n');
      res.end();
    }, delayMs);
  };
  // 直接对通道发一次请求：预算从参数进来，测的就是「谁在管超时」这件事本身
  const probe = async (handler, timeoutMs) => {
    const { server, port } = await listen(handler);
    const conn = new McpConnection({ transport: "streamable-http", url: `http://127.0.0.1:${port}/mcp` }, { timeoutMs: 30000 });
    let messages = 0;
    conn.channel.onMessage = () => { messages += 1; };
    const started = Date.now();
    let error = null;
    try {
      await conn.channel.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } }, { timeoutMs });
    } catch (err) {
      error = String(err?.message ?? err);
    }
    const elapsed = Date.now() - started;
    await conn.close().catch(() => {});
    await closeServer(server);
    return { error, elapsed, messages };
  };

  assert(DEFAULT_HTTP_TIMEOUT_MS === 30_000, "短操作的 30 秒默认值保留（没有被这一条抬高）");

  // (a) JSON 响应体：服务端 900ms 才回，预算 200ms → 必须在预算处切断
  const jsonCase = await probe(delayedJson(900), 200);
  assert(jsonCase.error !== null && /请求超时/.test(jsonCase.error), "超预算的 tools/call 报请求级超时: " + jsonCase.error);
  assert(jsonCase.elapsed < 700, "在请求预算附近报错，不是等写死的 30 秒（实测 " + jsonCase.elapsed + "ms）");

  // (b) SSE 响应体：头部先到、data 迟到 —— 消费阶段同一份预算
  const sseCase = await probe(delayedSse(900), 250);
  assert(sseCase.error !== null && /请求超时/.test(sseCase.error), "SSE 消费阶段的超时也是请求级: " + sseCase.error);
  assert(sseCase.elapsed < 700, "SSE 停顿超预算时按时报错（实测 " + sseCase.elapsed + "ms）");

  // (c) 反向：预算内该完成的必须完成（预算不是「一律切断」）
  const okCase = await probe(delayedJson(350), 5000);
  assert(okCase.error === null && okCase.messages === 1, "预算内的慢调用正常完成并收到结果（messages=" + okCase.messages + "）");
  assert(okCase.elapsed >= 300, "确实等到了服务端的 350ms（实测 " + okCase.elapsed + "ms）");
}

// ---------- 7. N-08：MCP 目录段挂载的代次守卫（迟到构建不许覆盖新一代）
console.log("\n[7] MCP 目录段：迟到的构建被丢弃");
{
  const { createMcpCatalogMount } = await import(modUrl("lib/index.js"));
  assert(typeof createMcpCatalogMount === "function", "index.js 导出目录段挂载守卫（N-08）");
  if (typeof createMcpCatalogMount === "function") {
    const settle = () => new Promise((r) => setTimeout(r, 25));
    const makeCtx = () => {
      const state = { active: new Map(), registered: [], released: [] };
      return {
        state,
        ctx: {
          systemPrompt: {
            section: (spec) => {
              const token = {};
              state.active.set(token, spec);
              state.registered.push(spec.text);
              return () => {
                state.active.delete(token);
                state.released.push(spec.text);
              };
            }
          }
        }
      };
    };
    const spec = { name: "plugin:dsh-studio:mcp", order: 0 };

    // 1) 两代交错：第二代先落地，第一代的构建迟到 —— 迟到者连 section 都不许建
    {
      const { ctx, state } = makeCtx();
      const gates = [];
      const mount = createMcpCatalogMount(ctx, { ...spec, build: () => new Promise((resolve) => gates.push(resolve)) });
      mount.mount();
      mount.mount();
      assert(gates.length === 2, "两次挂载各自发起一次构建（实际 " + gates.length + "）");
      gates[1]("## MCP 服务器（按需加载）\n第二代");
      await settle();
      assert(state.active.size === 1, "新一代先落地：活着的目录段恰好一份（实际 " + state.active.size + "）");
      gates[0]("## MCP 服务器（按需加载）\n第一代");
      await settle();
      assert(state.active.size === 1, "迟到的旧构建不落段：仍然只有一份（实际 " + state.active.size + "）");
      assert([...state.active.values()][0].text.includes("第二代"), "活着的是新一代的内容");
      assert(state.registered.length === 1, "迟到的那次构建没有登记过任何目录段（登记次数 " + state.registered.length + "）");
    }

    // 2) 卸载之后迟到的构建同样不许登记
    {
      const { ctx, state } = makeCtx();
      const gates = [];
      const mount = createMcpCatalogMount(ctx, { ...spec, build: () => new Promise((resolve) => gates.push(resolve)) });
      mount.mount();
      mount.dispose();
      gates[0]("## MCP 服务器（按需加载）\n卸载后回来");
      await settle();
      assert(state.registered.length === 0 && state.active.size === 0, "被 dispose 后迟到的构建不登记目录段");
    }

    // 3) 正常换代：一份接一份，旧的 disposer 必须被调用（卸净）
    {
      const { ctx, state } = makeCtx();
      let round = 0;
      const mount = createMcpCatalogMount(ctx, { ...spec, build: async () => "## 目录 v" + (round += 1) });
      mount.mount();
      await settle();
      assert(state.active.size === 1 && [...state.active.values()][0].text === "## 目录 v1", "第一次挂载登记一份目录段");
      mount.mount();
      await settle();
      assert(state.active.size === 1 && [...state.active.values()][0].text === "## 目录 v2", "换代后只剩新一代内容");
      assert(state.released.includes("## 目录 v1"), "旧一代的 disposer 被调用过（旧段卸净）");
      mount.dispose();
      assert(state.active.size === 0, "dispose 之后一份不剩");
    }

    // 4) 没有目录（null）与构建失败都不登记、不炸挂载方
    {
      const { ctx, state } = makeCtx();
      const empty = createMcpCatalogMount(ctx, { ...spec, build: async () => null });
      empty.mount();
      await settle();
      assert(state.registered.length === 0, "构建返回 null 时不登记目录段");
      const broken = createMcpCatalogMount(ctx, { ...spec, build: async () => { throw new Error("boom"); } });
      broken.mount();
      await settle();
      assert(state.registered.length === 0, "构建抛错时不登记、也不把异常抛给挂载方");
    }
  }
}

// ---------- 8. N-09：setRowDisabled 保 EOL、rowId 转义
console.log("\n[8] profile-mcp setRowDisabled：只动目标行");
{
  const { setRowDisabled } = await import(modUrl("lib/profile-mcp.js"));
  const CRLF = (lines) => lines.join("\r\n");
  const base = [
    "- insert:",
    "    - id: \"native-a\"",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: a",
    "    - id: \"native-b\"",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: b",
    ""
  ];
  const crlfText = CRLF(base);
  const on = setRowDisabled(crlfText, "native-a", true);
  const expected = crlfText.replace(
    "    - id: \"native-a\"\r\n",
    "    - id: \"native-a\"\r\n      disabled: true\r\n"
  );
  assert(on.changed === true, "CRLF 文件里命中目标行并插入 disabled");
  assert(on.text === expected, "只插入一行，其余字节完全不变（逐字节比对）");
  assert(on.text.replace(/\r\n/g, "").includes("\n") === false, "全文件仍是 CRLF，没有孤立的 LF（旧代码在这里会整篇翻成 LF）");
  assert(on.text.endsWith("\r\n") === crlfText.endsWith("\r\n"), "文件末尾换行的有无保持原样");

  const off = setRowDisabled(on.text, "native-a", false);
  assert(off.changed === true && off.text === crlfText, "去掉 disabled 后逐字节还原成原文件");

  // 末尾没有换行的文件：新增行同样不带尾换行
  const noTail = CRLF(base.slice(0, -1));
  const noTailOn = setRowDisabled(noTail, "native-b", true);
  assert(noTailOn.text.endsWith("\r\n") === false, "末尾无换行的文件，插入后仍无尾换行");
  assert(noTailOn.text.split("\r\n").length === noTail.split("\r\n").length + 1, "只多一行（行数 +1）");

  // rowId 里的正则元字符：诱饵行在前，必须只命中字面相同的那一行
  const trapText = ["- insert:", "    - id: \"axbbc\"", "      name: decoy", "    - id: \"a.b+c\"", "      name: real", ""].join("\n");
  const trap = setRowDisabled(trapText, "a.b+c", true);
  assert(trap.changed === true, "带元字符的 rowId 也能命中（a.b+c）");
  assert(trap.text.includes('    - id: "axbbc"\n      name: decoy\n    - id: "a.b+c"\n      disabled: true\n'), "改动落在字面相同的那一行，诱饵行没被动");
  assert(!trap.text.includes("name: decoy\n      disabled: true"), "诱饵行后面没有多出 disabled");
  assert(!trap.text.includes('    - id: "axbbc"\n      disabled: true'), "诱饵行紧接着的一行不是 disabled");

  const missing = setRowDisabled(trapText, "a.b+c", false);
  assert(missing.changed === false && missing.text === trapText, "没有 disabled 行时 changed=false 且文本原样");
  const noRow = setRowDisabled(trapText, "a?.c", true);
  assert(noRow.changed === false && noRow.text === trapText, "rowId 不匹配任何行时文本原样");
}

// ---------- 9. N-14：mock MCP 的 cursor 分页与 tools/list_changed（纯测试侧覆盖）
console.log("\n[9] mock MCP：分页聚合与 list_changed");
{
  const mockServer = path.join(pluginRoot, "tests", "fixtures", "mock-mcp-server.mjs");
  const register = (name, env) => registered.defs.mcp_register.execute({
    name,
    command: process.execPath,
    args: [mockServer],
    env,
    tier: "on-demand",
    // ：新登记默认试运行（只放只读工具）；本节要调可写的 grow 验 list_changed，登记时显式不进试运行
    trial: false
  });
  const serverRow = async (name) => (await registered.defs.mcp_list.execute({})).servers.find((s) => s.name === name);
  const waitToolCount = async (name, want, tries = 80) => {
    let seen;
    for (let i = 0; i < tries; i += 1) {
      seen = (await serverRow(name))?.toolCount;
      if (seen === want) return seen;
      await new Promise((r) => setTimeout(r, 50));
    }
    return seen;
  };

  // 分页模式：第一页 3 个 + nextCursor，第二页 2 个 —— 客户端要跨页聚合成 5 个
  const paged = await register("paged-mcp", { MOCK_MCP_PAGED: "1" });
  assert(paged.toolCount === 5, "客户端跨页聚合全部工具（5 个，实际 " + paged.toolCount + "）");
  assert(
    ["echo", "grow", "page-a", "page-b", "page-c"].every((t) => paged.tools.includes(t)),
    "两页的工具都在结果里: " + paged.tools.join(",")
  );

  // 调 grow → 服务端扩张工具集并发 list_changed → onToolsChanged → 工具列表刷新成 6 个
  await registered.defs.mcp_call.execute({ name: "paged-mcp", tool: "grow", args: {} });
  const grownCount = await waitToolCount("paged-mcp", 6);
  assert(grownCount === 6, "收到 list_changed 后客户端工具列表更新为新集合（6 个，实际 " + grownCount + "）");

  // 非空转自证 1：分页关掉 → 只有第一页（1 个），上面的「5 个」不是因为客户端瞎凑
  const plain = await register("plain-mcp", {});
  assert(plain.toolCount === 1 && plain.tools.join(",") === "echo", "非分页模式下只有 echo（实际 " + plain.tools.join(",") + "）");

  // 非空转自证 2：通知关掉 → grow 之后服务端新增了工具，但客户端收不到通知，缓存不变
  const silent = await register("silent-mcp", { MOCK_MCP_PAGED: "1", MOCK_MCP_NO_NOTIFY: "1" });
  assert(silent.toolCount === 5, "静默实例初始也是 5 个（实际 " + silent.toolCount + "）");
  await registered.defs.mcp_call.execute({ name: "silent-mcp", tool: "grow", args: {} });
  const silentAfter = await waitToolCount("silent-mcp", 6, 12);
  assert(silentAfter === 5, "服务端不发 list_changed 时客户端缓存不刷新（仍是 5，实际 " + silentAfter + "）");
}

// ---------- 10. N-11：scanner 条目级解析缓存（按文件 mtime/size 校验）
console.log("\n[10] scanner 条目级解析缓存");
// 公开导出不含开发历史：本节基线对拍依赖历史提交 af7daae，缺失时跳过本节
let SCANNER_ANCHOR = true;
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["cat-file", "-e", "af7daae^{commit}"], { cwd: pluginRoot, stdio: "pipe" });
} catch { SCANNER_ANCHOR = false; }
if (!SCANNER_ANCHOR) console.log("SKIP [10] 公开导出不含开发历史（基线提交 af7daae 不在），跳过基线对拍");
else {
  const { spawnSync } = await import("node:child_process");
  const fixture = path.join(pluginRoot, "tests", "fixtures", "scanner-cache-home.mjs");
  const probeRun = spawnSync(process.execPath, [fixture], { cwd: pluginRoot, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
  assert(probeRun.status === 0, "探针跑通（exit=" + probeRun.status + "）" + (probeRun.status === 0 ? "" : "\n" + String(probeRun.stderr ?? "").slice(-1200)));
  let probe = null;
  try { probe = JSON.parse(String(probeRun.stdout ?? "")); } catch { probe = null; }
  assert(probe !== null, "探针输出可解析的 JSON");
  if (probe !== null) {
    const env = probe.env ?? {};
    assert(
      env.tripletMatches === true && env.USERPROFILE === env.fakeHome && env.HOME === env.fakeHome &&
        env.DSH_HOME === path.join(env.fakeHome, ".dsh") && env.homedir === env.fakeHome,
      "USERPROFILE / HOME / DSH_HOME / homedir() 四者同指伪 HOME: " + env.fakeHome
    );
    assert(/dsh-scanner-cache-/.test(String(env.fakeHome)) && env.fakeHome !== fakeHome, "伪 HOME 是探针自己的临时目录（与测试 fakeHome 不同）");

    const fix = probe.fixture ?? {};
    assert((fix.skillMdFiles ?? 0) >= 400, "合成技能树 SKILL.md ≥400（实际 " + fix.skillMdFiles + "，条目 " + fix.entries + "）");
    assert((fix.shadowPairs ?? []).some((pair) => Array.isArray(pair.shadows) && pair.shadows.length >= 2), "同名遮蔽关系成形（shadows 累计两位）");
    assert((fix.sources ?? []).includes("custom") && fix.bomStripped === true && (fix.nested ?? 0) > 0 && (fix.flat ?? 0) > 0, "既有形态齐全：custom 源 / BOM / 嵌套 / 平铺");

    const eq = probe.equivalence ?? {};
    for (const [key, label] of [["cold", "冷扫"], ["size", "改 1 个变 size 后"], ["mtime", "改 1 个同 size 变 mtime 后"], ["delete", "删 1 个后"], ["add", "增 1 个后"]]) {
      const row = eq[key] ?? {};
      assert(row.equal === true && Array.isArray(row.diffs) && row.diffs.length === 0, "新旧逐项深比对全等（" + label + "，条目 " + row.count + "）" + (row.equal === true ? "" : " " + JSON.stringify(row.diffs)));
    }

    const rr = probe.reread ?? {};
    assert(
      rr.size?.newValueSeen === true && rr.size?.oldValueGone === true && rr.size?.readFile === 1 && rr.size?.sizeChanged === true,
      "变 size 必重读：新值出现 + 旧值消失 + 只读 1 个文件（" + rr.size?.sizeBefore + "→" + rr.size?.sizeAfter + " 字节）"
    );
    assert(
      rr.mtime?.newValueSeen === true && rr.mtime?.oldValueGone === true && rr.mtime?.readFile === 1 && rr.mtime?.sizeSame === true && rr.mtime?.mtimeChanged === true,
      "同 size 变 mtime 必重读：新值出现 + 旧值消失 + 只读 1 个文件（size 恒 " + rr.mtime?.sizeBefore + "）"
    );
    assert(rr.delete?.entryGone === true && rr.delete?.baselineSawGone === true && rr.delete?.readFile === 0, "删 1 个：条目消失，其余零重读");
    assert(rr.add?.entrySeen === true && rr.add?.baselineSawIt === true && rr.add?.readFile === 1, "增 1 个：新条目出现，只读新文件");

    const rf = probe.readFile ?? {};
    assert(rf.baselineCold >= 400 && rf.currentCold === rf.baselineCold, "冷扫 readFile 与基线同量（基线 " + rf.baselineCold + " / 新版 " + rf.currentCold + "）");
    assert(rf.currentWarm === 0 && Array.isArray(rf.currentWarmPaths) && rf.currentWarmPaths.length === 0, "无变更复扫 readFile = 0（基线全量 " + rf.baselineCold + "）");
    assert(rf.currentWarmRealpath === 0, "无变更复扫 realpath = 0（规范路径映射命中）");
    assert(rf.currentWarmReaddir === rf.baselineColdReaddir, "无变更复扫目录枚举对齐基线：readdir " + rf.currentWarmReaddir + " 次");

    const tm = probe.timing ?? {};
    assert(
      Array.isArray(tm.baselineCold) && Array.isArray(tm.currentWarm) && tm.currentWarmMedian < tm.baselineColdMedian * 0.75,
      "无变更复扫中位耗时显著低于基线冷扫（基线 " + tm.baselineColdMedian + "ms / 新版热扫 " + tm.currentWarmMedian + "ms）"
    );
    console.log("  ℹ 三段耗时（中位，交替 5 次）：基线冷扫 " + tm.baselineColdMedian + "ms / 新版冷扫 " + tm.currentColdMedian + "ms / 新版无变更复扫 " + tm.currentWarmMedian + "ms");
    console.log("  ℹ 原始数字：baselineCold=" + JSON.stringify(tm.baselineCold) + " currentCold=" + JSON.stringify(tm.currentCold) + " currentWarm=" + JSON.stringify(tm.currentWarm));
    console.log("  ℹ readFile：baselineCold=" + rf.baselineCold + " currentCold=" + rf.currentCold + " currentWarm=" + rf.currentWarm + "；stat baselineCold=" + rf.baselineColdStat + " currentWarm=" + rf.currentWarmStat + "（.md 候选 " + fix.mdFiles + " 个各多一次校验 stat）");
  }
}

rmSync(fakeHome, { recursive: true, force: true });
console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
