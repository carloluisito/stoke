# Stoke UI/UX Redesign — prompt for Claude design

I want to redesign the UI/UX of "stoke", my personal Claude Code token-cost
dashboard, to feel more interactive, polished, and instantly readable.

## What the app is

A local, single-user analytics dashboard (React + Recharts, no CSS framework,
dark theme via CSS custom properties). It monitors my AI coding sessions:
parses transcripts into SQLite, prices every conversation turn, keeps the
API prompt cache warm, and reports waste. Six tabs today:

1. **Overview** — net cost today, spend by day and by component, proxy status
2. **Sessions** — per-turn cost waterfall with cache-ping annotations
3. **Proxy** — live sessions, cache-TTL detection, ping budget and outcomes
4. **Cache Health** — hit rate and cache economics over time
5. **Waste Report** — priced findings (cache expiry, context bloat, verbosity,
   model mismatch), each with a $ amount
6. **Optimizer Log** — in-session interventions the tool made

## Current look (to improve on, not discard)

Dark dashboard, max-width 1100px, stat Cards + bordered Sections + tables,
tab nav with a blue (#3987e5) active state. Semantic data-viz palette I want
to **keep**: blue = output cost, aqua = fresh input, yellow/orange = cache
writes, green = cache reads, amber/red = warnings/critical. Data refreshes
by polling every 15s.

## Design goals

1. **"Glanceable first":** within 3 seconds of opening I should know — am I
   over budget today, is the cache healthy, is anything wasting money right
   now. Rework Overview as a true home: hero numbers, trend sparklines,
   and a "top action to take" callout.
2. **Make it feel alive:** the data updates every 15s — design live-update
   affordances (subtle value transitions, pulsing "live" indicator, new-row
   highlight in feeds) instead of a static page that silently swaps numbers.
3. **Interactivity upgrades:** cross-filtering (click a day in the spend
   chart → sessions below filter to it), hover tooltips that explain costs
   in plain English, expandable table rows for per-turn detail, time-range
   selector (today / 7d / 30d) that persists across tabs.
4. **Progressive disclosure:** I'm the only user but range from "quick
   glance" to "forensic deep-dive". Summary first, detail on demand —
   drawers or expanding panels rather than more tabs.
5. **Emotional design for money:** waste findings should feel actionable,
   not shameful — each finding card gets severity, $ impact, one-line
   cause, and a concrete "do this" suggestion with a copy button.
6. **Better information hierarchy in tables:** fewer borders, stronger
   alignment, tabular numerals, compact density toggle.
7. **Dark mode stays primary;** refine the palette for contrast and
   hierarchy (surfaces, elevation, focus states), and make sure all
   text/chart colors pass WCAG AA on the dark background.

## Constraints

- Tech stays React + Recharts + hand-written CSS custom properties (no
  Tailwind, no component library) — design tokens welcome, framework
  swaps not.
- Local single-user tool: no auth, no onboarding, no marketing fluff.
- Desktop-first (it lives on a second monitor), but nothing should break
  at ~1000px.
- Keep the semantic chart colors listed above; you may tune their exact
  values for contrast.

## Deliverables

- A design-token sheet (colors, spacing, type scale, radii, elevation)
- High-fidelity mockups of Overview, Sessions, and Waste Report
- The interaction patterns specced (live-update behavior, cross-filter,
  row expansion, time-range selector)
- A component inventory mapped to my existing primitives (Card, Section,
  Table, Badge, Intro) so I can implement incrementally
