// N-10 fixture：skillmgr_update_check 必须接 upstreamTtlMs 缓存（与 darwin 路径同口径）。
//
// 离线：本地 bare 仓库当上游，skill 目录用 .huashu-skill-meta.json 定源（repo 是本地路径）。
// 缓存是否生效用两条证据：
//   1) TTL 内第二次查询仍返回旧 sha（bare 已经前进了）；
//   2) 第二次查询前把 bare 改名下线 —— 真去 ls-remote 会 failed，命中缓存才会仍 latest。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const lib = (name) => import(pathToFileURL(path.join(pluginRoot, "lib", name)).href);

const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

// ---- 上游：dev 工作仓库 + bare 远端
const bare = path.join(home, "upstream.git");
const dev = path.join(home, "dev");
fs.mkdirSync(dev, { recursive: true });
git(["init", "-b", "main"], dev);
git(["init", "--bare", "-b", "main", bare]);
fs.writeFileSync(path.join(dev, "SKILL.md"), "---\nname: ttl-skill\ndescription: N-10 fixture\n---\nv1\n");
git(["add", "."], dev);
git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-m", "v1"], dev);
const shaV1 = git(["rev-parse", "HEAD"], dev);
git(["remote", "add", "origin", bare], dev);
git(["push", "origin", "main"], dev);

// ---- 扫描根：一个用 meta 定源的 skill 目录，本地 commit 钉在 v1
const agentRoot = path.join(home, ".agents", "skills");
const skillDir = path.join(agentRoot, "ttl-skill");
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: ttl-skill\ndescription: N-10 fixture\n---\nv1\n");
fs.writeFileSync(
	path.join(skillDir, ".huashu-skill-meta.json"),
	JSON.stringify({ repo: bare, ref: "main", subdir: "", commit: shaV1 }, null, 2) + "\n"
);

// ---- 工具两件：A 用默认 TTL（与 darwin 同口径），B 用 0 关缓存当对照
const { skillmgrUpdateCheckTool } = await lib("index.js");
const store = { view: async () => ({ agentSkillDir: agentRoot, mirrorDir: "" }) };
const cached = skillmgrUpdateCheckTool(store, { upstreamTtlMs: 600_000 });
const uncached = skillmgrUpdateCheckTool(store, { upstreamTtlMs: 0 });

const pick = (value) => {
	const skill = (value.skills ?? []).find((s) => s.name === "ttl-skill");
	return { status: skill?.status, upstreamSha: skill?.upstreamSha, localSha: skill?.localSha, message: value.message };
};

const first = pick(await cached.execute({ root: agentRoot }));

// ---- 上游前进一个提交
fs.writeFileSync(path.join(dev, "SKILL.md"), "---\nname: ttl-skill\ndescription: N-10 fixture\n---\nv2\n");
git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-am", "v2"], dev);
const shaV2 = git(["rev-parse", "HEAD"], dev);
git(["push", "origin", "main"], dev);

// ---- TTL 内第二次：先让上游彻底不可达，真联网就会 failed
const offline = bare + ".offline";
fs.renameSync(bare, offline);
const second = pick(await cached.execute({ root: agentRoot }));
fs.renameSync(offline, bare);

// ---- 对照：ttl=0 实例必须查到新 sha（证明「第二次没变」是缓存造成的）
const fresh = pick(await uncached.execute({ root: agentRoot }));

process.stdout.write(JSON.stringify({ shaV1, shaV2, first, second, fresh, agentRoot }));
