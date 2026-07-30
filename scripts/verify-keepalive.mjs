// Verify the hook-informed keepalive brake, end to end, on this machine.
//
//   npm run verify:keepalive
//
// Checks each link independently so a failure tells you WHICH one is broken:
//   1. hooks registered in every Claude profile (SessionEnd is the new one)
//   2. sidecar directory live, with current per-session state
//   3. the running proxy is not older than the code on disk
//   4. the brake itself, proven in isolation against a throwaway session id
//   5. real braking events observed so far
//
// Read-only except step 4, which creates and then deletes one sidecar for a
// fake session id. It never touches your real sessions and never stops the proxy.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STOKE_DIR = join(homedir(), ".stoke");
const STATE_DIR = join(STOKE_DIR, "session-state");
const EVENTS = join(STOKE_DIR, "events.jsonl");
const PROXY_URL = "http://127.0.0.1:9876";
const FAKE_ID = "verify00-0000-4aaa-8bbb-000000000001";

let failed = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); failed++; };
const warn = (m) => console.log(`  WARN  ${m}`);
const info = (m) => console.log(`        ${m}`);
const head = (n, t) => console.log(`\n[${n}] ${t}`);
const ago = (ms) => ms < 60000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60000)}m ago`;

// ---- 1. Hook registration -------------------------------------------------
head(1, "Claude Code hook registration");
// Only the profiles stoke is CONFIGURED to manage. Globbing ~/.claude* would
// flag unrelated profiles (.claude, .claudedesk, ...) that stoke deliberately
// leaves alone, turning "working correctly" into a wall of false failures.
// Precedence mirrors packages/monitor/src/config.js.
let profiles = [];
if (process.env.TOKEFF_CONFIG_DIRS) {
  profiles = process.env.TOKEFF_CONFIG_DIRS.split(",").map((d) => d.trim()).filter(Boolean);
  info("profiles from TOKEFF_CONFIG_DIRS");
} else {
  try {
    const c = JSON.parse(readFileSync(join(STOKE_DIR, "config.json"), "utf8"));
    if (Array.isArray(c.monitor?.configDirs)) profiles = c.monitor.configDirs;
  } catch { /* fall through */ }
  info(`profiles from ~/.stoke/config.json -> monitor.configDirs`);
}
profiles = profiles.filter((d) => existsSync(join(d, "settings.json")));

if (!profiles.length) {
  fail("no managed Claude profile found — run: node packages/cli/bin/stoke.mjs install");
}
const unmanaged = readdirSync(homedir())
  .filter((d) => d.startsWith(".claude") && existsSync(join(homedir(), d, "settings.json")))
  .map((d) => join(homedir(), d))
  .filter((d) => !profiles.includes(d));
if (unmanaged.length) {
  info(`not managed by stoke (ignored): ${unmanaged.map((d) => d.replace(homedir(), "~")).join(", ")}`);
}
for (const p of profiles) {
  let s;
  try {
    s = JSON.parse(readFileSync(join(p, "settings.json"), "utf8"));
  } catch {
    fail(`${p}: settings.json unreadable`);
    continue;
  }
  for (const ev of ["SessionEnd", "Stop", "UserPromptSubmit"]) {
    const cmds = (s.hooks?.[ev] ?? []).flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ""));
    const mine = cmds.find((c) => c.includes("plugin") && c.includes("hooks"));
    if (!mine) {
      fail(`${p}: no stoke ${ev} hook registered${ev === "SessionEnd" ? " -> run: node packages/cli/bin/stoke.mjs install" : ""}`);
      continue;
    }
    // The command embeds an absolute path; confirm the script actually exists there.
    const scriptPath = (mine.match(/"([^"]+\.mjs)"/) ?? mine.match(/(\S+\.mjs)/) ?? [])[1];
    if (scriptPath && !existsSync(scriptPath)) {
      fail(`${p}: ${ev} points at a missing script (${scriptPath}) -> re-run stoke install`);
    } else {
      pass(`${p.replace(homedir(), "~")}: ${ev}`);
    }
  }
}

// ---- 2. Sidecar directory -------------------------------------------------
head(2, "Session-state sidecars");
if (!existsSync(STATE_DIR)) {
  fail(`${STATE_DIR} does not exist — no hook has run yet. Send one prompt in a Claude Code session, then re-run.`);
} else {
  const files = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) {
    warn("directory exists but is empty — send a prompt in a Claude Code session, then re-run");
  } else {
    pass(`${files.length} session(s) reporting state`);
    for (const f of files) {
      try {
        const r = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8"));
        info(`${r.state.padEnd(11)} ${ago(Date.now() - r.ts).padEnd(10)} ${r.cwd || "(no cwd)"}`);
      } catch {
        warn(`${f} is not valid JSON (harmless: the proxy ignores it)`);
      }
    }
  }
}

// ---- 3. Is the running proxy older than the code? -------------------------
head(3, "Running proxy vs. code on disk");
let health = null;
try {
  const res = await fetch(`${PROXY_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
  health = await res.json();
} catch {
  warn("proxy not reachable on 9876 — start it with: npm start");
}
if (health) {
  const startedAt = Date.now() - health.uptimeSeconds * 1000;
  const srcDir = join(ROOT, "packages", "proxy", "src");
  let newest = 0, newestFile = "";
  for (const f of readdirSync(srcDir)) {
    const m = statSync(join(srcDir, f)).mtimeMs;
    if (m > newest) { newest = m; newestFile = f; }
  }
  info(`proxy up ${Math.round(health.uptimeSeconds / 3600)}h (since ${new Date(startedAt).toISOString()})`);
  if (newest > startedAt) {
    fail(`STALE: ${newestFile} changed after the proxy started — it is running OLD code.`);
    info("restart it:  node packages/cli/bin/stoke.mjs stop  &&  npm start");
  } else {
    pass("proxy started after the newest source change — running current code");
  }
}

