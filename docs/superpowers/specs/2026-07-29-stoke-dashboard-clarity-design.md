# Dashboard clarity redesign — design spec

**Date:** 2026-07-29
**Status:** approved, ready for implementation planning
**Scope:** `packages/monitor/web` (dashboard UI) + two `packages/monitor/src` API changes
**Non-scope:** the proxy daemon, pricing, waste detectors, transcript ingest

---

## Problem

The dashboard shows a lot and explains nothing. A first-time viewer cannot tell what stoke
does, whether it is working, or what it is worth. Measured against the live instance:

| Symptom | Measured |
|---|---|
| Waste tab renders every finding ever, unpaginated | **1,087 rows, 66,000 px tall** |
| …of which are sub-$1 verbosity findings | **741 rows, $0.17 each** |
| No date scoping, so "Total waste $668.75" is silently a lifetime figure | spans **2026-06-10 → 07-28** |
| Proxy tab session cards that are dead (`$0.00`, no countdown) | **16 of 22** |
| TTL advice rows that say "Switch to 1h" then "no change" | **20 of 28** |
| Project names rendered as mangled paths | `C--Users-carlo-Desktop-repositories-work-my-brain` |
| Largest number on the page is a **negative cost** (`$-0.47`) | reads as a bug |
| The same $0.47 fact repeated | **3×** on one screen |
| `Cache saved all-time $32,080` attributed to stoke | it is **Anthropic's cache**, not stoke |

### The core misframing

stoke has two engines and the dashboard headlines the smaller one.

| Engine | Value, last 30 days | % of spend | Where it appears today |
|---|---|---|---|
| Keep-alive proxy | **$52.73** net saved (243 rebuilds avoided) | 1.18% | the headline |
| Waste detection | **$439.62** identified & fixable | 9.80% | buried under 1,087 rows |

Baseline spend, last 30 days: **$4,484.94**.

---

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Audience is **both** first-timer and daily operator, via progressive disclosure | Level 1 is plain English; expert detail is one click deeper |
| D2 | Headline is **spend → avoidable slice → what stoke clawed back** | Anchors on the number the user already cares about; the "why" (9.8% waste) becomes self-evident; works on install day when savings are still $0 |
| D3 | Landing sections are labelled to answer **what / why / where / when** | Self-documenting for a newcomer, ordinary section labels for daily use |
| D4 | Cut `Cache saved all-time $32,080` and `Effective $/MTok` | The first is a ~2,000× overstatement of stoke's real contribution and destroys credibility on the numbers that *are* real; the second has no baseline and is unreadable |
| D5 | Replace it with a **real cumulative counter**: "since stoke started — 336 rebuilds avoided, $143.27 net saved" | An honest running total in the same emotional slot as the inflated number |
| D6 | Roll 1,087 findings into **5 cause cards** | Users act on causes, not incidents |
| D7 | Rewrite cause names into **plain language** | `cache_expiry` → "You walked away and the cache went cold." The *why* is the product's value |
| D8 | Hide `abandoned` sessions and `no change` TTL rows | 73% and 71% dead weight respectively |
| D9 | Drop the token-type stack from the landing trend | `output / fresh input / cache write / cache read` is expert-only; it moves to Sessions |
| D10 | **No** before/after-install comparison | Verified impossible — see Rejected below |
| D11 | Memoize `preventedSavings()` | Pre-existing 313 ms × every-5s poll; this design adds a second caller |

### Rejected: "since you installed stoke" before/after

Proposed and approved in discussion, then **withdrawn on verification**:
`turns` data begins `2026-06-10`; `proxy_events` begins `2026-06-08`. stoke predates every
transcript by two days, so **no before-period exists**. Any before/after panel would be
fabricated. Superseded by D5.

---

## Level 1 — the landing screen

Five sections, single scroll, ~1.5 viewports. Tab label `Home`.

### 1. What — the answer

```
You spent $4,485 on Claude Code in the last 30 days.
$440 of it was avoidable.
  └ That's 9.8% — billed for work Claude had already done, or output you didn't need.

[████████████████████████████████████░░░]   necessary $4,045 · avoidable $440
```

A **sentence**, not a bare metric. The proportion bar makes 9.8% visible rather than
something the reader must compute.

Directly beneath, the green "stoke is working" strip:

```
● stoke clawed back $52.73 of that
  It caught 243 cache rebuilds before Claude could re-bill you. Watching 4 live sessions.
  Since it started running: 336 rebuilds avoided · $143.27 net saved      ← D5
```

