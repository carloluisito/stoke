import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import { spendByDay, costByDay, cacheSavedUsd, spendByProject, spendByModel, sessions, sessionDetail, cacheStats, overview } from "../src/analytics/breakdowns.js";
import { loadPricing } from "../src/pricing.js";

let db;
const seed = [
  ["m1","s1","projA","2026-07-10T09:00:00Z","claude-opus-4-8",1000,500,4000,0,0,0.05],
  ["m2","s1","projA","2026-07-10T09:05:00Z","claude-opus-4-8",100,300,0,0,4000,0.02],
  ["m3","s2","projB","2026-07-11T09:00:00Z","claude-haiku-4-5",2000,100,0,1000,0,0.01],
  ["m4","s2","projB","2026-07-11T09:10:00Z","claude-haiku-4-5",50,80,0,0,1000,0.005],
];
beforeEach(() => {
  db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  seed.forEach(r => ins.run(...r));
});

describe("breakdowns", () => {
  it("spendByDay groups and sums", () => {
    const days = spendByDay(db, { days: 365 });
    expect(days.length).toBe(2);
    expect(days.find(d => d.day === "2026-07-10").cost).toBeCloseTo(0.07, 6);
  });
  it("spendByProject / spendByModel", () => {
    expect(spendByProject(db).find(p => p.project === "projB").cost).toBeCloseTo(0.015, 6);
    expect(spendByModel(db).find(m => m.model === "claude-opus-4-8").cost).toBeCloseTo(0.07, 6);
  });
  it("sessions list + detail ordered", () => {
    const s = sessions(db, {});
    expect(s.length).toBe(2);
    expect(sessionDetail(db, "s1").length).toBe(2);
  });
  it("sessions carry ended + ttlMs for live status", () => {
    const s2 = sessions(db, {}).find(x => x.session_id === "s2"); // wrote 1h cache tokens
    expect(s2.ended).toBe("2026-07-11T09:10:00Z");
    expect(s2.ttlMs).toBe(3600000);
    const s1 = sessions(db, {}).find(x => x.session_id === "s1"); // 5m-only session
    expect(s1.ttlMs).toBe(300000);
  });
  it("cacheStats hitRate = read/(read+fresh)", () => {
    const c = cacheStats(db);
    expect(c.totalRead).toBe(5000);
    expect(c.hitRate).toBeCloseTo(5000 / (5000 + 3150), 4);
  });
  it("overview returns totals", () => {
    const o = overview(db, new Date("2026-07-11T12:00:00Z"));
    expect(o.month).toBeCloseTo(0.085, 6);
    expect(o.today).toBeCloseTo(0.015, 6);
  });
  it("costByDay converts token components to dollars per day", () => {
    const days = costByDay(db, loadPricing(), { days: 365 });
    const d10 = days.find(d => d.day === "2026-07-10"); // opus: 1100 in, 800 out, 4000 w5, 4000 read
    expect(d10.input).toBeCloseTo(1100 / 1e6 * 5, 8);
    expect(d10.output).toBeCloseTo(800 / 1e6 * 25, 8);
    expect(d10.cacheWrite).toBeCloseTo(4000 / 1e6 * 6.25, 8);
    expect(d10.cacheRead).toBeCloseTo(4000 / 1e6 * 0.5, 8);
    expect(d10.total).toBeCloseTo(d10.input + d10.output + d10.cacheWrite + d10.cacheRead, 10);
  });
  it("cacheSavedUsd = reads x (input price - read price)", () => {
    // opus 4000 reads x (5-0.5)/M + haiku 1000 reads x (1-0.1)/M
    const saved = cacheSavedUsd(db, loadPricing(), new Date("2026-07-11T12:00:00Z"));
    expect(saved).toBeCloseTo(4000 / 1e6 * 4.5 + 1000 / 1e6 * 0.9, 8);
  });
});

// ── preventedSavings memoization ──────────────────────────────────────────────
// /api/proxy measured 313ms and App.jsx polls it every 5s, because every call
// re-read and JSON.parse'd all 47k+ proxy_events rows. These tests pin the memo
// behaviour: one scan per (window, event-log state).

import { preventedSavings, __resetSavingsMemo } from "../src/analytics/breakdowns.js";

describe("preventedSavings memoization", () => {
  // Minimal fake db exposing only what the function reads, plus a scan counter.
  function makeDb(events) {
    let nextId = 1;
    const rows = events.map((e) => ({ id: nextId++, raw: JSON.stringify(e) }));
    let scans = 0;
    return {
      scans: () => scans,
      push(e) { rows.push({ id: nextId++, raw: JSON.stringify(e) }); },
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

  // The subtlety that makes or breaks the memo: callers used to pass a fresh
  // now.toISOString() as toTs, so a key including it would never hit.
  it("treats an omitted toTs as open-ended and stable across calls", () => {
    const db = makeDb([ev("2026-07-01T00:00:00.000Z")]);
    preventedSavings(db, null, "2026-07-01", null);
    preventedSavings(db, null, "2026-07-01");
    expect(db.scans()).toBe(1);
  });

  it("still honours an explicit toTs bound", () => {
    const db = makeDb([ev("2026-07-01T00:00:00.000Z")]);
    const open = preventedSavings(db, null, "2026-07-01");
    const bounded = preventedSavings(db, null, "2026-07-01", "2026-07-01T00:00:00.000Z");
    expect(db.scans()).toBe(2);
    expect(bounded).not.toBe(open); // distinct cache entries
  });

  it("handles an empty event log without scanning twice", () => {
    const db = makeDb([]);
    const a = preventedSavings(db, null, "2026-07-01");
    preventedSavings(db, null, "2026-07-01");
    expect(a.savedUsd).toBe(0);
    expect(db.scans()).toBe(1);
  });
});

// ── preventedByDay ────────────────────────────────────────────────────────────
// Feeds the trend chart's third band, so stoke's value visibly accrues instead
// of being a single number.

import { preventedByDay } from "../src/analytics/breakdowns.js";

describe("preventedByDay", () => {
  // A real_request whose gap from its predecessor exceeds the TTL is a prevented
  // rebuild; cache_read tokens are what would otherwise have been re-billed.
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

  it("orders days oldest-first", () => {
    const db = makeDb([]);
    const keys = Object.keys(preventedByDay(db, null, 3, new Date("2026-07-21T00:00:00.000Z")));
    expect(keys).toEqual(["2026-07-19", "2026-07-20", "2026-07-21"]);
  });

  it("never returns NaN or a negative bar", () => {
    const db = makeDb([
      { kind: "ping_fired", ts: "2026-07-20T10:00:00.000Z", sessionKey: "s1", costUsd: 5 },
    ]);
    const out = preventedByDay(db, null, 3, new Date("2026-07-21T00:00:00.000Z"));
    for (const v of Object.values(out)) {
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