// ---- 4. Prove the brake in isolation -------------------------------------
head(4, "Brake self-test (isolated, uses a throwaway session id)");
const sidecar = join(STATE_DIR, `${FAKE_ID}.json`);
try {
  const { Registry } = await import(`file://${join(ROOT, "packages/proxy/src/registry.ts").replaceAll("\\", "/")}`);
  const { runSchedulerTick } = await import(`file://${join(ROOT, "packages/proxy/src/scheduler.ts").replaceAll("\\", "/")}`);
  const { JsonlLogger } = await import(`file://${join(ROOT, "packages/proxy/src/logger.ts").replaceAll("\\", "/")}`);
  const { BudgetGuard } = await import(`file://${join(ROOT, "packages/proxy/src/budget.ts").replaceAll("\\", "/")}`);
  const { defaultConfig } = await import(`file://${join(ROOT, "packages/proxy/src/config.ts").replaceAll("\\", "/")}`);

  const NO_RL = { unified5hUtilization: null, unified7dUtilization: null, unified5hResetEpoch: null, overageStatus: null };
  const config = defaultConfig();
  info(`state dir the proxy will read: ${config.hookSignals.stateDir}`);

  const seed = (lastRealAt) => {
    const registry = new Registry();
    const { key } = registry.upsert(
      {
        model: "claude-opus-4-7", tools: [], system: "verify",
        messages: [{ role: "user", content: `<stoke-session>${FAKE_ID}</stoke-session>` }],
      },
      "Bearer verify", lastRealAt,
    );
    registry.recordRealUsage(key, {
      input_tokens: 1, output_tokens: 0,
      cache_creation_input_tokens: 60000, cache_read_input_tokens: 0,
    }, NO_RL);
    return { registry, key };
  };
  const tick = async (registry, nowMs) => {
    let pinged = false;
    await runSchedulerTick({
      registry,
      logger: new JsonlLogger(join(process.env.TEMP ?? "/tmp", `verify-keepalive-${Date.now()}.jsonl`)),
      config,
      guard: new BudgetGuard(config),
      fetcher: async () => {
        pinged = true;
        return {
          status: 200,
          usage: { input_tokens: 2, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 60000 },
          ratelimits: NO_RL,
        };
      },
      nowMs, spendUsdToday: 0, spendUsdMonth: 0, pingsToday: 0,
    });
    return pinged;
  };

  if (existsSync(sidecar)) unlinkSync(sidecar);

  // 4a. Baseline: no signal at all -> must still ping (pre-hook behavior intact).
  {
    const t = Date.now();
    const { registry, key } = seed(t);
    const pinged = await tick(registry, t + 300_000);
    if (pinged && registry.get(key).state === "active") pass("no signal -> still pings (unchanged behavior preserved)");
    else fail(`no signal -> expected a ping, got pinged=${pinged} state=${registry.get(key).state}`);
    if (registry.get(key).claudeSessionId === FAKE_ID) pass("marker binding: session_id recovered from the payload");
    else fail(`marker binding failed: got ${registry.get(key).claudeSessionId}`);
  }

  // 4b. Run the REAL SessionEnd hook exactly as Claude Code invokes it.
  const hook = join(ROOT, "packages/monitor/plugin/hooks/session-end.mjs");
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: FAKE_ID, cwd: "verify-only" }),
    encoding: "utf8",
  });
  if (r.status === 0 && existsSync(sidecar)) pass("session-end.mjs wrote an 'ended' sidecar");
  else fail(`session-end.mjs did not produce a sidecar (exit ${r.status})`);

  if (existsSync(sidecar)) {
    const endedTs = JSON.parse(readFileSync(sidecar, "utf8")).ts;

    // 4c. The brake.
    {
      const { registry, key } = seed(endedTs - 1000);
      const pinged = await tick(registry, endedTs + 300_000);
      if (!pinged && registry.get(key).state === "abandoned") pass("after SessionEnd -> NO ping, session abandoned  <-- the brake");
      else fail(`brake did not fire: pinged=${pinged} state=${registry.get(key).state}`);
    }

    // 4d. Stale-signal guard: a real request after the signal must win.
    {
      const { registry, key } = seed(endedTs + 5000);
      const pinged = await tick(registry, endedTs + 300_000);
      if (pinged && registry.get(key).state === "active") pass("real request postdating the signal -> pings again (stale-signal guard)");
      else fail(`stale-signal guard failed: pinged=${pinged} state=${registry.get(key).state}`);
    }
  }
} catch (e) {
  fail(`self-test could not run: ${e.message}`);
} finally {
  if (existsSync(sidecar)) unlinkSync(sidecar);
  if (!existsSync(sidecar)) info("cleaned up the throwaway sidecar");
}

// ---- 5. Real braking events so far ---------------------------------------
head(5, "Real braking events in the log");
if (!existsSync(EVENTS)) {
  warn(`${EVENTS} not found`);
} else {
  const counts = {};
  let braked = [];
  for (const line of readFileSync(EVENTS, "utf8").split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind !== "session_paused") continue;
    counts[e.reason] = (counts[e.reason] ?? 0) + 1;
    if (e.reason === "claude_session_ended") braked.push(e);
  }
  info(`pause reasons all-time: ${JSON.stringify(counts)}`);
  if (braked.length) {
    pass(`${braked.length} session(s) braked by SessionEnd — the feature is live and firing`);
    info(`most recent: ${braked[braked.length - 1].ts}`);
  } else {
    warn("no claude_session_ended events yet.");
    info("Expected until you (a) restart the proxy and (b) fully exit a Claude Code session.");
    info("To produce one: open a session, send a prompt, then /exit. Re-run this within ~1 min.");
  }
}

console.log(failed ? `\nRESULT: ${failed} check(s) FAILED\n` : "\nRESULT: all checks passed\n");
process.exit(failed ? 1 : 0);
