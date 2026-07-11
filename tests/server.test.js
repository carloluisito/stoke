import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
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
  const routes = ["/api/overview","/api/spend/daily","/api/spend/projects","/api/spend/models",
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

describe("startServer port fallback", () => {
  it("falls back to the next port when the default is taken, never 9876", async () => {
    const blocker = net.createServer().listen(5599, "127.0.0.1");
    await new Promise(r => blocker.once("listening", r));
    const app2 = buildServer({ db, rules: loadPricing(), config: loadConfig({}) });
    const port = await startServer(app2, loadConfig({}));
    expect(port).toBeGreaterThanOrEqual(5600);
    expect(port).not.toBe(9876);
    await app2.close();
    blocker.close();
  });
});
