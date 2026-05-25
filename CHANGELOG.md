# Changelog

All notable changes to stoke are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — initial public release

Renamed from `cache-keepalive` and prepped for OSS. Substantial behavior
changes vs. the pre-release internal versions; treat this as the baseline.

### Added

- **TTL auto-detection per session** — proxy reads `cache_control.ttl` off
  every outgoing request and stores `Session.detectedTtlSeconds`. Handles
  5-min default, 1-hour subscription auto, and credit-fallback flips.
- **Per-session ping cadence and abandonment** — both derive from
  `detectedTtlSeconds`. Subscription users (1h TTL) get ~59-min cadence and
  ~6h abandonment automatically; API-key users (5m TTL) stay at 270s cadence
  and 30-min abandonment.
- **Adaptive ping cap** — `effectiveConsecutivePingCap` shrinks the cap when
  the observed return rate is low, expands it toward the configured ceiling
  when users do return. Pure function; tested across return-rate boundaries.
- **Three-way resume classification** — `survived` (clean cache hit),
  `partial` (cache mostly survived + small natural growth), `rebuilt` (cache
  was fully cold). The dashboard shows all three with distinct badges.
- **Resume event with rebuild cost** — `session_resumed` events log
  `cacheOutcome`, `rebuildCostUsd`, gap duration, and the read/created token
  pair. Surfaced as a row badge, hero aggregate, and drawer detail card.
- **TTL-change event** — `session_ttl_changed` emitted whenever a session's
  detected TTL flips between requests (e.g., plan-limit overage). Rendered
  in the event feed with a yellow glyph and tightened/loosened meta line.
- **Net savings everywhere** — gross savings, ping spend, and net (gross
  minus spend) are computed in `SavingsResult` and surfaced as separate
  fields in `/api/state`, the dashboard hero card, and the per-session drawer.
  Net can go negative — and turns red on the dashboard when it does.
- **Configurable pricing** — `pricing.cacheReadMultiplier` and
  `pricing.rebuildMultiplier` moved from hardcoded constants into Config so
  Anthropic rate changes are a config edit, not a code change.
- **Configurable adaptive-cap knobs** — `minConsecutivePings`,
  `maxConsecutivePings`, `adaptiveCapWindow`, `pingCadenceMarginSeconds`,
  `abandonTtlMultiplier`.
- **`session_resumed_total` and `session_ttl_changed_total` OTel counters**
  with outcome / from-state / TTL labels.
- **`run` subcommand** — `stoke run -- claude` launches the proxy and the
  Anthropic client together; lifetime is bound to the child.
- **`replay` subcommand** — `stoke replay <events.jsonl>` re-runs the savings
  math against an archived log.

### Changed

- **Removed `pingCadenceSeconds` and `abandonAfterMinutes` Config fields.**
  Both are now derived from per-session TTL. Old config files referencing
  these fields will fail validation; remove the fields or regenerate.
- **`Registry.upsert` returns an `UpsertResult` struct** (`{ key,
  previousState, gapMs, previousDetectedTtlSeconds,
  currentDetectedTtlSeconds }`) instead of bare `SessionKey`. Lets callers
  emit resume / TTL-change events without poking registry internals.
- **`Registry.abandonStale` takes a per-session callback** `(s) => thresholdMs`
  instead of a single static threshold. Enables per-session TTL-aware
  abandonment.
- **Config directory renamed** `~/.cache-keepalive/` → `~/.stoke/`. Existing
  users should move or wipe the old directory.
- **Dashboard hero card** renamed from `SAVED TODAY` to `NET SAVINGS TODAY`;
  shows breakdown line `$X saved − $Y ping spend`.

### Fixed

- Per-event TTL beats config-default TTL in savings calculations. Old logs
  without `cacheTtlSeconds` on `real_request` fall back to config.
- Subscription users on 1h TTL no longer over-count saved rebuilds by ~12×
  (the old hardcoded 5-min assumption miscounted any >5min gap as a saved
  rebuild even when the cache was still alive).

### Internal

- 219 tests, 0 dependencies for the core runtime, optional OTel.
- TypeScript strict mode; `npm run typecheck` is clean.
- Adaptive cap math: `cap = floor(rebuildMul/readMul × P(return))`, clamped
  to `[minConsecutivePings, maxConsecutivePings]`.
