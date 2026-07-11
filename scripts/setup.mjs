// One-command setup for a new machine: deps -> web build -> tests -> install -> verify.
// Idempotent: safe to re-run; the installer never duplicates or clobbers settings.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, cwd = root) => {
  console.log(`\n[setup] $ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};
const fail = (msg) => { console.error(`\n[setup] FAILED: ${msg}`); process.exit(1); };

// 1. Node version gate (better-sqlite3 needs a modern runtime; ESM features need >=20)
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) fail(`Node >= 20 required, found ${process.versions.node}. Install from nodejs.org and re-run.`);
console.log(`[setup] Node ${process.versions.node} OK`);

// 2. Dependencies (root + web)
run("npm install");
run("npm install", path.join(root, "web"));

// 3. Build the dashboard frontend
run("npm run build", path.join(root, "web"));
if (!fs.existsSync(path.join(root, "web", "dist", "index.html"))) fail("web build produced no dist/index.html");

// 4. Full test suite — do not install anything if tests fail on this machine
run("npx vitest run");

// 5. Register hooks/agents/skills into the Claude Code config dir (additive, non-clobbering)
run("node scripts/install.mjs --dry-run");
run("node scripts/install.mjs");

// 6. Verify: boot the server briefly and hit the API
const { loadConfig } = await import("../src/config.js");
const { openDb } = await import("../src/db.js");
const { loadPricing } = await import("../src/pricing.js");
const { backfill } = await import("../src/ingest.js");
const { buildServer, startServer } = await import("../src/server.js");

const config = loadConfig();
const db = openDb(config.dbPath);
backfill(db, loadPricing(), config.transcriptGlobDir);
const turns = db.prepare("SELECT COUNT(*) c FROM turns").get().c;
const app = buildServer({ db, rules: loadPricing(), config });
const port = await startServer(app, config);
const res = await fetch(`http://127.0.0.1:${port}/api/overview`);
if (!res.ok) fail(`verification request returned ${res.status}`);
const overview = await res.json();
await app.close();

console.log(`
[setup] ✅ COMPLETE
  - Config dir:        ${config.configDir}
  - Turns ingested:    ${turns}
  - 30-day spend seen: $${overview.month.toFixed(2)}
  - Dashboard verified on port ${port}

Next steps:
  npm start                 -> run ingestor + dashboard (http://localhost:${config.port})
  open a NEW Claude Code session -> hooks, /spend and /efficiency-audit are active
`);
