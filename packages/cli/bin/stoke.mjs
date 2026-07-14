#!/usr/bin/env node
// The `stoke` command — one app: cache keep-alive proxy + spend monitor +
// one dashboard. `stoke start` supervises both processes with crash
// isolation; everything else is thin plumbing.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { startSupervisor } from "../src/supervisor.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const proxyDir = path.join(repoRoot, "packages", "proxy");
const monitorDir = path.join(repoRoot, "packages", "monitor");
const stokeDir = path.join(os.homedir(), ".stoke");
const pidFile = path.join(stokeDir, "supervisor.pid");
const logFile = path.join(stokeDir, "supervisor.log");

const [, , command, ...rest] = process.argv;

const USAGE = `usage: stoke <command>

  start [--quiet]        start proxy (9876) + monitor (5599) under supervision
  stop                   stop the supervisor and both children (by exact PID)
  status                 health + today's net cost
  run -- <cmd> [...]     start everything, run <cmd> through the proxy, shared lifetime
  replay|tail|digest     proxy log tooling (passthrough)
  unset-env              remove the persistent ANTHROPIC_BASE_URL
  install [--migrate-db <path>] [--no-task]
                         Claude Code hooks/skills/statusline + login auto-start task
  uninstall              remove the login task and the persistent env var
`;

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(700, () => done(false));
  });
}

async function fetchJson(url, timeoutMs = 900) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(pidFile, "utf8")); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Proxy subcommands run through tsx (a workspace devDependency), resolved by
// node's module lookup from the proxy package directory.
function proxyPassthrough(args, { inherit = true } = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: proxyDir,
    stdio: inherit ? "inherit" : "pipe",
  });
  return r.status ?? 1;
}

async function cmdStart() {
  const quiet = rest.includes("--quiet");
  fs.mkdirSync(stokeDir, { recursive: true });

  const existing = readPidFile();
  if (existing?.supervisor && pidAlive(existing.supervisor)) {
    console.error(`stoke is already running (supervisor pid ${existing.supervisor}). Use 'stoke status' or 'stoke stop'.`);
    process.exit(1);
  }

  const children = [];
  if (await portInUse(9876)) {
    console.log("Port 9876 is already served — an existing proxy is running. Leaving it alone; starting the monitor only.");
  } else {
    children.push({
      name: "proxy",
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "start"],
      cwd: proxyDir,
    });
  }
  if (await portInUse(5599)) {
    console.log("Port 5599 is already served — an existing monitor is running. Not starting a second one.");
  } else {
    children.push({
      name: "monitor",
      command: process.execPath,
      args: ["scripts/start.mjs"],
      cwd: monitorDir,
    });
  }
  if (children.length === 0) {
    console.log("Everything is already running. Dashboard: http://localhost:5599");
    return;
  }

  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    try { fs.appendFileSync(logFile, stamped + "\n"); } catch { /* best effort */ }
    if (!quiet) console.log(line);
  };

  let sup;
  const writePids = () => {
    try {
      const statuses = sup?.statuses() ?? {};
      fs.writeFileSync(pidFile, JSON.stringify({
        supervisor: process.pid,
        children: Object.fromEntries(Object.entries(statuses).map(([n, s]) => [n, s.pid])),
      }, null, 2));
    } catch { /* best effort */ }
  };
  sup = startSupervisor(children, { log, onChange: () => writePids() });
  writePids();

  const shutdown = () => {
    log("[supervisor] stopping (user request)");
    sup.stop();
    try { fs.unlinkSync(pidFile); } catch { /* gone */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`[supervisor] stoke is up — dashboard http://localhost:5599 · log ${logFile}`);
}

async function cmdStop() {
  const info = readPidFile();
  if (!info) {
    console.log("No supervisor pidfile — nothing that stoke started is tracked. (A proxy started manually is intentionally left alone.)");
    return;
  }
  // Children first, then the supervisor — exact PIDs only.
  for (const [name, pid] of Object.entries(info.children ?? {})) {
    if (pid && pidAlive(pid)) {
      try { process.kill(pid); console.log(`stopped ${name} (pid ${pid})`); } catch { /* gone */ }
    }
  }
  if (info.supervisor && info.supervisor !== process.pid && pidAlive(info.supervisor)) {
    try { process.kill(info.supervisor); console.log(`stopped supervisor (pid ${info.supervisor})`); } catch { /* gone */ }
  }
  try { fs.unlinkSync(pidFile); } catch { /* gone */ }
}

async function cmdStatus() {
  const [health, overview] = await Promise.all([
    fetchJson("http://127.0.0.1:9876/api/health"),
    fetchJson("http://127.0.0.1:5599/api/overview"),
  ]);
  console.log(`proxy   (9876): ${health ? `UP — uptime ${Math.floor((health.uptimeSeconds ?? 0) / 60)}m, v${health.version}` : "DOWN — cache keep-alive inactive"}`);
  console.log(`monitor (5599): ${overview ? "UP — dashboard http://localhost:5599" : "DOWN — spend tracking/dashboard offline"}`);
  if (overview?.netCost) {
    const n = overview.netCost;
    console.log(`today: net $${(n.netCostUsd ?? 0).toFixed(2)}  (spend $${(n.spendUsd ?? 0).toFixed(2)} + pings $${(n.pingSpendUsd ?? 0).toFixed(2)} − prevented $${(n.preventedUsd ?? 0).toFixed(2)})`);
  }
  const info = readPidFile();
  if (info?.supervisor) {
    console.log(`supervisor: pid ${info.supervisor} ${pidAlive(info.supervisor) ? "(alive)" : "(stale pidfile)"}`);
  }
}

