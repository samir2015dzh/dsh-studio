/**
 * 审计 8：补测试——lib/sync.js（照 studio-backup 测试的进程内假服务范式测 WebDAV；git 通道用本机
 * 临时 bare 仓库，全程离线）、lib/lifecycle.js（伪 HOME 测 classify / scan / 归档 / 豁免）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modUrl = (rel) => pathToFileURL(join(pluginRoot, rel)).href;
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-sync-life-8-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.DSH_HOME = join(fakeHome, ".dsh");
process.env.DSH_STUDIO_HISTORY_DIR = join(fakeHome, "history");
process.env.DSH_STUDIO_TELEMETRY_DIR = join(fakeHome, "telemetry");

const { pushSnapshot, pullSnapshot, saveSync, loadSync } = await import(modUrl("lib/sync.js"));
const { createSnapshot } = await import(modUrl("lib/snapshot.js"));
const life = await import(modUrl("lib/lifecycle.js"));
const { readVersionRecords } = await import(modUrl("lib/versions.js"));
test.after(() => rmSync(fakeHome, { recursive: true, force: true }));

const dsh = join(fakeHome, ".dsh");
const put = (rel, text) => {
	mkdirSync(dirname(join(dsh, rel)), { recursive: true });
	writeFileSync(join(dsh, rel), text);
};
put("AGENTS.md", "# r\n");
put("skills/one/SKILL.md", "---\nname: one\ndescription: x\n---\nbody\n");
const snapDir = (id) => join(dsh, "dsh-studio", "snapshots", id);

function davServer({ failLatest = false, mkcol = null } = {}) {
	const files = new Map();
	const seen = [];
	const server = createServer((req, res) => {
		seen.push({ method: req.method, auth: req.headers.authorization, path: new URL(req.url, "http://x").pathname });
		const key = decodeURIComponent(new URL(req.url, "http://x").pathname);
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.method === "MKCOL") return res.writeHead(mkcol ?? (files.has(key) ? 405 : 201)).end();
			if (req.method === "PUT") {
				if (failLatest && key.endsWith("/LATEST")) return res.writeHead(507).end();
				files.set(key, Buffer.concat(chunks));
				return res.writeHead(201).end();
			}
			if (req.method === "GET") return files.has(key) ? res.writeHead(200).end(files.get(key)) : res.writeHead(404).end();
			res.writeHead(405).end();
		});
	});
	return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, files, seen, url: `http://127.0.0.1:${server.address().port}/dav` })));
}

test("[#8 审计 8] sync WebDAV：push 三件套 + Basic 认证；pull 落成本地快照且字节一致；失败如实报", async () => {
	const s = await createSnapshot("dav");
	const dav = await davServer();
	try {
		const cfg = { url: dav.url + "/", username: "u", password: "p:w" };
		await saveSync({ channel: "webdav", webdav: cfg });
		assert.equal((await loadSync()).webdav.password, "p:w");
		const r = await pushSnapshot("webdav", cfg, s.id);
		assert.deepEqual(r, { channel: "webdav", snapshotId: s.id, pushed: true });
		assert.ok(dav.seen.every((x) => x.auth === "Basic " + Buffer.from("u:p:w").toString("base64")), "每个请求都带认证");
		assert.equal(dav.seen[0].method, "MKCOL", "先建目录");
		assert.equal(dav.files.get("/dav/LATEST").toString().trim(), s.id);
		assert.ok(dav.files.get("/dav/config.tar.gz").equals(readFileSync(join(snapDir(s.id), "config.tar.gz"))));
		const pulled = await pullSnapshot("webdav", cfg, "from-dav");
		assert.equal(pulled.remoteId, s.id);
		assert.ok(readFileSync(join(snapDir(pulled.id), "config.tar.gz")).equals(readFileSync(join(snapDir(s.id), "config.tar.gz"))), "取回字节一致");
		assert.equal(JSON.parse(readFileSync(join(snapDir(pulled.id), "manifest.json"), "utf8")).pulled, true);
		await assert.rejects(() => pushSnapshot("webdav", cfg, "../escape"), /快照|id|不合法|invalid/i, "路径越权的 id 拒绝");
		await assert.rejects(() => pushSnapshot("webdav", cfg, "20990101-000000000-nope"), /快照不存在/);
		await assert.rejects(() => pushSnapshot("webdav", {}, s.id), /需要 url/);
	} finally {
		dav.server.close();
	}
	const broken = await davServer({ failLatest: true });
	try {
		await assert.rejects(() => pushSnapshot("webdav", { url: broken.url }, s.id), /PUT LATEST → HTTP 507/, "LATEST 写失败不能报成功");
		await assert.rejects(() => pullSnapshot("webdav", { url: broken.url + "/empty" }), /远端没有 LATEST/);
	} finally {
		broken.server.close();
	}
	const noDir = await davServer({ mkcol: 409 });
	try {
		await assert.rejects(() => pushSnapshot("webdav", { url: noDir.url }, s.id), /MKCOL → HTTP 409/);
	} finally {
		noDir.server.close();
	}
});

test("[#8 审计 8] sync git：空 bare 仓库首推建分支；同快照再推 = 无变化；pull 取回一致；远端不可达 pull 失败", async () => {
	const bare = mkdtempSync(join(tmpdir(), "sync-bare-"));
	execFileSync("git", ["init", "--bare", "-q", bare]);
	const s = await createSnapshot("git");
	const cfg = { remote: bare, workDir: join(fakeHome, "work-a") };
	const first = await pushSnapshot("git", cfg, s.id);
	assert.equal(first.pushed, true);
	const again = await pushSnapshot("git", cfg, s.id);
	assert.equal(again.pushed, false, "远端已是最新");
	// 另一台机器（另一份工作副本）拉
	const pulled = await pullSnapshot("git", { remote: bare, workDir: join(fakeHome, "work-b") }, "from-git");
	assert.equal(pulled.remoteId, s.id);
	assert.ok(readFileSync(join(snapDir(pulled.id), "config.tar.gz")).equals(readFileSync(join(snapDir(s.id), "config.tar.gz"))));
	await assert.rejects(() => pullSnapshot("git", { remote: join(fakeHome, "no-such-repo"), workDir: join(fakeHome, "work-c") }), /git fetch 失败/, "拿不到远端不拿旧副本冒充");
	await assert.rejects(() => pushSnapshot("git", { workDir: join(fakeHome, "work-d") }, s.id), /需要 remote/);
	await assert.rejects(() => pushSnapshot("ftp", cfg, s.id), /未知通道/);
	rmSync(bare, { recursive: true, force: true });
});

test("[#8 审计 8] lifecycle.classifySkill：档位与阈值关闭", () => {
	assert.equal(life.classifySkill({ ageDays: 10 }), "active");
	assert.equal(life.classifySkill({ ageDays: 90 }), "stale");
	assert.equal(life.classifySkill({ ageDays: 180 }), "archive");
	assert.equal(life.classifySkill({ ageDays: 500, archiveAfterDays: 0 }), "stale", "归档档关闭");
	assert.equal(life.classifySkill({ ageDays: 500, archiveAfterDays: 0, staleAfterDays: 0 }), "active");
	assert.equal(life.classifySkill({ ageDays: NaN }), "active");
});

test("[#8 审计 8] lifecycle.scanLifecycle：伪 HOME 里 stale 标记、目录版归档（留版本记录）、pinned / .no-merge / 单文件豁免、只报告模式零改动", async () => {
	const root = join(fakeHome, ".agents", "skills");
	const mk = (name, frontExtra = "") => {
		mkdirSync(join(root, name), { recursive: true });
		writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n${frontExtra}---\nbody\n`);
	};
	const now = Date.now();
	const DAY = 86_400_000;
	mk("fresh");
	mk("dusty");
	mk("ancient");
	mk("pinned-old", "protected: true\n");
	mk("nomerge-old");
	writeFileSync(join(root, "nomerge-old", ".no-merge"), "");
	writeFileSync(join(root, "loose.md"), "---\nname: loose\ndescription: d\n---\n");
	const age = (p, days) => utimesSync(p, (now - days * DAY) / 1000, (now - days * DAY) / 1000);
	age(join(root, "dusty", "SKILL.md"), 100);
	age(join(root, "ancient", "SKILL.md"), 400);
	age(join(root, "pinned-old", "SKILL.md"), 400);
	age(join(root, "nomerge-old", "SKILL.md"), 400);
	age(join(root, "loose.md"), 400);
	// fresh 有使用记录（比 mtime 优先）
	await life.recordSkillLoads([{ name: "fresh", sessionId: "s1", at: now - DAY }], { now });
	assert.equal(await life.recordSkillLoads([{ name: "fresh", sessionId: "s1", at: now }], { now }), 0, "同会话重放幂等");

	const cfg = { agentSkillDir: root };
	const dry = await life.scanLifecycle(cfg, { now, apply: false });
	assert.deepEqual(dry.stale.map((s) => s.name), ["dusty"]);
	assert.deepEqual(dry.archived.map((s) => s.name), ["ancient"]);
	assert.equal(dry.archived[0].path, null);
	assert.ok(existsSync(join(root, "ancient")), "只报告：不动文件");
	assert.deepEqual(dry.skipped.map((s) => [s.name, s.reason]).sort(), [["loose", "single-file"], ["nomerge-old", "pinned"], ["pinned-old", "pinned"]]);

	const real = await life.scanLifecycle(cfg, { now });
	assert.equal(existsSync(join(root, "ancient")), false, "归档后原目录不在");
	assert.ok(existsSync(join(real.archived[0].path, "SKILL.md")), "搬到 skill-archive-*");
	assert.match(real.archived[0].path, /skill-archive-/);
	assert.ok(existsSync(join(root, "pinned-old")) && existsSync(join(root, "nomerge-old")) && existsSync(join(root, "loose.md")), "豁免项不动");
	const state = await life.loadState();
	assert.equal(state.dusty.status, "stale");
	assert.equal(state.ancient.status, "archived");
	assert.equal(state.fresh.useCount, 1);
	assert.ok((await life.listArchived()).some((a) => a.name === "ancient"));
	const rec = (await readVersionRecords()).find((r) => r.action === "recycle" && r.name === "ancient");
	assert.ok(rec, "归档留了一条 recycle 版本记录（可回滚）");
});
