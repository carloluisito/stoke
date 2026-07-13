import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import { loadPricing } from "../src/pricing.js";
import { runDetectors, ttlAdvisor, savingsAttribution } from "../src/analytics/detectors.js";

const rules = loadPricing();
let db;

function seedTurns(db, rows) {
  const ins = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  rows.forEach(r => ins.run(...r));
}
// columns: message_id, session_id, project, ts, model, input, output, cw5m, cw1h, cread, cost

beforeEach(() => { db = openDb(":memory:"); });

describe("runDetectors", () => {
  it("fires cache_expiry when gap exceeds TTL and cache re-written", () => {
    seedTurns(db, [
      ["e1","sE","p","2026-07-11T10:00:00Z","claude-opus-4-8",100,100,50000,0,0,0.4],
      ["e2","sE","p","2026-07-11T10:30:00Z","claude-opus-4-8",100,100,50000,0,0,0.4], // 30m gap > 5m TTL
    ]);
    const f = runDetectors(db, rules).filter(x => x.type === "cache_expiry");
    expect(f.length).toBe(1);
    expect(f[0].session_id).toBe("sE");
    expect(f[0].wastedUsd).toBeGreaterThan(0);
  });
  it("fires cache_invalidation when gap is within TTL", () => {
    seedTurns(db, [
      ["i1","sI","p","2026-07-11T10:00:00Z","claude-opus-4-8",100,100,50000,0,0,0.4],
      ["i2","sI","p","2026-07-11T10:02:00Z","claude-opus-4-8",100,100,50000,0,0,0.4], // 2m gap <= 5m TTL
    ]);
    const f = runDetectors(db, rules).filter(x => x.type === "cache_invalidation");
    expect(f.length).toBe(1);
  });
  it("uses 1h TTL when the session wrote 1h cache tokens", () => {
    seedTurns(db, [
      ["h1","sH","p","2026-07-11T10:00:00Z","claude-opus-4-8",100,100,0,50000,0,0.6],
      ["h2","sH","p","2026-07-11T10:30:00Z","claude-opus-4-8",100,100,0,50000,0,0.6], // 30m gap <= 1h TTL
    ]);
    const f = runDetectors(db, rules);
    expect(f.filter(x => x.type === "cache_expiry").length).toBe(0);
    expect(f.filter(x => x.type === "cache_invalidation").length).toBe(1);
  });
  it("fires session_bloat when recent context is huge", () => {
    seedTurns(db, [
      ["b1","sB","p","2026-07-11T10:00:00Z","claude-opus-4-8",1000,100,0,0,150000,0.1],
      ["b2","sB","p","2026-07-11T10:01:00Z","claude-opus-4-8",1000,100,0,0,150000,0.1],
      ["b3","sB","p","2026-07-11T10:02:00Z","claude-opus-4-8",1000,100,0,0,150000,0.1],
    ]);
    const f = runDetectors(db, rules).filter(x => x.type === "session_bloat");
    expect(f.length).toBe(1);
    expect(f[0].recommendation).toMatch(/compact|clear/i);
  });
  it("fires output_verbosity on outlier long outputs", () => {
    seedTurns(db, [
      ["v1","sV","p","2026-07-11T10:00:00Z","claude-opus-4-8",100,100,0,0,0,0.01],
      ["v2","sV","p","2026-07-11T10:01:00Z","claude-opus-4-8",100,200,0,0,0,0.01],
      ["v3","sV","p","2026-07-11T10:02:00Z","claude-opus-4-8",100,150,0,0,0,0.01],
      ["v4","sV","p","2026-07-11T10:03:00Z","claude-opus-4-8",100,5000,0,0,0,0.13],
    ]);
    const f = runDetectors(db, rules).filter(x => x.type === "output_verbosity");
    expect(f.length).toBe(1);
    expect(f[0].wastedUsd).toBeGreaterThan(0);
  });
  it("fires model_mismatch on expensive mechanical opus sessions", () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push([`mm${i}`,"sM","p",`2026-07-11T10:0${i}:00Z`,"claude-opus-4-8",5000,100,0,0,0,0.1]);
    }
    seedTurns(db, rows); // cost 1.0 > 0.5; 100% of turns output<300
    const f = runDetectors(db, rules).filter(x => x.type === "model_mismatch");
    expect(f.length).toBe(1);
    expect(f[0].confidence).toBe("estimate");
  });
  it("stays silent on a clean cheap session", () => {
    seedTurns(db, [
      ["c1","sC","p","2026-07-11T10:00:00Z","claude-haiku-4-5",500,400,1000,0,0,0.003],
      ["c2","sC","p","2026-07-11T10:01:00Z","claude-haiku-4-5",100,600,0,0,1000,0.004],
    ]);
    expect(runDetectors(db, rules).length).toBe(0);
  });
});

describe("ttlAdvisor", () => {
  it("recommends 1h TTL when expiry losses exceed the write premium", () => {
    // Big expiry events with gaps under 1h, small total writes -> switch pays
    seedTurns(db, [
      ["t1","sT","projT","2026-07-11T10:00:00Z","claude-opus-4-8",100,100,500000,0,0,3.2],
      ["t2","sT","projT","2026-07-11T10:20:00Z","claude-opus-4-8",100,100,500000,0,0,3.2],
      ["t3","sT","projT","2026-07-11T10:40:00Z","claude-opus-4-8",100,100,500000,0,0,3.2],
    ]);
    const advice = ttlAdvisor(db, rules).find(a => a.project === "projT");
    expect(advice.verdict).toBe("switch-1h");
    expect(advice.monthlyDeltaUsd).toBeGreaterThan(0);
  });
  it("keeps 5m when there are no expiry events", () => {
    seedTurns(db, [
      ["k1","sK","projK","2026-07-11T10:00:00Z","claude-opus-4-8",100,100,50000,0,0,0.4],
      ["k2","sK","projK","2026-07-11T10:02:00Z","claude-opus-4-8",100,100,0,0,50000,0.03],
    ]);
    const advice = ttlAdvisor(db, rules).find(a => a.project === "projK");
    expect(advice.verdict).toBe("keep-5m");
  });
});

describe("savingsAttribution", () => {
  it("reports rate change around the first intervention", () => {
    // Before: session with expiry finding. After: clean session.
    seedTurns(db, [
      ["a1","sBefore","p","2026-07-01T10:00:00Z","claude-opus-4-8",100,100,50000,0,0,0.4],
      ["a2","sBefore","p","2026-07-01T10:30:00Z","claude-opus-4-8",100,100,50000,0,0,0.4],
      ["a3","sAfter","p","2026-07-10T10:00:00Z","claude-opus-4-8",100,100,50000,0,0,0.4],
      ["a4","sAfter","p","2026-07-10T10:02:00Z","claude-opus-4-8",100,100,0,0,50000,0.03],
    ]);
    db.prepare("INSERT INTO interventions (ts, session_id, lever, mode, message) VALUES (?,?,?,?,?)")
      .run("2026-07-05T00:00:00Z", "sX", "cache_expiry_warning", "suggest", "warned");
    const att = savingsAttribution(db, rules).find(a => a.lever === "cache_expiry_warning");
    expect(att.eventsPerSessionBefore).toBeGreaterThan(att.eventsPerSessionAfter);
    expect(att.estSavedUsd).toBeGreaterThanOrEqual(0);
  });
});
