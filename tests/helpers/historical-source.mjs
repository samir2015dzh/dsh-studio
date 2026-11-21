// 历史对拍是可选的；缺对象不等于当前功能断言可以整体退出成功。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
export function historicalSource(ref, file) {
	const result = spawnSync("git", ["show", `${ref}:${file}`], {
		cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", maxBuffer: 16 * 1024 * 1024
	});
	return result.status === 0 ? result.stdout : null;
}
