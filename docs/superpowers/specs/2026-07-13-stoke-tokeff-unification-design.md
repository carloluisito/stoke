# Stoke × Tokeff Unification — Design Spec

**Date:** 2026-07-13
**Status:** Approved direction (structure A: workspaces monorepo; name: stoke; one CLI + one dashboard; auto-start + self-heal)

## Problem

Two tools solve one problem — minimizing Claude Code token cost — from different angles:

- **stoke** (this repo): local HTTP proxy on `127.0.0.1:9876` that keeps prompt caches warm with `max_tokens: 0` pings, preventing expensive cache rebuilds. Has its own HTML dashboard on 9876, savings math, pricing multipliers, budget caps, event log (`~/.stoke/events.jsonl`).
- **tokeff** (`personal/token-efficiency`): transcript-based spend monitor — JSONL parser → SQLite → waste detectors → React dashboard on 5599 — plus Claude Code hooks/skills/statusline that change Claude's behavior in-session.

They disagree with each other today: tokeff never sees ping spend (pings don't appear in transcripts), each maintains its own pricing tables, and there are two dashboards with two versions of "what did this save/cost."

## Goal

One app, one brand (**stoke**), one command, one dashboard, one set of numbers. The proxy remains crash-isolated and zero-dependency — nothing that must never die shares a failure surface with anything that changes often.

## Repo layout (npm workspaces monorepo)

```
stoke/
├── package.json               # workspaces root; "bin": { "stoke": "packages/cli/bin/stoke.mjs" }
├── packages/
│   ├── proxy/                 # today's stoke src/ + tests/, unchanged role
│   │   ├── package.json       # ZERO production dependencies (tsx/typescript dev-only)
│   │   └── src/               # proxy, registry, scheduler, savings, budget, logger,
│   │                          # usage-parser, digest, env-setup, otel, config-schema
│   ├── monitor/               # tokeff's code, absorbed with git history
│   │   ├── package.json       # fastify, better-sqlite3, chokidar; react/vite/recharts (dev)
│   │   ├── src/               # parser, ingest, db, analytics, server
│   │   ├── web/               # the ONE React dashboard
│   │   ├── scripts/           # report.mjs, audit-session.mjs, install.mjs
│   │   └── plugin/            # Claude Code hooks, statusline, skills, cheap agents
│   ├── shared/                # single source of pricing truth
│   │   ├── package.json       # zero dependencies (so proxy may depend on it)
│   │   ├── pricing.json       # effective-dated per-model rules (from tokeff config/pricing.json)
│   │   └── pricing.mjs        # cost calculator used by BOTH proxy savings math and monitor turn pricing
│   └── cli/
│       ├── package.json       # zero dependencies
│       ├── bin/stoke.mjs      # command dispatch
│       └── src/supervisor.mjs # child-process supervision
└── docs/
```

Rules:
- `packages/proxy` and `packages/shared` and `packages/cli` stay **zero-production-dependency** forever. Proxy may import only from `shared`.
- The proxy's HTML dashboard (`dashboard/index.html`, dashboard routes in `dashboard-handler.ts`) is **removed**. Port 9876 serves proxy duties plus one JSON endpoint: `GET /_stoke/stats` (localhost-only) exposing live state: active sessions, detected TTL per session, pings fired, next ping ETA, budget state, uptime.
- `personal/token-efficiency` is retired after the merge (history preserved inside stoke).

## Data flow — one set of numbers

Single database: `~/.stoke/stoke.db` (better-sqlite3, owned by monitor only; the proxy never touches SQLite).

Sources feeding it:
1. **Transcript turns** — existing tokeff ingest of `~/.claude*/projects/**/*.jsonl` (chokidar watcher): per-turn input/output/cache-write/cache-read tokens, priced.
2. **Proxy events** — monitor tails `~/.stoke/events.jsonl` (rotation-aware) into new tables: `proxy_pings` (ts, session, tokens, cost), `proxy_saves` (prevented rebuild events w/ estimated saved $), `proxy_resumes` (outcome: survived/partial/rebuilt), `proxy_health` (starts, crashes, TTL detections).

One pricing source: `packages/shared/pricing.json` + `pricing.mjs`. The proxy's savings calculator (`savings.ts`) and the monitor's turn pricing both call it. stoke's ad-hoc pricing multipliers in `~/.stoke/config.json` are removed; model prices have exactly one home.

Unified cost model shown everywhere (dashboard, `/spend`, statusline, digest):

```
net cost = transcript spend + ping spend − prevented-rebuild savings
```

Detector changes: the cache-expiry waste detector becomes **proxy-aware** — for any window where the proxy was up, expiries it prevented are reported as savings, not waste; genuine expiries (proxy down or ping failed) remain waste findings. TTL advisor reads actual detected TTL from proxy events instead of inferring.

## Config

One file: `~/.stoke/config.json` with three sections — `proxy` (existing stoke schema: TTL margin, abandon threshold, budget caps), `monitor` (ports, DB path, transcript roots), `optimizer` (the levers currently in tokeff `plugin/optimizer-config.json`: efficiency_conventions, cache_expiry_warning, context_bloat_warning, bloat_hard_gate, wasteful_read_warning, session_cost_record — each observe/suggest/enforce). Existing configs are migrated on first run of the new CLI; unknown keys are preserved.

## CLI (`stoke`)

- `stoke start` — the supervisor: spawns **proxy** and **monitor** as separate child processes. Restart-on-crash with exponential backoff (1s doubling to 30s cap); the two children are independent — a monitor crash never restarts or touches the proxy. Writes `~/.stoke/supervisor.log` and crash events into `events.jsonl` (so they surface in the dashboard). Refuses to double-start (checks 9876/5599 owners).
- `stoke status` — proxy health (9876 responding, sessions, TTL, pings today), monitor health (5599, ingest lag, DB size), today's net cost.
- `stoke stop` — graceful stop of both children + supervisor (user-initiated only).
- `stoke run -- <cmd>` — existing passthrough (spawn Claude with proxy env, shared lifetime).
- `stoke replay | tail | digest` — kept, digest now reports the unified net-cost model.
- `stoke install` — one-shot setup: `ANTHROPIC_BASE_URL` env (existing env-setup), merge Claude Code hooks/statusline/skills/agents into settings (existing tokeff installer, paths now inside the monorepo), and register a Windows Scheduled Task ("Stoke", run at logon: `stoke start --quiet`). `stoke uninstall` reverses all three.

## Dashboard (monitor, http://localhost:5599)

tokeff's React dashboard is *the* dashboard, extended with the proxy's views:

- **Overview**: net cost today/this week (spend + pings − saves), cache hit rate, proxy up/down badge.
- **Sessions**: existing per-turn waterfall, now annotated with ping events and prevented/actual cache expiries on the timeline.
- **Cache**: merged cache-health view — stoke's TTL/resume-outcome/ping-cap panels + tokeff's cache analytics.
- **Waste**: existing detectors, proxy-aware as described.
- **Proxy**: live `/_stoke/stats` — active sessions, next pings, budget guard state, crash/restart history.
- **Optimizer log**: unchanged.

If the proxy is down, dashboard shows a DOWN banner and proxy panels degrade gracefully; spend monitoring keeps working (it never depended on the proxy).

## Claude Code integration

Everything currently in tokeff `plugin/` moves to `packages/monitor/plugin/` unchanged in behavior: 4 hooks (session-start conventions, pre-tool-use re-read guard, user-prompt-submit bloat gate, stop cost snapshot), statusline, `/spend` + `/efficiency-audit` skills, cheap-explore/cheap-search agents. `~/.claude-work/settings.json` and skill files are repointed to the new paths by the installer. The statusline additionally shows proxy state: `💰 $X.XX session · cache [HIT|COLD] · TTL 42m · $Y.YY today`.

## Error handling

- Supervisor: backoff restarts; after 5 consecutive crashes of a child within 5 minutes it keeps trying at the 30s cap and flags the child UNSTABLE in status/dashboard (never gives up on the proxy).
- events.jsonl tailer: survives rotation (inode/size heuristics), resumes from persisted offset, tolerates partial lines.
- Ingest: transactional per file batch with resume state (existing tokeff design), unchanged.
- Proxy unreachable from dashboard: DOWN banner; detectors fall back to unproxied assumptions for that window.
- Migration safety: the currently-running proxy process is never stopped or restarted by the migration; new code activates on the user's next restart.

## Testing

- Both existing suites keep running: proxy tests (`packages/proxy/tests`, run-tests.mjs) and monitor tests.
- New: **pricing parity** (shared pricing yields identical $ for the same usage on proxy and monitor sides), **events ingest** (sample events.jsonl fixture → expected rows), **net-cost model** (spend + pings − saves arithmetic incl. edge cases: proxy down, zero pings), **supervisor** (kill a fake child → restarted with backoff; monitor crash does not signal proxy child).
- Smoke: dashboard `npm run build`, `stoke status` against live setup.

## Migration plan (repo mechanics)

1. Branch `feat/unify-tokeff` off `fix/opus-4-8-pricing` (contains the current model pricing fix).
2. Restructure stoke in place: `git mv src packages/proxy/src` etc.; root package.json becomes workspaces manifest.
3. Import tokeff **with history**: `git remote add tokeff <local path>` → `git merge -s ours --no-commit --allow-unrelated-histories tokeff/main` → `git read-tree --prefix=packages/monitor/ -u tokeff/main` → commit.
4. Extract shared pricing; rewire both sides.
5. Build monitor ingest of proxy events, dashboard panels, CLI/supervisor, installer, Scheduled Task.
6. Migrate user state: move tokeff SQLite DB to `~/.stoke/stoke.db`, fold optimizer-config into `~/.stoke/config.json`, repoint `~/.claude-work/settings.json` hooks + skills.
7. Verify (tests, dashboard build, `/spend`, port 9876 untouched throughout), push branch, open PR via `gh`.
8. Afterwards (user actions): restart stoke at convenience to activate new code; delete the retired `token-efficiency` folders (work copy is locked by an active session until it closes).

## Out of scope

- Restarting the live proxy (user does this when convenient).
- Any change to ping strategy, TTL detection, or detector logic beyond proxy-awareness described above.
- Publishing to npm; remote CI.
