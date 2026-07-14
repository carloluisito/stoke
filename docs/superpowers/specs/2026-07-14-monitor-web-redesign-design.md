# Stoke monitor dashboard redesign — design

Rebuild `packages/monitor/web` (React + Vite) to match the approved Claude Design
prototype (`stoke-redesign/Stoke Dashboard.dc.html`), wired to the existing real
`/api/*` endpoints.

## Constraints
- Work stays entirely in `packages/monitor/web`. No changes to `packages/proxy`,
  no server changes, port 9876 untouched.
- Same `/api/*` contract as today. Filtering/derivation happens client-side.
- Honest accounting preserved: headline is always **net cost = spend + ping cost −
  prevented rebuilds**; gross savings never a headline; empty/degraded states state
  what is actually happening.

## Decisions (approved)
- **Full port** of the prototype's 4 phases.
- **Overview: Layout A only** (hero-left + side status). Drop the A/B toggle.
- **Liveness client-derived** — no server change. Poll `/api/proxy` faster (~5s) on
  the Proxy tab; ticker/toasts come from real counter deltas between polls.
- **Charts hand-rolled** in CSS/SVG (clickable day bars, sparkline, waterfall).
  **Drop `recharts`.**

## Design system & theming
- Port the prototype token block + component classes into `src/styles.css`
  (imported once from `main.jsx`), replacing the dark-only inline `<style>` in
  `index.html`. IBM Plex Sans/Mono via Google Fonts.
- Light + dark via `data-theme` on `<html>`, persisted to
  `localStorage("stoke-theme")`, seeded from `prefers-color-scheme`.

## Navigation & routing
- 6 tabs → **4**: Overview · Sessions · Proxy · Waste. Cache-health folds into
  Proxy + Overview; Optimizer log becomes a sub-view of Waste. No data dropped.
- **Hash routing**: `#overview`, `#sessions?project=…&model=…&day=…`,
  `#sessions/<id>`, `#proxy`, `#waste`, `#waste/log`. State survives refresh, is
  shareable.
- Header: brand, `role="tablist"` tabs (roving tabindex + arrow/Home/End),
  proxy-status pill, aria-live "updated Xs ago" chip, theme toggle.

## Pages (endpoint → UI)
- **Overview** — `/overview`, `/spend/daily-cost?days=30`, `/proxy`, `/waste`,
  `/ttl-advice`, `/cache`. Layout A hero net-cost + equation + 7-day sparkline;
  proxy-status & net-saved cards; "Do this now" cards (top waste / TTL switch /
  session bloat) deep-linking into their views; clickable stacked spend-by-day
  bars; 4 stat cards.
- **Sessions** — `/sessions?limit=100`, `/sessions/:id`. Filter bar
  (project/model selects, date-range chips, search) + sortable table (aria-sort);
  filtering done client-side over the fetched list. Row → turn **waterfall** built
  from the real turn array (`cache_write = cache_write_5m + cache_write_1h`).
- **Proxy** — `/proxy`, `/cache`, `/ttl-advice`. Status/plan/budget cards;
  per-session **countdown** to next ping (`(detectedTtl − 30) − idle`, client
  ticked); **event ticker** + **toasts** from poll deltas; TTL-advice list;
  explicit **degraded panel** when `proxyUp:false` (keep-alive UI hidden, spend
  tracking stated as still accurate).
- **Waste** — `/waste`, `/interventions`. Findings table with expandable
  recommendations (incl. "proxy up but couldn't prevent it" note when a
  `cache_expiry` finding has `proxyWasUp:true`), attribution table, optimizer-log
  sub-view.

## Liveness without a server change
- Countdowns tick client-side each second from real `live.sessions`.
- Ticker/toasts derived from **real counter deltas**: when `today.rebuildsAvoided`
  or `today.pingsFired` increment between polls, or a session's idle resets, emit
  an event; toast on a new prevented rebuild with the real saved delta. Nothing
  fabricated. All suppressed while the proxy is down.

## Resolved gaps
1. **Effective $/MTok** stat: not in `/overview`. Derive client-side
   (total spend ÷ total tokens from spend data). Falls back to "—" if unknown.
2. **Flagged-turn highlight**: real findings carry no turn index. Deep-link opens
   the session; highlight by heuristic (e.g. largest cache-write turn) — best
   effort, no exact mapping required.
3. **`live.sessions[]` fields**: adapt to the real shape confirmed from the
   monitor server; any missing field degrades gracefully (that card detail hides).

## File plan
Add: `src/styles.css`, `src/theme.js`, `src/router.js`, and `src/components/`
(Card, Badge, Skeleton, EmptyState, SpendChart, Sparkline, Waterfall,
LiveCountdown, Ticker, Toast, plus liveness hooks). Rewrite `App.jsx` and the 4
page files. Retire `CacheHealth.jsx` / `OptimizerLog.jsx` as standalone pages.
Drop `recharts` from `package.json`.

## Testing & verification
- Vitest on pure logic: router parse, poll-diff liveness, session filter/sort,
  formatters. UI verified by running `npm run dev` and driving the app; empty/
  degraded states render honestly when the backend is absent.
