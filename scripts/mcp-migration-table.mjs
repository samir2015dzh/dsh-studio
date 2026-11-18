#!/usr/bin/env node
/**
 * MCP 注册表迁移对照表。只读：不写 mcp.json、不写版本史。
 *
 * 三种用法：
 *   node scripts/mcp-migration-table.mjs [mcp.json]          还没迁移：按 v1→v2 迁移规则干跑，打印前后对照
 *   node scripts/mcp-migration-table.mjs --history           已经迁移：从版本史取最近一条 registry-migrate
 *                                                           记录与它的上一版（两份都是脱敏后的对象）对照
 *   node scripts/mcp-migration-table.mjs --before a.json --after b.json   任意两份注册表对照（如备份 vs 现状）
 *
 * 输出 markdown 表：每个 server × 每个字段一行，结论 same / added（迁移新增字段）/ changed / missing；
 * 凭据类键的值一律打码（同值比较在打码前做）。最后一行给总判定「逐项等价：是 / 否」。
 * 退出码：等价 0，不等价 1，用法 / 读取错误 2。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { compareMigration, migrateRegistry } from "../lib/mcp-migrate.js";
import { SENSITIVE_KEY, maskSecret } from "../lib/redact.js";

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};
const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

function maskDeep(value, key = "") {
	if (typeof value === "string") return SENSITIVE_KEY.test(key) && value !== "" && !/^«.*»$/.test(value) ? maskSecret(value) : value;
	if (Array.isArray(value)) return value.map((v) => maskDeep(v, key));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, k)]));
	return value;
}
const cell = (value, field) => {
	if (value === undefined) return "—";
	const text = JSON.stringify(maskDeep(value, field));
	const clipped = text.length > 70 ? text.slice(0, 69) + "…" : text;
	return "`" + clipped.replace(/\|/g, "\\|").replace(/`/g, "'") + "`";
};

async function load() {
	if (argv.includes("--history")) {
		const { readVersionRecords, getObject, REGISTRY_KEY } = await import("../lib/versions.js");
		const records = (await readVersionRecords()).filter((r) => r.key === REGISTRY_KEY);
		const migrate = [...records].reverse().find((r) => r.action === "registry-migrate");
		if (migrate === undefined) throw new Error("版本史里没有 registry-migrate 记录（还没迁移？去掉 --history 干跑）");
		const parent = records.find((r) => r.id === migrate.parent);
		if (parent === undefined || parent.state?.exists !== true) throw new Error(`迁移记录 ${migrate.id} 的上一版 ${migrate.parent} 不可用`);
		const before = JSON.parse((await getObject(parent.state.sha)).toString("utf8"));
		const after = JSON.parse((await getObject(migrate.state.sha)).toString("utf8"));
		return { before, after, label: `版本史：${parent.id} → ${migrate.id}（${migrate.at}）` };
	}
	const beforeFile = flag("--before");
	const afterFile = flag("--after");
	if (beforeFile !== undefined || afterFile !== undefined) {
		if (beforeFile === undefined || afterFile === undefined) throw new Error("--before 与 --after 要成对给");
		return { before: readJson(beforeFile), after: readJson(afterFile), label: `${beforeFile} → ${afterFile}` };
	}
	const file = argv.find((a) => !a.startsWith("--")) ?? resolve(homedir(), ".dsh", "dsh-studio", "mcp.json");
	const before = readJson(file);
	const after = migrateRegistry(before);
	if (after === null) throw new Error(`${file} 已经是 schema v${before.version}，不需要迁移；看迁移那一刻的对照用 --history`);
	return { before, after, label: `${file}（干跑，未写盘）` };
}

try {
	const { before, after, label } = await load();
	const { equivalent, rows } = compareMigration(before, after);
	const servers = [...new Set(rows.map((r) => r.server))];
	const out = [
		`# MCP 注册表迁移对照`,
		"",
		`来源：${label}`,
		`schema：v${before.version ?? 1} → v${after.version ?? "?"}；server 数：${(before.servers ?? []).length} → ${(after.servers ?? []).length}`,
		"",
		"| server | 字段 | 迁移前 | 迁移后 | 结论 |",
		"| --- | --- | --- | --- | --- |"
	];
	for (const r of rows) out.push(`| ${r.server} | ${r.field} | ${cell(r.before, r.field)} | ${cell(r.after, r.field)} | ${r.verdict} |`);
	out.push("");
	for (const name of servers) {
		const mine = rows.filter((r) => r.server === name);
		const changed = mine.filter((r) => r.verdict === "changed" || r.verdict === "missing").map((r) => r.field);
		const added = mine.filter((r) => r.verdict === "added").map((r) => r.field);
		out.push(`- ${name}：${mine.length} 个字段，${changed.length === 0 ? "原有字段全部相同" : "**有变化：" + changed.join("、") + "**"}${added.length > 0 ? "；新增 " + added.join("、") : ""}`);
	}
	out.push("", `**逐项等价：${equivalent ? "是" : "否"}**`);
	process.stdout.write(out.join("\n") + "\n");
	process.exit(equivalent ? 0 : 1);
} catch (error) {
	process.stderr.write("mcp-migration-table：" + (error instanceof Error ? error.message : String(error)) + "\n");
	process.exit(2);
}
