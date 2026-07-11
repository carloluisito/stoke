import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { statuslineData } from "../src/statusline-data.js";

function seeded(rows) {
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  rows.forEach(r => ins.run(...r));
  return db;
}

describe("statuslineData", () => {
  it("sums session and today cost", () => {
    const now = new Date("2026-07-11T12:00:00Z").getTime();
    const db = seeded([
      ["m1","s1","p","2026-07-11T11:59:30Z","claude-opus-4-8",100,100,0,0,5000,0.05],
      ["m2","s2","p","2026-07-11T08:00:00Z","claude-opus-4-8",100,100,0,0,0,0.10],
      ["m3","s3","p","2026-07-01T08:00:00Z","claude-opus-4-8",100,100,0,0,0,0.20],
    ]);
    const d = statuslineData(db, "s1", now);
    expect(d.sessionCost).toBeCloseTo(0.05, 6);
    expect(d.todayCost).toBeCloseTo(0.15, 6);
    expect(d.cacheWarm).toBe(true); // 30s ago < 5m TTL, had cache_read
  });
  it("cache goes cold past TTL", () => {
    const now = new Date("2026-07-11T12:00:00Z").getTime();
    const db = seeded([["m1","s1","p","2026-07-11T11:50:00Z","claude-opus-4-8",100,100,0,0,5000,0.05]]);
    expect(statuslineData(db, "s1", now).cacheWarm).toBe(false); // 10m > 5m
  });
  it("stays warm within 1h TTL when session used 1h writes", () => {
    const now = new Date("2026-07-11T12:00:00Z").getTime();
    const db = seeded([["m1","s1","p","2026-07-11T11:50:00Z","claude-opus-4-8",100,100,0,5000,0,0.05]]);
    expect(statuslineData(db, "s1", now).cacheWarm).toBe(true); // 10m < 1h
  });
});
