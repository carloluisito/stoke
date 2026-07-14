// One-command setup for a new machine:
//   git clone <repo> && cd stoke && npm run setup [-- --migrate-db <path>]
//
// deps -> dashboard build -> full test gate -> stoke install (all Claude
// profiles, ~/.stoke config, auto-start) -> verify. Idempotent: safe to
// re-run; the installer never duplicates or clobbers settings, and an
// already-running proxy on 9876 is never touched.

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, cwd = root) => {
  console.log(`\n[setup] $ ${cmd}   (in ${path.relative(root, cwd) || "."})`);
  execSync(cmd, { cwd, stdio: "inherit" });
};
const fail = (msg) => { console.error(`\n[setup] FAILED: ${msg}`); process.exit(1); };

// 1. Node version gate (better-sqlite3 prebuilds + ESM features need >= 20;
//    on Windows, Node 22+ is recommended — see .github/workflows/test.yml).
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) fail(`Node >= 20 required, found ${process.versions.node}. Install from nodejs.org and re-run.`);
if (process.platform === "win32" && major < 22) {
  console.warn(`[setup] WARNING: Node ${process.versions.node} on Windows may need Visual Studio build tools for better-sqlite3. Node >= 22 is recommended.`);
}
console.log(`[setup] Node ${process.versions.node} OK`);

// 2. Dependencies (workspace root covers proxy/monitor/shared/cli; web is standalone)
run("npm install");
run("npm install", path.join(root, "packages", "monitor", "web"));

// 3. Build the dashboard frontend
run("npm run build", path.join(root, "packages", "monitor", "web"));
if (!fs.existsSync(path.join(root, "packages", "monitor", "web", "dist", "index.html"))) {
  fail("web build produced no dist/index.html");
}

// 4. Full test gate — install nothing if the suites fail on this machine
run("npm test");

// 5. Install: Claude Code hooks/skills/agents into every detected profile,
//    ~/.stoke/config.json (profiles + optimizer levers), auto-start at logon.
//    Extra args (e.g. --migrate-db <path>, --no-task) pass straight through.
const extra = process.argv.slice(2);
const r = spawnSync(process.execPath, [path.join(root, "packages", "cli", "bin", "stoke.mjs"), "install", ...extra], {
  cwd: root,
  stdio: "inherit",
});
if (r.status !== 0) fail("stoke install failed — see output above");

// 6. Verify the monitor boots against this machine's data (briefly, on an
//    ephemeral check — the real start happens via `npm start` / logon task).
const monitorDir = path.join(root, "packages", "monitor");
const { loadConfig } = await import(`file://${path.join(monitorDir, "src", "config.js").replaceAll("\\", "/")}`);
const { openDb } = await import(`file://${path.join(monitorDir, "src", "db.js").replaceAll("\\", "/")}`);
const { loadPricing } = await import(`file://${path.join(monitorDir, "src", "pricing.js").replaceAll("\\", "/")}`);
const { backfill } = await import(`file://${path.join(monitorDir, "src", "ingest.js").replaceAll("\\", "/")}`);
const { ingestProxyEvents } = await import(`file://${path.join(monitorDir, "src", "proxy-events.js").replaceAll("\\", "/")}`);
const { buildServer } = await import(`file://${path.join(monitorDir, "src", "server.js").replaceAll("\\", "/")}`);

const config = loadConfig();
const db = openDb(config.dbPath);
const rules = loadPricing();
for (const dir of config.transcriptGlobDirs) backfill(db, rules, dir);
ingestProxyEvents(db, config.proxyEventsPath);
const turns = db.prepare("SELECT COUNT(*) c FROM turns").get().c;
const app = buildServer({ db, rules, config });
// Ephemeral port: never collide with a running monitor (5599) or proxy (9876).
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;
const res = await fetch(`http://127.0.0.1:${port}/api/overview`);
if (!res.ok) fail(`verification request returned ${res.status}`);
const overview = await res.json();
await app.close();
db.close();

console.log(`
[setup] COMPLETE
  - Claude profiles watched: ${config.configDirs.join(", ")}
  - Database:                ${config.dbPath}
  - Turns ingested:          ${turns}
  - 30-day spend seen:       $${overview.month.toFixed(2)}

Next steps:
  npm start                        -> proxy (9876) + monitor + dashboard (http://localhost:${config.port})
  open a NEW shell + Claude Code   -> requests route through the proxy; /spend and /efficiency-audit are active
  (stoke also auto-starts at your next logon)
`);
