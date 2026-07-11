import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { loadPricing } from "../src/pricing.js";
import { backfill, watch } from "../src/ingest.js";
import { buildServer, startServer } from "../src/server.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const rules = loadPricing();

for (const dir of config.transcriptGlobDirs) {
  console.log(`[tokeff] backfilling from ${dir} ...`);
  backfill(db, rules, dir);
  watch(db, rules, dir);
}
const turns = db.prepare("SELECT COUNT(*) c FROM turns").get().c;
console.log(`[tokeff] ${turns} turns ingested; watching ${config.transcriptGlobDirs.length} profile(s) for changes`);

const app = buildServer({ db, rules, config });
const port = await startServer(app, config);
console.log(`[tokeff] dashboard: http://localhost:${port}`);
