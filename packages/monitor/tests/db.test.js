import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";

describe("openDb", () => {
  it("creates schema in-memory and is idempotent", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(tables).toEqual(expect.arrayContaining(["turns", "ingest_state", "interventions"]));
    const db2 = openDb(":memory:");
    expect(db2).toBeTruthy();
  });
  it("upserts a turn by message_id", () => {
    const db = openDb(":memory:");
    const ins = db.prepare(`INSERT INTO turns (message_id, session_id, project, ts, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read, cost_usd)
      VALUES (@message_id,@session_id,@project,@ts,@model,@input_tokens,@output_tokens,@cache_write_5m,@cache_write_1h,@cache_read,@cost_usd)
      ON CONFLICT(message_id) DO NOTHING`);
    const row = { message_id: "m1", session_id: "s1", project: "p", ts: "2026-07-11T00:00:00Z", model: "claude-opus-4-8", input_tokens: 10, output_tokens: 5, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, cost_usd: 0.001 };
    ins.run(row); ins.run(row);
    expect(db.prepare("SELECT COUNT(*) c FROM turns").get().c).toBe(1);
  });
});
