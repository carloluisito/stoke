import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb } from "../src/db.js";
import { ingestProxyEvents } from "../src/proxy-events.js";
import { pingSpendUsd, preventedSavings, netCost } from "../src/analytics/breakdowns.js";
import { loadPricing } from "../src/pricing.js";

const T0 = "2026-07-13T10:00:00.000Z";
const T1 = "2026-07-13T10:01:00.000Z";
const T2 = "2026-07-13T10:20:00.000Z"; // 19m after T1 — past the 5m TTL

const usage = (read) => ({ input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: read });

const SAMPLE_EVENTS = [
  { ts: T0, kind: "proxy_started", config: {} },
  { ts: T1, kind: "real_request", sessionKey: "s1", model: "claude-fable-5", usage: usage(200_000), ratelimits: {}, cacheTtlSeconds: 300 },
  { ts: "2026-07-13T10:05:00.000Z", kind: "ping_fired", sessionKey: "s1", model: "claude-fable-5", usage: usage(200_000), ratelimits: {}, costUsd: 0.02 },
  { ts: "2026-07-13T10:10:00.000Z", kind: "ping_skipped", sessionKey: "s1", reason: "budget" },
  // Cache still read after a 19-minute gap: the proxy prevented a rebuild.
  { ts: T2, kind: "real_request", sessionKey: "s1", model: "claude-fable-5", usage: usage(200_000), ratelimits: {}, cacheTtlSeconds: 300 },
  { ts: "2026-07-13T10:25:00.000Z", kind: "session_resumed", sessionKey: "s1", fromState: "paused", gapMs: 60000, cacheOutcome: "survived", rebuildCostUsd: 0 },
];

function writeEventsFile(events) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pev-")), "events.jsonl");
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

describe("proxy events ingest", () => {
  it("ingests every event kind and extracts columns", () => {
    const db = openDb(":memory:");
    const file = writeEventsFile(SAMPLE_EVENTS);
    const r = ingestProxyEvents(db, file);
    expect(r.rows).toBe(6);
    const kinds = db.prepare("SELECT kind, COUNT(*) n FROM proxy_events GROUP BY kind").all();
    expect(Object.fromEntries(kinds.map(k => [k.kind, k.n]))).toEqual({
      proxy_started: 1, real_request: 2, ping_fired: 1, ping_skipped: 1, session_resumed: 1,
    });
    const ping = db.prepare("SELECT * FROM proxy_events WHERE kind='ping_fired'").get();
    expect(ping.cost_usd).toBeCloseTo(0.02);
    expect(ping.session_key).toBe("s1");
  });

  it("resumes from the stored offset — re-ingesting adds nothing", () => {
    const db = openDb(":memory:");
    const file = writeEventsFile(SAMPLE_EVENTS);
    ingestProxyEvents(db, file);
    expect(ingestProxyEvents(db, file).rows).toBe(0);
    // Append one more line: only it is ingested.
    fs.appendFileSync(file, JSON.stringify({ ts: "2026-07-13T11:00:00.000Z", kind: "ping_skipped", sessionKey: "s1", reason: "x" }) + "\n");
    expect(ingestProxyEvents(db, file).rows).toBe(1);
  });

  it("resets to offset 0 after rotation (stored offset > file size)", () => {
    const db = openDb(":memory:");
    const file = writeEventsFile(SAMPLE_EVENTS);
    ingestProxyEvents(db, file);
    // Simulate rotation: the proxy renamed the old log and started a new, smaller one.
    fs.writeFileSync(file, JSON.stringify({ ts: "2026-07-13T12:00:00.000Z", kind: "proxy_started", config: {} }) + "\n");
    expect(ingestProxyEvents(db, file).rows).toBe(1);
  });

  it("tolerates torn trailing lines and corrupt rows", () => {
    const db = openDb(":memory:");
    const file = writeEventsFile(SAMPLE_EVENTS.slice(0, 2));
    fs.appendFileSync(file, "{not json}\n" + '{"ts":"2026-07-13T10:06:00.000Z","kind":"ping_skipped","sessionKey":"s1","reason":"x"}'); // no trailing \n
    const r = ingestProxyEvents(db, file);
    expect(r.rows).toBe(2); // corrupt line skipped, torn line deferred
    fs.appendFileSync(file, "\n");
    expect(ingestProxyEvents(db, file).rows).toBe(1); // torn line completed
  });

  it("returns 0 rows when the events file does not exist", () => {
    const db = openDb(":memory:");
    expect(ingestProxyEvents(db, path.join(os.tmpdir(), "does-not-exist.jsonl")).rows).toBe(0);
  });
});

describe("net-cost model", () => {
  it("netCost = transcript spend + ping spend − prevented rebuilds", () => {
    const db = openDb(":memory:");
    const rules = loadPricing();
    const file = writeEventsFile(SAMPLE_EVENTS);
    ingestProxyEvents(db, file);
    db.prepare(`INSERT INTO turns (message_id, session_id, project, ts, model, input_tokens, output_tokens,
      cache_write_5m, cache_write_1h, cache_read, cost_usd) VALUES ('m1','s1','p','${T1}','claude-fable-5',0,0,0,0,0,1.0)`).run();

    const day = "2026-07-13";
    expect(pingSpendUsd(db, day, "2026-07-14")).toBeCloseTo(0.02);

    const prevented = preventedSavings(db, rules, day, "2026-07-14");
    // 200k cache-read tokens × $10/MTok × 1.25 (5m rebuild) = $2.50
    expect(prevented.rebuildsAvoided).toBe(1);
    expect(prevented.savedUsd).toBeCloseTo(2.5);

    const n = netCost(db, rules, new Date(T2));
    expect(n.spendUsd).toBeCloseTo(1.0);
    expect(n.pingSpendUsd).toBeCloseTo(0.02);
    expect(n.preventedUsd).toBeCloseTo(2.5);
    expect(n.netCostUsd).toBeCloseTo(1.0 + 0.02 - 2.5);
  });

  it("handles zero proxy data (proxy never ran)", () => {
    const db = openDb(":memory:");
    const rules = loadPricing();
    const n = netCost(db, rules);
    expect(n.spendUsd).toBe(0);
    expect(n.pingSpendUsd).toBe(0);
    expect(n.preventedUsd).toBe(0);
    expect(n.netCostUsd).toBe(0);
  });
});
