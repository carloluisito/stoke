# Dashboard Clarity Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the stoke dashboard's landing screen so a first-time viewer knows what stoke does, whether it's working, and what it's worth — in five plain-language sections instead of four bare KPI cards and a 1,087-row table.

**Architecture:** Aggregation moves server-side (`src/analytics/rollup.js`) so the waste payload drops from 438 KB to ~2 KB; presentation copy lives client-side (`web/src/lib/causes.js`). `pages/Overview.jsx` splits into six single-purpose components under `web/src/home/`. `preventedSavings()` gains memoization and an open-ended window so a second caller doesn't double a known 313 ms cost.

**Tech Stack:** Node ≥ 20, Fastify, better-sqlite3, React 18, Vite 6, Vitest 2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-29-stoke-dashboard-clarity-design.md`

## Global Constraints

- **Zero jargon on the landing screen.** Banned words in level-1 UI copy: `TTL`, `MTok`, `cache write`, `cache read`, `fresh input`, `proxy`, `attribution`, `lever`, `verdict`. (Level 2 tabs may use them.)
- **No borrowed credit.** Every dollar figure on the landing screen is either the user's own spend or attributable to stoke. Never re-introduce `cacheSavedUsd` there.
- **Hash route ids are frozen:** `overview`, `sessions`, `proxy`, `waste`. Only display labels change. `web/src/__tests__/router.test.js` must pass unmodified.
- **Never touch port 9876.** `startServer` already skips it; don't alter that guard.
- **No new runtime dependencies** in `packages/monitor` or `packages/monitor/web`.
- **Money formatting** uses existing `money()` from `web/src/api.js` (always 2 dp). Whole-dollar display uses `usd()`.
- **Test commands:**
  - server: `npm test -w @stoke/monitor` (vitest, excludes `web/`)
  - web: `npm --prefix packages/monitor/web run test`

---

## File Structure

**Create — server:**
| File | Responsibility |
|---|---|
| `packages/monitor/src/analytics/rollup.js` | Pure: findings[] + window → `{ causes, byProject }` |
| `packages/monitor/tests/rollup.test.js` | Unit tests for the above |

**Create — web:**
| File | Responsibility |
|---|---|
| `web/src/lib/projectName.js` | Pure: mangled path → readable name |
| `web/src/lib/causes.js` | Pure: finding type → plain-English copy + fix |
| `web/src/home/Answer.jsx` | Headline sentence + proportion bar |
| `web/src/home/StokeWorking.jsx` | Green strip + cumulative counter |
| `web/src/home/Causes.jsx` | Five rolled-up cause cards |
| `web/src/home/ByProject.jsx` | Leak-by-project bars |
| `web/src/home/LiveNow.jsx` | Warm sessions + countdowns |
| `web/src/home/Trend.jsx` | Daily bars: cost, avoidable, prevented |
| `web/src/home/Explainer.jsx` | Dismissible one-liner (localStorage) |
| `web/src/pages/Home.jsx` | Owns fetches, composes the six sections |
| `web/src/__tests__/projectName.test.js` | |
| `web/src/__tests__/causes.test.js` | |

**Modify:**
| File | Change |
|---|---|
| `packages/monitor/src/analytics/breakdowns.js:21-39` | Memoize `preventedSavings`, open-ended window |
| `packages/monitor/src/server.js:31-46` | Add `/api/proxy/savings`, extend `/api/waste` |
| `web/src/App.jsx:12-17,96-103` | Tab labels, route `overview` → `Home` |
| `web/src/api.js:104-113` | Delete `projectLabeler` (superseded) |
| `web/src/pages/Proxy.jsx` | Hide inactive sessions + no-change TTL rows |
| `web/src/pages/Waste.jsx` | 30-day default, grouped by cause |
| `web/src/pages/Sessions.jsx:5,28` | Use `projectName` |
| `web/src/styles.css` | Append landing-screen classes |
| `web/src/pages/Overview.jsx` | **Delete** — replaced by `pages/Home.jsx` |

---

## Task 1: Readable project names

Replaces two competing implementations (`projectLabeler` in `api.js`, `shortPath` in `Proxy.jsx`), neither of which produces a readable name.

**Files:**
- Create: `packages/monitor/web/src/lib/projectName.js`
- Test: `packages/monitor/web/src/__tests__/projectName.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `projectName(raw: string|null) => string` — the single name formatter used by every page.

- [ ] **Step 1: Write the failing test**

Create `packages/monitor/web/src/__tests__/projectName.test.js`:

```js
import { describe, it, expect } from "vitest";
import { projectName } from "../lib/projectName.js";

describe("projectName", () => {
  it("keeps the last two segments of a mangled Windows path", () => {
    expect(projectName("C--Users-carlo-Desktop-repositories-personal-omnidesk"))
      .toBe("personal/omnidesk");
  });
  it("keeps a multi-word trailing segment intact", () => {
    expect(projectName("C--Users-carlo-Desktop-repositories-personal-windlass-lms"))
      .toBe("personal/windlass-lms");
  });
  it("drops the repositories/Desktop scaffolding", () => {
    expect(projectName("C--Users-carlo-Desktop-repositories-ispade")).toBe("ispade");
  });
  it("handles a posix path", () => {
    expect(projectName("/home/me/code/work/api")).toBe("work/api");
  });
  it("returns a placeholder for empty input", () => {
    expect(projectName(null)).toBe("unknown");
    expect(projectName("")).toBe("unknown");
  });
  it("passes through a name that is already short", () => {
    expect(projectName("stoke")).toBe("stoke");
  });
  it("never returns an empty string for odd input", () => {
    expect(projectName("C--")).not.toBe("");
    expect(projectName("---")).not.toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/monitor/web run test -- projectName`
Expected: FAIL — `Failed to resolve import "../lib/projectName.js"`

- [ ] **Step 3: Write minimal implementation**

Create `packages/monitor/web/src/lib/projectName.js`:

```js
// Claude Code encodes a project's cwd as its directory name, replacing every
// path separator with "-" ("C--Users-me-Desktop-repositories-personal-omnidesk").
// Raw, that's unreadable in a table. Strip the scaffolding segments everyone
// shares and keep the last two meaningful ones: "personal/omnidesk".

// Segments that carry no information — they appear in every project on a machine.
const NOISE = new Set([
  "c", "d", "e", "users", "home", "desktop", "documents",
  "repositories", "repos", "code", "projects", "src", "dev", "git",
]);

export function projectName(raw) {
  if (!raw) return "unknown";
  const segments = String(raw)
    .split(/[\\/-]+/)
    .filter(Boolean)
    .filter((s) => !NOISE.has(s.toLowerCase()));
  if (segments.length === 0) return "unknown";

  // A user's own name sits between "Users" and the code dir; it's noise too, but
  // we can't enumerate it — it's whatever segment preceded a noise word. Taking
  // the tail two segments drops it naturally.
  const tail = segments.slice(-2);
  return tail.join("/");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/monitor/web run test -- projectName`
Expected: PASS, 7 tests.

Note: `personal-windlass-lms` splits to `["personal","windlass","lms"]`, so the tail-two rule yields `windlass/lms`, not `personal/windlass-lms`. **Fix by splitting on separators only, then trimming noise from the front:**

```js
export function projectName(raw) {
  if (!raw) return "unknown";
  // Split on real separators only; "-" inside a name must survive, so we split
  // on "-" but rejoin any trailing run that follows the last noise segment.
  const parts = String(raw).split(/[\\/-]+/).filter(Boolean);
  let i = 0;
  for (let j = 0; j < parts.length; j++) {
    if (NOISE.has(parts[j].toLowerCase())) i = j + 1;
  }
  const rest = parts.slice(i);
  if (rest.length === 0) return "unknown";
  if (rest.length === 1) return rest[0];
  // First remaining segment is the grouping dir; everything after it is the
  // project name, which may itself contain dashes.
  return rest[0] + "/" + rest.slice(1).join("-");
}
```

Re-run until all 7 pass. Verify by hand:
- `C--Users-carlo-Desktop-repositories-personal-windlass-lms` → last noise is `repositories` (index 4) → rest `["personal","windlass","lms"]` → `personal/windlass-lms` ✓
- `C--Users-carlo-Desktop-repositories-ispade` → rest `["ispade"]` → `ispade` ✓
- `/home/me/code/work/api` → last noise `code` → rest `["work","api"]` → `work/api` ✓
- `stoke` → no noise, rest `["stoke"]` → `stoke` ✓
- `C--` → parts `["C"]`, `C` is noise → rest `[]` → `unknown` ✓

- [ ] **Step 5: Commit**

```bash
git add packages/monitor/web/src/lib/projectName.js packages/monitor/web/src/__tests__/projectName.test.js
git commit -m "feat(monitor): readable project names, replacing two partial implementations"
```

---

## Task 2: Plain-English cause taxonomy

The single highest-value change: `cache_expiry` means nothing to a newcomer; the *why* is the product's value.

**Files:**
- Create: `packages/monitor/web/src/lib/causes.js`
- Test: `packages/monitor/web/src/__tests__/causes.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `CAUSES: Record<string, {title, why, fix, route}>`
  - `causeFor(type: string) => {title, why, fix, route}` — never returns undefined; unknown types fall back to the raw type as title.
  - `KNOWN_TYPES: string[]`

- [ ] **Step 1: Write the failing test**

Create `packages/monitor/web/src/__tests__/causes.test.js`:

```js
import { describe, it, expect } from "vitest";
import { CAUSES, causeFor, KNOWN_TYPES } from "../lib/causes.js";

