import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSavings,
  computeSavingsMulti,
  computeCacheHitRate,
  compute5hSparkline,
  CACHE_TTL_MS,
  REBUILD_MULTIPLIER,
} from "../src/savings.ts";
import { defaultConfig } from "../src/config.ts";
import type { EventRecord } from "../src/types.ts";

// Test helper: build a `real_request` EventRecord at a given ms timestamp.
function mkReal(
  tsMs: number,
  sessionKey: string,
  cacheRead: number,
  model: string = "claude-opus-4-7",
): Extract<EventRecord, { kind: "real_request" }> {
  return {
    ts: new Date(tsMs).toISOString(),
    kind: "real_request",
    sessionKey,
    model,
    usage: {
      input_tokens: 5,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheRead,
    },
    ratelimits: {
      unified5hUtilization: null,
      unified7dUtilization: null,
      unified5hResetEpoch: null,
      overageStatus: null,
    },
  };
}

// Test helper: build a `ping_fired` EventRecord with a fixed costUsd.
function mkPing(
  tsMs: number,
  sessionKey: string,
  costUsd: number,
  model: string = "claude-opus-4-7",
): EventRecord {
  return {
    ts: new Date(tsMs).toISOString(),
    kind: "ping_fired",
    sessionKey,
    model,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1,
    },
    ratelimits: {
      unified5hUtilization: null,
      unified7dUtilization: null,
      unified5hResetEpoch: null,
      overageStatus: null,
    },
    costUsd,
  };
}

test("computeSavings: empty events returns zero", () => {
  const cfg = defaultConfig();
  const r = computeSavings([], cfg, 0, 999_999_999);
  assert.equal(r.savedUsd, 0);
  assert.equal(r.rebuildsAvoided, 0);
  assert.equal(r.perSession.size, 0);
});

test("CACHE_TTL_MS and REBUILD_MULTIPLIER constants are correct", () => {
  assert.equal(CACHE_TTL_MS, 5 * 60 * 1000);
  assert.equal(REBUILD_MULTIPLIER, 1.25);
});

test("computeSavings: short gaps (< CACHE_TTL) yield no savings", () => {
  const cfg = defaultConfig();
  // Three events in one session, gaps of 60s and 120s — both below 5min TTL.
  const events: EventRecord[] = [
    mkReal(0, "s1", 100_000),
    mkReal(60_000, "s1", 100_000),
    mkReal(180_000, "s1", 100_000),
  ];
  const r = computeSavings(events, cfg, -1, 999_999_999);
  assert.equal(r.savedUsd, 0);
  assert.equal(r.rebuildsAvoided, 0);
});

test("computeSavings: > TTL gap with cache hit counts as a saved rebuild", () => {
  const cfg = defaultConfig();
  // First event has no predecessor (does NOT contribute). Second event is
  // 6 min later with cache_read > 0 → saved rebuild.
  const events: EventRecord[] = [
    mkReal(0, "s1", 200_000),
    mkReal(6 * 60_000, "s1", 200_000),
  ];
  const r = computeSavings(events, cfg, -1, 999_999_999);
  // opus-4-7 inputPerMtok = 5, REBUILD_MULTIPLIER = 1.25
  // expected = 200000 × 5 × 1.25 / 1e6 = 1.25
  assert.equal(r.savedUsd, 1.25);
  assert.equal(r.rebuildsAvoided, 1);
  assert.equal(r.perSession.get("s1"), 1.25);
});

test("computeSavings: > TTL gap WITHOUT cache hit yields no savings", () => {
  const cfg = defaultConfig();
  // 6 min gap but cache_read = 0 → proxy failed this turn, no savings.
  const events: EventRecord[] = [
    mkReal(0, "s1", 200_000),
    mkReal(6 * 60_000, "s1", 0),
  ];
  const r = computeSavings(events, cfg, -1, 999_999_999);
  assert.equal(r.savedUsd, 0);
  assert.equal(r.rebuildsAvoided, 0);
});

