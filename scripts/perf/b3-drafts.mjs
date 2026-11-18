#!/usr/bin/env node
/**
 * B3 量测：草稿目录积累到 N 份（默认 2000，绝大多数是终局草稿）时，
 * 蒸馏的 listDrafts（每轮提取的 ingest、每次状态查询、闲时检查都要走）第一次 / 之后各次的耗时。
 *
 *   node scripts/perf/b3-drafts.mjs [--lib <lib 目录>] [--drafts 2000]
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, dflt) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : dflt;
};
const libDir = resolve(arg("--lib", new URL("../../lib", import.meta.url).pathname));
const N = Number(arg("--drafts", 2000));
const home = await mkdtemp(join(tmpdir(), "b3-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_STUDIO_DISTILL_DIR = join(home, "distill");
const dir = join(home, "distill", "drafts");
await mkdir(dir, { recursive: true });
for (let i = 0; i < N; i += 1) {
	const id = `draft-${String(i).padStart(6, "0")}-x`;
	const status = i % 40 === 0 ? "queued" : ["published", "failed", "discarded", "merged"][i % 4];
	await writeFile(join(dir, id + ".json"), JSON.stringify({ v: 1, id, status, createdAt: new Date().toISOString(), name: `s-${i}`, body: "步骤\n".repeat(200), text: "x".repeat(2000), sha: String(i), provenance: { sessions: [{ id: "s", turns: [] }] }, history: [{ change: "queued" }] }, null, 2));
}
const { createDistill } = await import(pathToFileURL(join(libDir, "distill.js")).href);
const d = createDistill({ pluginConfig: {}, logger: null });
const t = async (label, fn, n = 1) => {
	const times = [];
	for (let i = 0; i < n; i += 1) {
		const s = performance.now();
		await fn();
		times.push(performance.now() - s);
	}
	times.sort((a, b) => a - b);
	console.log(`${label.padEnd(30)} ${times[Math.floor(n / 2)].toFixed(1).padStart(8)} ms (n=${n})`);
};
console.log(`lib = ${libDir}\n草稿 ${N} 份`);
await t("listDrafts 第一次", () => d.listDrafts());
await t("listDrafts 之后", () => d.listDrafts(), 5);
await t("listDrafts({status:queued}) 之后", () => d.listDrafts({ status: "queued" }), 5);
await rm(home, { recursive: true, force: true });
