// N-12 内存探针：在独立子进程里跑一次 createSnapshot，报 process.resourceUsage().maxrss 增量。
//
// 用法：
//   node tests/fixtures/snapshot-mem-probe.mjs build --home=<伪 HOME> [--mb=108] [--files=120]
//   node tests/fixtures/snapshot-mem-probe.mjs run   --home=<伪 HOME> [--lib=<snapshot.js 绝对路径>]
//
// build 只铺 fixture（不进快照），run 只跑一次打包并量峰值。两者分进程：build 的写入内存
// 不会算进 run 的基线。run 结束后删掉刚建的快照，避免磁盘随复跑累加。
// 调用方负责把 USERPROFILE / HOME / DSH_HOME 三件套指到伪 HOME（本脚本不自设）。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
	process.argv.slice(2).flatMap((raw) => {
		const match = /^--([^=]+)=(.*)$/.exec(raw);
		return match === null ? [] : [[match[1], match[2]]];
	})
);
const mode = process.argv[2];
const home = args.home ?? process.env.USERPROFILE ?? process.env.HOME;
const dsh = path.join(home, ".dsh");
const external = path.join(home, ".agents", "skills");
const MB = 1024 * 1024;

const write = (file, data) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
};

function build() {
	const totalMb = Number(args.mb ?? 108);
	const files = Number(args.files ?? 120);
	const perFile = Math.floor((totalMb * MB) / files);
	fs.rmSync(path.join(dsh, "skills"), { recursive: true, force: true });
	fs.rmSync(external, { recursive: true, force: true });
	write(path.join(dsh, "cordis.patch.yml"), "plugins: []\n");
	write(path.join(dsh, "AGENTS.md"), "# 内存探针伪 HOME\n");
	write(path.join(dsh, "dsh-studio", "extractor.json"), JSON.stringify({ agentSkillDir: external }, null, 2) + "\n");
	write(path.join(dsh, "dsh-studio", "quality.json"), JSON.stringify({ roll: [] }, null, 2) + "\n");
	// 定时配置保持默认：linkExternalSkills 开、maxSkillFileBytes 5 MB。
	// 每个 skill 目录只有一个 ~900 KB 文件 → 目录总量不到链接化门槛，也碰不到单文件上限 → 全部实打包。
	write(
		path.join(dsh, "dsh-studio", "snapshot.json"),
		JSON.stringify({ enabled: false, intervalHours: 24, keep: 10, maxSkillFileBytes: 5 * MB, linkExternalSkills: true }, null, 2) + "\n"
	);
	for (let i = 0; i < files; i += 1) {
		const name = "mem-" + String(i).padStart(3, "0");
		write(path.join(external, name, "data.bin"), Buffer.alloc(perFile, 65 + (i % 26)));
	}
	// 外部 skill 那个目录里也放一份只有小文件、来源不可确定的 skill，证明外部根确实被枚举
	write(path.join(external, "mem-extra", "SKILL.md"), "---\nname: mem-extra\n---\nprobe\n");
	const summary = { mode: "build", totalMb, files, perFile, root: external };
	process.stdout.write(JSON.stringify(summary) + "\n");
}

async function run() {
	const libPath = args.lib ?? path.resolve(import.meta.dirname, "..", "..", "lib", "snapshot.js");
	const snap = await import(pathToFileURL(libPath).href);
	const beforeKB = process.resourceUsage().maxRSS;
	const startedAt = Date.now();
	const manifest = await snap.createSnapshot("mem-probe");
	const afterKB = process.resourceUsage().maxRSS;
	const ms = Date.now() - startedAt;
	const source = fs.readFileSync(libPath);
	await snap.deleteSnapshot(manifest.id);
	process.stdout.write(
		JSON.stringify({
			mode: "run",
			lib: libPath,
			libSha256: createHash("sha256").update(source).digest("hex"),
			beforeKB,
			afterKB,
			deltaKB: afterKB - beforeKB,
			fileCount: manifest.files.length,
			maxFileBytes: manifest.files.reduce((max, file) => Math.max(max, file.bytes), 0),
			totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
			archiveBytes: manifest.archiveBytes,
			ms
		}) + "\n"
	);
}

if (mode === "build") build();
else if (mode === "run") await run();
else {
	console.error("用法：snapshot-mem-probe.mjs build|run --home=<伪 HOME> [--mb=108] [--files=120] [--lib=<snapshot.js>]");
	process.exit(2);
}
