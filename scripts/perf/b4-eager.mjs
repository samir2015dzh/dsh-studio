#!/usr/bin/env node
/**
 * B4 量测：N 台 eager server（假 MCP，每台握手慢 D 毫秒）冷启动建 eager 工具的总耗时。
 *   node scripts/perf/b4-eager.mjs [--lib <lib 目录>] [--servers 7] [--delay 800]
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (name, dflt) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : dflt;
};
const here = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(arg("--lib", join(here, "..", "..", "lib")));
const N = Number(arg("--servers", 7));
const D = Number(arg("--delay", 800));
const mock = join(here, "..", "..", "tests", "fixtures", "mock-mcp-server.mjs");
const home = await mkdtemp(join(tmpdir(), "b4-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_HOME = join(home, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(home, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(home, "telemetry");
const mcp = await import(pathToFileURL(join(libDir, "mcp.js")).href);
await mkdir(dirname(mcp.storePath()), { recursive: true });
const servers = Array.from({ length: N }, (_, i) => ({ name: `e${i}`, command: process.execPath, args: [mock], env: { MOCK_MCP_INIT_DELAY_MS: String(D) }, tier: "eager" }));
await writeFile(mcp.storePath(), JSON.stringify({ version: 2, servers }, null, 2));
const quiet = { info() {}, warn() {}, error() {} };
const runtime = new mcp.McpRuntime(quiet);
const s = performance.now();
const tools = await mcp.buildEagerTools(new mcp.McpStore({ logger: quiet }), runtime);
console.log(`lib = ${libDir}\n${N} 台 eager，每台握手慢 ${D} ms：建 ${tools.length} 个工具用了 ${Math.round(performance.now() - s)} ms`);
await runtime.closeAll();
await rm(home, { recursive: true, force: true });
