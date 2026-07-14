import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";

function writeStokeConfig(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stokecfg-")), "config.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("~/.stoke/config.json monitor section", () => {
  it("persisted monitor.configDirs drives profiles when no env is set", () => {
    const STOKE_CONFIG = writeStokeConfig({
      monitor: { configDirs: ["~/.claude-work", "~/.claude-personal"] },
    });
    const cfg = loadConfig({ STOKE_CONFIG });
    expect(cfg.configDirs).toEqual([
      path.join(os.homedir(), ".claude-work"),
      path.join(os.homedir(), ".claude-personal"),
    ]);
    expect(cfg.transcriptGlobDirs).toHaveLength(2);
  });

  it("TOKEFF_CONFIG_DIRS env overrides the persisted list", () => {
    const STOKE_CONFIG = writeStokeConfig({ monitor: { configDirs: ["~/.claude-work"] } });
    const cfg = loadConfig({ STOKE_CONFIG, TOKEFF_CONFIG_DIRS: "~/.claude-adhoc" });
    expect(cfg.configDirs).toEqual([path.join(os.homedir(), ".claude-adhoc")]);
  });

  it("falls back to CLAUDE_CONFIG_DIR when the stoke config has no monitor.configDirs", () => {
    const STOKE_CONFIG = writeStokeConfig({ plan: "enterprise" });
    const cfg = loadConfig({ STOKE_CONFIG, CLAUDE_CONFIG_DIR: "~/.claude-work" });
    expect(cfg.configDirs).toEqual([path.join(os.homedir(), ".claude-work")]);
  });

  it("optimizer section is exposed on config when present", () => {
    const STOKE_CONFIG = writeStokeConfig({ optimizer: { levers: { bloat_hard_gate: "enforce" }, thresholds: {} } });
    const cfg = loadConfig({ STOKE_CONFIG });
    expect(cfg.optimizer.levers.bloat_hard_gate).toBe("enforce");
  });
});
