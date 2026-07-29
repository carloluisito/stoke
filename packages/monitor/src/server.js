import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { spendByDay, costByDay, cacheSavedUsd, spendByProject, spendByModel, sessions, sessionDetail, cacheStats, overview, netCost, proxySummary, preventedSavings, preventedByDay } from "./analytics/breakdowns.js";
import { runDetectors, ttlAdvisor, savingsAttribution } from "./analytics/detectors.js";
import { rollupFindings } from "./analytics/rollup.js";

/** Live state from the proxy's loopback stats endpoint; null when it's down. */
async function fetchProxyStats(config) {
  try {
    const resp = await fetch(config.stokeStatsUrl, { signal: AbortSignal.timeout(500) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export function buildServer({ db, rules, config }) {
  const app = Fastify({ logger: false });

  app.get("/api/overview", async () => {
    const live = await fetchProxyStats(config);
    return {
      ...overview(db),
      cacheSavedUsd: cacheSavedUsd(db, rules),
      proxyUp: live !== null,
      netCost: netCost(db, rules),
    };
  });
  app.get("/api/proxy", async () => {
    const live = await fetchProxyStats(config);
    return { up: live !== null, live, ...proxySummary(db, rules) };
  });
  // Windowed keep-alive savings. preventedSavings already accepts an arbitrary
  // window, so this is a thin route over existing math. days=all -> since install,
  // which is what the landing screen's cumulative counter shows.
  app.get("/api/proxy/savings", (req) => {
    const raw = req.query.days;
    const days = raw === "all" ? 0 : Number(raw) || 30;
    const from = days > 0
      ? new Date(Date.now() - days * 86400e3).toISOString()
      : "1970-01-01T00:00:00.000Z";
    const out = { windowDays: days, ...preventedSavings(db, rules, from) };
    if (req.query.byDay === "1" && days > 0) out.byDay = preventedByDay(db, rules, days);
    return out;
  });
  app.get("/api/spend/daily", (req) => spendByDay(db, { days: Number(req.query.days) || 30 }));
  app.get("/api/spend/daily-cost", (req) => costByDay(db, rules, { days: Number(req.query.days) || 30 }));
  app.get("/api/spend/projects", () => spendByProject(db));
  app.get("/api/spend/models", () => spendByModel(db));
  app.get("/api/sessions", (req) => sessions(db, { limit: Number(req.query.limit) || 50 }));
  app.get("/api/sessions/:id", (req) => sessionDetail(db, req.params.id));
  app.get("/api/cache", () => cacheStats(db));
  // Default shape is unchanged for the Leaks tab, which needs every finding.
  // rollup=1 returns the aggregate the landing screen needs — five causes
  // instead of ~1,100 findings, a ~200x smaller payload.
  app.get("/api/waste", (req) => {
    const findings = runDetectors(db, rules).sort((a, b) => b.wastedUsd - a.wastedUsd);
    if (req.query.rollup !== "1") {
      return { findings, attribution: savingsAttribution(db, rules) };
    }
    const days = Number(req.query.days) || 30;
    const now = new Date();
    const from = new Date(now.getTime() - days * 86400e3).toISOString();
    const spendUsd = db.prepare("SELECT SUM(cost_usd) c FROM turns WHERE ts >= ?").get(from).c || 0;
    return rollupFindings(findings, { days, now, spendUsd });
  });
  app.get("/api/ttl-advice", () => ttlAdvisor(db, rules));
  app.get("/api/interventions", () =>
    db.prepare(`SELECT i.*, (SELECT t.project FROM turns t WHERE t.session_id = i.session_id LIMIT 1) AS project
      FROM interventions i ORDER BY i.ts DESC LIMIT 500`).all());

  const dist = path.join(config.projectRoot, "web", "dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    app.register(fastifyStatic, { root: dist });
  } else {
    // Dashboard was never built (fresh checkout that skipped `npm run setup`,
    // and dist/ is gitignored). Don't leave the raw Fastify 404 — it reads as a
    // broken app. The API above still works; only the UI is missing.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        reply.code(404).send({ error: "not found", url: req.url });
        return;
      }
      reply.code(503).type("text/html").send(dashboardMissingHtml());
    });
  }
  return app;
}

function dashboardMissingHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Stoke — dashboard not built</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#e6e6e6;background:#111}
code{background:#222;padding:.15em .4em;border-radius:4px}h1{font-size:1.4rem}a{color:#7aa2ff}</style>
<h1>Stoke dashboard isn't built yet</h1>
<p>The monitor and its API are running, but the dashboard's static files (<code>web/dist</code>)
were never produced on this machine.</p>
<p>Build it with the one-command setup, then reload:</p>
<pre><code>npm run setup</code></pre>
<p>Or build just the dashboard:</p>
<pre><code>npm --prefix packages/monitor/web install
npm --prefix packages/monitor/web run build</code></pre>
<p>The API is live meanwhile — e.g. <a href="/api/overview">/api/overview</a>.</p>`;
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