// Claude Code profiles to install into: TOKEFF_CONFIG_DIRS env wins, then
// CLAUDE_CONFIG_DIR, then every ~/.claude* dir that looks like a profile
// (has settings.json or projects/). Multi-profile setups (.claude-work +
// .claude-personal) get hooks and transcript-watching in all of them.
function detectProfiles() {
  if (process.env.TOKEFF_CONFIG_DIRS) {
    return process.env.TOKEFF_CONFIG_DIRS.split(/[,;]/).map((p) => path.resolve(p.trim())).filter(Boolean);
  }
  if (process.env.CLAUDE_CONFIG_DIR) return [path.resolve(process.env.CLAUDE_CONFIG_DIR)];
  const home = os.homedir();
  const found = [];
  for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.claude($|-)/.test(entry.name)) continue;
    const dir = path.join(home, entry.name);
    if (fs.existsSync(path.join(dir, "settings.json")) || fs.existsSync(path.join(dir, "projects"))) {
      found.push(dir);
    }
  }
  return found.length > 0 ? found : [path.join(home, ".claude")];
}

/** Persist monitor + optimizer sections into ~/.stoke/config.json (additive). */
function persistStokeConfig(configDirs) {
  const cfgPath = path.join(stokeDir, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch { /* fresh */ }
  cfg.monitor = { ...(cfg.monitor ?? {}), configDirs };
  if (!cfg.optimizer) {
    try {
      cfg.optimizer = JSON.parse(fs.readFileSync(path.join(monitorDir, "plugin", "optimizer-config.json"), "utf8"));
    } catch { /* optimizer defaults stay in the plugin file */ }
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

function cmdInstall() {
  fs.mkdirSync(stokeDir, { recursive: true });

  const profiles = detectProfiles();
  const cfgPath = persistStokeConfig(profiles);
  console.log(`Claude profiles: ${profiles.join(", ")}`);
  console.log(`Persisted to ${cfgPath} (monitor.configDirs + optimizer levers)`);

  // 1. Optional DB migration from the pre-merge tokeff install.
  const mIdx = rest.indexOf("--migrate-db");
  if (mIdx !== -1 && rest[mIdx + 1]) {
    const src = path.resolve(rest[mIdx + 1]);
    const target = path.join(stokeDir, "stoke.db");
    if (!fs.existsSync(src)) {
      console.log(`migrate-db: source not found (${src}) — skipped`);
    } else if (fs.existsSync(target)) {
      console.log(`migrate-db: ${target} already exists — left untouched`);
    } else {
      fs.copyFileSync(src, target);
      console.log(`migrate-db: copied ${src} -> ${target}`);
    }
  }

  // 2. Claude Code hooks / skills / agents / statusline — into every profile.
  const r = spawnSync(process.execPath, ["scripts/install.mjs"], {
    cwd: monitorDir,
    stdio: "inherit",
    env: { ...process.env, TOKEFF_CONFIG_DIRS: profiles.join(",") },
  });
  if (r.status !== 0) {
    console.error("Claude Code integration install failed — see output above.");
    process.exit(r.status ?? 1);
  }

  // 3. Auto-start at logon. schtasks /SC ONLOGON needs elevation, so fall
  // back to a hidden-window launcher in the user's Startup folder.
  if (!rest.includes("--no-task") && process.platform === "win32") {
    const stokeBin = fileURLToPath(import.meta.url);
    const tr = `"${process.execPath}" "${stokeBin}" start --quiet`;
    const t = spawnSync("schtasks", ["/Create", "/TN", "Stoke", "/TR", tr, "/SC", "ONLOGON", "/F"], { stdio: "pipe" });
    if (t.status === 0) {
      console.log("Scheduled Task 'Stoke' registered — stoke starts at every logon.");
    } else {
      const startupDir = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
      const vbs = path.join(startupDir, "stoke.vbs");
      const escaped = (p) => `""${p}""`;
      fs.mkdirSync(startupDir, { recursive: true });
      fs.writeFileSync(vbs, `' Auto-start stoke (cache keep-alive proxy + spend monitor) at logon, hidden.\r\nCreateObject("Wscript.Shell").Run "${escaped(process.execPath)} ${escaped(stokeBin)} start --quiet", 0, False\r\n`);
      console.log(`Scheduled Task needs elevation — wrote Startup launcher instead: ${vbs}`);
    }
  }

  console.log("\nInstall complete. ANTHROPIC_BASE_URL is set automatically the first time the proxy starts.");
}

function cmdUninstall() {
  if (process.platform === "win32") {
    const t = spawnSync("schtasks", ["/Delete", "/TN", "Stoke", "/F"], { stdio: "pipe" });
    console.log(t.status === 0 ? "Scheduled Task 'Stoke' removed." : "Scheduled Task 'Stoke' not present.");
    const vbs = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "stoke.vbs");
    try { fs.unlinkSync(vbs); console.log("Startup launcher removed."); } catch { /* not present */ }
  }
  proxyPassthrough(["unset-env"]);
  console.log("Claude Code hooks/skills were left in place — remove them from your CLAUDE_CONFIG_DIR settings.json if you want them gone.");
}

switch (command) {
  case "start":
    await cmdStart();
    break;
  case "stop":
    await cmdStop();
    break;
  case "status":
    await cmdStatus();
    break;
  case "run":
  case "replay":
  case "tail":
  case "digest":
  case "unset-env":
    process.exit(proxyPassthrough([command, ...rest]));
    break;
  case "install":
    cmdInstall();
    break;
  case "uninstall":
    cmdUninstall();
    break;
  default:
    console.log(USAGE);
    process.exit(command ? 2 : 0);
}