// Every type runDetectors() can emit, per src/analytics/detectors.js.
const DETECTOR_TYPES = [
  "cache_expiry",
  "cache_invalidation",
  "session_bloat",
  "output_verbosity",
  "model_mismatch",
];

describe("causes taxonomy", () => {
  it("covers every type the detectors emit", () => {
    for (const t of DETECTOR_TYPES) {
      expect(CAUSES[t], `missing copy for detector type "${t}"`).toBeDefined();
    }
  });

  it("exports the known types for iteration", () => {
    expect(KNOWN_TYPES.sort()).toEqual(DETECTOR_TYPES.sort());
  });

  it("gives every cause a title, a why and a fix", () => {
    for (const [type, c] of Object.entries(CAUSES)) {
      expect(c.title, `${type}.title`).toBeTruthy();
      expect(c.why, `${type}.why`).toBeTruthy();
      expect(c.fix, `${type}.fix`).toBeTruthy();
      expect(c.route, `${type}.route`).toBeTruthy();
    }
  });

  it("uses no jargon in landing-screen copy", () => {
    const banned = /\bTTL\b|\bMTok\b|cache write|cache read|fresh input|\bproxy\b|attribution|\blever\b/i;
    for (const [type, c] of Object.entries(CAUSES)) {
      expect(banned.test(c.title), `${type}.title has jargon`).toBe(false);
      expect(banned.test(c.why), `${type}.why has jargon`).toBe(false);
    }
  });

  it("falls back to the raw type instead of rendering blank", () => {
    const c = causeFor("some_new_detector");
    expect(c.title).toBe("some_new_detector");
    expect(c.why).toBeTruthy();
    expect(c.route).toBe("waste");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/monitor/web run test -- causes`
Expected: FAIL — cannot resolve `../lib/causes.js`

- [ ] **Step 3: Write minimal implementation**

Create `packages/monitor/web/src/lib/causes.js`:

```js
// Detector types are engineering labels ("cache_expiry"). A first-time viewer
// needs to know what happened to them and what to do about it, in their own
// words. This file is the only place that copy lives.
//
// `fix` is the single action that addresses the cause. `route` is the hash the
// card's link goes to. Keep `title` and `why` free of jargon — they render on
// the landing screen (see the jargon test in __tests__/causes.test.js).

export const CAUSES = {
  cache_expiry: {
    title: "You walked away and the cache went cold",
    why: "Claude keeps your context cached for a few minutes. Idle past that and the next message re-bills the whole conversation from scratch.",
    fix: "Use the longer 1-hour cache",
    route: "proxy",
  },
  cache_invalidation: {
    title: "You edited CLAUDE.md mid-session",
    why: "Changing your instructions or settings while a session is running invalidates everything cached behind them, so the conversation gets re-billed from the start.",
    fix: "Edit instructions between sessions",
    route: "waste",
  },
  session_bloat: {
    title: "Sessions ran near the context limit",
    why: "Once a conversation is very large, every new turn pays for all the dead context behind it. Compacting resets that.",
    fix: "Run /compact on long sessions",
    route: "waste",
  },
  output_verbosity: {
    title: "Replies were longer than they needed to be",
    why: "What Claude writes costs about five times what it reads. These turns produced far more text than the task asked for.",
    fix: "Ask for concise output",
    route: "waste",
  },
  model_mismatch: {
    title: "A top-tier model did mechanical work",
    why: "Bulk searching and file sweeps don't need the most expensive model — a cheaper one handles them for a fraction of the price.",
    fix: "Delegate searches to a cheaper model",
    route: "waste",
  },
};

export const KNOWN_TYPES = Object.keys(CAUSES);

/** Never returns undefined — an unrecognised type still renders something honest. */
export function causeFor(type) {
  return (
    CAUSES[type] || {
      title: type,
      why: "stoke flagged this as avoidable spend but has no plain-language explanation for it yet.",
      fix: "See the sessions",
      route: "waste",
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/monitor/web run test -- causes`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/monitor/web/src/lib/causes.js packages/monitor/web/src/__tests__/causes.test.js
git commit -m "feat(monitor): plain-English cause taxonomy for waste findings"
```

---

## Task 3: Server-side rollup

Turns 1,087 findings into five causes plus project totals. This is what shrinks the payload from 437,905 bytes to ~2 KB.

**Files:**
- Create: `packages/monitor/src/analytics/rollup.js`
- Test: `packages/monitor/tests/rollup.test.js`

**Interfaces:**
- Consumes: finding objects from `runDetectors(db, rules)`, shaped
  `{ type, session_id, project, ts, wastedUsd, recommendation, confidence? }`
- Produces: `rollupFindings(findings, { days, now, spendUsd, topProjects }) => { windowDays, spendUsd, avoidableUsd, avoidablePct, findingCount, causes, byProject }`
  - `causes: Array<{ type, usd, count, topProject }>` descending by `usd`
  - `byProject: Array<{ project, usd }>` descending by `usd`, length ≤ `topProjects`
  - `projectCount: number` — total distinct projects, so the UI can say "N more"

- [ ] **Step 1: Write the failing test**

Create `packages/monitor/tests/rollup.test.js`:

```js
import { describe, it, expect } from "vitest";
import { rollupFindings } from "../src/analytics/rollup.js";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400e3).toISOString();

const F = (type, project, wastedUsd, agoDays) => ({
  type, project, wastedUsd, ts: daysAgo(agoDays), session_id: "s" + agoDays,
});

describe("rollupFindings", () => {
  it("groups by type, sums dollars and counts occurrences", () => {
    const r = rollupFindings(
      [F("cache_expiry", "a", 10, 1), F("cache_expiry", "a", 5, 2), F("session_bloat", "b", 3, 1)],
      { days: 30, now: NOW, spendUsd: 100 },
    );
    expect(r.causes).toEqual([
      { type: "cache_expiry", usd: 15, count: 2, topProject: "a" },
      { type: "session_bloat", usd: 3, count: 1, topProject: "b" },
    ]);
  });

  it("excludes findings outside the window", () => {
    const r = rollupFindings(
      [F("cache_expiry", "a", 10, 5), F("cache_expiry", "a", 999, 45)],
      { days: 30, now: NOW, spendUsd: 100 },
    );
    expect(r.avoidableUsd).toBe(10);
    expect(r.findingCount).toBe(1);
  });

  it("computes the avoidable share of spend", () => {
    const r = rollupFindings([F("cache_expiry", "a", 25, 1)], { days: 30, now: NOW, spendUsd: 100 });
    expect(r.avoidableUsd).toBe(25);
    expect(r.avoidablePct).toBeCloseTo(0.25);
  });

  it("returns 0 not NaN when there is no spend", () => {
    const r = rollupFindings([], { days: 30, now: NOW, spendUsd: 0 });
    expect(r.avoidablePct).toBe(0);
    expect(r.avoidableUsd).toBe(0);
    expect(r.causes).toEqual([]);
    expect(Number.isNaN(r.avoidablePct)).toBe(false);
  });

  it("ranks projects by leak and caps the list", () => {
    const r = rollupFindings(
      [F("cache_expiry", "a", 5, 1), F("cache_expiry", "b", 9, 1), F("session_bloat", "c", 7, 1)],
      { days: 30, now: NOW, spendUsd: 100, topProjects: 2 },
    );
    expect(r.byProject).toEqual([{ project: "b", usd: 9 }, { project: "c", usd: 7 }]);
    expect(r.projectCount).toBe(3);
  });

  it("names the worst project per cause", () => {
    const r = rollupFindings(
      [F("cache_expiry", "small", 1, 1), F("cache_expiry", "big", 20, 1)],
      { days: 30, now: NOW, spendUsd: 100 },
    );
    expect(r.causes[0].topProject).toBe("big");
  });

  it("tolerates missing wastedUsd and project", () => {
    const r = rollupFindings(
      [{ type: "cache_expiry", ts: daysAgo(1) }],
      { days: 30, now: NOW, spendUsd: 10 },
    );
    expect(r.avoidableUsd).toBe(0);
    expect(r.causes[0].count).toBe(1);
  });

  it("treats days:0 as all-time", () => {
    const r = rollupFindings([F("cache_expiry", "a", 4, 400)], { days: 0, now: NOW, spendUsd: 10 });
    expect(r.avoidableUsd).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @stoke/monitor -- rollup`
Expected: FAIL — cannot resolve `../src/analytics/rollup.js`

- [ ] **Step 3: Write minimal implementation**

Create `packages/monitor/src/analytics/rollup.js`:

```js
// The dashboard used to ship every finding to the browser — 1,087 objects and
// 438 KB on a 51-day-old database, growing without bound. Users act on causes,
// not individual incidents, so aggregate here and send the summary.

/**
 * @param {Array<{type:string,project?:string,ts:string,wastedUsd?:number}>} findings
 * @param {{days?:number, now?:Date, spendUsd?:number, topProjects?:number}} opts
 *   days: window size; 0 or negative means all-time.
 */
export function rollupFindings(findings, opts = {}) {
  const { days = 30, now = new Date(), spendUsd = 0, topProjects = 5 } = opts;
  const cutoff = days > 0 ? now.getTime() - days * 86400e3 : -Infinity;

  const inWindow = (findings || []).filter((f) => {
    const t = Date.parse(f?.ts);
    return Number.isFinite(t) ? t >= cutoff : false;
  });

  const byType = new Map(); // type -> { usd, count, projects: Map }
  const byProject = new Map(); // project -> usd

  for (const f of inWindow) {
    const usd = Number(f.wastedUsd) || 0;
    const project = f.project || "unknown";

    let e = byType.get(f.type);
    if (!e) byType.set(f.type, (e = { usd: 0, count: 0, projects: new Map() }));
    e.usd += usd;
    e.count += 1;
    e.projects.set(project, (e.projects.get(project) || 0) + usd);

    byProject.set(project, (byProject.get(project) || 0) + usd);
  }

  const causes = [...byType.entries()]
    .map(([type, e]) => ({
      type,
      usd: e.usd,
      count: e.count,
      topProject: [...e.projects.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown",
    }))
    .sort((a, b) => b.usd - a.usd);

  const projects = [...byProject.entries()]
    .map(([project, usd]) => ({ project, usd }))
    .sort((a, b) => b.usd - a.usd);

  const avoidableUsd = causes.reduce((a, c) => a + c.usd, 0);

  return {
    windowDays: days,
    spendUsd,
    avoidableUsd,
    // Guard the divide — a fresh install has zero spend and must not render NaN%.
    avoidablePct: spendUsd > 0 ? avoidableUsd / spendUsd : 0,
    findingCount: inWindow.length,
    causes,
    byProject: projects.slice(0, topProjects),
    projectCount: projects.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @stoke/monitor -- rollup`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/monitor/src/analytics/rollup.js packages/monitor/tests/rollup.test.js
git commit -m "feat(monitor): server-side waste rollup by cause and project"
```

---

## Task 4: Memoize preventedSavings and open the window

`/api/proxy` measures 313 ms and `App.jsx` polls it every 5 s, re-reading all 47,853 `proxy_events` rows and `JSON.parse`-ing each. This task fixes that *before* Task 5 adds a second caller.

**The subtlety that makes or breaks this:** current callers pass `toTs = now.toISOString()`, which differs on every call. A memo keyed on `toTs` would never hit. So `toTs` becomes optional — `null` means "up to the latest event", which is stable between events.

**Files:**
- Modify: `packages/monitor/src/analytics/breakdowns.js:21-39` (`preventedSavings`), `:45-57` (`netCost`), `:60-85` (`proxySummary`)
- Test: `packages/monitor/tests/breakdowns.test.js` (append)

**Interfaces:**
- Consumes: `computeSavings` from `@stoke/shared/savings.mjs` (unchanged)
- Produces: `preventedSavings(db, rules, fromTs, toTs = null) => {savedUsd, rebuildsAvoided, pingSpendUsd, netSavedUsd}` — `toTs = null` means open-ended. Also exports `__resetSavingsMemo()` for tests.

- [ ] **Step 1: Write the failing test**

Append to `packages/monitor/tests/breakdowns.test.js`:

```js
import { preventedSavings, __resetSavingsMemo } from "../src/analytics/breakdowns.js";

describe("preventedSavings memoization", () => {
  // Minimal in-memory db with the two columns the function reads.
  function makeDb(events) {
    let nextId = 1;
    const rows = events.map((e) => ({ id: nextId++, ts: e.ts, raw: JSON.stringify(e) }));
    let scans = 0;
    return {
      scans: () => scans,
      push(e) { rows.push({ id: nextId++, ts: e.ts, raw: JSON.stringify(e) }); },
      prepare(sql) {
        if (/MAX\(id\)/.test(sql)) {
          return { get: () => ({ m: rows.length ? rows[rows.length - 1].id : null }) };
        }
        return {
          all: () => { scans += 1; return rows.map((r) => ({ raw: r.raw })); },
          get: () => ({ c: 0 }),
        };
      },
    };
  }

  const ev = (ts) => ({ kind: "ping_fired", ts, sessionKey: "k", costUsd: 0.01 });

  beforeEach(() => __resetSavingsMemo());

  it("scans the event log only once for repeated identical calls", () => {
    const db = makeDb([ev("2026-07-01T00:00:00.000Z")]);
    preventedSavings(db, null, "2026-07-01");
    preventedSavings(db, null, "2026-07-01");
    preventedSavings(db, null, "2026-07-01");
    expect(db.scans()).toBe(1);
  });

  it("returns the same value from cache", () => {
    const db = makeDb([ev("2026-07-01T00:00:00.000Z")]);
    const a = preventedSavings(db, null, "2026-07-01");
    const b = preventedSavings(db, null, "2026-07-01");
    expect(b).toEqual(a);
  });

  it("recomputes when a new proxy event lands", () => {
    const db = makeDb([ev("2026-07-01T00:00:00.000Z")]);
    preventedSavings(db, null, "2026-07-01");
    db.push(ev("2026-07-01T00:10:00.000Z"));
    preventedSavings(db, null, "2026-07-01");
    expect(db.scans()).toBe(2);
  });

  it("caches each window separately", () => {
    const db = makeDb([ev("2026-07-01T00:00:00.000Z")]);
    preventedSavings(db, null, "2026-07-01");
    preventedSavings(db, null, "2026-06-01");
    expect(db.scans()).toBe(2);
    preventedSavings(db, null, "2026-07-01");
    expect(db.scans()).toBe(2); // still cached
  });

  it("treats an omitted toTs as open-ended and stable across calls", () => {
    const db = makeDb([ev("2026-07-01T00:00:00.000Z")]);
    preventedSavings(db, null, "2026-07-01", null);
    preventedSavings(db, null, "2026-07-01");
    expect(db.scans()).toBe(1);
  });
});
```

Ensure `beforeEach` is in the file's vitest import; add it if the existing import line lacks it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @stoke/monitor -- breakdowns`
Expected: FAIL — `__resetSavingsMemo is not a function`, and the scan-count assertions fail (currently every call scans).

- [ ] **Step 3: Write the implementation**

In `packages/monitor/src/analytics/breakdowns.js`, replace the `preventedSavings` function (lines 16-39) with:

```js
// Recomputing this means reading and JSON.parse-ing the entire proxy event log
// (47k+ rows on a two-month-old install). The dashboard polls /api/proxy every
// 5s, so without a memo that cost is paid continuously and grows forever. The
// answer only changes when a new proxy event lands, so MAX(id) is a sound key.
//
// An open-ended window (toTs = null) is the common case and must key stably —
// callers used to pass a fresh now.toISOString() every time, which would defeat
// the cache entirely.
const OPEN_END = "9999-12-31T23:59:59.999Z";
let memoMaxId = null;
const memo = new Map();

/** Test hook — the memo is module state, so tests must be able to clear it. */
export function __resetSavingsMemo() {
  memoMaxId = null;
  memo.clear();
}

/**
 * Rebuilds the proxy prevented in [fromTs, toTs], priced with the shared
 * savings math over the full proxy event log (predecessor lookups must span
 * the whole log, so we window inside computeSavings, not in SQL).
 *
 * @param {string} fromTs inclusive ISO lower bound
 * @param {string|null} toTs inclusive ISO upper bound; null = up to the latest event
 */
export function preventedSavings(db, rules, fromTs, toTs = null) {
  const maxId = db.prepare("SELECT MAX(id) m FROM proxy_events").get().m ?? 0;
  if (maxId !== memoMaxId) {
    memo.clear();
    memoMaxId = maxId;
  }
  const end = toTs ?? OPEN_END;
  const key = fromTs + "|" + end;
  const hit = memo.get(key);
  if (hit) return hit;

  const rows = db.prepare("SELECT raw FROM proxy_events ORDER BY ts").all();
  const events = [];
  for (const r of rows) {
    try { events.push(JSON.parse(r.raw)); } catch { /* skip torn rows */ }
  }
  const cfg = {
    cacheTtlSeconds: 300,
    pricing: { cacheReadMultiplier: 0.1, rebuildMultiplier: 1.25, rebuildMultiplier1h: 2.0 },
    modelPricing: defaultModelPricingMap(rules ?? loadPricing(), new Date().toISOString()),
  };
  const s = computeSavings(events, cfg, Date.parse(fromTs), Date.parse(end));
  const out = {
    savedUsd: s.savedUsd,
    rebuildsAvoided: s.rebuildsAvoided,
    pingSpendUsd: s.pingSpendUsd,
    netSavedUsd: s.netSavedUsd,
  };
  memo.set(key, out);
  return out;
}
```

Then update both callers to stop passing a moving `toTs`.

`netCost` (was line 49) — replace:
```js
  const prevented = preventedSavings(db, rules, dayStart, nowIso);
```
with:
```js
  const prevented = preventedSavings(db, rules, dayStart);
```
and delete the now-unused `const nowIso = now.toISOString();` line if nothing else in the function uses it.

`proxySummary` (was line 74) — replace:
```js
    ...preventedSavings(db, rules, dayStart, nowIso),
```
with:
```js
    ...preventedSavings(db, rules, dayStart),
```
and delete its unused `nowIso` binding.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @stoke/monitor`
Expected: PASS — the 5 new memo tests plus every pre-existing test (`breakdowns`, `server`, `e2e` all exercise these functions).

- [ ] **Step 5: Verify the real speedup**

```bash
node -e "
const bs=require('better-sqlite3'),p=require('path'),os=require('os');
(async()=>{
const {preventedSavings}=await import('./packages/monitor/src/analytics/breakdowns.js');
const {loadPricing}=await import('./packages/monitor/src/pricing.js');
const db=bs(p.join(os.homedir(),'.stoke','stoke.db'),{readonly:true});
const r=loadPricing(), from=new Date(Date.now()-30*864e5).toISOString();
let t=Date.now(); preventedSavings(db,r,from); const cold=Date.now()-t;
t=Date.now(); for(let i=0;i<50;i++) preventedSavings(db,r,from); const warm=(Date.now()-t)/50;
console.log('cold '+cold+'ms  warm '+warm.toFixed(2)+'ms');
})()"
```
Expected: cold ~180 ms, warm under 1 ms. Record the numbers in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/monitor/src/analytics/breakdowns.js packages/monitor/tests/breakdowns.test.js
git commit -m "perf(monitor): memoize preventedSavings on MAX(proxy_events.id)"
```

---

## Task 5: API routes for the landing screen

**Files:**
- Modify: `packages/monitor/src/server.js:5-6` (imports), `:42-46` (`/api/waste`), add `/api/proxy/savings`
- Test: `packages/monitor/tests/server.test.js` (append)

**Interfaces:**
- Consumes: `rollupFindings` (Task 3), `preventedSavings` (Task 4), existing `runDetectors`, `overview`
- Produces:
  - `GET /api/waste` → unchanged shape (`{findings, attribution}`) when no query params — keeps the Leaks tab and existing tests working
  - `GET /api/waste?days=30&rollup=1` → the rollup object from Task 3
  - `GET /api/proxy/savings?days=30` → `{windowDays, savedUsd, pingSpendUsd, netSavedUsd, rebuildsAvoided}`; `days=all` → all-time

- [ ] **Step 1: Write the failing test**

Append to `packages/monitor/tests/server.test.js`, following that file's existing pattern for building a server against a temp db:

```js
describe("GET /api/waste?rollup=1", () => {
  it("returns a rollup instead of raw findings", async () => {
    const res = await app.inject({ url: "/api/waste?days=30&rollup=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("causes");
    expect(body).toHaveProperty("byProject");
    expect(body).toHaveProperty("avoidableUsd");
    expect(body).toHaveProperty("spendUsd");
    expect(body).not.toHaveProperty("findings");
    expect(Array.isArray(body.causes)).toBe(true);
  });

  it("never emits NaN for the avoidable share", async () => {
    const res = await app.inject({ url: "/api/waste?days=30&rollup=1" });
    expect(Number.isNaN(res.json().avoidablePct)).toBe(false);
  });

  it("keeps the raw shape when rollup is not requested", async () => {
    const res = await app.inject({ url: "/api/waste" });
    const body = res.json();
    expect(body).toHaveProperty("findings");
    expect(body).toHaveProperty("attribution");
  });
});

describe("GET /api/proxy/savings", () => {
  it("returns a windowed savings summary", async () => {
    const res = await app.inject({ url: "/api/proxy/savings?days=30" });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.windowDays).toBe(30);
    for (const k of ["savedUsd", "pingSpendUsd", "netSavedUsd", "rebuildsAvoided"]) {
      expect(typeof b[k]).toBe("number");
    }
  });

  it("supports all-time", async () => {
    const res = await app.inject({ url: "/api/proxy/savings?days=all" });
    expect(res.statusCode).toBe(200);
    expect(res.json().windowDays).toBe(0);
  });

  it("defaults to 30 days for a missing or junk value", async () => {
    expect((await app.inject({ url: "/api/proxy/savings" })).json().windowDays).toBe(30);
    expect((await app.inject({ url: "/api/proxy/savings?days=abc" })).json().windowDays).toBe(30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @stoke/monitor -- server`
Expected: FAIL — `/api/proxy/savings` 404s; `?rollup=1` still returns `findings`.

- [ ] **Step 3: Write the implementation**

In `packages/monitor/src/server.js`, extend the imports on lines 5-6:

```js
import { spendByDay, costByDay, cacheSavedUsd, spendByProject, spendByModel, sessions, sessionDetail, cacheStats, overview, netCost, proxySummary, preventedSavings } from "./analytics/breakdowns.js";
import { runDetectors, ttlAdvisor, savingsAttribution } from "./analytics/detectors.js";
import { rollupFindings } from "./analytics/rollup.js";
```

Replace the `/api/waste` handler (lines 42-45) with:

```js
  // Default shape is unchanged for the Leaks tab, which needs every finding.
  // rollup=1 returns the aggregate the landing screen needs — five causes
  // instead of ~1,100 findings, which is a ~200x smaller payload.
  app.get("/api/waste", (req) => {
    const findings = runDetectors(db, rules).sort((a, b) => b.wastedUsd - a.wastedUsd);
    if (req.query.rollup !== "1") {
      return { findings, attribution: savingsAttribution(db, rules) };
    }
    const days = Number(req.query.days) || 30;
    const now = new Date();
    const from = new Date(now.getTime() - days * 86400e3).toISOString();
    const spendUsd = db.prepare("SELECT SUM(cost_usd) c FROM turns WHERE ts >= ?").get(from).c || 0;
    return rollupFindings(findings, { days, now, spendUsd });
  });
```

Add the savings route immediately after the `/api/proxy` handler (after line 34):

```js
  // Windowed keep-alive savings. preventedSavings already accepts an arbitrary
  // window, so this is a thin route over existing math. days=all -> since install.
  app.get("/api/proxy/savings", (req) => {
    const raw = req.query.days;
    const days = raw === "all" ? 0 : Number(raw) || 30;
    const from = days > 0 ? new Date(Date.now() - days * 86400e3).toISOString() : "1970-01-01T00:00:00.000Z";
    return { windowDays: days, ...preventedSavings(db, rules, from) };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @stoke/monitor`
Expected: PASS, including all pre-existing server tests.

- [ ] **Step 5: Verify the payload actually shrank**

Restart the monitor, then:
```bash
echo "raw:    $(curl -s 'http://127.0.0.1:5599/api/waste' | wc -c) bytes"
echo "rollup: $(curl -s 'http://127.0.0.1:5599/api/waste?days=30&rollup=1' | wc -c) bytes"
curl -s 'http://127.0.0.1:5599/api/proxy/savings?days=all'
```
Expected: rollup under 5,000 bytes (success criterion 4); all-time savings shows a positive `netSavedUsd` and `rebuildsAvoided` in the hundreds.

- [ ] **Step 6: Commit**

```bash
git add packages/monitor/src/server.js packages/monitor/tests/server.test.js
git commit -m "feat(monitor): add waste rollup and windowed proxy savings endpoints"
```

---

## Task 6: The landing screen

Six presentational components plus a page that owns the fetches. Replaces `pages/Overview.jsx`.

**Files:**
- Create: `web/src/home/Answer.jsx`, `StokeWorking.jsx`, `Causes.jsx`, `ByProject.jsx`, `LiveNow.jsx`, `Trend.jsx`, `Explainer.jsx`
- Create: `web/src/pages/Home.jsx`
- Modify: `web/src/styles.css` (append)
- Delete: `web/src/pages/Overview.jsx`

**Interfaces:**
- Consumes: `projectName` (Task 1), `causeFor`/`CAUSES` (Task 2), `/api/waste?days=30&rollup=1` and `/api/proxy/savings` (Task 5), existing `useApi`, `Skeleton`, `money`, `usd`, `mmss`, `sessionCountdown`
- Produces: `<Home proxy={proxy} now={now} lastPollAt={lastPollAt} />` — the default export of `pages/Home.jsx`, rendered by `App.jsx` for route `overview`.

- [ ] **Step 1: Append the CSS**

Add to the end of `web/src/styles.css`:

```css
/* ===== landing screen ===== */
.seclabel{font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:26px 0 10px;display:flex;align-items:baseline;gap:9px}
.seclabel .q{color:var(--accent);font-weight:700}
.answer{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px 26px;box-shadow:var(--shadow)}
.sentence{font-size:25px;line-height:1.42;letter-spacing:-.015em;max-width:40ch}
.sentence b{font-weight:600;font-family:'IBM Plex Mono',monospace;font-size:30px;letter-spacing:-.03em}
.sentence .leak{color:var(--serious)}
.sentence small{display:block;font-size:13px;color:var(--dim);margin-top:12px}
.propbar{margin-top:20px;height:11px;border-radius:6px;overflow:hidden;display:flex;background:var(--surface2);border:1px solid var(--border)}
.propbar i{display:block;height:100%}
.proplegend{display:flex;gap:18px;margin-top:9px;font-size:11.5px;color:var(--dim);flex-wrap:wrap}
.proplegend b{font-weight:600;color:var(--text)}
.sw{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.working{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--good);border-radius:0 var(--radius) var(--radius) 0;padding:15px 18px;margin-top:12px}
.working.off{border-left-color:var(--faint)}
.wtitle{font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:8px}
.wsub{font-size:12.5px;color:var(--dim);margin-top:7px;line-height:1.55}
.wsince{font-size:12px;color:var(--dim);margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}
.cause{display:grid;grid-template-columns:78px 1fr auto;gap:16px;align-items:start;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:15px 17px;margin-bottom:9px;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer}
.cause:hover{border-color:var(--border2)}
.camt{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:19px;letter-spacing:-.02em;text-align:right;color:var(--serious)}
.ccount{font-size:10.5px;color:var(--faint);text-align:right;margin-top:3px;font-family:'IBM Plex Mono',monospace}
.cname{font-weight:600;font-size:14px}
.cwhy{font-size:12.5px;color:var(--dim);margin-top:4px;line-height:1.5;max-width:58ch}
.cfix{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--accent);background:var(--accent-weak);border:1px solid color-mix(in srgb,var(--accent) 25%,transparent);padding:6px 11px;border-radius:8px;white-space:nowrap}
.prow{display:grid;grid-template-columns:170px 1fr 66px;gap:12px;align-items:center;padding:8px 0}
.pname{font-family:'IBM Plex Mono',monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ptrack{height:8px;background:var(--surface2);border-radius:5px;overflow:hidden}
.ptrack i{height:100%;display:block;background:var(--serious)}
.pamt{font-family:'IBM Plex Mono',monospace;font-size:12.5px;text-align:right;font-weight:600}
.morelink{font-size:12px;color:var(--dim);margin-top:11px}
.morelink button{appearance:none;border:0;background:none;font:inherit;color:var(--accent);cursor:pointer;border-bottom:1px dashed color-mix(in srgb,var(--accent) 50%,transparent)}
.explainer{display:flex;align-items:flex-start;gap:12px;background:var(--surface2);border:1px solid var(--border);border-radius:11px;padding:12px 14px;margin-bottom:18px;font-size:13px;color:var(--dim);line-height:1.55}
.explainer button{appearance:none;border:0;background:none;color:var(--faint);cursor:pointer;font-size:16px;line-height:1;padding:0 2px}
.tbars{display:flex;align-items:flex-end;gap:3px;height:96px;margin-top:6px}
.tcol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:1px;min-width:0}
.tcol i{display:block;border-radius:1px}
.tcol .avoid{background:var(--serious)}
.tcol .rest{background:color-mix(in srgb,var(--text) 22%,transparent)}
.tcol .prev{background:var(--good)}
.tx{display:flex;justify-content:space-between;font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--faint);margin-top:6px}
@media(max-width:760px){.cause{grid-template-columns:66px 1fr}.cause .cfix{grid-column:2}.prow{grid-template-columns:120px 1fr 60px}.sentence{font-size:21px}.sentence b{font-size:25px}}
```

- [ ] **Step 2: Write Explainer.jsx**

Create `web/src/home/Explainer.jsx`:

```jsx
import React, { useState } from "react";

const KEY = "stoke.explainer.dismissed";

// One line for someone who has never seen stoke. Dismissed permanently — a
// returning user shouldn't be re-taught every visit.
export default function Explainer() {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  });
  if (hidden) return null;
  const dismiss = () => {
    try { localStorage.setItem(KEY, "1"); } catch { /* private mode — hide for this session only */ }
    setHidden(true);
  };
  return (
    <div className="explainer">
      <div>
        Claude Code re-bills you for context it already cached. stoke stops that, and shows you
        what else is leaking.
      </div>
      <button onClick={dismiss} aria-label="Dismiss explanation">✕</button>
    </div>
  );
}
```

- [ ] **Step 3: Write Answer.jsx**

Create `web/src/home/Answer.jsx`:

```jsx
import React from "react";
import { usd, pct } from "../api.js";

// The whole point of the screen: the user's own spend, then how much of it was
// avoidable. A sentence, not a bare metric — and a bar so the share is visible
// rather than something the reader has to compute.
export default function Answer({ spendUsd, avoidableUsd, avoidablePct, windowDays }) {
  const spend = spendUsd || 0;
  const avoid = avoidableUsd || 0;
  const necessary = Math.max(0, spend - avoid);
  const share = spend > 0 ? Math.min(1, avoid / spend) : 0;

  if (spend <= 0) {
    return (
      <div className="answer">
        <div className="sentence">
          stoke is watching. Nothing billed yet.
          <small>
            As soon as you use Claude Code, this shows what you spent and how much of it was
            avoidable.
          </small>
        </div>
      </div>
    );
  }

  return (
    <div className="answer">
      <div className="sentence">
        You spent <b>{usd(spend)}</b> on Claude&nbsp;Code in the last {windowDays} days.<br />
        <span className="leak"><b className="leak">{usd(avoid)}</b> of it was avoidable.</span>
        <small>
          That's {pct(avoidablePct ?? share)} — billed for work Claude had already done, or output
          you didn't need.
        </small>
      </div>
      <div className="propbar">
        <i style={{ width: `${(1 - share) * 100}%`, background: "color-mix(in srgb, var(--text) 22%, transparent)" }} />
        <i style={{ width: `${share * 100}%`, background: "var(--serious)" }} />
      </div>
      <div className="proplegend">
        <span><span className="sw" style={{ background: "color-mix(in srgb, var(--text) 22%, transparent)" }} />necessary spend <b>{usd(necessary)}</b></span>
        <span><span className="sw" style={{ background: "var(--serious)" }} />avoidable <b>{usd(avoid)}</b></span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write StokeWorking.jsx**

Create `web/src/home/StokeWorking.jsx`:

```jsx
import React from "react";
import { money } from "../api.js";

// stoke's own contribution, stated at its real size. The cumulative line is the
// honest replacement for the old "cache saved all-time" figure, which credited
// stoke with Anthropic's prompt cache.
export default function StokeWorking({ window30, allTime, warmCount, proxyUp }) {
  if (!proxyUp) {
    return (
      <div className="working off">
        <div className="wtitle">Keep-alive is off</div>
        <div className="wsub">
          No pings are firing, so cache rebuilds aren't being prevented right now.
          <strong style={{ color: "var(--text)" }}> Spend tracking still works</strong> — everything
          above and below is accurate. Start it with <code>stoke start</code>.
        </div>
      </div>
    );
  }

  const net = window30?.netSavedUsd ?? 0;
  const rebuilds = window30?.rebuildsAvoided ?? 0;

  return (
    <div className="working">
      <div className="wtitle"><span className="livedot" />stoke clawed back {money(net)} of that</div>
      <div className="wsub">
        It caught <strong style={{ color: "var(--text)" }}>{rebuilds} cache rebuilds</strong> before
        Claude could re-bill you
        {warmCount > 0 && <> — and is keeping {warmCount} session{warmCount === 1 ? "" : "s"} alive right now</>}.
      </div>
      {allTime && allTime.rebuildsAvoided > 0 && (
        <div className="wsince">
          Since stoke started running: <strong style={{ color: "var(--text)" }}>{allTime.rebuildsAvoided}</strong> rebuilds
          avoided · <strong style={{ color: "var(--good)" }}>{money(allTime.netSavedUsd)}</strong> net saved
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Write Causes.jsx**

Create `web/src/home/Causes.jsx`:

```jsx
import React from "react";
import { usd } from "../api.js";
import { causeFor } from "../lib/causes.js";
import { projectName } from "../lib/projectName.js";
import { go } from "../router.js";

// 1,087 individual findings are unreadable and unactionable. Users fix causes,
// so group by cause, sort by cost, and give each one a single next step.
export default function Causes({ causes, ttlSwitchCount }) {
  if (!causes?.length) return null;
  return (
    <>
      {causes.map((c) => {
        const meta = causeFor(c.type);
        // The TTL fix is the one action stoke can quantify a target for.
        const fixLabel =
          c.type === "cache_expiry" && ttlSwitchCount > 0
            ? `Use the longer cache on ${ttlSwitchCount} project${ttlSwitchCount === 1 ? "" : "s"} →`
            : `${meta.fix} →`;
        return (
          <button key={c.type} className="cause" onClick={() => go(meta.route)}>
            <div>
              <div className="camt">{usd(c.usd)}</div>
              <div className="ccount">{c.count}×</div>
            </div>
            <div>
              <div className="cname">{meta.title}</div>
              <div className="cwhy">{meta.why}</div>
              {c.topProject && (
                <div className="ccount" style={{ textAlign: "left", marginTop: 6 }}>
                  worst: {projectName(c.topProject)}
                </div>
              )}
            </div>
            <span className="cfix">{fixLabel}</span>
          </button>
        );
      })}
    </>
  );
}
```

- [ ] **Step 6: Write ByProject.jsx**

Create `web/src/home/ByProject.jsx`:

```jsx
import React from "react";
import { usd } from "../api.js";
import { projectName } from "../lib/projectName.js";
import { go } from "../router.js";

// Which projects leak. Names are normalised — the raw values are mangled cwd
// encodings like "C--Users-me-Desktop-repositories-personal-omnidesk".
export default function ByProject({ byProject, projectCount }) {
  if (!byProject?.length) return null;
  const max = byProject[0].usd || 1;
  const more = Math.max(0, (projectCount || 0) - byProject.length);
  return (
    <div className="card">
      {byProject.map((p) => (
        <div key={p.project} className="prow">
          <div className="pname" title={p.project}>{projectName(p.project)}</div>
          <div className="ptrack"><i style={{ width: `${Math.max(2, (p.usd / max) * 100)}%` }} /></div>
          <div className="pamt">{usd(p.usd)}</div>
        </div>
      ))}
      {more > 0 && (
        <div className="morelink">
          <button onClick={() => go("waste")}>{more} more project{more === 1 ? "" : "s"} →</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Write LiveNow.jsx**

Create `web/src/home/LiveNow.jsx`:

```jsx
import React from "react";
import { mmss } from "../api.js";
import { projectName } from "../lib/projectName.js";
import { sessionCountdown } from "../live.js";
import { go } from "../router.js";
import { Empty } from "../components.jsx";

// Only sessions stoke is actually working on. The dashboard used to render every
// tracked session, of which most are finished and show $0.00 and no countdown.
export default function LiveNow({ sessions, now, lastPollAt }) {
  const all = sessions || [];
  const active = all.filter((s) => s.cacheStatus === "warm" || s.cacheStatus === "paused");
  const inactive = all.length - active.length;

  if (!active.length) {
    return (
      <Empty title="No sessions to keep alive right now">
        Start a Claude Code conversation and stoke will hold its cache open between messages.
      </Empty>
    );
  }

  return (
    <>
      <div className="grid cards2">
        {active.map((s) => {
          const cd = sessionCountdown(s, now, lastPollAt);
          return (
            <div key={s.key} className={`livecard ${s.cacheStatus}`}>
              <div className="fx" style={{ alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <div className="mono" style={{ fontWeight: 600 }}>{projectName(s.projectPath)}</div>
                  <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {s.model?.replace("claude-", "")}
                  </div>
                </div>
              </div>
              <div className="countdown mt14">
                <div className="cdtop">
                  <span className="dim" style={{ fontSize: 12 }}>
                    {s.cacheStatus === "paused" ? "paused" : "keeping cache alive, next check in"}
                  </span>
                  <span className={`cdtime num ${cd.pinging ? "pinging" : ""}`}>
                    {!cd.active ? "—" : cd.pinging ? "just now" : mmss(cd.seconds)}
                  </span>
                </div>
                <div className="cdbar">
                  <div className={`cdfill ${cd.seconds < 30 ? "warnc" : ""}`}
                    style={{ width: (cd.active ? cd.frac * 100 : 0).toFixed(1) + "%" }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {inactive > 0 && (
        <div className="morelink">
          <button onClick={() => go("proxy")}>
            {inactive} finished session{inactive === 1 ? "" : "s"} hidden →
          </button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 8: Write Trend.jsx**

Create `web/src/home/Trend.jsx`:

```jsx
import React from "react";
import { usd } from "../api.js";
import { dayLabel } from "../api.js";
import { go } from "../router.js";

// Daily cost with the avoidable share shaded, so the leak is visible over time
// rather than being a single number. No token-type stack — that's expert detail
// and it lives on the Sessions tab now.
export default function Trend({ days, avoidableByDay = {}, preventedByDay = {} }) {
  const rows = days || [];
  if (!rows.length) return null;
  const totals = rows.map((d) => d.total || 0);
  const max = Math.max(...totals, 0.01);
  const H = 96;

  return (
    <div className="card">
      <div className="tbars">
        {rows.map((d) => {
          const total = d.total || 0;
          const avoid = Math.min(total, avoidableByDay[d.day] || 0);
          const prev = preventedByDay[d.day] || 0;
          const px = (v) => Math.round((v / max) * H);
          return (
            <div
              key={d.day}
              className="tcol"
              title={`${dayLabel(d.day)} · ${usd(total)} spent${avoid ? ` · ${usd(avoid)} avoidable` : ""}${prev ? ` · ${usd(prev)} saved by stoke` : ""}`}
              onClick={() => go(`sessions?day=${d.day}`)}
              style={{ cursor: "pointer" }}
            >
              {prev > 0 && <i className="prev" style={{ height: Math.max(1, px(prev)) }} />}
              {avoid > 0 && <i className="avoid" style={{ height: Math.max(1, px(avoid)) }} />}
              <i className="rest" style={{ height: Math.max(1, px(total - avoid)) }} />
            </div>
          );
        })}
      </div>
      <div className="tx">
        <span>{dayLabel(rows[0].day)}</span>
        <span>{dayLabel(rows[rows.length - 1].day)}</span>
      </div>
      <div className="proplegend" style={{ marginTop: 10 }}>
        <span><span className="sw" style={{ background: "color-mix(in srgb, var(--text) 22%, transparent)" }} />necessary</span>
        <span><span className="sw" style={{ background: "var(--serious)" }} />avoidable</span>
        <span><span className="sw" style={{ background: "var(--good)" }} />saved by stoke</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Write pages/Home.jsx**

Create `web/src/pages/Home.jsx`:

```jsx
import React from "react";
import { useApi, Skeleton } from "../components.jsx";
import Explainer from "../home/Explainer.jsx";
import Answer from "../home/Answer.jsx";
import StokeWorking from "../home/StokeWorking.jsx";
import Causes from "../home/Causes.jsx";
import ByProject from "../home/ByProject.jsx";
import LiveNow from "../home/LiveNow.jsx";
import Trend from "../home/Trend.jsx";

// Five sections that answer, in order: what is this, why should I care, where is
// it happening, what is stoke doing right now, and is it getting better.
// This page owns every fetch; the section components are presentational.
export default function Home({ proxy, now, lastPollAt }) {
  const { data: roll } = useApi("/waste?days=30&rollup=1", { refreshMs: 30000 });
  const { data: save30 } = useApi("/proxy/savings?days=30", { refreshMs: 30000 });
  const { data: saveAll } = useApi("/proxy/savings?days=all", { refreshMs: 60000 });
  const { data: spendDays } = useApi("/spend/daily-cost?days=30", { refreshMs: 60000 });
  const { data: ttl } = useApi("/ttl-advice", { refreshMs: 60000 });

  if (!roll) {
    return (
      <>
        <Head />
        <div className="answer">
          <Skeleton w={220} h={30} />
          <Skeleton w={320} h={30} mt={10} />
          <Skeleton w="100%" h={11} mt={20} />
        </div>
      </>
    );
  }

  const sessions = proxy?.live?.sessions ?? [];
  const warm = sessions.filter((s) => s.cacheStatus === "warm").length;
  const ttlSwitchCount = (ttl || []).filter((t) => t.verdict !== "keep" && t.monthlyDeltaUsd > 0).length;

  return (
    <>
      <Head />
      <Explainer />

      <div className="seclabel"><span className="q">What</span> · this is your Claude Code bill</div>
      <Answer
        spendUsd={roll.spendUsd}
        avoidableUsd={roll.avoidableUsd}
        avoidablePct={roll.avoidablePct}
        windowDays={roll.windowDays}
      />
      <StokeWorking
        window30={save30}
        allTime={saveAll}
        warmCount={warm}
        proxyUp={proxy ? proxy.up : true}
      />

      {roll.causes.length > 0 && (
        <>
          <div className="seclabel"><span className="q">Why</span> · where it leaked, biggest first</div>
          <Causes causes={roll.causes} ttlSwitchCount={ttlSwitchCount} />
        </>
      )}

      {roll.byProject.length > 0 && (
        <>
          <div className="seclabel"><span className="q">Where</span> · which projects leaked the most</div>
          <ByProject byProject={roll.byProject} projectCount={roll.projectCount} />
        </>
      )}

      <div className="seclabel"><span className="q">When</span> · stoke is acting right now</div>
      <LiveNow sessions={sessions} now={now} lastPollAt={lastPollAt} />

      <div className="seclabel"><span className="q">Trend</span> · daily cost over 30 days</div>
      <Trend days={spendDays} />
    </>
  );
}

function Head() {
  return (
    <div className="hr">
      <div>
        <div className="pagetitle">Home</div>
        <div className="pagesub">What you spent, what was avoidable, and what stoke did about it.</div>
      </div>
    </div>
  );
}
```

Note: `Trend` receives no per-day series yet — the rollup is a 30-day aggregate. Render
cost-only now; `avoidableByDay` arrives in Task 7 Step 4 and `preventedByDay` in Task 8.

- [ ] **Step 10: Wire it into App.jsx and delete Overview**

In `web/src/App.jsx`, change the import on line 7 from `Overview` to `Home`:

```jsx
import Home from "./pages/Home.jsx";
```

Change the tab list (lines 12-17) to:

```jsx
const TABS = [
  ["overview", "Home"],
  ["waste", "Leaks"],
  ["sessions", "Sessions"],
  ["proxy", "Keep-alive"],
];
```

Change the route render (line 97) to pass the liveness props:

```jsx
        {route.tab === "overview" && <Home proxy={proxy} now={now} lastPollAt={lastPollAt} />}
```

Update the brand subtitle (line 54) from `cache keep-alive` to:

```jsx
          stoke<span className="brandsub">keeps your Claude Code bill down</span>
```

Then remove the old page:

```bash
git rm packages/monitor/web/src/pages/Overview.jsx
```

- [ ] **Step 11: Build and verify in a browser**

```bash
npm --prefix packages/monitor/web run test
npm --prefix packages/monitor/web run build
```
Expected: all web tests pass; build succeeds.

Reload `http://127.0.0.1:5599/#overview` and confirm:
- headline reads as a sentence with a proportion bar
- five cause cards with plain titles
- project names read `personal/omnidesk`, not `C--Users-…`
- only warm/paused sessions listed, with `N finished sessions hidden`
- no `$-0.47`, no `$32,080`, no `$/MTok` anywhere
- check both themes and 900 px width

- [ ] **Step 12: Commit**

```bash
git add packages/monitor/web/src/home packages/monitor/web/src/pages/Home.jsx packages/monitor/web/src/App.jsx packages/monitor/web/src/styles.css
git commit -m "feat(monitor): plain-language landing screen replacing the Overview KPI grid"
```

---

## Task 7: Level-2 tabs and the per-day trend series

**Files:**
- Modify: `web/src/pages/Proxy.jsx`, `web/src/pages/Waste.jsx`, `web/src/pages/Sessions.jsx:5,28`, `web/src/api.js:104-113`
- Modify: `packages/monitor/src/analytics/rollup.js` (add `byDay`), `packages/monitor/tests/rollup.test.js`
- Modify: `web/src/pages/Home.jsx` (pass the new series)

**Interfaces:**
- Consumes: `rollupFindings` (Task 3), `projectName` (Task 1)
- Produces: `rollupFindings(...).byDay: Record<string, number>` — `YYYY-MM-DD` → avoidable USD that day.

- [ ] **Step 1: Add byDay to the rollup — failing test first**

Append to `packages/monitor/tests/rollup.test.js`:

```js
  it("buckets avoidable dollars by day for the trend chart", () => {
    const r = rollupFindings(
      [F("cache_expiry", "a", 4, 1), F("cache_expiry", "a", 6, 1), F("session_bloat", "b", 2, 3)],
      { days: 30, now: NOW, spendUsd: 100 },
    );
    const d1 = daysAgo(1).slice(0, 10);
    const d3 = daysAgo(3).slice(0, 10);
    expect(r.byDay[d1]).toBe(10);
    expect(r.byDay[d3]).toBe(2);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @stoke/monitor -- rollup`
Expected: FAIL — `Cannot read properties of undefined (reading '2026-07-28')`

- [ ] **Step 3: Implement byDay**

In `packages/monitor/src/analytics/rollup.js`, add alongside the other accumulators:

```js
  const byDay = new Map(); // YYYY-MM-DD -> usd
```

Inside the `for (const f of inWindow)` loop, after the `byProject` line:

```js
    const day = String(f.ts).slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + usd);
```

And in the returned object, after `projectCount`:

```js
    byDay: Object.fromEntries(byDay),
```

- [ ] **Step 4: Run to verify it passes, then feed the chart**

Run: `npm test -w @stoke/monitor -- rollup`
Expected: PASS, 9 tests.

In `web/src/pages/Home.jsx`, change the `Trend` render to:

```jsx
      <Trend days={spendDays} avoidableByDay={roll.byDay} />
```

- [ ] **Step 5: Trim the Keep-alive tab**

In `web/src/pages/Proxy.jsx`:

Replace the local `shortPath` helper (line 7) with the shared name formatter — delete the
`const shortPath = ...` line and add to the imports:

```jsx
import { projectName } from "../lib/projectName.js";
```

Then replace every `shortPath(` call with `projectName(` (two sites: the live-session card and
the event ticker).

Add a state hook at the top of the `Proxy` component, after the existing `useApi` calls:

```jsx
  const [showInactive, setShowInactive] = React.useState(false);
```

Replace the live-sessions block so dead cards are collapsed. Change:

```jsx
                {(live.sessions || []).map((s) => {
```
to:
```jsx
                {(live.sessions || [])
                  .filter((s) => showInactive || s.cacheStatus === "warm" || s.cacheStatus === "paused")
                  .map((s) => {
```

And immediately after that list's closing `)}`, before the empty-state check, add:

```jsx
                {(() => {
                  const dead = (live.sessions || []).filter(
                    (s) => s.cacheStatus !== "warm" && s.cacheStatus !== "paused",
                  ).length;
                  if (!dead) return null;
                  return (
                    <div className="morelink">
                      <button onClick={() => setShowInactive((v) => !v)}>
                        {showInactive ? "Hide" : "Show"} {dead} finished session{dead === 1 ? "" : "s"}
                      </button>
                    </div>
                  );
                })()}
```

For the TTL list, replace the `(ttl || []).map(...)` block with a split that hides no-change rows:

```jsx
                {(() => {
                  const rows = ttl || [];
                  const actionable = rows.filter((a) => a.verdict !== "keep" && a.monthlyDeltaUsd > 0);
                  const rest = rows.length - actionable.length;
                  return (
                    <>
                      {actionable.map((a, i) => (
                        <div key={i} className="attr" style={{ padding: "12px 16px", gridTemplateColumns: "1fr auto" }}>
                          <div>
                            <div className="mono" style={{ fontWeight: 600 }}>{projectName(a.project)}</div>
                            <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{a.reasoning}</div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <Badge cls="b-good">{verdictLabel(a.verdict)}</Badge>
                            <div className="num" style={{ fontSize: 12, marginTop: 5, color: "var(--dim)" }}>
                              save {money(a.monthlyDeltaUsd)}/mo
                            </div>
                          </div>
                        </div>
                      ))}
                      {!actionable.length && (
                        <div style={{ padding: 16, color: "var(--dim)", fontSize: 12.5 }}>
                          Every project is already on the right cache setting.
                        </div>
                      )}
                      {rest > 0 && (
                        <div className="morelink" style={{ padding: "10px 16px" }}>
                          {rest} project{rest === 1 ? "" : "s"} need no change
                        </div>
                      )}
                    </>
                  );
                })()}
```

Also change the page title/sub (`Head()` at the bottom) to:

```jsx
        <div className="pagetitle">Keep-alive</div>
        <div className="pagesub">How stoke holds your cache open between messages</div>
```

- [ ] **Step 6: Group the Leaks tab and default to 30 days**

In `web/src/pages/Waste.jsx`:

Add imports:
```jsx
import { projectName } from "../lib/projectName.js";
import { causeFor } from "../lib/causes.js";
```

Change the page head to:
```jsx
          <div className="pagetitle">Leaks</div>
          <div className="pagesub">Every avoidable charge stoke found, grouped by cause.</div>
```

In `Findings()`, add a window filter defaulting to 30 days. After the existing `useState` calls:

```jsx
  const [days, setDays] = useState(30);
```

Immediately after `const findings = waste.findings || [];`, replace it with a windowed list:

```jsx
  const all = waste.findings || [];
  const cutoff = Date.now() - days * 86400e3;
  const findings = days === 0 ? all : all.filter((f) => Date.parse(f.ts) >= cutoff);
```

Add a range selector into the existing `.filterbar`, before the type chips:

```jsx
        {[[30, "30 days"], [7, "7 days"], [0, "All time"]].map(([v, l]) => (
          <button key={v} className={`chipbtn ${days === v ? "on" : ""}`} onClick={() => setDays(v)}>{l}</button>
        ))}
```

Replace the three summary cards' first card label so the window is explicit:

```jsx
        <div className="card"><div className="klabel">Avoidable {days === 0 ? "all time" : `· last ${days} days`}</div>
```

Change the type chip labels to use the plain-language titles, so the tab agrees with the
landing screen. Replace `typeLabel(c)` in the chip map with:

```jsx
            {c === "all" ? "All causes" : causeFor(c).title}
```

And in the table body, replace the project cell to use readable names:

```jsx
                    <td className="mono" style={{ fontSize: 12 }}>{projectName(f.project)}</td>
```

- [ ] **Step 7: Point Sessions at the shared name formatter and delete projectLabeler**

In `web/src/pages/Sessions.jsx`:

- Change the import on line 5 to drop `projectLabeler`:
  ```jsx
  import { money, dateShort, dayLabel } from "../api.js";
  import { projectName } from "../lib/projectName.js";
  ```
- Delete the `const label = useMemo(...)` line (line 28).
- Replace both `label(p)` / `label(r.project)` call sites with `projectName(p)` and
  `projectName(r.project)`.
- Remove `useMemo` from the React import if it's now unused.

In `web/src/api.js`, delete the `projectLabeler` function (lines 102-113) and its comment —
nothing imports it now.

Verify nothing still references the removed symbols:

```bash
grep -rn "projectLabeler\|shortPath" packages/monitor/web/src/
```
Expected: no output.

- [ ] **Step 8: Run the full suite**

```bash
npm test -w @stoke/monitor
npm --prefix packages/monitor/web run test
npm --prefix packages/monitor/web run build
```
Expected: all green, build succeeds.

- [ ] **Step 9: Verify every success criterion**

```bash
# criterion 4 — landing payload under 5 KB
curl -s 'http://127.0.0.1:5599/api/waste?days=30&rollup=1' | wc -c
# criterion 5 — warm /api/proxy under 20ms
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "%{time_total}s\n" http://127.0.0.1:5599/api/proxy; done
# criterion 6 — no jargon in landing-screen source
grep -rniE "MTok|cache write|cache read|fresh input|attribution|\blever\b" \
  packages/monitor/web/src/home packages/monitor/web/src/pages/Home.jsx
```
Expected: under 5,000 bytes; times under 0.02 s after the first; no jargon matches.

Browser pass at 1440 px and 900 px, light and dark:
- all four tabs render without console errors
- Keep-alive shows only active sessions until "Show N finished" is clicked
- Leaks defaults to 30 days and groups by plain-language cause
- Sessions shows readable project names

- [ ] **Step 10: Commit**

```bash
git add packages/monitor/src/analytics/rollup.js packages/monitor/tests/rollup.test.js \
  packages/monitor/web/src/pages packages/monitor/web/src/api.js
git commit -m "feat(monitor): trim Keep-alive and Leaks tabs, unify project names, shade trend"
```

---

## Task 8: Per-day prevented savings for the trend

The spec's trend section requires a series for **what stoke prevented each day**, so its value
visibly accrues rather than being one number. `computeSavingsMulti(events, config, windows)`
already computes many windows in a single pass over the event log, so 30 day-buckets cost the
same one scan as today's single figure — no per-day loop, no 30× cost.

**Files:**
- Modify: `packages/monitor/src/analytics/breakdowns.js` (add `preventedByDay`)
- Modify: `packages/monitor/src/server.js` (extend `/api/proxy/savings`)
- Modify: `packages/monitor/web/src/pages/Home.jsx` (pass the series)
- Test: `packages/monitor/tests/breakdowns.test.js` (append)

**Interfaces:**
- Consumes: `computeSavingsMulti` from `@stoke/shared/savings.mjs`, signature
  `(events, config, windows: Array<{fromMs, toMs}>) => SavingsResult[]`
- Produces: `preventedByDay(db, rules, days = 30) => Record<'YYYY-MM-DD', number>` — net USD
  saved per UTC day. `/api/proxy/savings?days=30&byDay=1` adds `byDay` to its response.

- [ ] **Step 1: Write the failing test**

Append to `packages/monitor/tests/breakdowns.test.js`:

```js
import { preventedByDay } from "../src/analytics/breakdowns.js";

describe("preventedByDay", () => {
  // A real_request whose gap from its predecessor exceeds the TTL is a prevented
  // rebuild; cache_read tokens are what would have been re-billed.
  const req = (ts, cacheRead) => ({
    kind: "real_request", ts, sessionKey: "s1",
    model: "claude-sonnet-4-5", usage: { cache_read_input_tokens: cacheRead },
  });

  function makeDb(events) {
    return {
      prepare(sql) {
        if (/MAX\(id\)/.test(sql)) return { get: () => ({ m: events.length }) };
        return { all: () => events.map((e) => ({ raw: JSON.stringify(e) })), get: () => ({ c: 0 }) };
      },
    };
  }

  it("returns a bucket keyed by UTC day", () => {
    const db = makeDb([
      req("2026-07-20T10:00:00.000Z", 0),
      req("2026-07-20T11:00:00.000Z", 500000), // 1h gap > 300s TTL -> prevented
    ]);
    const out = preventedByDay(db, null, 30, new Date("2026-07-21T00:00:00.000Z"));
    expect(Object.keys(out)).toContain("2026-07-20");
    expect(out["2026-07-20"]).toBeGreaterThan(0);
  });

  it("covers every day in the window, zero-filled", () => {
    const db = makeDb([]);
    const out = preventedByDay(db, null, 7, new Date("2026-07-21T00:00:00.000Z"));
    expect(Object.keys(out)).toHaveLength(7);
    for (const v of Object.values(out)) expect(v).toBe(0);
  });

  it("never returns NaN", () => {
    const db = makeDb([req("2026-07-20T10:00:00.000Z", 0)]);
    const out = preventedByDay(db, null, 3, new Date("2026-07-21T00:00:00.000Z"));
    for (const v of Object.values(out)) expect(Number.isNaN(v)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @stoke/monitor -- breakdowns`
Expected: FAIL — `preventedByDay is not a function`

- [ ] **Step 3: Implement preventedByDay**

In `packages/monitor/src/analytics/breakdowns.js`, extend the shared-module import on line 2:

```js
import { computeSavings, computeSavingsMulti } from "@stoke/shared/savings.mjs";
```

Then add after `preventedSavings`:

```js
/**
 * Net USD the keep-alive prevented, bucketed by UTC day, zero-filled across the
 * whole window so the chart has no gaps.
 *
 * One pass over the event log for all N days — computeSavingsMulti shares the
 * predecessor map across windows, so this costs the same as a single window.
 */
export function preventedByDay(db, rules, days = 30, now = new Date()) {
  const rows = db.prepare("SELECT raw FROM proxy_events ORDER BY ts").all();
  const events = [];
  for (const r of rows) {
    try { events.push(JSON.parse(r.raw)); } catch { /* skip torn rows */ }
  }
  const cfg = {
    cacheTtlSeconds: 300,
    pricing: { cacheReadMultiplier: 0.1, rebuildMultiplier: 1.25, rebuildMultiplier1h: 2.0 },
    modelPricing: defaultModelPricingMap(rules ?? loadPricing(), new Date().toISOString()),
  };

  // Build one UTC-day window per day, oldest first, matching how costByDay
  // buckets spend (substr(ts,1,10)) so the two series line up on the chart.
  const dayKeys = [];
  const windows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400e3);
    const key = d.toISOString().slice(0, 10);
    dayKeys.push(key);
    windows.push({
      fromMs: Date.parse(key + "T00:00:00.000Z"),
      toMs: Date.parse(key + "T23:59:59.999Z"),
    });
  }

  const results = computeSavingsMulti(events, cfg, windows);
  const out = {};
  for (let i = 0; i < dayKeys.length; i++) {
    const v = results[i]?.netSavedUsd;
    // Clamp: a day with pings but no prevented rebuild nets negative, which
    // would render as an inverted bar. Zero is the honest floor for a chart.
    out[dayKeys[i]] = Number.isFinite(v) ? Math.max(0, v) : 0;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @stoke/monitor -- breakdowns`
Expected: PASS — 3 new tests plus the 5 memo tests from Task 4.

- [ ] **Step 5: Expose it on the savings route**

In `packages/monitor/src/server.js`, extend the breakdowns import to include `preventedByDay`,
then replace the `/api/proxy/savings` handler added in Task 5 with:

```js
  app.get("/api/proxy/savings", (req) => {
    const raw = req.query.days;
    const days = raw === "all" ? 0 : Number(raw) || 30;
    const from = days > 0 ? new Date(Date.now() - days * 86400e3).toISOString() : "1970-01-01T00:00:00.000Z";
    const out = { windowDays: days, ...preventedSavings(db, rules, from) };
    if (req.query.byDay === "1" && days > 0) out.byDay = preventedByDay(db, rules, days);
    return out;
  });
```

Append to `packages/monitor/tests/server.test.js`:

```js
  it("returns a per-day series when asked", async () => {
    const res = await app.inject({ url: "/api/proxy/savings?days=7&byDay=1" });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(Object.keys(b.byDay)).toHaveLength(7);
  });

  it("omits the per-day series by default", async () => {
    const res = await app.inject({ url: "/api/proxy/savings?days=7" });
    expect(res.json().byDay).toBeUndefined();
  });
```

- [ ] **Step 6: Feed the chart**

In `packages/monitor/web/src/pages/Home.jsx`, change the 30-day savings fetch to request the
series:

```jsx
  const { data: save30 } = useApi("/proxy/savings?days=30&byDay=1", { refreshMs: 30000 });
```

and change the `Trend` render to:

```jsx
      <Trend days={spendDays} avoidableByDay={roll.byDay} preventedByDay={save30?.byDay} />
```

`Trend` already defaults `preventedByDay` to `{}`, so a slow or failed savings fetch degrades to
a cost-and-leak chart rather than crashing.

- [ ] **Step 7: Verify all three series render**

```bash
npm test -w @stoke/monitor
npm --prefix packages/monitor/web run test
npm --prefix packages/monitor/web run build
curl -s 'http://127.0.0.1:5599/api/proxy/savings?days=30&byDay=1' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const nz=Object.entries(j.byDay).filter(([,v])=>v>0);console.log('days:',Object.keys(j.byDay).length,'| non-zero:',nz.length);console.log(nz.slice(-5));})"
```
Expected: 30 day keys, several non-zero. In the browser, the trend shows three stacked bands
(green prevented, orange avoidable, grey necessary) and the tooltip names all three.

- [ ] **Step 8: Commit**

```bash
git add packages/monitor/src/analytics/breakdowns.js packages/monitor/src/server.js \
  packages/monitor/tests/breakdowns.test.js packages/monitor/tests/server.test.js \
  packages/monitor/web/src/pages/Home.jsx
git commit -m "feat(monitor): per-day prevented-savings series on the trend chart"
```

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|---|---|
| D1 progressive disclosure | 6 (landing), 7 (tabs) |
| D2 headline spend → avoidable → clawed back | 6 Steps 3-4 |
| D3 what/why/where/when sections | 6 Step 9 |
| D4 cut $32,080 / $/MTok / negative net | 6 Step 10 (Overview deleted) |
| D5 cumulative counter | 5 (`days=all`), 6 Step 4 |
| D6 roll 1,087 into 5 causes | 3, 5, 6 Step 5 |
| D7 plain-language names | 2 |
| D8 hide abandoned + no-change TTL | 7 Step 5 |
| D9 drop token-type stack | 6 Step 8 |
| Trend: per-day prevented series | 8 |
| D10 no before/after | n/a — rejected in spec |
| D11 memoize | 4 |
| C1 waste rollup endpoint | 5 |
| C2 windowed savings endpoint | 5 |
| C3 memoization | 4 |
| Empty: install day | 6 Step 3 (`spend <= 0` branch) |
| Empty: no findings | 6 Step 9 (conditional sections) |
| Empty: proxy down | 6 Step 4 (`proxyUp` false branch) |
| Empty: unknown finding type | 2 (`causeFor` fallback) |
| Test: rollup | 3, 7 Step 1 |
| Test: projectName | 1 |
| Test: causes coverage | 2 |
| Test: zero-spend guard | 3 |
| Success criteria 1-6 | 7 Step 9 |

No gaps.

**Placeholder scan:** No TBD/TODO. Every code step carries runnable code. Task 1 Step 4
deliberately shows a first implementation failing a case and the corrected version — that is a
worked correction, not a placeholder.

**Type consistency:**
- `projectName(raw)` — Tasks 1, 6, 7 all call it with one string argument. ✓
- `causeFor(type)` returns `{title, why, fix, route}` — used identically in Tasks 2, 6, 7. ✓
- `rollupFindings(findings, opts)` returns `{windowDays, spendUsd, avoidableUsd, avoidablePct, findingCount, causes, byProject, projectCount, byDay}` — `byDay` added in Task 7 and consumed there; Task 6 does not read it. ✓
- `preventedSavings(db, rules, fromTs, toTs = null)` — Task 4 defines, Task 5 calls with three args. ✓
- `/api/proxy/savings` returns `{windowDays, savedUsd, pingSpendUsd, netSavedUsd, rebuildsAvoided}` — `StokeWorking` reads `netSavedUsd` and `rebuildsAvoided`. ✓
- `Trend` props `{days, avoidableByDay, preventedByDay}` — Task 6 passes `days`, Task 7 adds `avoidableByDay`, Task 8 adds `preventedByDay`. All three populated by the end. ✓
- `preventedByDay(db, rules, days)` returns `Record<'YYYY-MM-DD', number>` — Task 8 defines, Task 8 Step 6 consumes. ✓

**Gap found and closed during review:** the first draft left `preventedByDay` permanently
unpopulated, silently dropping the spec's "second series for what stoke prevented each day".
Task 8 implements it. Without that task the trend would show only cost and leak, and stoke's
accruing value — the point of the section — would be invisible.