test("computeSavings: per-session attribution is correct across two sessions", () => {
  const cfg = defaultConfig();
  const events: EventRecord[] = [
    mkReal(0, "s1", 100_000),
    mkReal(0, "s2", 50_000),
    mkReal(6 * 60_000, "s1", 100_000), // s1 saves a rebuild
    mkReal(7 * 60_000, "s2", 50_000),  // s2 saves a rebuild
  ];
  const r = computeSavings(events, cfg, -1, 999_999_999);
  const s1Expected = (100_000 * 5 * 1.25) / 1e6; // 0.625
  const s2Expected = (50_000 * 5 * 1.25) / 1e6;  // 0.3125
  assert.equal(r.perSession.get("s1"), s1Expected);
  assert.equal(r.perSession.get("s2"), s2Expected);
  assert.equal(r.savedUsd, s1Expected + s2Expected);
  assert.equal(r.rebuildsAvoided, 2);
});

test("computeSavings: predecessor lookup spans the full event log, not just the window", () => {
  // The first event is before windowFrom; the second is inside the window.
  // Without the spec's "full event log" lookup the second one would be
  // treated as having no predecessor and contribute $0.
  const cfg = defaultConfig();
  const events: EventRecord[] = [
    mkReal(0, "s1", 100_000),              // before window
    mkReal(6 * 60_000, "s1", 100_000),     // inside window, 6min gap
  ];
  const r = computeSavings(events, cfg, 60_000, 999_999_999);
  // Expected = 100000 × 5 × 1.25 / 1e6 = 0.625
  assert.equal(r.savedUsd, 0.625);
  assert.equal(r.rebuildsAvoided, 1);
});

test("computeCacheHitRate: empty events returns null hitRate", () => {
  const r = computeCacheHitRate([], 0, 999_999_999);
  assert.equal(r.hitRate, null);
  assert.equal(r.realRequests, 0);
  assert.equal(r.cacheHits, 0);
});

test("computeCacheHitRate: counts only real_request events in window", () => {
  const events: EventRecord[] = [
    mkReal(0, "s1", 100_000),    // hit
    mkReal(60_000, "s1", 0),     // miss
    mkReal(120_000, "s1", 50_000), // hit
    mkReal(180_000, "s1", 0),    // miss
  ];
  const r = computeCacheHitRate(events, 0, 999_999_999);
  assert.equal(r.realRequests, 4);
  assert.equal(r.cacheHits, 2);
  assert.equal(r.hitRate, 0.5);
});

test("computeCacheHitRate: window filtering", () => {
  const events: EventRecord[] = [
    mkReal(0, "s1", 100_000),    // before window
    mkReal(60_000, "s1", 100_000), // in window — hit
    mkReal(120_000, "s1", 0),    // in window — miss
  ];
  const r = computeCacheHitRate(events, 30_000, 200_000);
  assert.equal(r.realRequests, 2);
  assert.equal(r.cacheHits, 1);
  assert.equal(r.hitRate, 0.5);
});

test("computeSavingsMulti: empty events returns one zero-result per window", () => {
  const cfg = defaultConfig();
  const r = computeSavingsMulti([], cfg, [
    { fromMs: 0, toMs: 100 },
    { fromMs: 100, toMs: 200 },
  ]);
  assert.equal(r.length, 2);
  for (const result of r) {
    assert.equal(result.savedUsd, 0);
    assert.equal(result.rebuildsAvoided, 0);
    assert.equal(result.perSession.size, 0);
  }
});

test("computeSavingsMulti: results equal N parallel computeSavings calls", () => {
  const cfg = defaultConfig();
  const events: EventRecord[] = [
    mkReal(0, "s1", 100_000),
    mkReal(6 * 60_000, "s1", 100_000),     // saves a rebuild
    mkReal(12 * 60_000, "s2", 200_000),
    mkReal(20 * 60_000, "s2", 200_000),    // saves a rebuild (8min gap > 5min)
  ];
  const windows = [
    { fromMs: -1, toMs: 999_999_999 },     // all time
    { fromMs: 5 * 60_000, toMs: 15 * 60_000 }, // only s1's saved event
  ];
  const multi = computeSavingsMulti(events, cfg, windows);
  const single0 = computeSavings(events, cfg, windows[0].fromMs, windows[0].toMs);
  const single1 = computeSavings(events, cfg, windows[1].fromMs, windows[1].toMs);
  assert.equal(multi[0].savedUsd, single0.savedUsd);
  assert.equal(multi[0].rebuildsAvoided, single0.rebuildsAvoided);
  assert.equal(multi[1].savedUsd, single1.savedUsd);
  assert.equal(multi[1].rebuildsAvoided, single1.rebuildsAvoided);
});

