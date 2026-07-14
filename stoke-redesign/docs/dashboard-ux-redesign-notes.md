# Stoke dashboard redesign — prototype notes

This repo delivers an **interactive design prototype** (`Stoke Dashboard.dc.html`) of the
redesigned monitor dashboard, driven by mock data shaped exactly like the real
`/api/*` endpoints. It is the design target for the implementation work in
`packages/monitor/web`; it does not modify the live codebase, and it never touches
`packages/proxy` or port 9876.

Honest accounting is preserved throughout: the headline is always **net cost =
spend + ping cost − prevented rebuilds**, gross savings never appear as a headline,
and every empty/degraded state states what is actually happening.

## Phase 1 — Design system + motion
- Token system in `:root` (dark base, kept from the current palette; cache-read green
  lightened to `#2a9d3a` for WCAG-AA contrast on dark). Full **light theme** under
  `[data-theme="light"]` with a manual toggle persisted to `localStorage` and seeded
  from `prefers-color-scheme` on first load.
- Typography scale, spacing rhythm, radii and elevation are centralized as utility
  classes; tables use `tabular-nums`.
- Micro-interactions: hover/focus transitions on cards, rows and tabs; **count-up**
  tween on the net-cost and today-spend values when a poll lands; pulsing
  **"updated Xs ago"** chip.
- **Skeleton loaders** shaped like content replace `Loading…`; zero-data views get
  honest empty states.
- A11y: `<header>/<nav>/<main>` landmarks, `role="tablist"` tabs with full arrow/Home/
  End keyboard operation and roving tabindex, keyboard-operable table rows, visible
  focus rings, aria-sort on sortable headers, aria-live regions for the poll chip and
  toasts.

## Phase 2 — Answer-first cockpit
- Overview is a cockpit: hero **net-cost** number with the spend/ping/prevented
  equation, a 7-day trend sparkline, inline proxy status, and a **"do this now"** panel
  derived from real data (top waste finding, TTL advice verdict, session-bloat) — each
  card deep-links to the relevant view.
- Tabs consolidated to **Overview · Sessions · Proxy · Waste**. Cache-health content
  folded into Proxy (hit rate, budgets, TTL advice) and Overview; the Optimizer log is
  a sub-view of Waste. No information was dropped.
- **URL/hash state**: `#overview`, `#sessions?project=…&model=…&day=…`,
  `#sessions/<id>`, `#proxy`, `#waste`, `#waste/log`. Views, selected session and the
  shareable filters survive refresh.
- Two Overview cockpit directions are included behind an in-app **Layout A / B**
  toggle (A: hero-left with side status; B: centered full-width band).

## Phase 3 — Drill-downs + filters
- Click a **day bar** on the spend chart → Sessions filtered to that day.
- Click a **waste finding** ("Open session waterfall") → the offending session's
  turn-by-turn waterfall, auto-scrolled to the flagged turn (highlighted, without
  `scrollIntoView`).
- **Do-this-now** cards and TTL advice deep-link into their views.
- Sessions filter bar: project, model, date range chips, free-text search; **sortable
  columns** (aria-sort). Waste findings have **expandable rows** with the full
  recommendation and, for `cache_expiry` with `proxyWasUp:true`, the "proxy was up but
  couldn't prevent it — check ping budget" note.

## Phase 4 — Liveness
- Proxy page shows **per-session countdown to the next cache ping**, computed as
  `(detectedTtlSeconds − 30) − idleSec`, animating and turning warm under 30s; when it
  reaches zero the session flashes "ping fired", resets idle, and appends to the ticker.
- **Live event ticker** (pings, resumes, real requests, prevented rebuilds), newest
  first, with enter animation.
- **Toast** on a new prevented rebuild: "🔥 kept cache warm — saved $X.XX" using the
  real computed value; suppressed while the proxy is down.
- Calm by default: countdowns tick, but nothing loops or distracts when idle.
- **Degraded mode** is explicit: a "Simulate proxy down" toggle sets `live: null`,
  hides keep-alive UI, shows the red degraded panel, and reflects "proxy down" in the
  header — while spend tracking stays accurate.

## Additive API needs (for the real implementation)
The prototype assumes only additive server work — never renaming/removing existing
fields (the `stoke status` CLI and tests read them):
- `GET /api/sessions?day=YYYY-MM-DD&project=…&model=…` — filter params for the day-bar
  and project drill-downs (add vitest coverage).
- `GET /api/sessions/:id` — turn waterfall (already specified) plus an optional
  `flaggedTurn` index echoed from a waste finding, or map finding→turn client-side.
- Optional additive **SSE** route on the monitor for the event ticker instead of fast
  polling; polling the existing `/api/proxy` faster is an acceptable fallback.

## Deferred / needs a human step
- The prototype uses fixed mock data; wiring `useApi` 15s polling to these shapes is
  the implementation step.
- No human step is required to review the prototype. When implementing, the only new
  server work is the additive filter params / optional SSE above — each needs a vitest
  test to "stay green".
