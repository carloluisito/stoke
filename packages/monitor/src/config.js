import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env, overrides = {}) {
  // Multi-profile: TOKEFF_CONFIG_DIRS="~/.claude-work,~/.claude-personal" watches
  // and installs into every listed profile. Falls back to CLAUDE_CONFIG_DIR, then ~/.claude.
  const expand = (p) => path.resolve(p.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
  const configDirs = env.TOKEFF_CONFIG_DIRS
    ? env.TOKEFF_CONFIG_DIRS.split(/[,;]/).map(expand).filter(Boolean)
    : [env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude")];
  const configDir = configDirs[0];
  return {
    configDir,
    configDirs,
    transcriptGlobDir: path.join(configDir, "projects"),
    transcriptGlobDirs: configDirs.map(d => path.join(d, "projects")),
    dbPath: path.join(projectRoot, "data", "tokeff.db"),
    port: 5599,
    portRange: [5600, 5610],
    optimizerConfigPath: path.join(projectRoot, "plugin", "optimizer-config.json"),
    projectRoot,
    ...overrides,
  };
}