### 2. Why — the leak, by cause

Five cards, descending by dollars. Each carries a plain-English *why* and **one concrete fix**.
Numbers below are the live 30-day values.

| $ | Count | Plain-language title | Fix |
|---|---|---|---|
| $242.60 | 68× | You walked away and the cache went cold | Switch 8 projects to 1h cache → |
| $83.19 | 429× | Replies were longer than they needed to be | Turn on terse replies → |
| $66.21 | 25× | You edited CLAUDE.md mid-session | See the 25 sessions → |
| $43.57 | 98× | Sessions ran near the context limit | See the 98 sessions → |
| $4.05 | 4× | A top-tier model did mechanical work | See the 4 sessions → |

Each card expands to its incidents; "see the N sessions" deep-links into the Leaks tab.

### 3. Where — by project

Horizontal bars, **readable names**, top 5 + "N more projects" (28 projects currently have
findings, so N is 23 today — the count is derived, never hard-coded):
`personal/omnidesk $100` · `personal/windlass-lms $66` · `ispade $59` ·
`work/resto-backend $54` · `personal/agent-creator $35`

### 4. When — right now

Only `warm` and `paused` sessions, each with its live countdown to the next keep-alive ping.
This is what makes stoke's *timing* legible: it pings just before the TTL expires.
`16 finished sessions hidden` is a text link, not 16 cards.

### 5. Trend

30 daily cost bars with the avoidable portion shaded, plus a second series for
**what stoke prevented each day**, so value visibly accrues. No token-type stack.

### Header

`stoke — keeps your Claude Code bill down` · `Home · Leaks · Sessions · Keep-alive` ·
one `all running` pill. The `updated 2s ago` chip folds into the pill's tooltip.
A dismissible one-liner for true first-timers (persisted in `localStorage`):

> Claude Code re-bills you for context it already cached. stoke stops that, and shows you
> what else is leaking.

---

## Level 2 — the tabs

| Tab | Route id (unchanged) | Change |
|---|---|---|
| **Home** | `overview` | rebuilt per above |
| **Leaks** | `waste` | default 30-day window; grouped by cause with incidents nested; sub-$1 verbosity findings collapse to one expandable line (429 in the 30-day window, 741 all-time) |
| **Sessions** | `sessions` | unchanged, plus readable project names; inherits the token-type detail dropped from Home |
| **Keep-alive** | `proxy` | `abandoned` sessions behind a "show inactive (16)" toggle; TTL list shows only the 8 actionable rows, the other 20 behind "20 with no change" |

Route ids stay as-is so existing deep links (`go("sessions/"+id)`, `go("waste")`) and
`router.test.js` keep working. Only display labels change — "proxy" is jargon.

---

## Architecture

`pages/Overview.jsx` (213 lines, does everything) becomes a composition of single-purpose
units. Logic moves into pure modules so it is testable without a DOM.

```
pages/Home.jsx            composes the 5 sections            (~70 lines)
home/Answer.jsx           headline sentence + proportion bar
home/StokeWorking.jsx     green strip + cumulative counter
home/Causes.jsx           5 rolled-up cause cards
home/ByProject.jsx        leak-by-project bars
home/LiveNow.jsx          warm sessions + countdowns
home/Trend.jsx            daily bars, avoidable + prevented series

lib/causes.js             type → { title, why, fix, route }   ← plain-English taxonomy
lib/projectName.js        C--Users-…-omnidesk → personal/omnidesk  (pure)
```

Aggregation runs where the data lives, not in the browser:

```
src/analytics/rollup.js   findings[] + window → { causes, byProject }  (pure, server-side)
```

The server aggregates and emits raw `type` / `project` keys; the client owns presentation
(`causes.js` supplies the copy, `projectName.js` the readable name). This keeps C1's payload
small without duplicating the grouping logic in two places.

`lib/projectName.js` resolves an existing duplication: `projectLabeler` (`api.js`) and
`shortPath` (`Proxy.jsx`) are two implementations of the same idea and neither yields a
readable name. One function, used everywhere.

Each unit takes data as props and renders; none fetches. `Home.jsx` owns the fetches so
polling stays centralized, as `App.jsx` already does for `/proxy`.

---

## Data flow

Every number on the landing screen already exists in the API. Three changes:

### C1 — `GET /api/waste?days=30&rollup=1`

Returns 5 grouped causes + project totals instead of 1,087 raw findings.
Not cosmetic: the current response is **437,905 bytes** and grows without bound.
Rollup brings it to ~2 KB. Raw findings remain available un-rolled for the Leaks tab.

