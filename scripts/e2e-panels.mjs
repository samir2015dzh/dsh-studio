/**
 * 面板端到端验证（手动跑，不进 npm test）：真实路由 + 临时 HOME，把 lib/client.js 渲染进无头 Chromium 实际点一遍。
 *
 *   node scripts/e2e-panels.mjs            全部四段
 *   ONLY=BD node scripts/e2e-panels.mjs    只跑其中几段（A 配置快照 / B Skill 工作台 / C 提取配置 / D MCP）
 *
 * 需要本机装有 playwright 与 Chromium（不是本仓库的依赖；没有就报出来并退出码 2）。全程不碰真实 ~/.dsh 与 ~/.agents。
 * 覆盖的是全库审查第二批修掉的五处面板硬伤：导入 skill 路由、定时备份设置、提取模型下拉、MCP「去掉勾选」、
 * 详情页开关后再保存 / 页签绕过未保存确认。对修复前的代码跑这份脚本，这几项会挂。
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

let chromium;
try {
	({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
	console.error("找不到 playwright：这份脚本要用无头 Chromium（npm i -g playwright && npx playwright install chromium）");
	process.exit(2);
}
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-panel-e2e-"));
process.env.HOME = home; process.env.USERPROFILE = home; process.env.DSH_HOME = path.join(home, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = path.join(home, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = path.join(home, "telemetry");
const put = (rel, data) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
put(".agents/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Use when testing alpha\n---\n\n# Alpha\n\nbody line\n");
put(".agents/skills/beta/SKILL.md", "---\nname: beta\ndescription: Use when testing beta\n---\n\n# Beta\n");
put(".dsh/AGENTS.md", "# rules\n");
put(".dsh/dsh-studio/mcp.json", JSON.stringify({ version: 2, servers: [{ name: "demo", transport: "stdio", command: "node", args: ["x.js"], tier: "on-demand",
  tools: [{ name: "read_a", description: "reads a" }, { name: "write_b", description: "writes b" }, { name: "list_c", description: "lists c" }], toolFilter: { mode: "all", names: [] } }] }));
// 一个可导入的本地技能包
const L = (f) => path.join(repo, "lib", f);
const { packTarGz } = await import(L("snapshot.js"));
fs.writeFileSync(path.join(home, "pkg.tar.gz"), packTarGz([{ rel: "pkg/SKILL.md", data: Buffer.from("---\nname: imported-one\ndescription: Use when imported\n---\nbody\n") }]));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = { logger: quiet, skills: { list: async () => [], get: async () => null } };
const { makeRoutes } = await import(L("routes.js"));
const { buildExtractorRoutes } = await import(L("extractor-api.js"));
const { ExtractorStore } = await import(L("extractor.js"));
const { buildMcpRoutes, McpStore, McpRuntime } = await import(L("mcp.js"));
const store = new ExtractorStore();
const mcpStore = new McpStore({ logger: quiet });
const routes = [...makeRoutes(ctx, store), ...buildExtractorRoutes(ctx, store), ...buildMcpRoutes(mcpStore, new McpRuntime(quiet), { logger: quiet })];
const exact = new Map(routes.filter((r) => r.kind === "exact").map((r) => [r.path, r]));
const prefixes = routes.filter((r) => r.kind !== "exact");
const page = `<!doctype html><meta charset="utf8"><body><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>window.__captured=null;window.__ModuleLoader__={load:(m)=>{window.__captured=m}};</script>
<script src="/client.js"></script>
<script>
const mod = window.__captured.factory((id)=>({react:React})[id]);
window.__panels = {};
mod.apply({ slots: { inject: (_n, fn) => fn(), register: (meta, Comp) => { window.__panels[meta.id] = Comp; } } });
window.__mount = (id) => { const el = document.getElementById("root"); if (window.__root) window.__root.unmount(); window.__root = ReactDOM.createRoot(el); window.__root.render(React.createElement(window.__panels[id])); };
</script>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const file = { "/react.js": path.join(repo, "node_modules/react/umd/react.development.js"), "/react-dom.js": path.join(repo, "node_modules/react-dom/umd/react-dom.development.js"), "/client.js": L("client.js") }[url.pathname];
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page); }
  if (file) { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }); return res.end(fs.readFileSync(file)); }
  const route = exact.get(url.pathname) ?? prefixes.find((r) => url.pathname.startsWith(r.path));
  if (!route) { res.writeHead(404); return res.end("{}"); }
  if (url.pathname.endsWith("/extract-status") || url.pathname.endsWith("/extract/status")) {
    // 本容器没有宿主的 provider 设置：给状态响应补一份可选模型清单
    const end = res.end.bind(res);
    res.end = (body) => { try { const j = JSON.parse(body); j.availableModels = [{ provider: "deepseek", model: "chat-v4", label: "deepseek / chat-v4" }, { provider: "magpie", model: "group/x1", label: "magpie / group/x1" }]; body = JSON.stringify(j); res.setHeader?.("content-length", Buffer.byteLength(body)); } catch {} return end(body); };
  }
  try { await route.handler(req, res); } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e?.message ?? e) })); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 1000 } });
const pageErrors = []; p.on("pageerror", (e) => pageErrors.push(String(e)));
// C7：React 缺 key 的警告（开发版 React 打在 console.error 上）
const keyWarnings = []; p.on("console", (m) => { if (/unique "key" prop/.test(m.text())) keyWarnings.push(m.text().slice(0, 200)); });
const dialogs = []; let dialogAnswer = false;
p.on("dialog", async (d) => { dialogs.push(d.message()); if (dialogAnswer) await d.accept(); else await d.dismiss(); });
await p.goto(`http://127.0.0.1:${port}/`);
const results = [];
const check = (label, ok, detail = "") => { results.push(ok); console.log(ok ? "  PASS" : "  FAIL", label, detail); };
const api = (url, body) => p.evaluate(async ([u, bd]) => (await fetch(u, bd === null ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bd) })).json(), [url, body ?? null]);
const mount = async (id) => { await p.evaluate((i) => window.__mount(i), id); await p.waitForTimeout(700); };
const rootText = async () => (await p.locator("#root").innerText()).replace(/\n+/g, " | ");

const only = (process.env.ONLY ?? "ABCD");
const section = async (k, fn) => { if (!only.includes(k)) return; try { await fn(); } catch (e) { check("段 " + k + " 中途异常", false, String(e.message).split("\n")[0]); } };
await section("A", async () => {
console.log("A. 配置快照：定时备份 + 导入 skill");
await mount("skill-snapshot");
const schedBox = p.locator('label:has-text("定时备份") input[type=checkbox]');
await schedBox.click(); await p.waitForTimeout(500);
let sched = (await api("/api/dsh-studio/snapshot/schedule")).schedule;
check("勾选「定时备份」后服务端 enabled=true", sched.enabled === true, JSON.stringify(sched));
const nums = p.locator('label:has-text("定时备份") ~ input');
await nums.nth(0).fill("12", { timeout: 3000 }); await nums.nth(0).press("Enter"); await p.waitForTimeout(500);
await nums.nth(1).fill("7"); await nums.nth(1).blur(); await p.waitForTimeout(500);
sched = (await api("/api/dsh-studio/snapshot/schedule")).schedule;
check("间隔 / 保留份数失焦后保存", sched.intervalHours === 12 && sched.keep === 7, JSON.stringify(sched));
check("输入框回显服务端值", (await nums.nth(0).inputValue()) === "12" && (await nums.nth(1).inputValue()) === "7");
await p.getByPlaceholder("GitHub 地址或本地 .tar.gz 文件").fill(path.join(home, "pkg.tar.gz"));
await p.getByRole("button", { name: "导入 skill" }).click(); await p.waitForTimeout(900);
const imported = fs.existsSync(path.join(home, ".agents/skills/imported-one/SKILL.md"));
check("面板导入 skill 成功落盘", imported, (await rootText()).match(/导入[^|]*/g)?.slice(-1)[0] ?? "");
check("页面没有「store is not defined」", !(await rootText()).includes("store is not defined"));

});
await section("B", async () => {
console.log("B. Skill 工作台：开关后再保存 / 未保存确认");
await mount("skill-manager");
const skillFile = path.join(home, ".agents/skills/alpha/SKILL.md");
await p.locator(':text-is("alpha"):visible').first().click(); await p.waitForTimeout(700);
const boxes = p.locator("input[type=checkbox]:visible");
const area = p.locator("textarea:visible");
await boxes.first().click(); await p.waitForTimeout(900);
check("取消「启用」后文件带上 disable-model-invocation", fs.readFileSync(skillFile, "utf8").includes("disable-model-invocation: true"));
const afterToggle = await area.inputValue();
check("编辑框同步成磁盘上的新内容", afterToggle.includes("disable-model-invocation: true"), JSON.stringify(afterToggle.slice(0, 120)));
await area.fill(afterToggle + "\nADDED-LINE\n");
await p.getByRole("button", { name: "保存", exact: true }).click(); await p.waitForTimeout(900);
const saved = fs.readFileSync(skillFile, "utf8");
check("改正文再保存：正文生效且开关没被冲掉", saved.includes("ADDED-LINE") && saved.includes("disable-model-invocation: true") && saved.includes("user-invocable: false"), JSON.stringify(saved.slice(0, 160)));
// 脏草稿时切开关被拦
await area.fill(saved + "\nDIRTY\n");
await boxes.first().click(); await p.waitForTimeout(600);
check("草稿未保存时不许切开关", (await rootText()).includes("有未保存的改动") && fs.readFileSync(skillFile, "utf8") === saved);
// 脏草稿时点页签：先弹确认；取消则留在编辑页
dialogAnswer = false; dialogs.length = 0;
await p.locator(".dshs-chip", { hasText: "回收站" }).click(); await p.waitForTimeout(400);
check("脏草稿点「回收站」页签弹未保存确认", dialogs.length === 1, JSON.stringify(dialogs));
check("取消后仍在编辑页、草稿还在", (await area.count()) === 1 && (await area.inputValue()).includes("DIRTY"));
dialogAnswer = true;
await p.locator(".dshs-chip", { hasText: "回收站" }).click(); await p.waitForTimeout(500);
check("确认后才切走", (await p.locator("textarea:visible").count()) === 0);

});
await section("C", async () => {
console.log("C. 提取配置：模型下拉");
await mount("skill-manager");
await p.locator("summary", { hasText: "从对话里提取技能" }).click(); await p.waitForTimeout(500);
const modelSelect = p.locator("select", { has: p.locator("option", { hasText: "deepseek / chat-v4" }) });
check("下拉里有可选模型", (await modelSelect.count()) === 1);
await modelSelect.selectOption({ label: "deepseek / chat-v4" });
await p.getByRole("button", { name: /保存配置|保存设置/ }).first().click(); await p.waitForTimeout(900);
const status = await api("/api/dsh-studio/extract-status");
check("保存后服务端 provider / model 分开且正确", status.provider === "deepseek" && status.model === "chat-v4", JSON.stringify({ provider: status.provider, model: status.model }));
await mount("skill-manager");
await p.locator("summary", { hasText: "从对话里提取技能" }).click(); await p.waitForTimeout(600);
const shownLabel = await p.locator("select", { has: p.locator("option", { hasText: "deepseek / chat-v4" }) }).evaluate((el) => el.options[el.selectedIndex].textContent);
check("重新打开后下拉仍选中该模型（不是「自动」/「自定义」）", shownLabel === "deepseek / chat-v4", shownLabel);

});
await section("D", async () => {
console.log("D. MCP：工具过滤「去掉勾选」");
await mount("skill-mcp");
await p.getByRole("button", { name: /^工具 / }).click(); await p.waitForTimeout(500);
await p.locator(':text-is("去掉勾选"):visible').click(); await p.waitForTimeout(700);
const toolBox = (name) => p.locator("label", { hasText: name }).locator("input[type=checkbox]");
await toolBox("write_b").click(); await p.waitForTimeout(900);
let server = (await api("/api/dsh-studio/mcp")).servers?.find((s) => s.name === "demo");
const reg = () => JSON.parse(fs.readFileSync(path.join(home, ".dsh/dsh-studio/mcp.json"), "utf8")).servers[0].toolFilter;
check("勾选 write_b → 进入去掉名单", JSON.stringify(reg()) === JSON.stringify({ mode: "deny", names: ["write_b"] }), JSON.stringify(reg()));
check("对外工具数 3 → 2", server?.toolCount === 2, String(server?.toolCount));
check("复选框显示为已勾", await toolBox("write_b").isChecked());
await toolBox("write_b").click(); await p.waitForTimeout(900);
check("取消勾选 → 移出名单", reg().names.length === 0, JSON.stringify(reg()));

});
check("全程没有未捕获的页面错误", pageErrors.length === 0, JSON.stringify(pageErrors));
check("全程没有 React 缺 key 的警告", keyWarnings.length === 0, JSON.stringify(keyWarnings.slice(0, 2)));
console.log(results.every(Boolean) ? "\nALL PASS " + results.length : "\nFAILED " + results.filter((x) => !x).length + "/" + results.length);
await b.close();
server.close();
fs.rmSync(home, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
