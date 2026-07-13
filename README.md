# stoke

> One tool to minimize Claude Code token cost: keep the prompt cache warm, watch every dollar, and change wasteful behavior — with one command and one dashboard.

[![test](https://github.com/carloluisito/stoke/actions/workflows/test.yml/badge.svg)](https://github.com/carloluisito/stoke/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**stoke** is two engines behind one CLI:

- **The proxy** (`packages/proxy`, port 9876) sits between Claude Code and
  `api.anthropic.com`. While you're idle — meetings, lunch, deep thought — it
  fires `max_tokens: 0` keep-alive pings against your cached prefix just
  before the TTL expires. The cache stays warm; your next prompt is cheap.
- **The monitor** (`packages/monitor`, port 5599) parses every Claude Code
  transcript into SQLite, prices each turn, detects waste (cache expiries,
  context bloat, verbose output, model mismatch), and injects cost-saving
  hooks, skills, and a statusline into Claude Code itself.

They share one pricing source (`packages/shared`) and one database, so the
dashboard shows one truthful number:

```
net cost = what Claude spent + what pings cost − rebuilds the proxy prevented
```

## Why the proxy pays for itself

Anthropic's prompt cache has a TTL — **5 minutes** on API-key auth, **1
hour** on a Claude subscription. Walk away past that window and the next
turn pays a full **cache rebuild at 1.25× the input rate** (2× on 1-hour
TTL) — about $0.56 on a typical 150k-token session. stoke pays the **0.1×
cache-read rate** (~$0.045) just before each expiry instead. The dashboard's
headline is **net savings** (gross minus ping spend), never gross.

## Install

```bash
git clone https://github.com/carloluisito/stoke
cd stoke
npm install
node packages/cli/bin/stoke.mjs install    # Claude Code hooks/skills/statusline + auto-start at logon
```

Requires Node ≥ 20. The proxy and CLI keep **zero runtime dependencies**;
the monitor uses Fastify + better-sqlite3 + chokidar. Migrating from a
standalone tokeff install? Add `--migrate-db <path-to-tokeff.db>`.

## Run

```bash
npm start            # = stoke start: proxy (9876) + monitor (5599), supervised
npm run status       # health + today's net cost
```

`stoke start` supervises both processes with **crash isolation**: each
restarts on failure with exponential backoff, and nothing the monitor does
can ever take down the proxy. If a proxy is already serving 9876, stoke
leaves it alone and starts only what's missing. `stoke install` registers
auto-start at logon (Scheduled Task, or a Startup-folder launcher when not
elevated).

On Windows, the proxy's first start writes `ANTHROPIC_BASE_URL` to the
user-scope registry so every new shell routes Claude Code through it.
macOS/Linux: a marked block in `~/.zshrc` / `~/.bashrc`. Opt out with
`autoSetEnvVar: false` or `CACHE_KEEPALIVE_AUTO_SET_ENV=0`; undo with
`stoke unset-env`.

## The dashboard — http://localhost:5599

- **Overview** — net cost today, spend by day/component, proxy UP/DOWN badge
- **Sessions** — per-turn cost waterfall, ping-annotated; warm/cold resume status
- **Proxy** — live sessions being kept warm, detected TTL, ping budget,
  resume outcomes (survived / partial / rebuilt), net saved today
- **Cache health** — hit rate and cache economics
- **Waste report** — priced findings (cache expiry, bloat, verbosity,
  model mismatch), proxy-aware: an expiry the proxy *could not* prevent says so
- **Optimizer log** — every in-session intervention the hooks made

The proxy itself serves only `GET /api/health` (ungated liveness) and
`GET /_stoke/stats` (loopback-only live state for the dashboard).

## Claude Code integration

`stoke install` merges into your `CLAUDE_CONFIG_DIR`:

- **Hooks** — session-start cost conventions, a large-file re-read guard,
  a context-bloat gate, and a session cost snapshot on stop
  (levers configurable observe/suggest/enforce in `~/.stoke/config.json`)
- **Skills** — `/spend` (instant spend report) and `/efficiency-audit`
  (why is this session expensive?)
- **Agents** — `cheap-explore` / `cheap-search` Haiku subagents for
  mechanical fan-out work
- **Statusline** — live session cost + cache state

## CLI reference

```
stoke start [--quiet]     supervise proxy + monitor
stoke stop                stop what stoke started (exact PIDs only)
stoke status              health + today's net cost
stoke run -- claude       one-shot: everything up, claude through the proxy
stoke replay <log>        re-run savings math on an archived event log
stoke tail                tail -f ~/.stoke/events.jsonl
stoke digest              savings summary (also printed at midnight + shutdown)
stoke install|uninstall   Claude Code integration + auto-start
```

## State & configuration

Everything lives in `~/.stoke/`: `config.json` (proxy + monitor + optimizer
sections), `stoke.db` (the one database), `events.jsonl` (proxy event log,
rotates past 50 MB), `supervisor.log`, `digest.log`.

Model prices are data, not code: `packages/shared/pricing.json` holds
effective-dated per-model rules used by *both* engines. The proxy's most-tuned
config fields:

| Field | Default | Purpose |
|---|---|---|
| `cacheTtlSeconds` | `300` | Fallback TTL when detection has no data. |
| `pingCadenceMarginSeconds` | `30` | Fire ping (TTL − margin) after last activity. |
| `abandonTtlMultiplier` | `6` | Abandon after N TTL periods of no real request. |
| `maxConsecutivePings` | `5` | Adaptive-cap ceiling. |
| `minConsecutivePings` | `2` | Adaptive-cap floor. |
| `pricing.cacheReadMultiplier` | `0.1` | Cache-read multiple of input rate. |
| `pricing.rebuildMultiplier` | `1.25` | 5-min cache-write multiple. |
| `pricing.rebuildMultiplier1h` | `2.0` | 1-hour cache-write multiple. |

Full schema: `packages/proxy/src/types.ts` + `config-schema.ts`.
OpenTelemetry export stays available and opt-in (see `otel` config section).

## How it works (the design)

See [`demo/demo.html`](./demo/demo.html) for an interactive walkthrough of
the proxy's keep-alive strategy, and
`docs/superpowers/specs/2026-07-13-stoke-tokeff-unification-design.md` for
the unified architecture.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports and PRs welcome.

## Security

stoke is **local-only**. Do not bind to non-loopback addresses. See
[SECURITY.md](./SECURITY.md) for the disclosure policy.

## License

[MIT](./LICENSE)
