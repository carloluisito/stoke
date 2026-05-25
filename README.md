# stoke

> Keep your Claude prompt cache warm so you never pay for a rebuild.

[![test](https://github.com/USERNAME/stoke/actions/workflows/test.yml/badge.svg)](https://github.com/USERNAME/stoke/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**stoke** is a local proxy that sits between Claude Code (or any Anthropic
API client) and `api.anthropic.com`. While you're idle — meetings, lunch,
deep thought — it fires `max_tokens: 0` keep-alive pings against your
cached prefix just before the TTL expires. The cache stays warm. Your next
prompt is cheap.

## Why

Anthropic's prompt cache has a TTL:

- **5 minutes** by default on API-key auth
- **1 hour** automatically on a Claude subscription (Claude Code requests it
  on every cache_control block)

If you walk away past that window, the next turn pays a full **cache rebuild
at 1.25× the input rate** — about **$0.56** on a typical 150k-token Claude
Code session. stoke pays the **0.1× cache-read rate** (~$0.045) every
~(TTL − 30s) instead, and refreshes the timer. Net: ~$0.52 saved per
avoided rebuild, at zero workflow cost.

For a subscription user on 1h TTL, that's roughly **one ping per long idle
gap** — ~13× fewer pings than a tool that hardcodes the 5-min cadence.

## How it adapts

- **TTL-aware.** stoke reads `cache_control.ttl` off every outgoing request,
  per-session. Subscription users get 1-hour cadence; API-key users get
  5-minute cadence; mid-session credit-fallback flips are detected on the
  next request.
- **Adaptive cap.** After N consecutive pings without a real request, stoke
  pauses itself — capping wasted spend on dead sessions. The cap shrinks
  when most idle users don't return, expands when they do.
- **Honest accounting.** Dashboard headline is **net savings** (gross minus
  ping spend), not gross. Resumes are classified `survived` / `partial` /
  `rebuilt` so you can see exactly what the proxy did or didn't prevent.

## Install

```bash
git clone https://github.com/USERNAME/stoke
cd stoke
npm install
```

Requires Node ≥ 20. Zero required runtime dependencies (OTel is optional).

## Run

One-shot — launch the proxy and Claude Code with one command, sharing lifetime:

```bash
npm start -- run -- claude
```

Or two windows:

```bash
# window 1
npm start

# window 2
ANTHROPIC_BASE_URL=http://127.0.0.1:9876 claude
```

On Windows, `npm start` writes `ANTHROPIC_BASE_URL` to the user-scope
registry so every new shell inherits it. macOS/Linux: it writes a marked
block to `~/.zshrc` / `~/.bashrc`. Opt out with `autoSetEnvVar: false` in
config or `CACHE_KEEPALIVE_AUTO_SET_ENV=0`.

## Dashboard

stoke prints a tokenized URL at startup:

```
Dashboard: http://127.0.0.1:9876/dashboard?token=ab12cd34…
```

Open it in a browser. Bookmark it — the token regenerates on every restart.
The token gates every `/dashboard/*` and `/api/*` route except
`GET /api/health`, which is intentionally ungated for external monitors.

The dashboard surfaces:

- **Net savings** ($ saved − ping spend) — today / month / last 5h
- **Detected TTL** per session (`5m` or `1h` pill on each row)
- **Resume outcomes** today: survived / partial / rebuilt + total rebuild $
- **Observed return rate** + **effective ping cap** (live adaptive math)
- **Cache health** — hit rate, warm/cold/paused/abandoned breakdown
- **Recent events** — pings, resumes, TTL changes, pauses

## Inspect from the CLI

```bash
npm run status   # one-shot summary
npm run tail     # tail -f the JSONL event log
```

The event log lives at `~/.stoke/events.jsonl`. Rotates to
`events.jsonl.1`, `.2`, … past 50 MB (configurable).

## Replay archived traffic

```bash
npm start -- replay ~/.stoke/events.jsonl.1
```

Re-runs the savings + hit-rate math against a captured log. Useful for
verifying changes to `src/savings.ts` without running live.

## Daily digest

At startup, every local midnight, and on shutdown, stoke prints a savings
summary to stdout and appends it to `~/.stoke/digest.log`:

```
stoke digest · 2026-05-25T04:00:00Z
  Today        saved $24.83  ·  47 rebuilds avoided  ·  4.1× ROI
  This month   saved $312.04 ·  588 rebuilds avoided
  Pings fired today: 75   Pings spent: $13.24
  Resumes today: 47 survived · 3 partial · 0 rebuilt ($0.06 paid)
  Cache hit rate today: 100%
```

## OpenTelemetry (optional)

Tracing and metrics export is opt-in. To enable:

1. `npm install --include=optional` (pulls `@opentelemetry/*`)
2. In `~/.stoke/config.json`:
   ```json
   {
     "otel": {
       "enabled": true,
       "serviceName": "stoke",
       "endpoint": "http://localhost:4318"
     }
   }
   ```
3. Restart.

Counters: `stoke.pings_fired_total`, `stoke.pings_skipped_total`,
`stoke.real_requests_total`, `stoke.session_resumed_total`,
`stoke.session_ttl_changed_total`. Labels include outcome / from-state /
TTL where relevant.

## Configuration

Drop a JSON file at `~/.stoke/config.json`. The full schema lives in
`src/types.ts` (the `Config` interface) and `src/config-schema.ts`
(validators with ranges). Most-tuned fields:

| Field | Default | Purpose |
|---|---|---|
| `cacheTtlSeconds` | `300` | Fallback TTL when detection has no data. |
| `pingCadenceMarginSeconds` | `30` | Fire ping (TTL − margin) after last activity. |
| `abandonTtlMultiplier` | `6` | Abandon after N TTL periods of no real request. |
| `maxConsecutivePings` | `5` | Adaptive-cap ceiling. |
| `minConsecutivePings` | `2` | Adaptive-cap floor. |
| `adaptiveCapWindow` | `50` | Rolling sample size for return-rate observation. |
| `pricing.cacheReadMultiplier` | `0.1` | Anthropic's published cache-read multiplier. |
| `pricing.rebuildMultiplier` | `1.25` | Anthropic's published cache-write multiplier. |

Environment-variable overrides for ad-hoc / testing:

- `CACHE_KEEPALIVE_PORT` — override `listen.port`
- `CACHE_KEEPALIVE_HOST` — override `listen.host`
- `CACHE_KEEPALIVE_LOG_PATH` — override `logPath`
- `CACHE_KEEPALIVE_AUTO_SET_ENV=0` — disable `autoSetEnvVar`

## Stop

`Ctrl+C` the proxy. To remove the persisted `ANTHROPIC_BASE_URL`:

```bash
npm start -- unset-env
```

Already-open shells keep their environment until restart.

## How it works (the design)

See [`demo/demo.html`](./demo/demo.html) for an interactive walkthrough. Open
it in a browser — the "Guided walkthrough" scenario explains the proxy from
first principles in 7 steps, the others let you flip between subscription /
API-key / walk-away scenarios at adjustable speed.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports and PRs welcome.

## Security

stoke is **local-only**. Do not bind to non-loopback addresses. See
[SECURITY.md](./SECURITY.md) for the disclosure policy.

## License

[MIT](./LICENSE)
