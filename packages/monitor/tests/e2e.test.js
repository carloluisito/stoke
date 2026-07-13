import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb } from "../src/db.js";
import { loadPricing } from "../src/pricing.js";
import { loadConfig } from "../src/config.js";
import { backfill } from "../src/ingest.js";
import { buildServer } from "../src/server.js";

let app, db;

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokeff-e2e-"));
  const proj = path.join(root, "C--Users-me-e2eproj");
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync("tests/fixtures/session-basic.jsonl", path.join(proj, "s1.jsonl"));
  db = openDb(path.join(root, "e2e.db"));
  backfill(db, loadPricing(), root);
  app = buildServer({ db, rules: loadPricing(), config: loadConfig({}) });
});
afterAll(async () => { await app.close(); });

describe("end to end", () => {
  it("overview totals equal the sum of session costs", async () => {
    const overview = (await app.inject({ url: "/api/overview" })).json();
    const sessions = (await app.inject({ url: "/api/sessions" })).json();
    const sum = sessions.reduce((a, s) => a + s.cost, 0);
    expect(sessions.length).toBeGreaterThan(0);
    expect(overview.month).toBeCloseTo(sum, 8);
  });
  it("session detail turns sum to the session cost", async () => {
    const sessions = (await app.inject({ url: "/api/sessions" })).json();
    const detail = (await app.inject({ url: `/api/sessions/${sessions[0].session_id}` })).json();
    const sum = detail.reduce((a, t) => a + t.cost_usd, 0);
    expect(sum).toBeCloseTo(sessions[0].cost, 8);
  });
  it("waste and ttl-advice endpoints respond coherently", async () => {
    const waste = (await app.inject({ url: "/api/waste" })).json();
    const ttl = (await app.inject({ url: "/api/ttl-advice" })).json();
    expect(Array.isArray(waste.findings)).toBe(true);
    expect(ttl.find(a => a.project === "C--Users-me-e2eproj")).toBeTruthy();
  });
});