```jsonc
{ "windowDays": 30,
  "spendUsd": 4484.94, "avoidableUsd": 439.62, "avoidablePct": 0.098,
  "causes": [ { "type":"cache_expiry", "usd":242.60, "count":68,
                "fix":{ "kind":"ttl_switch", "projects":8 } } ],
  "byProject": [ { "project":"personal/omnidesk", "usd":100.41 } ] }
```

### C2 — `GET /api/proxy/savings?days=30`

`preventedSavings(db, rules, fromTs, toTs)` **already accepts an arbitrary window**, so this
is a thin route over an existing function, not new infrastructure. Also serves the all-time
cumulative figure for D5 (`days=all`).

### C3 — memoize `preventedSavings()` (D11)

`/api/proxy` measures **313 ms** and `App.jsx` polls it **every 5,000 ms**. Each call reads all
**47,853** `proxy_events` rows and `JSON.parse`s every one — measured at **180 ms** inside
`preventedSavings` alone — to recompute a value that only changes when a ping fires.
Cache the result keyed on `SELECT MAX(id) FROM proxy_events`; recompute only when it moves.

This is pre-existing, not introduced here, but this design adds a second caller to the same
function and would otherwise double a known cost.

---

## Empty and error states

| Condition | Behaviour |
|---|---|
| No turns yet (install day) | "stoke is watching. Nothing billed yet." — **not** `$0 avoidable (NaN%)`. Guards divide-by-zero in the proportion bar |
| Spend > 0, no findings | Genuine all-clear: "Nothing avoidable found in the last 30 days" |
| Proxy down | Green strip goes neutral, reusing the existing honest copy: keep-alive inactive, **spend tracking still works** |
| A finding type with no `causes.js` entry | Falls back to the raw type as title rather than rendering blank; covered by a test |
| Fewer than 5 causes present | Render only those present; no placeholder cards |

---

## Testing

Pure modules get unit tests; the existing five test files must keep passing.

- `rollup.test.js` — windowing, grouping, sums, count aggregation, top-N projects, empty input
- `projectName.test.js` — mangled paths, short paths, `C--`, unknown/null
- `causes.test.js` — **every finding type present in the DB has a `causes.js` entry.** Without
  this, a newly added detector silently renders a blank card
- `rollup.test.js` — zero-spend guard returns `avoidablePct: 0`, never `NaN`
- Existing: `charts`, `format`, `live`, `router`, `sessions` — unchanged, must stay green

Verification gate: full `vitest` run in `packages/monitor`, plus a browser check of the four
tabs at 1440 px and 900 px in both themes.

---

## Success criteria

1. A viewer who has never seen stoke can state what it does and what it saved, from the
   landing screen alone, without scrolling past section 2.
2. No screen exceeds ~2 viewports; no unpaginated list of more than 25 rows.
3. Every dollar figure on the landing screen is attributable to stoke or explicitly labelled
   as the user's own spend. No borrowed credit.
4. `/api/waste` landing payload under 5 KB. **Met** — 437,627 → 2,131 bytes.
5. `preventedSavings()` costs ~0 on a warm cache. **Met** — 276.9 ms → 0.029 ms (9,577×).
6. Zero jargon on level 1: no "TTL", "MTok", "cache write", "proxy", "attribution", "lever".

### Criterion 5 was originally written wrong

It first read *"`/api/proxy` p50 under 20 ms"*. That is not achievable by anything in this spec,
and the number was set without checking where the endpoint's time actually goes. Measured after
the memoization:

| Endpoint | p50 | Calls the proxy daemon? |
|---|---|---|
| `/api/cache`, `/api/sessions`, `/api/spend/projects` | 4–9 ms | no |
| `/api/proxy`, `/api/overview` | 62–67 ms | yes |
| proxy daemon's `/__stoke/stats`, called directly | 305–407 ms | — |

`/api/proxy` went from 313 ms to ~62 ms, and the `preventedSavings` component of that went to
effectively zero. The remaining ~60 ms is the loopback HTTP call to the proxy daemon for live
state, which cannot be cached (that is the point of it being live).

**Follow-up worth filing separately:** the proxy daemon's own `/__stoke/stats` takes 305–407 ms
standalone. Every dashboard poll pays it, and the monitor only avoids the worst case because of
its 500 ms `AbortSignal.timeout`. That is in `packages/proxy`, which this spec lists as
non-scope, so it was not touched here.
