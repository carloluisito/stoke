import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env, overrides = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR
    ? path.resolve(env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  return {
    configDir,
    transcriptGlobDir: path.join(configDir, "projects"),
    dbPath: path.join(projectRoot, "data", "tokeff.db"),
    port: 5599,
    portRange: [5600, 5610],
    optimizerConfigPath: path.join(projectRoot, "plugin", "optimizer-config.json"),
    projectRoot,
    ...overrides,
  };
}