test("compute5hSparkline: empty events returns 20 zero buckets", () => {
  const cfg = defaultConfig();
  const now = 5 * 60 * 60 * 1000; // 5h
  const buckets = compute5hSparkline([], cfg, now);
  assert.equal(buckets.length, 20);
  for (const b of buckets) {
    assert.equal(b.savedUsd, 0);
  }
});

test("compute5hSparkline: buckets are 15-minute spans and oldest first", () => {
  const cfg = defaultConfig();
  const now = 5 * 60 * 60 * 1000; // pick now = 5h exactly so bucket starts align cleanly
  const buckets = compute5hSparkline([], cfg, now);
  // First bucket starts 5h ago; second starts 15min later; etc.
  const firstStart = Date.parse(buckets[0].tsIso);
  const secondStart = Date.parse(buckets[1].tsIso);
  assert.equal(secondStart - firstStart, 15 * 60 * 1000);
  // First bucket starts 20 × 15min = 300min before now
  assert.equal(now - firstStart, 20 * 15 * 60 * 1000);
});

test("compute5hSparkline: saved rebuild lands in the correct bucket", () => {
  const cfg = defaultConfig();
  const now = 5 * 60 * 60 * 1000; // 5h
  // Place predecessor BEFORE the window, current at t=2min (in first bucket).
  // First bucket spans [now-5h, now-4h45min] = [0, 15min].
  // Predecessor at t=-7min (before first bucket), current at t=2min (in first bucket, 9min gap → saved).
  const events: EventRecord[] = [
    mkReal(-7 * 60_000, "s1", 100_000),    // before window — predecessor only
    mkReal(2 * 60_000, "s1", 100_000),     // inside first bucket, 9min gap → saved
  ];
  const buckets = compute5hSparkline(events, cfg, now);
  const expected = (100_000 * 5 * 1.25) / 1e6; // 0.625
  assert.equal(buckets[0].savedUsd, expected);
  // All other buckets stay zero.
  for (let i = 1; i < buckets.length; i++) {
    assert.equal(buckets[i].savedUsd, 0);
  }
});

test("compute5hSparkline: bucketCount parameter overrides default", () => {
  const cfg = defaultConfig();
  const buckets = compute5hSparkline([], cfg, 999_999, 10);
  assert.equal(buckets.length, 10);
});

test("computeSavings: cacheTtlSeconds=3600 means 10-min gap is NOT a saved rebuild", () => {
  // With 1-hour cache, a 10-minute gap is still within TTL — no rebuild was
  // actually avoided by keep-alive, so net savings should be 0.
  const cfg = { ...defaultConfig(), cacheTtlSeconds: 3600 };
  const events: EventRecord[] = [
    mkReal(0, "s1", 200_000),
    mkReal(10 * 60_000, "s1", 200_000),
  ];
  const r = computeSavings(events, cfg, -1, 999_999_999);
  assert.equal(r.savedUsd, 0);
  assert.equal(r.rebuildsAvoided, 0);
});

test("computeSavings: returns pingSpendUsd and netSavedUsd", () => {
  const cfg = defaultConfig();
  // 6-min gap with cache hit → gross = 1.25. Plus two pings in window
  // costing 0.10 each → ping spend 0.20. Net = 1.05.
  const events: EventRecord[] = [
    mkReal(0, "s1", 200_000),
    mkPing(2 * 60_000, "s1", 0.10),
    mkPing(4 * 60_000, "s1", 0.10),
    mkReal(6 * 60_000, "s1", 200_000),
  ];
  const r = computeSavings(events, cfg, -1, 999_999_999);
  assert.equal(r.savedUsd, 1.25);
  assert.equal(r.pingSpendUsd, 0.20);
  assert.equal(r.netSavedUsd, 1.05);
});

test("computeSavings: pingSpendUsd is restricted to events inside the window", () => {
  const cfg = defaultConfig();
  // Two pings: one outside the window, one inside. Only the inside one counts.
  const events: EventRecord[] = [
    mkReal(0, "s1", 200_000),
    mkPing(60_000, "s1", 0.10),   // outside window
    mkPing(120_000, "s1", 0.20),  // inside window
    mkReal(6 * 60_000, "s1", 200_000),
  ];
  const r = computeSavings(events, cfg, 100_000, 999_999_999);
  assert.equal(r.pingSpendUsd, 0.20);
});

