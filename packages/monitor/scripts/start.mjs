import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { loadPricing } from "../src/pricing.js";
import { backfill, watch } from "../src/ingest.js";
import { ingestProxyEvents, watchProxyEvents } from "../src/proxy-events.js";
import { buildServer, startServer } from "../src/server.js";

const config = loadConfig();
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
