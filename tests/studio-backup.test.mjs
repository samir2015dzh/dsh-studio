/**
 * ：studio 级备份包与跨机恢复（R7）。
 *
 * 两台「机器」= 同一进程里的两个伪 HOME（A / B，路径不同，用来验跨机路径改写）；所有路径都在调用时按 HOME 现算。
 * WebDAV 对端是进程内的最小 HTTP 服务（PUT / GET / MKCOL / DELETE），全程离线。
 *
 *   [1] 打包：清单 + 清单 sha + 五类对象齐全；凭据一个都不出机；超限技能文件只记 sha；锁 / 临时文件不进包；旁挂索引
 *   [2] 校验：改一个字节 / 改清单 / 夹带条目 / 越权路径都被拒；校验不过的包恢复零改动
 *   [3] 干净环境恢复：预演零写盘；真恢复后注册表 / 配置 / 技能 / 版本史 / 数据就位，来源机路径改成本机，
 *       占位符不落盘、缺的凭据逐条列出；版本记录 studio-restore 带 restoreOf；能在新机器上回滚到来源机的旧版本；恢复报告落盘
 *   [4] 冲突不静默覆盖：版本分叉 / 同名 server 配置不同 / 配置文件不同 → 待裁；本机是祖先 → 快进；本机更新 → 保留；
 *       resolutions 裁定后才动；重复恢复同一份包幂等（零写盘、不打保护包）
 *   [5] 节奏：默认关；开了只在闲时窗口跑；自动包按 keep 清理，手动包不动
 *   [6] WebDAV：复用 sync.json 的 webdav 段（Basic 认证）；push 写包 + sha + INDEX + LATEST，按 remoteKeep 清远端；
 *       pull 取 LATEST 并校验；远端包被篡改 → 拒收
 *   [7] 工具 / 路由经注册层可用；路由只认 loopback
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const root = mkdtempSync(join(tmpdir(), "dsh-studio-backup-"));
const homeA = join(root, "machine-a", "alice");
const homeB = join(root, "machine-b", "bob");
for (const k of ["DSH_STUDIO_HISTORY_DIR", "DSH_STUDIO_OPTIMIZER_DIR", "DSH_STUDIO_GOVERNANCE_DIR", "DSH_STUDIO_DISTILL_DIR", "DSH_STUDIO_CATALOG_EVAL_DIR", "DSH_STUDIO_BACKUP_DIR", "DSH_AGENTS_HOME"]) delete process.env[k];
process.env.DSH_STUDIO_TELEMETRY_DIR = join(root, "telemetry");
function useHome(h) {
	process.env.HOME = h;
	process.env.USERPROFILE = h;
	process.env.DSH_HOME = join(h, ".dsh");
}
useHome(homeA);

const { createStudioBackup, verifyPackageBuffer, MANIFEST_FILE, MANIFEST_SHA_FILE } = await import(modUrl("lib/studio-backup.js"));
const { buildStudioBackupTools, buildStudioBackupRoutes, STUDIO_BACKUP_API } = await import(modUrl("lib/studio-backup-tools.js"));
const { STUDIO_BACKUP_DEFAULTS } = await import(modUrl("lib/studio-backup-config.js"));
const { versionedSkillWrite, readVersionRecords, rollbackSkill } = await import(modUrl("lib/versions.js"));
const { packTarGz, unpackTarGz, REDACTED } = await import(modUrl("lib/snapshot.js"));

test.after(() => rmSync(root, { recursive: true, force: true }));
const quiet = { info() {}, warn() {}, error() {} };

const SECRET_KEY = "sk-live-0123456789abcdef-SECRET";
const SECRET_TOKEN = "ghp_TOKEN_abcdefghijklmnopqrstuvwxyz";
const SECRET_LLM = "llm-key-zyxwvutsrqponm-SECRET";

// ── 夹具 ────────────────────────────────────────────────────────────────────
const p = (h, ...rest) => join(h, ...rest);
const dshSkills = (h) => p(h, ".dsh", "skills");
const agentSkills = (h) => p(h, ".agents", "skills");
const write = (file, text) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
};
const skillMd = (name, body) => `---\nname: ${name}\ndescription: ${name} 的说明\n---\n# ${name}\n\n${body}\n`;
async function versioned(h, dir, name, body, action = "edit") {
	useHome(h);
	await versionedSkillWrite(dir, { action, actor: "test", reason: "夹具" }, async () => write(join(dir, "SKILL.md"), skillMd(name, body)));
}
function registryOf(h, overrides = {}) {
	return {
		version: 2,
		idleTimeoutMinutes: 10,
		toolDescriptionMaxLength: 150,
		servers: [
			{ name: "rea", tier: "on-demand", transport: "stdio", command: "node", args: [p(h, "tools", "rea", "index.js")], env: { REA_API_KEY: SECRET_KEY, MODE: "fast" }, cwd: "", tools: [{ name: "search", description: "搜" }], catalog: { summary: "检索" }, trial: false, ...(overrides.rea ?? {}) },
			{ name: "baimiao", tier: "on-demand", transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer " + SECRET_TOKEN }, tools: [], catalog: { summary: "白描" }, trial: false, ...(overrides.baimiao ?? {}) }
		]
	};
}

async function seedMachineA() {
	useHome(homeA);
	write(p(homeA, ".dsh", "dsh-studio", "mcp.json"), JSON.stringify(registryOf(homeA), null, 2) + "\n");
	write(p(homeA, ".dsh", "dsh-studio", "extractor.json"), JSON.stringify({ agentSkillDir: agentSkills(homeA), llmApiKey: SECRET_LLM, enabled: true }, null, 2) + "\n");
	write(p(homeA, ".dsh-studio", "optimizer", "config.json"), JSON.stringify({ enabled: true, limits: { maxSkills: 2 } }, null, 2) + "\n");
	write(p(homeA, ".dsh-studio", "governance", "config.json"), JSON.stringify({ merge: { minScore: 0.6 } }, null, 2) + "\n");
	// 数据区：评估集、报告、追加型日志、运行时状态；锁与临时文件不该进包
	write(p(homeA, ".dsh-studio", "optimizer", "evals", "fork-skill.json"), JSON.stringify({ cases: [{ prompt: "x" }] }) + "\n");
	write(p(homeA, ".dsh-studio", "optimizer", "discards.jsonl"), '{"id":"d1"}\n{"id":"d2"}\n');
	write(p(homeA, ".dsh-studio", "optimizer", "state.json"), '{"lastRoundAt":1}\n');
	write(p(homeA, ".dsh-studio", "distill", "batch.lock"), "pid");
	write(p(homeA, ".dsh-studio", "governance", "reports", ".r1.json.123.tmp"), "half");
	write(p(homeA, ".dsh-studio", "governance", "reports", "r1.json"), '{"ok":true}\n');
	// 技能：dsh 根一个、agents 根若干；agents 根上一个单文件技能；一个带超限大文件
	await versioned(homeA, join(dshSkills(homeA), "dsh-only"), "dsh-only", "dsh 根里的技能", "create");
	await versioned(homeA, join(agentSkills(homeA), "fork-skill"), "fork-skill", "v1 共同祖先", "create");
	await versioned(homeA, join(agentSkills(homeA), "ff-skill"), "ff-skill", "v1", "create");
	await versioned(homeA, join(agentSkills(homeA), "newer-on-b"), "newer-on-b", "v1", "create");
	await versioned(homeA, join(agentSkills(homeA), "history-skill"), "history-skill", "旧版：第一稿", "create");
	await versioned(homeA, join(agentSkills(homeA), "history-skill"), "history-skill", "新版：第二稿");
	write(join(agentSkills(homeA), "solo.md"), "---\nname: solo\ndescription: 单文件技能\n---\nsolo\n");
	write(join(agentSkills(homeA), "big-skill", "SKILL.md"), skillMd("big-skill", "带大文件"));
	write(join(agentSkills(homeA), "big-skill", "assets", "huge.bin"), Buffer.alloc(64 * 1024, 7));
	write(join(agentSkills(homeA), "with-git", ".git", "config"), "[core]\n");
	write(join(agentSkills(homeA), "with-git", "SKILL.md"), skillMd("with-git", "带 .git 的技能"));
	write(join(agentSkills(homeA), "PENDING_PULLS.json"), "{}");
}

const backupA = () => {
	useHome(homeA);
	return createStudioBackup({ pluginConfig: { maxSkillFileBytes: 32 * 1024 }, fullPluginConfig: { announceToAgent: true, studioBackup: { enabled: false }, secretish: { apiKey: "plugin-row-key" } }, logger: quiet });
};
const backupB = (extra = {}) => {
	useHome(homeB);
	return createStudioBackup({ pluginConfig: { maxSkillFileBytes: 32 * 1024, ...extra }, logger: quiet });
};
const pkgPath = (h, id) => p(h, ".dsh-studio", "studio-backup", "packages", id + ".tar.gz");
const readTree = (dir) => {
	const out = {};
	const walk = (d, pre = "") => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const rel = pre === "" ? e.name : pre + "/" + e.name;
			if (e.isDirectory()) walk(join(d, e.name), rel);
			else out[rel] = readFileSync(join(d, e.name), "utf8");
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
};

let firstPackage;

test("[1] 打包：清单 + 校验和 + 五类对象；凭据不出机；超限只记 sha；锁 / 临时文件不进包", async () => {
	await seedMachineA();
	const b = backupA();
	const r = await b.exportPackage({ label: "move to b" });
	firstPackage = r.id;
	assert.match(r.id, /^studio-\d{8}-\d{9}-move_to_b$/);
	const buf = readFileSync(r.file);
	const entries = new Map(unpackTarGz(buf).map((e) => [e.rel, e.data]));
	assert.ok(entries.has(MANIFEST_FILE) && entries.has(MANIFEST_SHA_FILE), "清单与清单 sha 都在包里");
	const manifest = JSON.parse(entries.get(MANIFEST_FILE).toString("utf8"));
	assert.equal(manifest.format, "dsh-studio-backup");
	assert.equal(manifest.schema, 1);
	assert.equal(manifest.source.home, homeA.split("\\").join("/"));
	// 五类对象
	assert.ok(entries.has("registry/mcp.json"));
	assert.deepEqual(manifest.objects.registry.names, ["rea", "baimiao"]);
	assert.deepEqual(manifest.objects.config.map((c) => c.id).sort(), ["extractor", "governance", "optimizer"]);
	const units = manifest.objects.skills.units.map((u) => `${u.root}/${u.name}`).sort();
	assert.deepEqual(units, ["agents/big-skill", "agents/ff-skill", "agents/fork-skill", "agents/history-skill", "agents/newer-on-b", "agents/solo.md", "agents/with-git", "dsh/dsh-only"]);
	assert.ok(manifest.objects.history.records >= 6 && manifest.objects.history.objects >= 6, "版本史记录与对象都进包");
	assert.ok(entries.has("history/versions.jsonl"));
	assert.ok(entries.has("data/optimizer/evals/fork-skill.json") && entries.has("data/optimizer/discards.jsonl") && entries.has("data/governance/reports/r1.json"));
	// 不该进包的
	assert.ok(!entries.has("data/optimizer/config.json"), "数据区根上的 config.json 属于配置层，不重复");
	assert.ok(![...entries.keys()].some((k) => /\.lock$|\.tmp$|\/\.git\/|PENDING_PULLS/.test(k)), "锁 / 临时文件 / .git / 根上的非技能文件都不进包");
	// 超限大文件只记 sha
	const big = manifest.objects.skills.units.find((u) => u.name === "big-skill");
	assert.equal(big.files["assets/huge.bin"].packed, false);
	assert.match(big.files["assets/huge.bin"].sha, /^[0-9a-f]{64}$/);
	assert.ok(!entries.has("skills/agents/big-skill/assets/huge.bin"));
	assert.equal(manifest.objects.skills.skippedFiles.length, 1);
	// 凭据：包里任何地方都没有明文（含 gzip 解开后的整包字节）
	const raw = gunzipSync(buf).toString("latin1");
	for (const secret of [SECRET_KEY, SECRET_TOKEN, SECRET_LLM, "plugin-row-key"]) assert.ok(!raw.includes(secret), "包里不许有明文凭据：" + secret.slice(0, 8));
	const reg = JSON.parse(entries.get("registry/mcp.json").toString("utf8"));
	assert.equal(reg.servers[0].env.REA_API_KEY, REDACTED);
	assert.equal(reg.servers[0].env.MODE, "fast", "非凭据字段原样");
	assert.ok(manifest.redacted.some((x) => x.object === "registry") && manifest.redacted.some((x) => x.object === "config:extractor"));
	assert.equal(manifest.reference.pluginConfig.secretish.apiKey, REDACTED, "插件配置行只作参考，且同样脱敏");
	// 每个条目都在清单里、sha 对得上
	const v = verifyPackageBuffer(buf);
	assert.equal(v.ok, true, v.errors.join("\n"));
	assert.equal(v.stats.entries, entries.size - 2);
	// 旁挂索引
	const list = await b.listPackages();
	assert.equal(list[0].id, r.id);
	assert.equal(list[0].summary.skills, 8);
	assert.equal(list[0].sha256, r.sha256);
	// 拷出一份
	const copy = await b.exportPackage({ label: "copy", to: join(root, "usb") + "/" });
	assert.ok(existsSync(copy.copiedTo) && copy.copiedTo.startsWith(join(root, "usb")));
	await b.deletePackage(copy.id);
});

test("[2] 校验：篡改 / 夹带 / 越权都拒收；校验不过的包恢复零改动", async () => {
	useHome(homeA);
	const buf = readFileSync(pkgPath(homeA, firstPackage));
	const list = unpackTarGz(buf);
	const repack = (mutate) => packTarGz(mutate(list.map((e) => ({ rel: e.rel, data: Buffer.from(e.data) }))));
	// 改一个技能文件的一个字节
	const flipped = verifyPackageBuffer(repack((es) => es.map((e) => (e.rel === "skills/agents/ff-skill/SKILL.md" ? { ...e, data: Buffer.from(e.data.toString("utf8").replace("v1", "v9")) } : e))));
	assert.equal(flipped.ok, false);
	assert.ok(flipped.errors.some((x) => x.includes("sha256 不符：skills/agents/ff-skill/SKILL.md")));
	// 改清单（哪怕只是改个标签）
	const forged = verifyPackageBuffer(repack((es) => es.map((e) => (e.rel === MANIFEST_FILE ? { ...e, data: Buffer.from(e.data.toString("utf8").replace('"label": "move_to_b"', '"label": "evil"')) } : e))));
	assert.ok(forged.errors.some((x) => x.includes("清单 sha256 对不上")));
	// 夹带清单外的条目、越权路径、版本史对象内容与名字不符
	const smuggled = verifyPackageBuffer(repack((es) => [...es, { rel: "skills/agents/x/SKILL.md", data: Buffer.from("x") }, { rel: "../../etc/passwd", data: Buffer.from("x") }]));
	assert.ok(smuggled.errors.some((x) => x.includes("清单外的条目（拒收）：skills/agents/x/SKILL.md")));
	assert.ok(smuggled.errors.some((x) => x.includes("../../etc/passwd")));
	const objRel = list.find((e) => e.rel.startsWith("history/objects/")).rel;
	const badObj = verifyPackageBuffer(repack((es) => es.map((e) => (e.rel === objRel ? { ...e, data: gzipSync(Buffer.from("not the content")) } : e))));
	assert.ok(badObj.errors.some((x) => x.includes("版本史对象内容与 sha 不符") || x.includes("sha256 不符：" + objRel)));
	assert.equal(verifyPackageBuffer(Buffer.from("not a gzip")).ok, false);
	// 校验不过 → 恢复零改动（换到一台空机器上试）
	const evil = join(root, "evil.tar.gz");
	writeFileSync(evil, repack((es) => es.map((e) => (e.rel === "registry/mcp.json" ? { ...e, data: Buffer.from('{"servers":[]}') } : e))));
	const b = backupB();
	await assert.rejects(b.restore({ file: evil, dryRun: false }), /校验未通过，未做任何改动/);
	assert.ok(!existsSync(p(homeB, ".dsh")) && !existsSync(p(homeB, ".agents")), "B 上一个对象都没写");
	assert.deepEqual(readTree(p(homeB, ".dsh-studio")), {}, "B 的 .dsh-studio 下没有任何文件（只可能留下操作锁的空目录）");
});

test("[3] 干净环境恢复：预演零写盘；真恢复后五类对象就位、路径改成本机、凭据缺口列出、可回滚到来源机旧版", async () => {
	const file = pkgPath(homeA, firstPackage);
	const b = backupB();
	const dry = await b.restore({ file });
	assert.equal(dry.dryRun, true);
	assert.ok(dry.items.every((i) => ["create", "merged", "skipped"].includes(i.action)), "干净环境：全是新建 / 并入");
	assert.ok(dry.needsCredentials.some((n) => n.object === "registry:rea" && n.field === "env.REA_API_KEY"), "预演也报出缺哪些凭据");
	assert.ok(!existsSync(p(homeB, ".dsh")) && !existsSync(p(homeB, ".agents")), "预演不写任何对象");
	assert.ok(existsSync(p(homeB, ".dsh-studio", "studio-backup", "restores", dry.id + ".json")), "预演也留一份报告");

	const r = await b.restore({ file, dryRun: false });
	assert.equal(r.counts.failed ?? 0, 0, JSON.stringify(r.items.filter((i) => i.action === "failed")));
	assert.equal(r.pending.length, 0);
	assert.ok(r.preRestore, "真恢复前打了保护包");
	assert.ok(existsSync(pkgPath(homeB, r.packageId)), "外部包先收进本地包目录");
	// 注册表：路径改成 B、占位符不落盘、缺的凭据列出
	const reg = JSON.parse(readFileSync(p(homeB, ".dsh", "dsh-studio", "mcp.json"), "utf8"));
	assert.deepEqual(reg.servers.map((s) => s.name), ["rea", "baimiao"]);
	assert.equal(reg.servers[0].args[0], p(homeB, "tools", "rea", "index.js"), "来源机 home 改成本机 home");
	assert.equal(reg.servers[0].env.MODE, "fast");
	assert.ok(!("REA_API_KEY" in reg.servers[0].env), "本机没有现值的凭据键不写（绝不写占位符）");
	assert.ok(!JSON.stringify(reg).includes(REDACTED));
	assert.deepEqual(r.needsCredentials.map((n) => `${n.object}:${n.field}`).sort(), ["config:extractor:llmApiKey", "registry:baimiao:headers.Authorization", "registry:rea:env.REA_API_KEY"]);
	// 配置：extractor 的路径改成 B，凭据键不落盘
	const ex = JSON.parse(readFileSync(p(homeB, ".dsh", "dsh-studio", "extractor.json"), "utf8"));
	assert.equal(ex.agentSkillDir, agentSkills(homeB));
	assert.ok(!("llmApiKey" in ex));
	assert.deepEqual(JSON.parse(readFileSync(p(homeB, ".dsh-studio", "optimizer", "config.json"), "utf8")), { enabled: true, limits: { maxSkills: 2 } });
	// 技能：两个根都就位，内容一致；大文件报告为未能恢复
	assert.equal(readFileSync(join(agentSkills(homeB), "fork-skill", "SKILL.md"), "utf8"), readFileSync(join(agentSkills(homeA), "fork-skill", "SKILL.md"), "utf8"));
	assert.ok(existsSync(join(dshSkills(homeB), "dsh-only", "SKILL.md")));
	assert.ok(existsSync(join(agentSkills(homeB), "solo.md")));
	assert.ok(!existsSync(join(agentSkills(homeB), "big-skill", "assets", "huge.bin")));
	const bigItem = r.items.find((i) => i.id === "skill:agents/big-skill");
	assert.deepEqual(bigItem.detail.missingLargeFiles, ["assets/huge.bin"]);
	// 数据区
	assert.equal(readFileSync(p(homeB, ".dsh-studio", "optimizer", "discards.jsonl"), "utf8"), '{"id":"d1"}\n{"id":"d2"}\n');
	assert.ok(existsSync(p(homeB, ".dsh-studio", "governance", "reports", "r1.json")));
	// 版本史：A 的记录全部并入（target 改成 B），恢复本身留 studio-restore 记录且 restoreOf 指回 A 的版本
	useHome(homeB);
	const recs = await readVersionRecords();
	const aRecs = recs.filter((x) => x.actor === "test");
	assert.ok(aRecs.length >= 6 && aRecs.every((x) => !String(x.target).includes("alice")), "来源机记录的 target 都改到本机");
	const restored = recs.filter((x) => x.action === "studio-restore" && x.key.includes("history-skill"));
	assert.equal(restored.length, 1);
	const aLatest = aRecs.filter((x) => x.key === restored[0].key).at(-1);
	assert.equal(restored[0].restoreOf, aLatest.id, "restoreOf 指向包内对应的那条版本");
	assert.ok(!recs.some((x) => x.action === "baseline" && x.actor === "external"), "没有被误判成插件外改动的假 baseline");
	assert.ok(recs.some((x) => x.key === "mcp:registry" && x.action === "studio-restore"), "注册表写入同样留 studio-restore 版本记录");
	// 在新机器上回滚到来源机的第一稿
	const first = aRecs.find((x) => x.key === restored[0].key && x.action === "create");
	await rollbackSkill({ name: "history-skill", versionId: first.id, actor: "test" });
	assert.match(readFileSync(join(agentSkills(homeB), "history-skill", "SKILL.md"), "utf8"), /旧版：第一稿/);
	// 恢复报告落盘（json + md），可再读
	const rep = await b.getRestoreReport(r.id);
	assert.equal(rep.id, r.id);
	assert.match(readFileSync(p(homeB, ".dsh-studio", "studio-backup", "restores", r.id + ".md"), "utf8"), /需补凭据/);
});

test("[4] 冲突报告待裁、不静默覆盖；祖先快进、本机更新保留；裁定后才动；重复恢复幂等", async () => {
	// B 上先回到与 A 一致（[3] 末尾回滚过 history-skill，这里用版本化写入改回去，制造「本机更新」形态之外的干扰最少）
	await versioned(homeB, join(agentSkills(homeB), "history-skill"), "history-skill", "新版：第二稿");
	// 分叉：两边各改 fork-skill；快进：只有 A 改 ff-skill；本机更新：只有 B 改 newer-on-b
	await versioned(homeA, join(agentSkills(homeA), "fork-skill"), "fork-skill", "A 的改法");
	await versioned(homeB, join(agentSkills(homeB), "fork-skill"), "fork-skill", "B 的改法");
	await versioned(homeA, join(agentSkills(homeA), "ff-skill"), "ff-skill", "v2（A 上的新版）");
	await versioned(homeB, join(agentSkills(homeB), "newer-on-b"), "newer-on-b", "v2（B 上的新版）");
	// 注册表：A 改了 rea 的 MODE；B 上 baimiao 补了凭据（凭据不比）
	useHome(homeA);
	write(p(homeA, ".dsh", "dsh-studio", "mcp.json"), JSON.stringify(registryOf(homeA, { rea: { env: { REA_API_KEY: SECRET_KEY, MODE: "slow" } } }), null, 2) + "\n");
	const regB = JSON.parse(readFileSync(p(homeB, ".dsh", "dsh-studio", "mcp.json"), "utf8"));
	regB.servers[1].headers = { Authorization: "Bearer b-machine-token" };
	write(p(homeB, ".dsh", "dsh-studio", "mcp.json"), JSON.stringify(regB, null, 2) + "\n");
	// 配置：两边治理配置不同
	write(p(homeB, ".dsh-studio", "governance", "config.json"), JSON.stringify({ merge: { minScore: 0.9 } }) + "\n");
	// 追加型日志：A 多了一行
	write(p(homeA, ".dsh-studio", "optimizer", "discards.jsonl"), '{"id":"d1"}\n{"id":"d2"}\n{"id":"d3"}\n');
	const second = await backupA().exportPackage({ label: "round2" });

	const b = backupB();
	const plan = await b.restore({ file: second.file });
	const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]));
	assert.equal(byId["skill:agents/fork-skill"].action, "conflict");
	assert.match(byId["skill:agents/fork-skill"].reason, /版本分叉/);
	assert.equal(byId["skill:agents/ff-skill"].action, "fast-forward");
	assert.equal(byId["skill:agents/newer-on-b"].action, "kept-local");
	assert.equal(byId["skill:agents/history-skill"].action, "same");
	assert.equal(byId["registry:rea"].action, "conflict");
	assert.match(byId["registry:rea"].reason, /env/);
	assert.equal(byId["registry:baimiao"].action, "same", "只差凭据值不算冲突");
	assert.equal(byId["config:governance"].action, "conflict");
	assert.equal(byId["data:optimizer/discards.jsonl"].action, "merged");
	assert.equal(byId["data:optimizer/state.json"].action, "same");
	assert.deepEqual(plan.pending.map((x) => x.id).sort(), ["config:governance", "registry:rea", "skill:agents/fork-skill"]);

	// 不裁定直接真恢复：冲突项一个都不动，其余照常
	const forkBefore = readFileSync(join(agentSkills(homeB), "fork-skill", "SKILL.md"), "utf8");
	const r1 = await b.restore({ file: second.file, dryRun: false });
	assert.equal(r1.pending.length, 3);
	assert.equal(readFileSync(join(agentSkills(homeB), "fork-skill", "SKILL.md"), "utf8"), forkBefore, "分叉的技能不被覆盖");
	assert.match(readFileSync(join(agentSkills(homeB), "ff-skill", "SKILL.md"), "utf8"), /A 上的新版/, "祖先快进");
	assert.match(readFileSync(join(agentSkills(homeB), "newer-on-b", "SKILL.md"), "utf8"), /B 上的新版/, "本机更新保留");
	const regAfter = JSON.parse(readFileSync(p(homeB, ".dsh", "dsh-studio", "mcp.json"), "utf8"));
	assert.equal(regAfter.servers[0].env.MODE, "fast", "同名 server 冲突不覆盖");
	assert.equal(regAfter.servers[1].headers.Authorization, "Bearer b-machine-token", "本机凭据原样");
	assert.equal(JSON.parse(readFileSync(p(homeB, ".dsh-studio", "governance", "config.json"), "utf8")).merge.minScore, 0.9);
	assert.equal(readFileSync(p(homeB, ".dsh-studio", "optimizer", "discards.jsonl"), "utf8"), '{"id":"d1"}\n{"id":"d2"}\n{"id":"d3"}\n', "追加型日志按行并集");
	assert.match(r1.markdown, /待裁冲突（3）/);

	// 所有者裁定：技能用包内的、server 保留本机、治理配置用包内的
	const r2 = await b.restore({ id: r1.packageId, dryRun: false, resolutions: { "skill:agents/fork-skill": "package", "registry:rea": "local", "config:governance": "package" } });
	const r2ById = Object.fromEntries(r2.items.map((i) => [i.id, i]));
	assert.equal(r2ById["skill:agents/fork-skill"].action, "resolved-package");
	assert.equal(r2ById["registry:rea"].action, "resolved-local");
	assert.equal(r2.pending.length, 0);
	assert.match(readFileSync(join(agentSkills(homeB), "fork-skill", "SKILL.md"), "utf8"), /A 的改法/);
	assert.equal(JSON.parse(readFileSync(p(homeB, ".dsh", "dsh-studio", "mcp.json"), "utf8")).servers[0].env.MODE, "fast");
	assert.equal(JSON.parse(readFileSync(p(homeB, ".dsh-studio", "governance", "config.json"), "utf8")).merge.minScore, 0.6);
	// 被覆盖的 B 版本仍在版本史里，可回滚
	useHome(homeB);
	const forkRecs = (await readVersionRecords()).filter((x) => x.name === "fork-skill");
	assert.ok(forkRecs.some((x) => x.action === "studio-restore" && x.restoreOf), "裁定写入也留 studio-restore 记录");

	// 幂等：同一份包再恢复一次 → 没有可写项、不打保护包
	const before = (await b.listPackages()).length;
	const r3 = await b.restore({ id: r1.packageId, dryRun: false, resolutions: { "registry:rea": "local" } });
	assert.ok(r3.items.every((i) => ["same", "kept-local", "resolved-local", "skipped"].includes(i.action)), JSON.stringify(r3.counts));
	assert.equal(r3.preRestore, null);
	assert.equal((await b.listPackages()).length, before);
});

test("[5] 节奏：默认关；开了只在闲时窗口跑；自动包按 keep 清理，手动包不动", async () => {
	assert.equal(STUDIO_BACKUP_DEFAULTS.enabled, false);
	let clock = new Date(2026, 10, 16, 3, 0, 0).getTime();
	useHome(homeB);
	const off = createStudioBackup({ logger: quiet, now: () => clock });
	assert.equal((await off.tick()).reason, "disabled");
	const manualBefore = (await off.listPackages()).filter((x) => x.label !== "scheduled").length;
	const on = createStudioBackup({ pluginConfig: { enabled: true, idleMinutes: 0, minIntervalHours: 0, checkEveryMinutes: 0, keep: 2, idleWindow: { start: "02:00", end: "06:00" } }, logger: quiet, now: () => clock });
	const ran = [];
	for (let i = 0; i < 3; i++) {
		clock += 60_000;
		const t = await on.tick();
		assert.equal(t.ran, true, JSON.stringify(t));
		ran.push(t.id);
	}
	const scheduled = (await on.listPackages()).filter((x) => x.label === "scheduled").map((x) => x.id);
	assert.deepEqual(scheduled.sort(), ran.slice(1).sort(), "自动包只留最近 keep=2 份");
	assert.equal((await on.listPackages()).filter((x) => x.label !== "scheduled").length, manualBefore, "手动包与保护包不受 keep 影响");
	clock = new Date(2026, 10, 16, 12, 0, 0).getTime();
	assert.equal((await on.tick()).reason, "outside-window");
});

test("[6] WebDAV：复用 sync.json；push 带 sha / INDEX / LATEST 并清远端；pull 校验；篡改拒收", async () => {
	const files = new Map();
	const auth = [];
	const server = createServer((req, res) => {
		auth.push(req.headers.authorization);
		const key = decodeURIComponent(new URL(req.url, "http://x").pathname);
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.method === "MKCOL") return res.writeHead(files.has(key) ? 405 : 201).end();
			if (req.method === "PUT") {
				files.set(key, Buffer.concat(chunks));
				return res.writeHead(201).end();
			}
			if (req.method === "DELETE") {
				files.delete(key);
				return res.writeHead(204).end();
			}
			if (req.method === "GET") return files.has(key) ? res.writeHead(200).end(files.get(key)) : res.writeHead(404).end();
			res.writeHead(405).end();
		});
	});
	await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
	const url = `http://127.0.0.1:${server.address().port}/dav`;
	try {
		useHome(homeA);
		write(p(homeA, ".dsh", "dsh-studio", "sync.json"), JSON.stringify({ channel: "webdav", webdav: { url, username: "u", password: "pw" } }));
		const a = createStudioBackup({ pluginConfig: { remoteKeep: 2 }, logger: quiet });
		const st = await a.status();
		assert.equal(st.remote.configured, true);
		assert.ok(!JSON.stringify(st).includes("pw"), "status 不回显凭据");
		const ids = [];
		for (let i = 0; i < 3; i++) {
			const e = await a.exportPackage({ label: "dav" + i });
			ids.push(e.id);
			const r = await a.push({ id: e.id });
			assert.equal(r.pushed, true);
		}
		assert.ok(auth.every((h) => h === "Basic " + Buffer.from("u:pw").toString("base64")), "沿用 sync.json 的 Basic 认证");
		assert.equal(files.get("/dav/studio-backup/LATEST").toString().trim(), ids[2]);
		assert.ok(!files.has(`/dav/studio-backup/${ids[0]}.tar.gz`), "超出 remoteKeep 的远端旧包被删");
		assert.ok(files.has(`/dav/studio-backup/${ids[1]}.tar.gz`) && files.has(`/dav/studio-backup/${ids[2]}.tar.gz.sha256`));
		assert.deepEqual(JSON.parse(files.get("/dav/studio-backup/INDEX.json")).packages.map((x) => x.id), ids.slice(1));
		// B 取 LATEST
		useHome(homeB);
		write(p(homeB, ".dsh", "dsh-studio", "sync.json"), JSON.stringify({ channel: "webdav", webdav: { url, username: "u", password: "pw" } }));
		const b = createStudioBackup({ logger: quiet });
		const pulled = await b.pull({});
		assert.equal(pulled.id, ids[2]);
		assert.equal(pulled.checksumChecked, true);
		assert.ok(existsSync(pkgPath(homeB, ids[2])));
		assert.equal((await b.verify({ id: ids[2] })).ok, true);
		// 远端被篡改：sha 对不上 → 拒收，本地不落
		const tampered = Buffer.from(files.get(`/dav/studio-backup/${ids[1]}.tar.gz`));
		tampered[tampered.length - 10] ^= 0xff;
		files.set(`/dav/studio-backup/${ids[1]}.tar.gz`, tampered);
		await assert.rejects(b.pull({ id: ids[1] }), /sha256 与远端记录不符/);
		assert.ok(!existsSync(pkgPath(homeB, ids[1])));
	} finally {
		server.close();
	}
	// 没配 WebDAV：明确报错，不猜地址
	useHome(join(root, "machine-c"));
	await assert.rejects(createStudioBackup({ logger: quiet }).push({}), /没有备份包|webdav\.url/);
});

test("[7] 工具 / 路由经注册层可用；路由只认 loopback", async () => {
	useHome(homeB);
	const backup = createStudioBackup({ logger: quiet });
	const tools = Object.fromEntries(buildStudioBackupTools({ backup }).map((t) => [t.name, t]));
	assert.deepEqual(Object.keys(tools).sort(), ["skillmgr_studio_backup", "skillmgr_studio_restore"]);
	const status = await tools.skillmgr_studio_backup.execute({ action: "status" });
	assert.equal(status.ok, true);
	assert.match(status.message, /整目录灾备/);
	const exp = await tools.skillmgr_studio_backup.execute({ action: "export", label: "tool" });
	assert.equal(exp.ok, true, exp.message);
	const ver = await tools.skillmgr_studio_backup.execute({ action: "verify", id: exp.result.id });
	assert.equal(ver.ok, true, ver.message);
	const dry = await tools.skillmgr_studio_restore.execute({ id: exp.result.id, resolutions: '{"registry:rea":"local"}' });
	assert.equal(dry.ok, true, dry.message);
	assert.equal(dry.dryRun, true, "工具默认只预演");
	const rep = await tools.skillmgr_studio_backup.execute({ action: "report", id: dry.reportId });
	assert.equal(rep.ok, true);
	const bad = await tools.skillmgr_studio_backup.execute({ action: "delete", id: "../../etc" });
	assert.equal(bad.ok, false);
	assert.match(bad.message, /不合法/);

	const routes = buildStudioBackupRoutes({ logger: quiet }, { backup });
	assert.deepEqual(routes.map((r) => r.path), Object.values(STUDIO_BACKUP_API));
	const call = async (path, method, body, remote = "127.0.0.1", query = "") => {
		const route = routes.find((r) => r.path === path);
		const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
		const req = { method, url: path + query, headers: { host: "127.0.0.1" }, socket: { remoteAddress: remote }, [Symbol.asyncIterator]: async function* () { yield* chunks; } };
		let status = 0;
		let out = "";
		const res = { writeHead(c) { status = c; return this; }, end(d) { out = String(d ?? ""); } };
		await route.handler(req, res);
		return { status, body: out ? JSON.parse(out) : null };
	};
	assert.equal((await call(STUDIO_BACKUP_API.status, "GET", undefined, "10.0.0.8")).status, 403);
	assert.equal((await call(STUDIO_BACKUP_API.restore, "GET")).status, 405);
	const s = await call(STUDIO_BACKUP_API.status, "GET");
	assert.equal(s.status, 200);
	assert.ok(Array.isArray(s.body.packages));
	const v = await call(STUDIO_BACKUP_API.verify, "POST", { id: exp.result.id });
	assert.equal(v.body.ok, true);
	const pr = await call(STUDIO_BACKUP_API.restore, "POST", { id: exp.result.id });
	assert.equal(pr.status, 200);
	assert.equal(pr.body.dryRun, true, "路由同样默认只预演");
	const rp = await call(STUDIO_BACKUP_API.report, "GET", undefined, "127.0.0.1", "?id=" + pr.body.id);
	assert.equal(rp.body.id, pr.body.id);
	assert.equal((await call(STUDIO_BACKUP_API.remote, "POST", { action: "nope" })).status, 400);
});
