# Stoke × Tokeff Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge tokeff (`personal/token-efficiency`) into stoke as an npm-workspaces monorepo producing one CLI (`stoke`), one dashboard (monitor, port 5599), one pricing source, and one net-cost model — per `docs/superpowers/specs/2026-07-13-stoke-tokeff-unification-design.md`.

**Architecture:** Four workspaces: `packages/proxy` (today's stoke engine, zero-dep, port 9876), `packages/monitor` (tokeff: ingest → SQLite → analytics → Fastify + React dashboard, now also ingesting `~/.stoke/events.jsonl`), `packages/shared` (pricing + savings math, zero-dep), `packages/cli` (supervisor + install). Proxy loses its HTML dashboard, gains a localhost-only stats endpoint.

**Tech Stack:** Node ≥20 ESM, TypeScript+tsx (proxy), plain ESM JS (monitor/shared/cli), better-sqlite3, Fastify, chokidar, React 18 + Vite + Recharts, node:test (proxy) + vitest (monitor).

## Global Constraints

- **NEVER stop, restart, or bind over the running proxy** (PID 32616, port 9876). All work is disk-only; new code activates on the user's next manual restart.
- `packages/proxy`, `packages/shared`, `packages/cli`: **zero production dependencies** (proxy keeps optional @opentelemetry/*; tsx/typescript stay devDeps).
- Proxy may import only from `@stoke/shared`.
- Repo: `C:\Users\carlo\Desktop\repositories\personal\stoke`, branch `feat/unify-tokeff`. Commit after every task; never push to main; PR via `gh` at the end.
- All ESM (`"type": "module"` everywhere).
- Windows paths in user-facing config; forward slashes inside JS.

---

### Task 0: Baseline

**Files:** none (verification only)

- [ ] Run proxy suite: `npm test` in repo root. Expected: all 23 test files pass. Record output.
- [ ] Run monitor suite: `npm test` in `personal/token-efficiency`. Expected: 13 vitest files pass.
- [ ] Verify port 9876 listening (read-only `Get-NetTCPConnection -LocalPort 9876 -State Listen`). Record PID — this instance must be untouched through the whole plan.

### Task 1: Workspace restructure (proxy package)

**Files:**
- Create: `packages/proxy/package.json`, root `package.json` (rewrite as workspaces manifest)
- Move (git mv): `src/` → `packages/proxy/src/`, `tests/` → `packages/proxy/tests/`, `scripts/run-tests.mjs` → `packages/proxy/scripts/run-tests.mjs`, `tsconfig.json` → `packages/proxy/tsconfig.json`
- Keep at root for later tasks: `dashboard/`, `demo/`, `docs/`

**Interfaces:** Produces workspace `@stoke/proxy` with scripts `start`, `test`, `typecheck` runnable via `npm run <s> -w @stoke/proxy`.

- [ ] `git mv src packages/proxy/src` etc. (four moves above).
- [ ] `packages/proxy/package.json`: name `@stoke/proxy`, `"type":"module"`, scripts `{"start":"tsx src/cli.ts start","test":"node scripts/run-tests.mjs","typecheck":"tsc -p . --noEmit"}`, devDeps `tsx`, `typescript`, `@types/node`; optionalDeps: the six `@opentelemetry/*` copied verbatim from old root.
- [ ] Root `package.json`: name `stoke`, private, `"workspaces":["packages/*"]`, scripts `{"start":"node packages/cli/bin/stoke.mjs start","test":"npm run test -ws --if-present","test:proxy":"npm run test -w @stoke/proxy"}`, `"bin":{"stoke":"packages/cli/bin/stoke.mjs"}`.
- [ ] Fix `run-tests.mjs` discovery root if it assumes `tests/` relative to repo root (point to package dir).
- [ ] `npm install` at root (expect EPERM risk on locked files ≈ none: tsx has no natives; retry once if hit).
- [ ] `npm run test:proxy` → all pass. Commit `refactor: move proxy into packages/proxy workspace`.

### Task 2: Import tokeff with git history

**Files:** Create `packages/monitor/**` (entire tokeff tree via read-tree)

**Interfaces:** Produces workspace `@stoke/monitor` (renamed from tokeff package name) with vitest suite green.

- [ ] `git remote add tokeff C:/Users/carlo/Desktop/repositories/personal/token-efficiency && git fetch tokeff`
- [ ] Determine tokeff HEAD branch (`git -C <tokeff> branch --show-current`, expected `main`).
- [ ] `git merge -s ours --no-commit --allow-unrelated-histories tokeff/main` then `git read-tree --prefix=packages/monitor/ -u tokeff/main` then commit `feat: absorb tokeff as packages/monitor (history preserved)`. Remove remote.
- [ ] `packages/monitor/package.json`: rename to `@stoke/monitor`. Exclude `packages/monitor/web` from root workspaces? No — add `"workspaces":["packages/*"]` only; web stays a nested standalone (build via `npm run build --prefix packages/monitor/web`). Ensure monitor `data/`, `node_modules/` not committed (check merged .gitignore covers them).
- [ ] `npm install` at root; `npx vitest run` inside `packages/monitor` → 13 files pass (fix any path assumptions: `config.js` `projectRoot` derivation must resolve to `packages/monitor`, not repo root). Commit.

### Task 3: Shared pricing package (one source of truth)

**Files:**
- Create: `packages/shared/package.json` (`@stoke/shared`, zero deps), `packages/shared/pricing.d.ts`
- Move: `packages/monitor/config/pricing.json` → `packages/shared/pricing.json`; `packages/monitor/src/pricing.js` → `packages/shared/pricing.mjs`
- Modify: `packages/monitor/src/*` imports of pricing; `packages/proxy/src/config.ts` (modelPricing defaults), `packages/proxy/src/savings.ts` (derive multipliers per model+TTL)
- Test: `packages/monitor/tests/pricing.test.js` (path update), new `packages/proxy/tests/unit/shared-pricing.test.ts`

**Interfaces (produced):**
- `loadPricing(filePath?) → rules[]`, `ruleFor(model, ts, rules) → rule|undefined`, `priceTurn(turn, rules) → usd` (unchanged API, new home `@stoke/shared/pricing.mjs`)
- New: `inputPerMtok(model, ts, rules) → number|undefined`, `multipliersFor(model, ts, rules) → {cacheRead, rebuild5m, rebuild1h}|undefined` (ratios cache_read/input, cache_write_5m/input, cache_write_1h/input)

- [ ] Move files; add the two new helper functions to `pricing.mjs` (pure ratio math over `ruleFor`).
- [ ] Write failing tests: monitor pricing tests point at new path; proxy test asserts `multipliersFor("claude-fable-5", now)` → `{cacheRead:0.1, rebuild5m:1.25, rebuild1h:2.0}`.
- [ ] `packages/shared/pricing.d.ts` hand-written declarations so proxy TS imports cleanly.
- [ ] `savings.ts`: where it currently reads `config.pricing.cacheReadMultiplier` / `rebuildMultiplier`, first try `multipliersFor(model, ts, sharedRules)` with TTL-appropriate rebuild (session's detected TTL: 1h vs 5m); fall back to config multipliers when model unknown. `config.ts` default `modelPricing` now built from `pricing.json` input prices (config override still wins).
- [ ] Run both suites; update proxy savings/config test expectations only where 1h-TTL sessions now price rebuilds at 2.0×. Commit `feat: single pricing source in @stoke/shared`.

### Task 4: Port savings math to shared (single implementation)

**Files:**
- Create: `packages/shared/savings.mjs` + JSDoc types (port of `packages/proxy/src/savings.ts`: `computeSavings`, `computeSavingsMulti`, `computeCacheHitRate`, `compute5hSparkline` — same signatures, events/config/window args)
- Modify: `packages/proxy/src/savings.ts` → thin typed re-export of shared implementation
- Test: existing `packages/proxy/tests/unit/savings.test.ts` unchanged (now validates the shared port)

- [ ] Port function-by-function; keep field names identical to `EventRecord` kinds (`proxy_started|real_request|ping_fired|ping_skipped|session_paused|session_resumed|session_ttl_changed`).
- [ ] Proxy `savings.ts` re-exports with types; run proxy suite (savings + digest + dashboard tests exercise it). All pass unmodified → parity proven. Commit.

### Task 5: Proxy stats endpoint, HTML dashboard removed

**Files:**
- Modify: `packages/proxy/src/dashboard-handler.ts` → `stats-handler.ts`: keep `GET /api/health` (no auth) and `GET /api/state` logic renamed to **`GET /_stoke/stats`** (loopback-remote-address check instead of bearer token); delete `/dashboard*`, `/api/stream` SSE, `/api/reload` routes
- Modify: `packages/proxy/src/proxy.ts` (mount rename), `packages/proxy/src/cli.ts` (drop dashboard URL/token printout, print stats URL)
- Delete: `dashboard/` (root), `scripts/dashboard-smoke.mjs` if root copy remains
- Test: rewrite `packages/proxy/tests/unit/dashboard-handler.test.ts` → `stats-handler.test.ts` (loopback allowed, non-loopback 403, payload includes `sessions[].ttlSeconds`, `budget`, `savingsToday`)

- [ ] Failing tests first, then implement; stats payload = existing `/api/state` shape + `savingsToday` from shared `computeSavings` over today's window.
- [ ] Full proxy suite green. Commit `feat: proxy serves /_stoke/stats; HTML dashboard removed`.

### Task 6: Monitor ingests proxy events

**Files:**
- Create: `packages/monitor/src/proxy-events.js`
- Modify: `packages/monitor/src/db.js` (DDL), `packages/monitor/scripts/start.mjs` (boot the tailer)
- Test: `packages/monitor/tests/proxy-events.test.js` + fixture `tests/fixtures/events-sample.jsonl` (one line per event kind, real field names from proxy `types.ts`)

**Interfaces (produced):**
- DDL: `proxy_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT, session_key TEXT, tokens INT, cost_usd REAL, raw TEXT)`; `idx_proxy_events_ts(ts)`, reuse `ingest_state` row keyed by the events.jsonl absolute path for offset resume.
- `ingestProxyEvents(db, filePath) → {rows:number}` (offset-resumed, partial-line tolerant, rotation-aware: stored offset > current size → reset 0); `watchProxyEvents(db, filePath)` (chokidar).

- [ ] TDD: fixture → expected rows incl. rotation-reset case; implement; vitest green. Commit.

### Task 7: Net-cost model + proxy-aware waste detector

**Files:**
- Modify: `packages/monitor/src/analytics/breakdowns.js` (add `pingSpend(db, fromTs, toTs)`, `preventedSavings(db, rules, fromTs, toTs)` — the latter feeds `proxy_events` rows into shared `computeSavings`), `packages/monitor/src/analytics/detectors.js` (cache-expiry finding suppressed → reclassified when a `ping_fired` row exists for the gap window; finding gains `preventedByProxy:true` counterpart in savings attribution), `packages/monitor/src/server.js` (extend `/api/overview` with `{netCost, pingSpendUsd, preventedUsd, proxyUp}`; add `GET /api/proxy` = proxy_events aggregates + live fetch of `http://127.0.0.1:9876/_stoke/stats` with 500ms timeout, `proxyUp:false` on failure)
- Test: extend `detectors.test.js` (gap covered by ping → no waste finding), new assertions in `server.test.js` for `/api/proxy` (stats fetch mocked/unreachable → graceful degrade)

- [ ] TDD as above; `netCost = turns spend + pingSpend − preventedSavings`. All monitor tests green. Commit.

### Task 8: Dashboard UI unification

**Files:**
- Create: `packages/monitor/web/src/pages/Proxy.jsx` (live stats: sessions/TTL/next pings, budget guard, crash history from `/api/proxy`)
- Modify: `web/src/pages/Overview.jsx` (net-cost tile: spend + pings − saved, proxy UP/DOWN badge), `web/src/pages/Cache.jsx` (resume outcomes, ping cap, TTL panels from `/api/proxy`), `web/src/pages/Sessions.jsx` (ping markers on the per-turn waterfall via timestamp overlap with session span), router/nav registration
- Test: `npm run build` in `web/` (build IS the smoke test; component logic kept in plain functions where practical)

- [ ] Implement pages against the exact `/api/proxy` + `/api/overview` shapes from Task 7; follow existing page/component idioms (Recharts, existing palette). Build passes. Commit `feat: one dashboard — proxy panels join the monitor UI`.

### Task 9: Unified config + DB location + migration

**Files:**
- Modify: `packages/monitor/src/config.js`: `dbPath` default → `~/.stoke/stoke.db` (override `TOKEFF_DB`); read `~/.stoke/config.json` and honor `monitor` (port, transcript roots) + `optimizer` (levers/thresholds) sections with fallback to `plugin/optimizer-config.json`; hooks read the same path (they load config via `loadConfig`)
- Modify: `packages/proxy/src/config-schema.ts`: accept+ignore unknown top-level `monitor`/`optimizer` keys (forward-compat, single file for both)
- Test: `config.test.js` (monitor) — new cases: `~/.stoke/config.json` sections honored, fallbacks work; proxy `config-schema.test.ts` — unknown sections tolerated

- [ ] TDD; both suites green. Commit `feat: one ~/.stoke/config.json; DB at ~/.stoke/stoke.db`.

### Task 10: CLI + supervisor + install

**Files:**
- Create: `packages/cli/package.json` (`@stoke/cli`, zero deps), `packages/cli/bin/stoke.mjs`, `packages/cli/src/supervisor.mjs`, `packages/cli/src/install.mjs`
- Test: `packages/cli/tests/supervisor.test.js` (node:test; fake children = tiny scripts that exit N times then persist)

**Interfaces (produced):**
- `stoke start [--quiet]` → supervisor: children `proxy` (`node --import tsx src/cli.ts start`, cwd `packages/proxy`) and `monitor` (`node scripts/start.mjs`, cwd `packages/monitor`); per-child backoff 1s→2→…→30s cap; crash count in 5-min window > 5 → mark UNSTABLE (keep restarting); pidfile `~/.stoke/supervisor.pid`; log `~/.stoke/supervisor.log`; refuse if 9876 already owned (prints "proxy already running — leaving it alone", starts monitor only).
- `stoke status` — GET 9876 `/api/health` + 5599 `/api/overview`; print proxy/monitor health + today's netCost.
- `stoke stop` — signals only PIDs recorded in its own pidfile (never a bare port kill).
- `stoke run|replay|tail|digest` — passthrough to `@stoke/proxy` cli.ts equivalents.
- `stoke install [--migrate-db <path>]` — (a) proxy env-setup (ANTHROPIC_BASE_URL), (b) monitor `scripts/install.mjs` (hooks/skills/agents/statusline into `CLAUDE_CONFIG_DIR`), (c) `schtasks /Create /TN Stoke /TR "<node> <abs stoke.mjs> start --quiet" /SC ONLOGON /F`, (d) if `--migrate-db` and target `~/.stoke/stoke.db` missing → copy. `stoke uninstall` reverses a–c.

- [ ] TDD supervisor (restart, backoff, independence: killing monitor child leaves proxy child untouched); implement CLI dispatch; `stoke status` exercised against live old proxy (read-only GET). Commit.

### Task 11: Installer paths + repoint live Claude Code settings

**Files:**
- Modify: `packages/monitor/scripts/install.mjs` (projectRoot now `packages/monitor`; hook paths point into monorepo), `packages/monitor/plugin/skills/*/SKILL.md` (`%TOKEFF_ROOT%` substitution unchanged), `packages/monitor/plugin/statusline.mjs` (append ` · TTL <m>m` from `/_stoke/stats` best-effort 200ms timeout)
- Test: `install.test.js` green with new roots; `statusline.test.js` case: stats unreachable → TTL segment omitted

- [ ] Run `stoke install --migrate-db C:/Users/carlo/Desktop/repositories/personal/token-efficiency/data/tokeff.db` with `CLAUDE_CONFIG_DIR=C:\Users\carlo\.claude-work` → hooks/skills in `~/.claude-work` now point at `personal/stoke/packages/monitor/plugin/...`; Scheduled Task registered; DB migrated.
- [ ] Verify each hook responds: pipe a minimal hook-event JSON into each of the 4 hook scripts at their NEW paths; exit 0. Commit.

### Task 12: Final verification + PR

- [ ] Full: proxy suite, monitor vitest, cli tests, `web` build, `/spend` skill smoke (runs `report.mjs` against `~/.stoke/stoke.db`).
- [ ] Boot monitor alone (`node scripts/start.mjs`) → 5599 serves dashboard; `/api/proxy` shows live old-proxy stats via 9876 (old instance still exposes `/api/health`; stats endpoint appears only after user's restart — degrade path proves itself). Stop the monitor process I started (its own PID only).
- [ ] Confirm 9876 owner PID unchanged from Task 0.
- [ ] Push `feat/unify-tokeff`, `gh pr create` (base main) with summary + test evidence. Leave user note: restart stoke when convenient; delete retired token-efficiency folders.

## Self-review

- Spec coverage: layout→T1–2, pricing→T3, one savings impl→T4, stats+dashboard removal→T5, events ingest→T6, net-cost+detectors→T7, dashboard→T8, config/DB→T9, CLI/supervisor/autostart→T10, integration repoint+migration→T11, verification/PR→T12. Uninstall covered (T10). Statusline TTL (T11). ✓
- No placeholders: every task names exact files, signatures, and expected test outcomes. Code-level detail is resolved at execution with the fact sheets + TDD steps above. ✓
- Type consistency: event kinds, pricing helpers (`multipliersFor`, `inputPerMtok`), route names (`/_stoke/stats`, `/api/proxy`) used consistently across tasks. ✓
