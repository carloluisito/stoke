import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { loadPricing } from "../src/pricing.js";
import { backfill, watch } from "../src/ingest.js";
import { ingestProxyEvents, watchProxyEvents } from "../src/proxy-events.js";
import { buildServer, startServer } from "../src/server.js";

// First run on a fresh checkout: dist/ is gitignored, so if `npm run setup`
// was skipped the dashboard has no static files and the server can only show
// the "not built" fallback. Build it once here so `npm start`, `stoke start`,
// and the logon autostart all yield a working UI without manual steps.
function ensureDashboardBuilt(projectRoot) {
  const web = path.join(projectRoot, "web");
  if (fs.existsSync(path.join(web, "dist", "index.html"))) return;
  console.log("[stoke-monitor] dashboard not built — building web/dist (first run on this machine)…");
  try {
    if (!fs.existsSync(path.join(web, "node_modules"))) {
      execSync("npm install", { cwd: web, stdio: "inherit" });
    }
    execSync("npm run build", { cwd: web, stdio: "inherit" });
    console.log("[stoke-monitor] dashboard built.");
  } catch (e) {
    console.error(`[stoke-monitor] dashboard build failed: ${e.message}`);
    console.error("[stoke-monitor] API will still start; run `npm run setup` to enable the dashboard UI.");
  }
}

const config = loadConfig();
ensureDashboardBuilt(config.projectRoot);
const db = openDb(config.dbPath);
const rules = loadPricing();

for (const dir of config.transcriptGlobDirs) {
  console.log(`[stoke-monitor] backfilling from ${dir} ...`);
  backfill(db, rules, dir);
  watch(db, rules, dir);
}
const turns = db.prepare("SELECT COUNT(*) c FROM turns").get().c;
console.log(`[stoke-monitor] ${turns} turns ingested; watching ${config.transcriptGlobDirs.length} profile(s) for changes`);

const proxyRows = ingestProxyEvents(db, config.proxyEventsPath);
watchProxyEvents(db, config.proxyEventsPath);
console.log(`[stoke-monitor] ${proxyRows.rows} new proxy events from ${config.proxyEventsPath}`);

const app = buildServer({ db, rules, config });
const port = await startServer(app, config);
console.log(`[stoke-monitor] dashboard: http://localhost:${port}`);
