#!/usr/bin/env node
/**
 * 版本史保留口径的对拍 / 执行脚本（：每 key 保留最近 200 条，objects/ 按引用 GC）。
 *
 * 验收用法（真机历史副本，不碰真机原件）：
 *   1. 把真机 `~/.dsh-studio/history` 整个复制一份，例如到 D:\tmp\history-copy
 *   2. node scripts/history-retention.mjs --dir D:\tmp\history-copy            # 只预演 + 自检（零写入）
 *   3. node scripts/history-retention.mjs --dir D:\tmp\history-copy --apply    # 在副本上执行保留，再自检 + 回滚抽验
 *
 * 输出：执行前后记录数 / 每 key 最大条数 / 对象数 / 被引用对象数 / 缺失对象（应为 0），
 * 以及回滚抽验：每个 key 取保留窗口里最老、最新两条，逐个确认其引用的对象都能取出且 sha 相符
 * （= 该版本仍可回滚；不真的写回技能文件）。
 *
 * 参数：--dir <版本史目录>（必填，防止误跑到真机）  --keep <N>（默认 200）  --apply  --grace-ms <N>（对象 GC 宽限，默认 3600000）
 * 退出码：0 通过；1 自检未过；2 参数错误。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const dir = value("--dir");
if (!dir || !existsSync(dir)) {
	console.error("需要 --dir <版本史目录副本>（存在的目录）。本脚本不默认指向真机目录。");
	process.exit(2);
}
process.env.DSH_STUDIO_HISTORY_DIR = resolve(dir);
const keep = value("--keep") ? Number(value("--keep")) : undefined;
const graceMs = value("--grace-ms") ? Number(value("--grace-ms")) : undefined;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v = await import(pathToFileURL(join(root, "lib/versions.js")).href);

const show = (label, obj) => console.log(label + " " + JSON.stringify(obj, null, 2));

const before = await v.verifyVersionRetention({ keep });
show("执行前自检：", before);
const plan = await v.applyVersionRetention({ keep, graceMs, dryRun: true });
show("保留预演：", plan);
if (!flag("--apply")) {
	console.log("（未加 --apply：只预演，零写入）");
	process.exit(before.missingObjects.length === 0 ? 0 : 1);
}
const done = await v.applyVersionRetention({ keep, graceMs });
show("执行结果：", done);
const after = await v.verifyVersionRetention({ keep });
show("执行后自检：", after);

// 回滚抽验：每个 key 保留窗口里最老、最新两条，引用的对象都能取出
const records = await v.readVersionRecords();
const byKey = new Map();
for (const rec of records) {
	const list = byKey.get(rec.key) ?? [];
	list.push(rec);
	byKey.set(rec.key, list);
}
let checked = 0;
const broken = [];
for (const [key, list] of byKey) {
	for (const rec of new Set([list[0], list.at(-1)])) {
		if (rec.state?.exists !== true) continue;
		const shas = [rec.state.sha, ...Object.values(rec.state.files ?? {}).filter((f) => f?.stored === true).map((f) => f.sha)].filter(Boolean);
		for (const sha of shas) {
			try {
				await v.getObject(sha);
			} catch (error) {
				broken.push({ key, id: rec.id, sha, error: error instanceof Error ? error.message : String(error) });
			}
		}
		checked += 1;
	}
}
show("回滚抽验：", { checkedVersions: checked, broken });
const pass = after.ok && broken.length === 0 && after.records === done.kept;
console.log(pass ? "✅ 保留口径与回滚能力一致" : "❌ 自检未过");
process.exit(pass ? 0 : 1);
