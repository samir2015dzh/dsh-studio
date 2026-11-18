<div align="center">

  # DSH Studio

  **A skill workbench plus on-demand MCP, in one plugin**

  [简体中文](README.zh-CN.md) · [Features](#features) · [Install](#installation) · [Start](#5-minute-start) · [Advanced](#advanced) · [Appendix](#appendix)

  ![License](https://img.shields.io/badge/License-MIT-blue.svg)
  ![DSH](https://img.shields.io/badge/DSH-Plugin-0f766e.svg)
  ![Version](https://img.shields.io/github/package-json/v/samir2015dzh/dsh-studio?label=Version&color=2563eb)
</div>

> Upstream already lets you view, edit, and extract skills by hand. This plugin adds automatic judgment, auto-save, semantic merge, models that follow DSH, plus on-demand MCP, filters, a trash can, and grouping by purpose.

## Features

Once it is installed in DSH, it can decide whether a turn is worth saving, which skill it belongs to, and how to avoid duplicates.

- **Judge first, then extract**: A few seconds after a turn ends, it first asks whether anything is worth saving. Full extraction runs only when the answer is yes, with interval limits so it does not run too often.
- **Save directly when it can**: New skills are written to `~/.agents/skills` by default, so DSH can use them right away. They stay in the review list only when writing fails (for example, a name conflict).
- **Merge when it fits**: New content is compared with skills you already have. It merges into an existing one when it can, and creates a new skill only for a truly new topic. See [Advanced](#how-merging-works) for the details.
- **Models follow DSH**: The panel lists the models already configured in DSH. Leave them blank to follow the current chat. The plugin does not store API keys.
- **See recent changes**: The workbench lists skills that changed recently, so you can see what it just learned.
- **Cleanup before writing**: Merges drop repeated sections and protocol leftovers, and reject overwrites that become much shorter.
- **Skill checkup**: After a `SKILL.md` is written, the next turn can review it with darwin-skill. See [Advanced](#skill-checkup-and-grouping).
- **Three filters**: Filter by source, enabled state, and purpose at the same time.
- **Grouped by purpose**: Extraction picks one of eight fixed categories. Existing skills can be classified in batch; see [Advanced](#skill-checkup-and-grouping).
- **Trash can**: Delete moves a skill to the trash. You can restore it later, or delete it for good.
- **Multiple sources**: By default it only scans DSH and `~/.agents`. To include other agent skill folders, see [Configuration](#configuration).
- **Name checks**: Invalid names are flagged so the host can still load the skill, and name conflicts show which copy is actually used.

## Installation

> **Do not** junction this repo's `node_modules` or `node_modules/@deepseek-ai` to your DSH install directory.
> `pnpm install` / `npm install` in this repo run a path check first and will fail if a link escapes the repo. That check is **not** shipped in the published tarball (pnpm 10+ would otherwise report `ERR_PNPM_IGNORED_BUILDS`). Install dependencies only inside this repo.

Point the plugin at this folder with `link:` so you can change the code without publishing.

1. Clone the repo anywhere you like:

```bash
git clone <this-repo> D:/dsh-plugins/dsh-studio
```

2. Register it in the profile `package.json`:

```json
{
  "dependencies": { "dsh-studio": "link:D:/dsh-plugins/dsh-studio" },
  "dsh": { "profile": { "bundles": ["dsh-studio"] } }
}
```

3. Create a directory junction so `node_modules` resolves here:

```powershell
New-Item -ItemType Junction `
  -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-studio" `
  -Target "D:\dsh-plugins\dsh-studio"
```

4. Install the `zstd` command (**needed for automatic extraction**): DSH writes session logs as `session.v4.jsonl.zstd`, and the extractor decompresses them with `zstd -d -c`. Without it no session can be read, and nothing is reported — extraction just never finds anything. Use `winget install Meta.Zstandard`, `brew install zstd`, or `apt install zstd`, then confirm `zstd --version` works.

5. Restart DSH and open **Settings → Skill workbench**.

## 5-minute start

If you only want to browse or edit skills, you do not need the full unattended setup:

1. Add the plugin to your profile as above, then restart DSH.
2. Open “Skill workbench” in Settings to browse, edit, and toggle skills.
3. **Turn off auto-save first**: set `autoAccept: false` in the config. The factory default is `true`, which writes to your skill library directly.
4. When you want automatic extraction, turn `autoPerTurn` / `autoAccept` back on, and make sure `agentSkillDir` points at the folder you really want to write to.

Install dependencies only inside this repo. You can run `npm run guard:install` first.

## Configuration

> Other agent skill roots (such as `~/.claude` or `~/.cursor`) are **not scanned by default**. Set `DSH_STUDIO_SCAN_ALL_AGENTS=1` to include them, or set `DSH_CLAUDE_HOME` / `DSH_CURSOR_HOME` and similar for a single source.

The config file is `~/.dsh/dsh-studio/extractor.json` (mode 0600). These are the factory defaults:

```json
{
  "enabled": true,
  "autoPerTurn": true,
  "intervalMinutes": 1440,
  "windowDays": 7,
  "maxCandidatesPerRun": 3,
  "autoAccept": true,
  "mergeThreshold": 0.2,
  "skillLanguage": "zh",
  "agentSkillDir": "C:\\Users\\<you>\\.agents\\skills",
  "provider": "",
  "model": ""
}
```

| Key | What it does |
| --- | --- |
| `autoPerTurn` | After each turn, ask whether anything is worth saving |
| `intervalMinutes` | Fallback scan interval; default is once a day. `0` means rely on per-turn judgment only |
| `autoAccept` | When `true`, write straight to the skill library instead of the review list |
| `mergeThreshold` | Local similarity pre-filter (the model still makes the final call) |
| `skillLanguage` | `zh` (default) / `en` / `auto`; code and commands are not translated |
| `provider` / `model` | Leave blank to follow the current chat, or pick one in the panel |

The older `llmBaseUrl` / `llmApiKey` / `llmModel` fields still work, but you usually do not need them.

## Advanced

### Re-align local dependencies after every dsh upgrade

dsh ships fast and the runtime shape of `@deepseek-ai/*` changes with it. When this plugin is installed into a
profile as a link, its bare imports resolve to **this repo's own `node_modules`**, not the host copy. Falling behind
the host breaks plugin assembly — the symptom is every plugin vanishing after a restart (the host falls back to its
base + web-app skeleton).

```bash
node scripts/check-host-deps.mjs   # compares against the host; exit 1 = mismatch
```

Run it after each dsh upgrade; when it reports a mismatch, apply the printed `pnpm add -D ...` command and restart dsh.

### How merging works

A candidate has to pass four checks before it is written. If any check says it should not merge, it becomes a new skill or is dropped.

```
New candidate
  │
  ├─ ① Tombstone: this name was merged before
  │     → Fold into the longest skill in the same family; drop it if that fails
  │
  ├─ ② Category labels: the model looks at category first, then the description
  │     → Different category and unlike description usually means no merge
  │
  ├─ ③ Local review: if the model suggests a merge, check once more
  │     → Same family is allowed; cross-family needs a similarity floor, or it is saved as new
  │
  └─ ④ The merge itself: add the new experience into existing sections
        → Drop repeated sections and leftovers; reject a much shorter body
```

Categories are derived from names (for example `gui-*` → gui). You can extend them in `CATEGORY_ALIASES` in `lib/extractor.js`.

### On-demand MCP

The “MCP servers” page collects MCP servers already in DSH, loads them on demand, disconnects them when idle, and lets you choose which tools are visible.

- Three modes: **on** (tools are given to the model right away) / **on demand** (listed first, loaded when used) / **off**
- If nothing is called for a while, the upstream connection is closed and reopened the next time it is needed
- Existing config is scanned at startup; click “Take over” to let this plugin manage a server
- Secret fields are masked by default, and ordinary environment variables are not listed

Tools: `mcp_list` / `mcp_register` / `mcp_load` / `mcp_call` / `mcp_takeover` / `mcp_catalog_eval` (catalog regression watch, report-only).
Config lives at `~/.dsh/dsh-studio/mcp.json`. See [MCP.md](./MCP.md) for fields and limits.

### Config snapshots

The “Config snapshots” page packs the `~/.dsh` files worth backing up, so you can return to a point in time.

- Config and skill-related files are included; **secrets, session logs, and `node_modules` are not**
- “Back up now” can take a label; a safety copy is made automatically before a real restore
- You can export or import a `.tar.gz`, and remap paths when moving between machines
- Scheduled cleanup only removes automatic snapshots, not ones you made by hand

Settings live in `~/.dsh/dsh-studio/snapshot.json`. Snapshot files are under `~/.dsh/dsh-studio/snapshots/`.

### Multi-machine sync

Below the snapshot panel, you can push the latest backup or pull it onto another machine.

Git, Gist, WebDAV, and S3 are supported. A pull lands as a local snapshot first and does not overwrite your current config directly.

Sync settings live in `~/.dsh/dsh-studio/sync.json`. **Credentials are never stored in snapshots.**

### Skill checkup and grouping

After a `SKILL.md` is written, the next turn can ask `darwin-skill` to score it on nine dimensions. Related duplicates are folded into one host.

Existing skills can be classified in batch with `node scripts/classify-skills.mjs --write`. Preview with `--limit` first; each file is backed up as `.bak-group` before it is written.

### Telemetry and version history (evolution groundwork)

The plugin records two things locally as groundwork for future automatic skill / MCP optimization. Neither changes behavior:

- **Telemetry**: skill triggers / injections, MCP tool calls (server, tool, duration, success or failure, error class), and which MCP catalog entries shown to the model each turn were used. Only names, counts, durations and error classes are stored, **never conversation text or arguments**. Daily files at `~/.dsh/dsh-studio/telemetry/events-YYYY-MM-DD.jsonl`, kept 90 days, excluded from snapshots. `skillmgr_stats` shows the last 7 days. If writing fails, only the stats are lost.
- **Version history**: every write to both skill stores and the MCP registry (distilled create, semantic merge, rewrite, group change, idle recycle, trash, registry add/remove/edit) gets a record: time, actor, diff summary, source session, empty eval slot. Stored outside `.dsh` in `~/.dsh-studio/history/` and included in config snapshots and sync; registry credentials never enter history. Query with `skillmgr_history`; `skillmgr_rollback` restores one skill or the whole registry to any version, and the rollback is recorded too.

Override the directories with `DSH_STUDIO_TELEMETRY_DIR` / `DSH_STUDIO_HISTORY_DIR`; set `telemetry.enabled: false` in config to turn telemetry off.

### Skill optimization loop

On top of telemetry and version history the plugin can improve frequently used skills: pick candidates from telemetry (high use and high failure rate first; **skills without telemetry are never auto-optimized**) → Darwin-style iterations (mutate → evaluate → keep the best) → evaluation gate → risk tier → a change report per round.

- **Gate**: each skill gets a frozen regression set (`~/.dsh-studio/optimizer/evals/<skill>.json`, generated from the current version on first run, editable). A candidate must score at least the baseline with no regression on critical cases; failures are discarded with reasons (`discards.jsonl`). No bypass switch; only the owner can release an individual case from the panel (`POST /api/dsh-studio/optimizer/override`, reason required, recorded).
- **Tiers**: wording / examples / ordering / formatting are applied automatically after the gate (`optimize` version record, rollback with `skillmgr_rollback`); adding or removing steps, changing triggers or tool calls only produce a proposal for `skillmgr_optimize_decide`. Rules live in `optimizer.autonomy`.
- **Red lines**: permission / security sections are never changed automatically. The list is in `lib/skill-redlines.js` (built-ins cannot be removed; `optimizer.redlines.extra*` only adds).
- **Conflicts**: duplicate skill names, a file changed during the round, or a model-reported overlap with a neighbouring skill stop the round with a report.
- **Cadence and cost**: automatic rounds are **off by default**. When enabled they run only in the idle window (02:00–06:00, idle ≥ 30 min, ≥ 20 h apart) with caps of 1 skill, 2 generations × 2 mutations, 12 model calls, 40k tokens and 5 minutes per round; hitting any cap stops the round.

Enable with `optimizer: { enabled: true }` in the plugin config row or `~/.dsh-studio/optimizer/config.json`. Run manually with `skillmgr_optimize_run`; inspect with `skillmgr_optimize_status`. Override the directory with `DSH_STUDIO_OPTIMIZER_DIR`.

### Skill library governance

Governance only **proposes and reports**; it never merges or edits a skill on its own. Every write goes through version records and owner approval.

- **Merge proposals (R6)**: candidates from telemetry (co-trigger, same name in several roots, usage) plus content similarity (trigger, step skeleton, tool set), each with evidence. A proposal carries a merged draft, a diff, and an eval preview through the optimizer gate (both sources and the draft). Approving writes a new version of the kept skill that records both sources (`governance-merge`); the other source goes to trash (`merge-archive`, recoverable) and `skillmgr_governance_status skill=<name>` shows where it was merged. Permission / security sections must survive the merge or the proposal is blocked.
- **Conflict report (G7)**: same name in several roots, trigger overlap, contradictory instructions, tool conflicts, each with quoted evidence and a suggested action. Runs in the idle round and incrementally whenever a skill gets a new version. The owner rules (`rule` / `dismiss`).
- **Lessons (G8)**: only from telemetry failures, optimizer discard / override records and owner-ruled conflicts; every lesson cites its source events, repeats merge into a count (priority), and the output is a patch proposal. Lessons are versioned and can be withdrawn (recorded).
- **Shown but unused**: library skills that never triggered in the window, plus MCP catalog entries shown but unused, per server and per session.
- **Cadence**: automatic rounds are **off by default** (`governance: { enabled: true }`); idle window 02:00–06:00, ≥ 7 days apart, caps of 1 merge proposal, 2 lesson proposals, 8 model calls, 40k tokens, 5 minutes. Reports go to `~/.dsh-studio/governance/reports/` (`DSH_STUDIO_GOVERNANCE_DIR`).

### Distillation hardening

Extraction (per turn, on the timer, from the panel or a tool) no longer writes skills directly or folds into existing ones. Every candidate becomes a **draft** under `~/.dsh-studio/distill/drafts/` (outside every skill root, so the model cannot call it) with provenance: session ids, time, and the key turns located in each source session.

- **Dedupe first**: drafts that closely resemble a library skill (governance similarity ≥ `distill.dedupe.minScore`) become a governance merge proposal with the draft as the source; nothing new is created. Approving the proposal records the draft in the merged version's lineage.
- **Gate**: other drafts are scored on an eval set built from the source session's real requests plus the draft (frozen in the optimizer eval directory) and judged with the optimizer's `gateVerdict` against an absolute line (mean ≥ 7, critical ≥ 6). Passing drafts are written through the versioned path (`distill:gate-pass`, record carries `distill` provenance); failures are discarded with reasons (`discards.jsonl`). There is no bypass; the owner can only `discard` or `requeue` a draft.
- **Cadence**: manual `skillmgr_distill_run` (optionally naming a session) plus an idle batch that is **off by default** (`distill: { enabled: true }`), capped at 3 drafts, 12 model calls, 40k tokens and 5 minutes per batch. Each batch writes a report with counts, pass rate and where merges went.
- **Source jump**: `GET /api/dsh-studio/distill/source?id=<draft>` returns the messages around each key turn.

### Studio backup package (cross-machine restore)

To move to another machine, or to combine what two DSH installs have learned, use a studio backup package: one `.tar.gz` holding the MCP registry, the optimizer / governance / distill / extractor configs, both skill libraries, the version history and the evolution data, with a manifest and a sha256 per entry. Credentials are always redacted.

- **Restore merges per object**: version history is a union by id; skills follow the version chain (missing locally → create, local is an ancestor of the packaged version → fast-forward, local is newer → keep). Forked skills, same-named servers with different config and differing config files are reported as **pending conflicts and left alone** until the owner reruns with `resolutions`. Restores are dry-run by default; a real one takes a protective package first, and every run writes a restore report. Source-machine paths are rewritten to this machine; missing credentials are listed field by field.
- **Cadence**: manual `skillmgr_studio_backup {action:"export"}`; idle auto-packaging is **off by default** (`studioBackup: { enabled: true }`) with configurable retention; WebDAV push / pull reuse the webdav settings in sync.json.
- **Versus snapshots and the daily backup**: those are same-machine disaster recovery (files overwritten as-is); the package is a portable per-object merge. Neither replaces the other. See [STUDIO-BACKUP.md](./STUDIO-BACKUP.md) (Chinese).

## Appendix

### Tools

| Tool | What it does |
| --- | --- |
| `skillmgr_list` | List skills (source, enabled state, group) |
| `skillmgr_get` | Read a skill's full content |
| `skillmgr_save` | Write the full `SKILL.md` back |
| `skillmgr_policy` | Enable or disable invocation |
| `skillmgr_extract_run` | Run extraction now |
| `skillmgr_extract_status` | Show switches, interval, queue, and last run |
| `skillmgr_extract_config` | Change extraction settings |
| `skillmgr_extract_list` / `_accept` / `_reject` | Handle the review list (usually empty when auto-save is on) |
| `skillmgr_trash` / `_list` / `skillmgr_restore` / `skillmgr_purge` | Move to trash, list, restore, or delete for good |
| `skillmgr_snapshot` / `_list` / `_restore` / `_transfer` | Back up, list, restore, export, or import config |
| `skillmgr_sync` | Sync across machines: view config, push, or pull |
| `skillmgr_stats` | Weekly telemetry: calls, failure rate and latency per skill and per MCP server / tool, plus catalog entries shown but unused |
| `skillmgr_optimize_status` | Optimization loop config, red-line list, pending proposals, recent reports |
| `skillmgr_optimize_run` | Run one optimization round now and return its report |
| `skillmgr_optimize_decide` | Approve or reject an optimization proposal |
| `skillmgr_governance_status` | Governance config, pending merge / lesson proposals, open conflicts, lineage of one skill, latest report |
| `skillmgr_governance_run` | Run one governance round now (conflicts / merge / lessons / unused) |
| `skillmgr_governance_decide` | Approve / reject a proposal, rule / dismiss a conflict, withdraw a lesson |
| `skillmgr_distill_status` | Distillation queue, drafts, gate pass / fail records, reports; one draft with its provenance |
| `skillmgr_distill_run` | Run one distillation batch now (optionally distill a named session first) |
| `skillmgr_distill_decide` | Discard or requeue a draft (no direct approval: drafts enter the library only through the gate) |
| `skillmgr_studio_backup` | Studio backup package: status / export / verify / push to or pull from WebDAV / delete / read a restore report |
| `skillmgr_studio_restore` | Restore from a package (dry-run by default; conflicts stay pending until resolved) |
| `skillmgr_history` | Version history of skills and the MCP registry |
| `skillmgr_rollback` | Roll one skill or the whole registry back to a version (the rollback is recorded too) |

The panel uses the HTTP routes under `/api/dsh-studio/*`.

### Debugging

#### Known limitations

- State files use a cross-process lock, but it is advisory; a script that bypasses it can still race.
- Panel source lives in `src/client/` as plain JavaScript modules; `lib/client.js` is generated from it (`npm run build:client`). The original TypeScript types were not restored.
- Other agent skill roots are not scanned by default; see Configuration above.

One-shot historical patches live in `scripts/archive/` and are not daily tools.

Raw model output from each call is saved to `~/.dsh/dsh-studio/last-llm-raw.txt`. Check that file first if parsing fails.

These two regression scripts do not touch your real directories:

```bash
node scripts/e2e-preview.mjs    # full extract-to-save path
node scripts/e2e-tombstone.mjs  # tombstone rule check
```

### Differences from upstream

Based on [zhengjy01/dsh-skill-studio](https://github.com/zhengjy01/dsh-skill-studio) (MIT License), with substantial additions.

The main additions are models through the DSH channel, judge-then-save each turn, semantic merge, and the panel's recent-changes list and model picker.

### License

MIT.
