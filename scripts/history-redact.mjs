#!/usr/bin/env node
/**
 * ：版本史里注册表旧版本的内嵌凭据重新脱敏——预演 / 执行 / 自检脚本。
 *
 * 插件启动 2 分钟后会自动做一次（之后每天随版本史保留一起），本脚本用于先在真机历史副本上预演：
 *   1. 把真机 `~/.dsh-studio/history` 整个复制一份，例如到 D:\tmp\history-copy
 *   2. node scripts/history-redact.mjs --dir D:\tmp\history-copy            # 只预演（零写入）
 *   3. node scripts/history-redact.mjs --dir D:\tmp\history-copy --apply    # 在副本上执行，再自检
 *
 * 自检：执行后再预演一遍须为 0 份待改；版本史自检（verifyVersionRetention）无缺失对象；
 * 每条注册表版本的对象都能取出且 sha 相符（= 仍可回滚）。
 * 参数：--dir <版本史目录>（必填，防止误跑到真机）  --apply
 * 退出码：0 通过；1 自检未过；2 参数错误。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const i = args.indexOf("--dir");
const dir = i >= 0 ? args[i + 1] : undefined;
if (!dir || !existsSync(dir)) {
	console.error("需要 --dir <版本史目录副本>（存在的目录）。本脚本不默认指向真机目录。");
	process.exit(2);
}
process.env.DSH_STUDIO_HISTORY_DIR = resolve(dir);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v = await import(pathToFileURL(join(root, "lib/versions.js")).href);
const show = (label, obj) => console.log(label + " " + JSON.stringify(obj, null, 2));

const plan = await v.redactRegistryHistory({ dryRun: true });
show("预演：", plan);
if (!args.includes("--apply")) {
	console.log("（未加 --apply：只预演，零写入）");
	process.exit(plan.missingObjects.length === 0 ? 0 : 1);
}
show("执行：", await v.redactRegistryHistory());
const again = await v.redactRegistryHistory({ dryRun: true });
show("执行后再预演（待改须为 0）：", again);
const check = await v.verifyVersionRetention();
show("版本史自检：", check);
let unreadable = 0;
for (const rec of await v.readVersionRecords()) {
	if (rec.key !== v.REGISTRY_KEY || rec.state?.exists !== true) continue;
	try {
		JSON.parse((await v.getObject(rec.state.sha)).toString("utf8"));
	} catch {
		unreadable += 1;
	}
}
console.log(`注册表版本对象取不出 / 解析不了：${unreadable}`);
const ok = again.objectsRewritten === 0 && check.missingObjects.length === 0 && unreadable === 0;
console.log(ok ? "通过" : "未通过");
process.exit(ok ? 0 : 1);
