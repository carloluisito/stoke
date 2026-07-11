import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { spendByDay, costByDay, cacheSavedUsd, spendByProject, spendByModel, sessions, sessionDetail, cacheStats, overview } from "./analytics/breakdowns.js";
import { runDetectors, ttlAdvisor, savingsAttribution } from "./analytics/detectors.js";

export function buildServer({ db, rules, config }) {
  const app = Fastify({ logger: false });

  app.get("/api/overview", () => ({ ...overview(db), cacheSavedUsd: cacheSavedUsd(db, rules) }));
  app.get("/api/spend/daily", (req) => spendByDay(db, { days: Number(req.query.days) || 30 }));
  app.get("/api/spend/daily-cost", (req) => costByDay(db, rules, { days: Number(req.query.days) || 30 }));
  app.get("/api/spend/projects", () => spendByProject(db));
  app.get("/api/spend/models", () => spendByModel(db));
  app.get("/api/sessions", (req) => sessions(db, { limit: Number(req.query.limit) || 50 }));
  app.get("/api/sessions/:id", (req) => sessionDetail(db, req.params.id));
  app.get("/api/cache", () => cacheStats(db));
  app.get("/api/waste", () => ({
    findings: runDetectors(db, rules).sort((a, b) => b.wastedUsd - a.wastedUsd),
    attribution: savingsAttribution(db, rules),
  }));
  app.get("/api/ttl-advice", () => ttlAdvisor(db, rules));
  app.get("/api/interventions", () =>
    db.prepare(`SELECT i.*, (SELECT t.project FROM turns t WHERE t.session_id = i.session_id LIMIT 1) AS project
      FROM interventions i ORDER BY i.ts DESC LIMIT 500`).all());

  const dist = path.join(config.projectRoot, "web", "dist");
  if (fs.existsSync(dist)) {
    app.register(fastifyStatic, { root: dist });
  }
  return app;
}

export async function startServer(app, config) {
  const ports = [config.port, ...range(config.portRange[0], config.portRange[1])];
  for (const port of ports) {
    if (port === 9876) continue; // reserved — never touch
    try {
      await app.listen({ port, host: "127.0.0.1" });
      return port;
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error("No free port in configured range");
}

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
