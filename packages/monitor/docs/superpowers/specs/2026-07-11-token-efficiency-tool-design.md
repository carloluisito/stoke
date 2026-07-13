# Token Efficiency Tool — Design Spec

**Date:** 2026-07-11
**Status:** Approved by user (brainstorming session 2026-07-11)
**Scope:** Complete product — monitor + optimizer for personal, API-billed Claude Code usage

## Problem

Claude Code usage billed per-token through the Anthropic API has three large, largely invisible cost drivers:

1. **Output tokens cost 5× input tokens** (e.g. Opus 4.8: $25/MTok out vs $5/MTok in).
2. **Cached input costs ~10× less than fresh input** ($0.50 vs $5 on Opus 4.8), but the prompt cache is a *prefix match with a TTL* — pauses past the TTL or anything that mutates early context silently re-bills the whole conversation history at full price, with no visible signal.
3. **Model tiering is 5–10×** (Haiku 4.5 is 5× cheaper than Opus 4.8; Sonnet 5 ~2.5×), and mechanical subtasks (searches, file exploration) often run on the frontier model unnecessarily.

The user has no per-session visibility into where dollars go, and no active mechanism preventing the wasteful patterns. This tool provides both, **without degrading output quality**.

## Requirements

- **Monitor + optimizer** in one product.
- **Personal usage, API billing** — single user, direct dollar cost, all data local.
- **All optimization levers allowed** (zero-risk, model/effort routing, workflow shaping) with **conservative defaults and per-lever override**.
- **Surface:** Claude Code plugin (hooks, skills, statusline, subagents) + local web dashboard.
- **Quality guardrail:** the main-loop model is never downgraded automatically. Model routing applies only to subagents. Every intervention is logged and auditable.
- **Never touch port 9876** (reserved by an unrelated long-running app). Dashboard runs on **localhost:5599**.

## Architecture

One Node.js project, four components sharing a local SQLite database:

```
Claude Code session
  ├─ writes transcripts → <config-dir>/projects/**/*.jsonl
  │                            │
  │                     [1] Ingestor (file watcher + parser) → SQLite
  │                            │
  │                     [2] Analytics engine (cost model + waste detectors)
  │                            │
  │                     [3] Dashboard (localhost:5599 web app)
  │
  └─ fires hooks → [4] Optimizer plugin (hooks + skills + statusline + subagents)
```

Data source of truth is the Claude Code transcript JSONL files: each assistant message carries a `usage` block with `input_tokens`, `output_tokens`, `cache_creation_input_tokens` (with per-TTL breakdown), `cache_read_input_tokens`, and the model ID. This gives per-message granularity with zero infrastructure and nothing in the API request path.

**Stack:** Node.js, better-sqlite3, Fastify + React/Vite dashboard, hooks as small Node scripts. Windows-compatible throughout.

## Component 1 — Ingestor

- File watcher tails every transcript JSONL under `<config-dir>/projects/**` as Claude Code writes it. The config dir is auto-detected (`CLAUDE_CONFIG_DIR` env var, else `~/.claude`) and overridable in config — on this machine it is `~/.claude-work`.
- Parses assistant-message `usage` blocks; dedupes by message ID (transcripts can be re-read; resumed/forked sessions repeat messages).
- Stores one row per turn: session ID, project dir, timestamp, model, input/output tokens, cache write tokens **per TTL bucket** (5m / 1h), cache read tokens.
- Handles historical backfill on first run (parses all existing transcripts).

### Cost model (TTL- and date-aware)

A versioned pricing config file (effective-dated, so price changes are data edits, not code changes):

| Model | Input $/MTok | Output $/MTok | Cache write 5m | Cache write 1h | Cache read |
|---|---|---|---|---|---|
| Fable 5 (`claude-fable-5`) | 10.00 | 50.00 | 12.50 | 20.00 | 1.00 |
| Opus 4.8 (`claude-opus-4-8`) | 5.00 | 25.00 | 6.25 | 10.00 | 0.50 |
| Sonnet 5 (`claude-sonnet-5`) | 2.00 → 3.00 after 2026-08-31 | 10.00 → 15.00 | 2.50 → 3.75 | 4.00 → 6.00 | 0.20 → 0.30 |
| Haiku 4.5 (`claude-haiku-4-5`) | 1.00 | 5.00 | 1.25 | 2.00 | 0.10 |

Rules encoded: cache write = 1.25× input (5-minute TTL) or 2× input (1-hour TTL); cache read = 0.1× input. **TTL is a per-request API setting, not plan-dependent** — the ingestor records the actually-used TTL from the usage data's cache-creation breakdown; nothing hardcodes 5 minutes. Unknown model IDs fall back to a configurable default row and are flagged in the dashboard.

## Component 2 — Analytics engine

