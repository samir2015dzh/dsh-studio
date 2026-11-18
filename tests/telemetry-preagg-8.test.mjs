/**
 * 审计 4：遥测统计按日预聚合——与直读口径逐项对拍；第二次统计只读增量日；
 * 日文件变了（mtime / size）缓存失效；缓存坏了自动重算；被清掉的日子缓存跟着清。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { computeStats, computeStatsDirect, statsCounters } = await import(pathToFileURL(join(pluginRoot, "lib/telemetry.js")).href);

const DAY = 86_400_000;
const p2 = (n) => String(n).padStart(2, "0");
const localDay = (t) => {
	const d = new Date(t);
	return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

// 可复现的伪随机
let seed = 20261116;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

function makeEvent(t) {
	const type = pick(["skill.trigger", "skill.inject", "mcp.call", "mcp.call", "catalog.outcome", "mcp.load", "mcp.unload", "mcp.verify", "mcp.breaker", "mcp.registry"]);
	const ev = { v: 1, ts: new Date(t).toISOString(), type, sid: pick(["s1", "s2", "s3", "s4"]) };
	const server = pick(["rea", "memory-bank", "docbase", "baimiao"]);
	if (type.startsWith("skill.")) Object.assign(ev, { skill: pick(["a", "b", "c", "d", "e"]), ok: rnd() > 0.2 });
	else if (type === "mcp.call") Object.assign(ev, { server, tool: pick(["search", "read", "write"]), ok: rnd() > 0.3, ms: rnd() > 0.1 ? Math.round(rnd() * 900) : undefined, err: pick(["timeout", "network", undefined]), via: pick(["mcp_call", "native", undefined]) });
	else if (type === "catalog.outcome") {
		const shown = ["rea", "memory-bank", "docbase"].filter(() => rnd() > 0.3);
		Object.assign(ev, { shown, used: shown.filter(() => rnd() > 0.5) });
	} else if (type === "mcp.load") Object.assign(ev, { server, ok: rnd() > 0.2 });
	else if (type === "mcp.unload") Object.assign(ev, { server, cause: pick(["idle", "reload", undefined]) });
	else if (type === "mcp.verify") Object.assign(ev, { server, state: pick(["verified", "failed"]) });
	else if (type === "mcp.breaker") Object.assign(ev, { server, state: pick(["open", "half-open", "closed"]) });
	else Object.assign(ev, { server, action: "edit" });
	return ev;
}

const dir = mkdtempSync(join(tmpdir(), "telemetry-preagg-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const NOW = new Date(2026, 10, 16, 15, 37, 12).getTime();
const write = (t, ev = makeEvent(t)) => appendFileSync(join(dir, `events-${localDay(t)}.jsonl`), JSON.stringify(ev) + "\n");
for (let d = 100; d >= 0; d -= 1) {
	const n = Math.floor(rnd() * 25);
	const dayStart = new Date(new Date(NOW - d * DAY).setHours(0, 0, 0, 0)).getTime();
	for (let i = 0; i < n; i += 1) {
		const t = dayStart + Math.floor(rnd() * DAY);
		if (t <= NOW) write(t);
	}
}
// 坏行 + 日文件里混了别的日子的事件（时区 / 时钟变动），以及 ts 不合法的行
appendFileSync(join(dir, `events-${localDay(NOW - 20 * DAY)}.jsonl`), "{not json\n");
write(NOW - 20 * DAY, { ...makeEvent(NOW - 40 * DAY), ts: new Date(NOW - 40 * DAY).toISOString() });
appendFileSync(join(dir, `events-${localDay(NOW - 5 * DAY)}.jsonl`), JSON.stringify({ type: "skill.trigger", skill: "a", ts: "nope" }) + "\n");

const same = async (opts, label) => {
	const cached = await computeStats({ dir, retentionDays: 90, ...opts });
	const direct = await computeStatsDirect({ dir, retentionDays: 90, ...opts });
	assert.deepStrictEqual(cached, direct, label);
	assert.equal(JSON.stringify(cached), JSON.stringify(direct), label + "（序列化后也逐字节一致）");
	return cached;
};

test("[#8 审计 4] 预聚合与直读口径逐项对拍（多个 now × 多个周数）", async () => {
	for (const now of [NOW, NOW - 3 * DAY - 5_000, NOW - 0.5 * DAY, NOW + 2 * DAY]) {
		for (const weeks of [1, 4, 13]) await same({ now, weeks }, `now=${new Date(now).toISOString()} weeks=${weeks}`);
	}
	const r = await same({ now: NOW, weeks: 13 }, "整季");
	assert.ok(r.events > 500 && r.badLines === 1);
});

test("[#8 审计 4] 第二次统计只读增量日：今天 + 窗口边界日；日文件变了才重算", async () => {
	await computeStats({ dir, now: NOW, weeks: 4, retentionDays: 90 });
	const before = { ...statsCounters };
	await same({ now: NOW, weeks: 4 }, "缓存命中后仍对拍");
	// same() 里直读那一遍会读全部日文件；只看缓存那一遍：再跑一次单独数
	const b2 = { ...statsCounters };
	await computeStats({ dir, now: NOW, weeks: 4, retentionDays: 90 });
	const reads = statsCounters.rawDayReads - b2.rawDayReads;
	assert.ok(reads <= 4 + 2, `缓存路径只读今天与窗口边界日（实际 ${reads} 个日文件，共 ${readdirSync(dir).filter((n) => n.endsWith(".jsonl")).length} 个）`);
	assert.ok(statsCounters.aggHits > before.aggHits);
	assert.ok(existsSync(join(dir, ".agg")), "预聚合落盘");
	// 改一个老日子（size 变）→ 只那一天重算，结果仍对拍
	const builds = statsCounters.aggBuilds;
	write(NOW - 30 * DAY + 3_600_000);
	await same({ now: NOW, weeks: 13 }, "老日子追加事件后");
	assert.ok(statsCounters.aggBuilds > builds);
	// 磁盘缓存坏了：重算、不报错（新进程视角：清空进程内缓存做不到，只验证坏文件被覆盖后仍对拍）
	for (const n of readdirSync(join(dir, ".agg")).slice(0, 3)) writeFileSync(join(dir, ".agg", n), "garbage");
	await same({ now: NOW, weeks: 13 }, "磁盘缓存坏了");
});

test("[#8 审计 4] 按会话过滤走直读口径；被清掉的日子缓存跟着清", async () => {
	const a = await computeStats({ dir, now: NOW, weeks: 2, retentionDays: 90, sid: "s2" });
	const b = await computeStatsDirect({ dir, now: NOW, weeks: 2, retentionDays: 90, sid: "s2" });
	assert.deepStrictEqual(a, b);
	const old = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()[0];
	await computeStats({ dir, now: NOW, weeks: 1, retentionDays: 120 });
	assert.ok(existsSync(join(dir, ".agg", old + ".json")));
	rmSync(join(dir, old));
	await computeStats({ dir, now: NOW, weeks: 1, retentionDays: 120 });
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(existsSync(join(dir, ".agg", old + ".json")), false);
	mkdirSync(join(dir, ".agg"), { recursive: true });
});
