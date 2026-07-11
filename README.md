# tokeff — Token Efficiency Monitor + Optimizer for Claude Code

Measures exactly where your API-billed Claude Code tokens go, and actively prevents the wasteful patterns — **without ever degrading output quality**.

## Why

Three economics dominate Claude API cost:

1. **Output tokens cost 5× input** (Opus 4.8: $25 vs $5 per MTok).
2. **Cached input is ~10× cheaper than fresh input** — but the prompt cache is a prefix match with a TTL (5 min default, 1h opt-in at a higher write price). Pauses past the TTL or mid-session context mutations silently re-bill your whole conversation at full price.
3. **Model tiering is 5–10×** — mechanical subtasks don't need a frontier model.

tokeff makes all three visible and actionable.

## What's inside

| Component | What it does |
|---|---|
| **Ingestor** | Watches Claude Code transcript JSONL files (`<config-dir>/projects/**`), parses per-turn usage (input/output/cache-write-per-TTL/cache-read), prices every turn with an effective-dated pricing config, stores in local SQLite. |
| **Analytics** | Spend by day/project/session/model; cache hit rate; six dollar-quantified waste detectors (cache expiry, cache invalidation, session bloat, output verbosity, model mismatch, savings attribution); a TTL advisor that computes whether 1-hour caching would pay off for your gap patterns. |
| **Dashboard** | Local web app on **http://localhost:5599** — Overview, Sessions (per-turn cost waterfall), Cache health, Waste report, Optimizer log. |
| **Optimizer** | Claude Code hooks (fail-open, can never break a session), Haiku subagents (`cheap-explore`, `cheap-search`), skills (`/spend`, `/efficiency-audit`), and a live cost statusline. |

## Quick start (any machine)

```bash
node scripts/setup.mjs   # deps + web build + tests + install + verify, idempotent
npm start                # backfill + watch + dashboard on :5599
```

Opening this repo in Claude Code also exposes a **`/setup-tokeff`** project skill that walks through the same setup with prerequisites and troubleshooting — clone the repo on a new machine, open Claude Code, invoke the skill.

Manual equivalent:

```bash
npm install
cd web && npm install && npm run build && cd ..
node scripts/install.mjs --dry-run   # review what will be registered
node scripts/install.mjs             # register hooks/agents/skills/statusline
```

The installer merges additively into `<config-dir>/settings.json` — existing hooks and an existing statusline are never clobbered. Config dir resolution: `CLAUDE_CONFIG_DIR` env var, else `~/.claude`.

## Optimizer modes

`plugin/optimizer-config.json` sets each lever to `observe` (log only), `suggest` (default — warn, never act), or `enforce`:

| Lever | Default | Behavior |
|---|---|---|
| `efficiency_conventions` | suggest | Injects terse-output + delegate-to-cheap-subagents conventions at session start |
| `cache_expiry_warning` | suggest | Warns when your pause exceeded the cache TTL (full-price re-bill imminent) |
| `context_bloat_warning` | suggest | Suggests `/compact` when per-turn context exceeds ~120k tokens |
| `wasteful_read_warning` | suggest | Warns on full re-reads of large files already in context |
| `session_cost_record` | enforce | Records a session cost snapshot at each stop |

**Quality guardrails (by design, not configurable):** the main-loop model is never downgraded; model routing exists only as opt-in subagents; every intervention is logged and auditable in the dashboard.

## Pricing config

`config/pricing.json` is effective-dated data — the Sonnet 5 intro-pricing rollover (2026-09-01) is already encoded. Cache write = 1.25× input (5m TTL) or 2× (1h TTL); cache read = 0.1×. TTL is a **per-request API setting, not plan-dependent**; tokeff reads the actually-used TTL from each turn's usage data. Edit the file to track future price changes — no code changes needed.

## Uninstall

Remove the tokeff entries from `<config-dir>/settings.json` (`hooks.*` commands pointing into this repo, and `statusLine` if it references `plugin/statusline.mjs`), and delete `<config-dir>/agents/cheap-*.md` and `<config-dir>/skills/{spend,efficiency-audit}`. Your data stays in `data/tokeff.db`.

## Tests

```bash
npm test              # full Vitest suite
cd web && npm run build   # frontend build check
```
