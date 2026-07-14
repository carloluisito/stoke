import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** ~/.stoke/config.json — one config file for proxy, monitor, and optimizer. */
export function stokeConfigPath(env = process.env) {
  return env.STOKE_CONFIG || path.join(os.homedir(), ".stoke", "config.json");
}

function readStokeConfig(env) {
  try {
    return JSON.parse(fs.readFileSync(stokeConfigPath(env), "utf8"));
  } catch {
    return {};
  }
}

export function loadConfig(env = process.env, overrides = {}) {
  // Multi-profile: TOKEFF_CONFIG_DIRS="~/.claude-work,~/.claude-personal" watches
  // and installs into every listed profile. Falls back to CLAUDE_CONFIG_DIR, then ~/.claude.
  const expand = (p) => path.resolve(p.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
  const stoke = readStokeConfig(env);
  const monitor = stoke.monitor ?? {};
  // Profile resolution order: TOKEFF_CONFIG_DIRS env (ad-hoc override) >
  // persisted monitor.configDirs in ~/.stoke/config.json (survives logon
  // auto-start, where no shell env is set) > CLAUDE_CONFIG_DIR > ~/.claude.
  const configDirs = env.TOKEFF_CONFIG_DIRS
    ? env.TOKEFF_CONFIG_DIRS.split(/[,;]/).map(expand).filter(Boolean)
    : Array.isArray(monitor.configDirs) && monitor.configDirs.length > 0
      ? monitor.configDirs.map(expand)
      : [env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude")];
  const configDir = configDirs[0];
  const stokeDir = path.join(os.homedir(), ".stoke");
  return {
    configDir,
    configDirs,
    transcriptGlobDir: path.join(configDir, "projects"),
    transcriptGlobDirs: configDirs.map(d => path.join(d, "projects")),
    // One database for everything, next to the proxy's own state.
    dbPath: env.TOKEFF_DB || monitor.dbPath || path.join(stokeDir, "stoke.db"),
    port: monitor.port ?? 5599,
    portRange: monitor.portRange ?? [5600, 5610],
    // The proxy's event log and loopback stats endpoint.
    proxyEventsPath: monitor.proxyEventsPath || path.join(stokeDir, "events.jsonl"),
    stokeStatsUrl: monitor.stokeStatsUrl || "http://127.0.0.1:9876/_stoke/stats",
    // Optimizer levers: the `optimizer` section of ~/.stoke/config.json wins;
    // the legacy plugin/optimizer-config.json remains the fallback.
    optimizer: stoke.optimizer,
    optimizerConfigPath: path.join(projectRoot, "plugin", "optimizer-config.json"),
    projectRoot,
    ...overrides,
  };
}