Plain breakdowns: spend per day / project / session / model; input vs output vs cache-read vs cache-write; effective $/MTok actually paid; cache hit rate.

### Waste detectors (each finding is dollar-quantified)

| Detector | Catches | Signal |
|---|---|---|
| Cache expiry | Pause exceeded the cache TTL; next turn re-billed full history | `cache_read` drops to ~0 mid-session with `cache_creation` spike, gap > observed TTL |
| Cache invalidation | Early context mutated mid-session (CLAUDE.md edit, settings change) broke the prefix | Same signature, gap < TTL |
| Session bloat | Context so large each turn re-processes a mountain; `/compact` or `/clear` overdue | Rising per-turn input tokens; cost-per-turn trend |
| Output verbosity | Long output on trivial turns (output = 5× input price) | Output tokens per turn vs turn type |
| Model mismatch | Frontier model doing mechanical work a cheap subagent could do | Sessions dominated by search/read tool calls on an expensive model |
| Savings attribution | What the optimizer actually saved | Detector rates before/after each optimizer feature enabled |

### TTL optimizer (advisor)

Uses the detected TTL and the user's real gap/reuse patterns to answer, per project: "would 1-hour TTL save or cost money?" Break-even encoded: 5m TTL pays off at ≥2 reuses of the prefix; 1h TTL (2× write) needs ≥3. Output is a recommendation with the dollar delta — never automated, since TTL is set by Claude Code's own requests.

## Component 3 — Dashboard (localhost:5599)

- **Overview** — spend today/week/month, trend line, stacked input/output/cache-read/cache-write breakdown, effective $/MTok.
- **Sessions** — per-session cost list; drill-down to a per-turn cost waterfall ("why did this session cost $4?" answerable at a glance).
- **Cache health** — hit rate over time; every expiry/invalidation event with its dollar cost; detected TTL per session.
- **Waste report** — ranked detector findings, each with a concrete recommendation and estimated monthly savings; includes the TTL optimizer's per-project verdict.
- **Optimizer log** — every intervention (warning shown, guidance injected), fully auditable.

All local; no data leaves the machine.

## Component 4 — Optimizer (Claude Code plugin)

Three modes, per-lever: `observe` (log only), `suggest` (**default** — warns/recommends, never silently changes behavior), `enforce` (acts automatically). Config file with per-lever toggles.

**Hard quality guardrails:**
- Main-loop model is never downgraded automatically; routing applies to subagents only (frontier model still supervises).
- Every intervention is logged to SQLite and visible in the dashboard.

### Hooks

| Hook | Behavior |
|---|---|
| `SessionStart` | Injects a compact efficiency convention: terse final outputs, delegate mechanical searches to cheap subagents, prefer targeted reads over whole-file reads |
| `UserPromptSubmit` | If gap since last turn > detected TTL: informs that the cache expired (full-price re-bill imminent; fresh session may be cheaper). Flags oversized context with a `/compact` suggestion |
| `PreToolUse` | Warns on wasteful patterns, e.g. re-reading a large file already in context |
| `Stop` | Finalizes the per-session cost record |

### Subagents

Pre-defined `cheap-explore` / `cheap-search` agent definitions pinned to Haiku 4.5 at low effort, plus injected guidance so the main model delegates mechanical fan-out work to them.

### Skills

- `/spend` — instant spend report in-chat (today/session/project).
- `/efficiency-audit` — analyzes the current session live; recommends actions (compact, split, delegate).

### Statusline

Live session cost, cache hit indicator, warm/expired cache marker (TTL-aware).

### Recommendation-only levers (never automated)

Default-model-per-project switching, batching non-urgent work, session-splitting habits, TTL switching. The dashboard quantifies each; the user decides.

## Error handling

- Ingestor tolerates malformed/partial JSONL lines (skip + log), transcript rotation, and concurrent writes by Claude Code.
- Unknown models → default pricing row + dashboard flag.
- Hooks fail open: any hook error must never block or break a Claude Code session (timeouts, try/catch, exit 0 on internal failure).
- Dashboard port conflict on 5599 → next free port in a configured range, never 9876.

## Testing

- Unit: transcript parser (fixture JSONL files incl. cache-TTL breakdown shapes, malformed lines, dedupe), cost model (per-model, per-date, per-TTL cases incl. Sonnet 5 intro-pricing rollover), each waste detector against synthetic session fixtures.
- Integration: end-to-end ingest of a recorded real transcript → expected SQLite rows → expected dashboard API responses.
- Hooks: invoked with sample hook JSON payloads; assert output contract and fail-open behavior.

## Out of scope

- Team/org aggregation, OTEL export (can be added later; nothing depends on it).
- API proxy (`ANTHROPIC_BASE_URL` interception) — rejected for fragility.
- Automated main-model downgrading — permanently out by design.
