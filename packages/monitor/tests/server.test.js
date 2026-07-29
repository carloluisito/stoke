import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { loadPricing } from "../src/pricing.js";
import { loadConfig } from "../src/config.js";
import { buildServer, startServer } from "../src/server.js";

let db, app;
beforeEach(() => {
  db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  ins.run("m1","s1","projA","2026-07-10T09:00:00Z","claude-opus-4-8",1000,500,4000,0,0,0.05);
  ins.run("m2","s1","projA","2026-07-10T09:05:00Z","claude-opus-4-8",100,300,0,0,4000,0.02);
  db.prepare("INSERT INTO interventions (ts, session_id, lever, mode, message) VALUES (?,?,?,?,?)")
    .run("2026-07-10T09:00:01Z","s1","efficiency_conventions","suggest","injected conventions");
  app = buildServer({ db, rules: loadPricing(), config: loadConfig({}) });
});
afterEach(async () => { await app.close(); });

describe("api routes", () => {
  const routes = ["/api/overview","/api/spend/daily","/api/spend/daily-cost","/api/spend/projects","/api/spend/models",
    "/api/sessions","/api/sessions/s1","/api/cache","/api/waste","/api/ttl-advice","/api/interventions"];
  for (const r of routes) {
    it(`GET ${r} returns 200 JSON`, async () => {
      const res = await app.inject({ method: "GET", url: r });
      expect(res.statusCode).toBe(200);
      expect(() => res.json()).not.toThrow();
    });
  }
  it("waste payload includes findings and attribution", async () => {
    const res = await app.inject({ method: "GET", url: "/api/waste" });
    const body = res.json();
    expect(body).toHaveProperty("findings");
    expect(body).toHaveProperty("attribution");
  });
});

describe("missing dashboard build", () => {
  // projectRoot with no web/dist — simulates a fresh checkout that skipped setup.
  const noDist = { ...loadConfig({}), projectRoot: path.join(os.tmpdir(), "stoke-no-dist-xyz") };

  it("serves a helpful 503 HTML page for the UI instead of a raw 404", async () => {
    const a = buildServer({ db, rules: loadPricing(), config: noDist });
    const res = await a.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toMatch(/not built|npm run setup/i);
    await a.close();
  });

  it("still answers real API routes and 404s unknown /api as JSON", async () => {
    const a = buildServer({ db, rules: loadPricing(), config: noDist });
    expect((await a.inject({ method: "GET", url: "/api/overview" })).statusCode).toBe(200);
    const miss = await a.inject({ method: "GET", url: "/api/nope" });
    expect(miss.statusCode).toBe(404);
    expect(() => miss.json()).not.toThrow();
    await a.close();
  });
});

describe("startServer port fallback", () => {
  it("falls back to the next port when the default is taken, never 9876", async () => {
    // Occupy 5599 ourselves — or accept that another process (e.g. a running
    // tokeff dashboard) already holds it; either way the precondition is met.
    const blocker = net.createServer();
    const weBlocked = await new Promise(resolve => {
      blocker.once("listening", () => resolve(true));
      blocker.once("error", () => resolve(false)); // already in use by someone else
      blocker.listen(5599, "127.0.0.1");
    });
    const app2 = buildServer({ db, rules: loadPricing(), config: loadConfig({}) });
    const port = await startServer(app2, loadConfig({}));
    expect(port).toBeGreaterThanOrEqual(5600);
    expect(port).not.toBe(9876);
    await app2.close();
    if (weBlocked) blocker.close();
  });
});

describe("GET /api/waste?rollup=1", () => {
  it("returns a rollup instead of raw findings", async () => {
    const res = await app.inject({ url: "/api/waste?days=30&rollup=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("causes");
    expect(body).toHaveProperty("byProject");
    expect(body).toHaveProperty("byDay");
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

  // Spec success criterion 4. Only the absolute cap is asserted: this fixture
  // has two turns and produces zero findings, so the raw payload is already
  // tiny and the rollup's extra keys make it nominally larger. The size *win*
  // is a property of real data volume (measured 437,627 -> 2,097 bytes on the
  // live database, 209x) and can't be demonstrated on an empty fixture.
  it("stays under the landing-screen payload budget", async () => {
    const roll = await app.inject({ url: "/api/waste?days=30&rollup=1" });
    expect(roll.body.length).toBeLessThan(5000);
  });

  it("collapses many findings into at most one row per cause", async () => {
    const res = await app.inject({ url: "/api/waste?days=30&rollup=1" });
    const body = res.json();
    // Whatever the finding count, causes can never exceed the detector types.
    expect(body.causes.length).toBeLessThanOrEqual(5);
    const types = body.causes.map((c) => c.type);
    expect(new Set(types).size).toBe(types.length); // one row per type
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

  it("returns a per-day series when asked", async () => {
    const res = await app.inject({ url: "/api/proxy/savings?days=7&byDay=1" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().byDay)).toHaveLength(7);
  });

  it("omits the per-day series by default", async () => {
    const res = await app.inject({ url: "/api/proxy/savings?days=7" });
    expect(res.json().byDay).toBeUndefined();
  });

  it("omits the per-day series for all-time, which has no fixed day count", async () => {
    const res = await app.inject({ url: "/api/proxy/savings?days=all&byDay=1" });
    expect(res.json().byDay).toBeUndefined();
  });
});
