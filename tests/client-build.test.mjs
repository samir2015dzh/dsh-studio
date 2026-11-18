/**
 * 客户端包的构建：lib/client.js 必须能由 src/client 原样生成。
 * 谁直接改了 lib/client.js 而没改源码（或反过来忘了重新生成），这里会红。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { buildClient, parseClientSource, CLIENT_FILES } = await import(pathToFileURL(join(pluginRoot, "scripts/build-client.mjs")).href);

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};
const throws = (fn, pattern) => {
	try {
		fn();
		return false;
	} catch (error) {
		return pattern.test(String(error?.message ?? error));
	}
};

console.log("\n[1] 产物与源码一致");
{
	const current = readFileSync(join(pluginRoot, "lib/client.js"), "utf8");
	assert(buildClient() === current, "lib/client.js 与 src/client 生成结果逐字节一致（不一致就运行 npm run build:client）");
	const onDisk = readdirSync(join(pluginRoot, "src/client")).filter((name) => name.endsWith(".js")).sort();
	assert(JSON.stringify(onDisk) === JSON.stringify([...CLIENT_FILES].sort()), "src/client 下的文件与 CLIENT_FILES 一一对应（没有漏拼的源文件）");
	assert(current.startsWith("window.__ModuleLoader__.load({\n\tid: \"dsh-studio\",\n\tfactory: (require) => {\n"), "保持宿主的加载器外壳");
	assert(current.endsWith("\t\texports.apply = apply;\n\t\texports.inject = inject;\n\t\treturn module.exports;\n\t}\n});\n"), "包导出 apply 与 inject");
	for (const file of CLIENT_FILES) assert(current.includes(`\t\t//#region src/client/${file}\n`), `产物里有 ${file} 的区域标记，可对回源码`);
}

console.log("\n[2] 源文件各自语法正确，自检通过");
{
	for (const file of CLIENT_FILES) {
		const r = spawnSync(process.execPath, ["--check", join(pluginRoot, "src/client", file)], { encoding: "utf8" });
		assert(r.status === 0, `node --check src/client/${file}`);
	}
	const check = spawnSync(process.execPath, [join(pluginRoot, "scripts/check-client.mjs")], { encoding: "utf8" });
	assert(check.status === 0, "scripts/check-client.mjs 通过：" + String(check.stdout).trim().split("\n").pop());
	const upToDate = execFileSync(process.execPath, [join(pluginRoot, "scripts/build-client.mjs"), "--check"], { encoding: "utf8" });
	assert(/一致/.test(upToDate), "build-client.mjs --check 退出码 0");
}

console.log("\n[3] 源文件约定的校验");
{
	const ok = parseClientSource("x.js", 'import * as React from "react";\nimport { h } from "./ui-base.js";\n\nfunction A() {\n\treturn h("div");\n}\n\nexport { A };\n');
	assert(JSON.stringify(ok.imports) === JSON.stringify(["react", "./ui-base.js"]) && ok.exported.join() === "A" && ok.body.length === 3, "拆出 import 来源、正文、导出名");
	const bare = parseClientSource("x.js", "const a = 1;\n");
	assert(bare.imports.length === 0 && bare.exported.length === 0 && bare.body.join() === "const a = 1;", "没有 import / export 的文件原样通过");
	assert(throws(() => parseClientSource("x.js", 'import { h } from "./ui-base.js";\nconst a = 1;\n'), /空一行/), "import 后不空行 → 报错");
	assert(throws(() => parseClientSource("x.js", "const a = 1;\nexport { a };\n"), /空一行/), "export 前不空行 → 报错");
	assert(throws(() => parseClientSource("x.js", "const a = 1;\nexport const b = 2;\nconst c = 3;\n"), /顶格的 import \/ export/), "正文里顶格的 export → 报错");
	assert(throws(() => parseClientSource("x.js", "const a = 1;\r\n"), /CR/), "CRLF 换行 → 报错");
	assert(throws(() => parseClientSource("x.js", "const a = 1;"), /末尾缺换行/), "末尾没换行 → 报错");

	const files = { "api.js": "const a = 1;\n\nexport { a };\n" };
	const read = (file) => files[file] ?? readFileSync(join(pluginRoot, "src/client", file), "utf8");
	files["api.js"] = 'import { h } from "./ui-base.js";\n\nconst a = 1;\n';
	assert(throws(() => buildClient(read), /排在后面/), "依赖了排在后面的文件 → 报错（拼接后是顺序执行）");
	files["api.js"] = 'import { z } from "./nope.js";\n\nconst a = 1;\n';
	assert(throws(() => buildClient(read), /不在 CLIENT_FILES/), "引用了清单外的文件 → 报错");
}

if (failed > 0) {
	console.error(`\n${failed} 项失败`);
	process.exit(1);
}
console.log("\n全部通过");
