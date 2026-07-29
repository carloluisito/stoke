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
    expect(r.causes[0].topProject).toBe("unknown");
  });

  it("treats days:0 as all-time", () => {
    const r = rollupFindings([F("cache_expiry", "a", 4, 400)], { days: 0, now: NOW, spendUsd: 10 });
    expect(r.avoidableUsd).toBe(4);
  });

  it("skips findings with an unparseable timestamp", () => {
    const r = rollupFindings(
      [{ type: "cache_expiry", project: "a", wastedUsd: 5, ts: "not-a-date" }],
      { days: 30, now: NOW, spendUsd: 10 },
    );
    expect(r.findingCount).toBe(0);
    expect(r.avoidableUsd).toBe(0);
  });

  it("survives null input", () => {
    const r = rollupFindings(null, { days: 30, now: NOW, spendUsd: 10 });
    expect(r.causes).toEqual([]);
    expect(r.avoidablePct).toBe(0);
  });

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
});
