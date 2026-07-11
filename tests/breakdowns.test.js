import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import { spendByDay, spendByProject, spendByModel, sessions, sessionDetail, cacheStats, overview } from "../src/analytics/breakdowns.js";

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
});