test("computeSavings: netSavedUsd can be negative (more spend than gross)", () => {
  const cfg = defaultConfig();
  // Idle never resolves: no rebuild was avoided, but pings still cost $.
  const events: EventRecord[] = [
    mkReal(0, "s1", 200_000),
    mkPing(2 * 60_000, "s1", 0.50),
    mkPing(4 * 60_000, "s1", 0.50),
  ];
  const r = computeSavings(events, cfg, -1, 999_999_999);
  assert.equal(r.savedUsd, 0);
  assert.equal(r.pingSpendUsd, 1.0);
  assert.equal(r.netSavedUsd, -1.0);
});

test("computeSavingsMulti: each window has its own pingSpendUsd / netSavedUsd", () => {
  const cfg = defaultConfig();
  const events: EventRecord[] = [
    mkReal(0, "s1", 200_000),
    mkPing(2 * 60_000, "s1", 0.10),
    mkReal(6 * 60_000, "s1", 200_000),
    mkPing(10 * 60_000, "s2", 0.50),
  ];
  const windows = [
    { fromMs: 0, toMs: 5 * 60_000 },         // covers first ping only
    { fromMs: 5 * 60_000, toMs: 15 * 60_000 }, // covers rebuild + second ping
  ];
  const r = computeSavingsMulti(events, cfg, windows);
  assert.equal(r[0].pingSpendUsd, 0.10);
  assert.equal(r[0].savedUsd, 0);
  assert.equal(r[0].netSavedUsd, -0.10);
  assert.equal(r[1].pingSpendUsd, 0.50);
  assert.equal(r[1].savedUsd, 1.25);
  assert.equal(r[1].netSavedUsd, 0.75);
});

test("compute5hSparkline: buckets include pingSpendUsd alongside savedUsd", () => {
  const cfg = defaultConfig();
  const now = 5 * 60 * 60 * 1000;
  // Place a ping at t=2min (inside first bucket).
  const events: EventRecord[] = [
    mkPing(2 * 60_000, "s1", 0.07),
  ];
  const buckets = compute5hSparkline(events, cfg, now);
  assert.equal(buckets[0].pingSpendUsd, 0.07);
  assert.equal(buckets[0].savedUsd, 0);
  for (let i = 1; i < buckets.length; i++) {
    assert.equal(buckets[i].pingSpendUsd, 0);
  }
});

test("computeSavings: cacheTtlSeconds=3600 means 65-min gap IS a saved rebuild", () => {
  const cfg = {
    ...defaultConfig(),
    cacheTtlSeconds: 3600,
    pingCadenceSeconds: 3300,
    abandonAfterMinutes: 240,
  };
  const events: EventRecord[] = [
    mkReal(0, "s1", 200_000),
    mkReal(65 * 60_000, "s1", 200_000),
  ];
  const r = computeSavings(events, cfg, -1, 999_999_999);
  assert.equal(r.savedUsd, 1.25);
  assert.equal(r.rebuildsAvoided, 1);
});

test("computeSavings: per-event cacheTtlSeconds beats config (subscription 1h vs default 5min)", () => {
  // Config defaults say 5-min TTL. Each event carries its own detected TTL=3600.
  // A 10-minute gap should NOT count as a saved rebuild because under the 1h
  // TTL the cache was still warm at that point.
  const cfg = defaultConfig();
  const e1 = { ...mkReal(0, "s1", 200_000), cacheTtlSeconds: 3600 };
  const e2 = { ...mkReal(10 * 60_000, "s1", 200_000), cacheTtlSeconds: 3600 };
  const r = computeSavings([e1, e2], cfg, -1, 999_999_999);
  assert.equal(r.savedUsd, 0);
  assert.equal(r.rebuildsAvoided, 0);
});

test("computeSavings: per-event cacheTtlSeconds — 5min TTL counts a 6-min gap even when config says 3600", () => {
  // Config says 1h, but the event itself was on the 5-min TTL (e.g. subscription
  // user dropped to credit-fallback). 6-min gap should be counted.
  const cfg = { ...defaultConfig(), cacheTtlSeconds: 3600, pingCadenceSeconds: 3300, abandonAfterMinutes: 240 };
  const e1 = { ...mkReal(0, "s1", 200_000), cacheTtlSeconds: 300 };
  const e2 = { ...mkReal(6 * 60_000, "s1", 200_000), cacheTtlSeconds: 300 };
  const r = computeSavings([e1, e2], cfg, -1, 999_999_999);
  assert.equal(r.rebuildsAvoided, 1);
});
