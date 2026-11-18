// 从 src/client/*.js 生成 lib/client.js（设置面板的客户端包）。
//
//   node scripts/build-client.mjs            重新生成 lib/client.js
//   node scripts/build-client.mjs --check    只比对，不写盘；lib/client.js 与源码不一致时退出码 1
//
// 为什么不用打包器：宿主通过 window.__ModuleLoader__.load({ id, factory }) 加载这个文件，
// scripts/check-client.mjs 与 tests/boot.test.mjs 也都按现在的排版读它。这里做的事很简单 ——
// 按固定顺序把各源文件去掉 import / export 后拼进同一个 factory 作用域，产物可逐行对回源码。
//
// 源文件的约定（构建时会校验，不满足就报错）：
//   - 开头是若干行 `import … from "…";`，后跟一个空行（没有 import 就直接是正文）
//   - 结尾可以有一行 `export { a, b };`，前面隔一个空行
//   - 正文里不能再出现顶格的 import / export
//   - 所有文件共用一个作用域，顶层名字不能重复
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = join(root, "src", "client");
const OUT_FILE = join(root, "lib", "client.js");

/** 拼接顺序 = 依赖顺序（被依赖的在前）；最后一个是入口，它的 export 就是包的导出。 */
export const CLIENT_FILES = [
	"api.js",
	"ui-base.js",
	"skill-widgets.js",
	"McpPanel.js",
	"ExtractorPanel.js",
	"SnapshotPanel.js",
	"skill-dialogs.js",
	"SkillManagerPanel.js",
	"index.js"
];

const IMPORT_LINE = /^import .+ from "(.+)";$/;
const EXPORT_LINE = /^export \{ (.+) \};$/;
const INDENT = "\t\t";

/** 拆出一个源文件的 import 来源、正文行、导出名。 */
export function parseClientSource(file, text) {
	if (text.includes("\r")) throw new Error(`${file}: 含 CR 换行，请保持 LF`);
	if (!text.endsWith("\n")) throw new Error(`${file}: 文件末尾缺换行`);
	const lines = text.slice(0, -1).split("\n");
	const imports = [];
	let start = 0;
	while (start < lines.length && IMPORT_LINE.test(lines[start])) {
		imports.push(lines[start].match(IMPORT_LINE)[1]);
		start += 1;
	}
	if (imports.length > 0) {
		if (lines[start] !== "") throw new Error(`${file}: import 之后要空一行`);
		start += 1;
	}
	let end = lines.length;
	let exported = [];
	if (end > start && EXPORT_LINE.test(lines[end - 1])) {
		exported = lines[end - 1].match(EXPORT_LINE)[1].split(",").map((name) => name.trim());
		if (lines[end - 2] !== "") throw new Error(`${file}: export 之前要空一行`);
		end -= 2;
	}
	const body = lines.slice(start, end);
	if (body.length === 0 || body[0] === "" || body[body.length - 1] === "") throw new Error(`${file}: 正文不能以空行开头或结尾`);
	const stray = body.findIndex((line) => /^(import|export)\b/.test(line));
	if (stray !== -1) throw new Error(`${file}: 正文第 ${stray + 1} 行有顶格的 import / export（import 只能放开头，export 只能放最后一行）`);
	return { imports, body, exported };
}

/** 生成 lib/client.js 的全文。read(file) 返回 src/client 下某个文件的文本。 */
export function buildClient(read = (file) => readFileSync(join(SRC_DIR, file), "utf8")) {
	const out = [
		"window.__ModuleLoader__.load({",
		'\tid: "dsh-studio",',
		"\tfactory: (require) => {",
		`${INDENT}var module = { exports: {} };`,
		`${INDENT}var exports = module.exports;`,
		`${INDENT}Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
		`${INDENT}let React = require("react");`
	];
	const seen = new Set();
	let entryExports = [];
	for (const file of CLIENT_FILES) {
		const { imports, body, exported } = parseClientSource(file, read(file));
		for (const source of imports) {
			if (source === "react") continue;
			const dep = source.replace(/^\.\//, "");
			if (!CLIENT_FILES.includes(dep)) throw new Error(`${file}: 引用了不在 CLIENT_FILES 里的 ${source}`);
			// 拼接后是同一个作用域里的顺序执行：依赖必须排在前面
			if (!seen.has(dep)) throw new Error(`${file}: 依赖 ${source}，但它在 CLIENT_FILES 里排在后面`);
		}
		seen.add(file);
		out.push(`${INDENT}//#region src/client/${file}`);
		for (const line of body) out.push(line === "" ? "" : INDENT + line);
		out.push(`${INDENT}//#endregion`);
		entryExports = exported;
	}
	if (entryExports.length === 0) throw new Error("入口文件没有 export");
	for (const name of entryExports) out.push(`${INDENT}exports.${name} = ${name};`);
	out.push(`${INDENT}return module.exports;`, "\t}", "});", "");
	return out.join("\n");
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const next = buildClient();
	if (process.argv.includes("--check")) {
		let current = "";
		try {
			current = readFileSync(OUT_FILE, "utf8");
		} catch {
			/* 文件不存在按不一致处理 */
		}
		if (current !== next) {
			const a = current.split("\n");
			const b = next.split("\n");
			let i = 0;
			while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
			console.error(`lib/client.js 与 src/client 不一致（第 ${i + 1} 行起）。请改 src/client 后运行 npm run build:client，不要直接改 lib/client.js。`);
			process.exit(1);
		}
		console.log(`lib/client.js 与 src/client 一致（${CLIENT_FILES.length} 个源文件）`);
	} else {
		writeFileSync(OUT_FILE, next, "utf8");
		console.log(`已生成 lib/client.js（${CLIENT_FILES.length} 个源文件，${next.split("\n").length - 1} 行）`);
	}
}
