/**
 * 发布清单：打进 tarball 的 package.json 不能带 preinstall/install/postinstall；
 * 仓库内的守卫脚本在打包后必须还原；verify 对缺 pnpm / IGNORED_BUILDS 给出说明。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const lib = await import(pathToFileURL(join(pluginRoot, "scripts/lib/publish-manifest.mjs")).href);
const {
	PNPM_MISSING_HINT,
	IGNORED_BUILDS_HINT,
	PACK_BACKUP_NAME,
	lifecycleBuildScriptsOf,
	stripLifecycleScripts,
	stripPackManifest,
	restorePackManifest,
	withStrippedManifest,
	readTarballText,
	explainTarballInstallFailure,
} = lib;

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

const fixturePkg = {
	name: "demo",
	version: "1.0.0",
	scripts: {
		preinstall: "node scripts/guard-install.mjs",
		test: "node tests/demo.test.mjs",
		"guard:install": "node scripts/guard-install.mjs --check",
	},
};

const stripped = stripLifecycleScripts(fixturePkg);
assert(stripped.stripped.join(",") === "preinstall", "只去掉 preinstall");
assert(stripped.pkg.scripts.test === "node tests/demo.test.mjs", "其它 scripts 保留");
assert(stripped.pkg.scripts["guard:install"] !== undefined, "guard:install 保留");
assert(stripped.pkg.scripts.preinstall === undefined, "剥离后没有 preinstall");
assert(fixturePkg.scripts.preinstall === "node scripts/guard-install.mjs", "原对象不被改写");

const already = stripLifecycleScripts({ name: "x", scripts: { test: "echo" } });
assert(already.stripped.length === 0 && already.pkg.scripts.test === "echo", "没有构建脚本时原样返回");

assert(lifecycleBuildScriptsOf({ scripts: { preinstall: "x", install: "y", test: "z" } }).join(",") === "preinstall,install", "检出 preinstall 与 install");

const root = mkdtempSync(join(tmpdir(), "dsh-publish-manifest-"));
const originalText = `${JSON.stringify(fixturePkg, null, 2)}\n`;
writeFileSync(join(root, "package.json"), originalText);

const removed = stripPackManifest(root);
assert(removed.join(",") === "preinstall", "stripPackManifest 去掉 preinstall");
assert(existsSync(join(root, PACK_BACKUP_NAME)), "留下备份文件");
const mid = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert(mid.scripts.preinstall === undefined && mid.scripts.test === fixturePkg.scripts.test, "工作副本已去掉 preinstall、保留 test");
assert(restorePackManifest(root) === true, "restore 成功");
assert(readFileSync(join(root, "package.json"), "utf8") === originalText, "还原后与原文逐字节一致");
assert(!existsSync(join(root, PACK_BACKUP_NAME)), "备份已删除");

let sawStripped = false;
await withStrippedManifest(root, () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	sawStripped = pkg.scripts.preinstall === undefined;
});
assert(sawStripped, "withStrippedManifest 回调期间没有 preinstall");
assert(readFileSync(join(root, "package.json"), "utf8") === originalText, "withStrippedManifest 结束后还原");

let threw = false;
try {
	await withStrippedManifest(root, () => {
		throw new Error("boom");
	});
} catch (error) {
	threw = error instanceof Error && error.message === "boom";
}
assert(threw, "回调抛错会冒出来");
assert(readFileSync(join(root, "package.json"), "utf8") === originalText, "回调抛错后仍还原");

// 中断残留：已剥离的清单 + 备份 → 再 strip 不会把已剥离的版本当成原文备份
stripPackManifest(root);
assert(existsSync(join(root, PACK_BACKUP_NAME)), "第二次模拟中断时有备份");
stripPackManifest(root); // 应先还原再重新剥离
restorePackManifest(root);
assert(readFileSync(join(root, "package.json"), "utf8") === originalText, "残留备份不会丢掉原文");

// 最小 ustar + gzip，核对 readTarballText
const body = Buffer.from('{"name":"packed"}\n', "utf8");
const name = "package/package.json";
const header = Buffer.alloc(512);
header.write(name, 0, "utf8");
header.write("0000644", 100, "utf8"); // mode
header.write("0000000", 108, "utf8");
header.write("0000000", 116, "utf8");
const sizeOct = body.length.toString(8).padStart(11, "0") + " ";
header.write(sizeOct, 124, "utf8");
header.write("0", 156, "utf8"); // typeflag file
header.write("ustar\0", 257, "utf8");
header.write("00", 263, "utf8");
let checksum = 0;
for (let i = 0; i < 512; i++) checksum += header[i];
// checksum field was spaces during calc? we wrote zeros. Recalc properly:
header.fill(" ", 148, 156);
checksum = 0;
for (let i = 0; i < 512; i++) checksum += header[i];
header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
const pad = body.length % 512 === 0 ? 0 : 512 - (body.length % 512);
const tar = Buffer.concat([header, body, Buffer.alloc(pad), Buffer.alloc(1024)]);
const tgz = join(root, "demo.tgz");
writeFileSync(tgz, gzipSync(tar));
assert(readTarballText(tgz, "package/package.json") === '{"name":"packed"}\n', "readTarballText 能读出 ustar 条目");

assert(
	explainTarballInstallFailure("spawnSync pnpm ENOENT", { pnpmResolved: "" }).includes(PNPM_MISSING_HINT),
	"缺 pnpm 的 ENOENT 要有说明",
);
assert(
	explainTarballInstallFailure("'pnpm' 不是内部或外部命令，也不是可运行的程序", { pnpmResolved: "" }).includes(PNPM_MISSING_HINT),
	"Windows 找不到 pnpm 要有说明",
);
assert(
	explainTarballInstallFailure("ERR_PNPM_IGNORED_BUILDS Ignored build scripts: dsh-studio", { pnpmResolved: "/tmp/pnpm" }).includes(IGNORED_BUILDS_HINT),
	"IGNORED_BUILDS 要有说明",
);
assert(
	explainTarballInstallFailure("some other failure", { pnpmResolved: "/usr/bin/pnpm" }) === "some other failure",
	"其它错误保持原文",
);

// 集成：对本仓库跑 withStrippedManifest + npm pack --ignore-scripts，核对 tarball 清单
console.log("\n[pack this repo without lifecycle build scripts]");
const { npmInvocation } = await import(pathToFileURL(join(pluginRoot, "scripts/lib/resolve-npm.mjs")).href);
const packDir = mkdtempSync(join(tmpdir(), "dsh-pack-out-"));
let packedJson = null;
let restoredAfterPack = false;
try {
	await withStrippedManifest(pluginRoot, () => {
		const working = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
		assert(lifecycleBuildScriptsOf(working).length === 0, "打包期间工作树 package.json 已去掉构建脚本");
		const inv = npmInvocation(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir]);
		const result = spawnSync(inv.command, inv.args, {
			encoding: "utf8",
			cwd: pluginRoot,
			env: process.env,
			timeout: 120_000,
		});
		if (result.status !== 0) {
			console.error(result.stdout.slice(-400));
			console.error(result.stderr.slice(-400));
		}
		assert(result.status === 0, `npm pack 应成功，实际 ${result.status}`);
		try {
			const start = result.stdout.indexOf("[");
			const end = result.stdout.lastIndexOf("]");
			packedJson = JSON.parse(result.stdout.slice(start, end + 1))[0];
		} catch (error) {
			console.error("parse pack json failed", error.message, result.stdout.slice(-300));
		}
	});
	const after = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
	restoredAfterPack = after.scripts?.preinstall === "node scripts/guard-install.mjs";
	assert(restoredAfterPack, "打包结束后仓库 package.json 仍有 preinstall 守卫");
	assert(!existsSync(join(pluginRoot, PACK_BACKUP_NAME)), "打包结束后不留下备份文件");
	const filename = packedJson?.filename ?? "";
	const tarballPath = filename && existsSync(join(packDir, filename))
		? join(packDir, filename)
		: filename && existsSync(join(pluginRoot, filename))
			? join(pluginRoot, filename)
			: "";
	assert(tarballPath !== "", `找到 tarball（filename=${filename}）`);
	if (tarballPath !== "") {
		const packedPkg = JSON.parse(readTarballText(tarballPath, "package/package.json") ?? "{}");
		assert(
			lifecycleBuildScriptsOf(packedPkg).length === 0,
			`tarball 里的 package.json 不应有构建脚本，实际 ${lifecycleBuildScriptsOf(packedPkg).join(",")}`,
		);
		assert(packedPkg.scripts?.test, "tarball 仍保留 test 等其它脚本");
		assert(packedPkg.scripts?.["guard:install"], "tarball 仍保留 guard:install（手动检查用）");
		assert(packedPkg.name === "dsh-studio", "tarball 包名不变");
	}
} finally {
	restorePackManifest(pluginRoot);
	rmSync(packDir, { recursive: true, force: true });
	if (packedJson?.filename && existsSync(join(pluginRoot, packedJson.filename))) {
		rmSync(join(pluginRoot, packedJson.filename), { force: true });
	}
}

rmSync(root, { recursive: true, force: true });

if (failed > 0) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall passed");
