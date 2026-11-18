/**
 * Windows 上 spawn `.cmd` / `.bat` 垫片（审计 6）。
 *
 * 问题：Node 的 child_process.spawn 不走 shell 时**不按 PATHEXT 解析**命令名——注册表里写 `npx`、`uvx`、
 * `pnpm` 这类命令，在 Windows 上真身是 `npx.cmd`，直接 spawn("npx") 报 ENOENT；就算写成 `npx.cmd`，
 * 新版 Node（CVE-2024-27980 之后）也拒绝不经 shell 直接起 .cmd/.bat（EINVAL）。正确做法是解析出真实路径，
 * 命中 .cmd/.bat 时经 `cmd.exe /d /s /c "<整行>"` 起，并对每个参数做 cmd 元字符转义。
 *
 * 转义规则照抄 cross-spawn（MIT，https://github.com/moxystudio/node-cross-spawn lib/util/escape.js 与
 * lib/parse.js）：参数先按 MSVCRT 规则给反斜杠 / 双引号转义并整体加引号，再给 cmd 元字符加 `^`；
 * node_modules/.bin 下的 cmd-shim 垫片会把参数再交给一层 cmd，所以元字符要转义两次。
 *
 * 纯函数（平台、环境、文件存在判断都可注入），便于在非 Windows 上测试；非 Windows 原样返回。
 */
import { existsSync, statSync } from "node:fs";
import { win32 } from "node:path";

const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
const CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** cmd 命令名转义：元字符前加 ^。 */
export function escapeCommand(command) {
	return String(command).replace(META_CHARS, "^$1");
}

/** cmd 参数转义（cross-spawn 口径）。 */
export function escapeArgument(arg, doubleEscapeMetaChars = false) {
	let s = String(arg);
	// MSVCRT：引号前的反斜杠翻倍，引号本身 \"
	s = s.replace(/(\\*)"/g, '$1$1\\"');
	// 结尾的反斜杠翻倍（后面要补一个收尾引号）
	s = s.replace(/(\\*)$/, "$1$1");
	s = `"${s}"`;
	s = s.replace(META_CHARS, "^$1");
	if (doubleEscapeMetaChars) s = s.replace(META_CHARS, "^$1");
	return s;
}

const envGet = (env, name) => {
	if (!env) return undefined;
	if (env[name] !== undefined) return env[name];
	const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
	return key === undefined ? undefined : env[key];
};

const isFileDefault = (p) => {
	try {
		return existsSync(p) && statSync(p).isFile();
	} catch {
		return false;
	}
};

/**
 * 按 PATH × PATHEXT 解析命令（Windows 口径：win32 路径规则、PATH 用 `;` 分隔，先查 cwd）。找不到返回 null。
 * 命令已带路径：只在那个位置按扩展名补齐；已带 PATHEXT 里的扩展名：只认原样。
 *
 * 候选顺序：先在**所有**目录里按 PATHEXT 补扩展名找，全落空才回头认无扩展名的同名文件兜底。
 * Windows 自己从不执行无扩展名文件；npm 在 nodejs 目录里放的 `npx`（sh 脚本）与 `npx.cmd` 并存，
 * 若让无扩展名先命中，planSpawn 会把 sh 脚本直接交给 spawn → ENOENT（真机实录）。
 */
export function resolveWindowsCommand(command, options = {}) {
	const env = options.env ?? process.env;
	const isFile = options.isFile ?? isFileDefault;
	const cwd = options.cwd && options.cwd !== "" ? options.cwd : process.cwd();
	const exts = String(envGet(env, "PATHEXT") ?? DEFAULT_PATHEXT)
		.split(";")
		.map((e) => e.trim())
		.filter((e) => e !== "");
	const cmd = String(command);
	const hasExt = exts.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase()));
	let bases;
	if (/[\\/]/.test(cmd) || win32.isAbsolute(cmd)) {
		bases = [win32.isAbsolute(cmd) ? cmd : win32.resolve(cwd, cmd)];
	} else {
		const dirs = [cwd, ...String(envGet(env, "PATH") ?? "").split(";")].filter((d) => d !== "");
		bases = dirs.map((dir) => win32.join(dir.replace(/^"(.*)"$/, "$1"), cmd));
	}
	if (hasExt) return bases.find((b) => isFile(b)) ?? null;
	for (const base of bases) {
		const hit = exts.map((e) => base + e).find((c) => isFile(c));
		if (hit) return hit;
	}
	// 兜底：没有任何 PATHEXT 候选时，才认无扩展名的同名文件（既有行为）
	return bases.find((b) => isFile(b)) ?? null;
}

/**
 * 算出真正交给 spawn 的 {command, args, options 增量, resolved, shim}。
 * @param {string} command 注册表里的命令
 * @param {string[]} args
 * @param {{platform?: string, env?: object, cwd?: string, isFile?: (p: string) => boolean}} [options]
 */
export function planSpawn(command, args = [], options = {}) {
	const platform = options.platform ?? process.platform;
	const list = Array.isArray(args) ? args.map(String) : [];
	if (platform !== "win32") return { command, args: list, extra: {}, resolved: null, shim: false };
	const resolved = resolveWindowsCommand(command, { ...options, platform });
	const target = resolved ?? String(command);
	if (!/\.(cmd|bat)$/i.test(target)) {
		// .exe / .com 或没解析出来（交给 spawn 报原始错误）：用解析出的真实路径直接起
		return { command: target, args: list, extra: {}, resolved, shim: false };
	}
	const doubleEscape = CMD_SHIM.test(target);
	const line = [escapeCommand(win32.normalize(target)), ...list.map((a) => escapeArgument(a, doubleEscape))].join(" ");
	const comspec = envGet(options.env ?? process.env, "ComSpec") || "cmd.exe";
	return { command: comspec, args: ["/d", "/s", "/c", `"${line}"`], extra: { windowsVerbatimArguments: true }, resolved, shim: true };
}
