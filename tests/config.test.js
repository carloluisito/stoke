import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import path from "node:path";
import os from "node:os";

describe("loadConfig", () => {
  it("uses CLAUDE_CONFIG_DIR when set", () => {
    const c = loadConfig({ CLAUDE_CONFIG_DIR: "C:/x/.claude-work" });
    expect(c.configDir).toBe(path.resolve("C:/x/.claude-work"));
    expect(c.transcriptGlobDir).toBe(path.join(path.resolve("C:/x/.claude-work"), "projects"));
  });
  it("falls back to ~/.claude", () => {
    const c = loadConfig({});
    expect(c.configDir).toBe(path.join(os.homedir(), ".claude"));
  });
  it("defaults port 5599 and range excludes 9876", () => {
    const c = loadConfig({});
    expect(c.port).toBe(5599);
    expect(c.portRange).toEqual([5600, 5610]);
  });
  it("accepts overrides", () => {
    const c = loadConfig({}, { port: 6001 });
    expect(c.port).toBe(6001);
  });
  it("supports multiple profiles via TOKEFF_CONFIG_DIRS", () => {
    const c = loadConfig({ TOKEFF_CONFIG_DIRS: "C:/x/.claude-work, C:/x/.claude-personal" });
    expect(c.configDirs).toEqual([path.resolve("C:/x/.claude-work"), path.resolve("C:/x/.claude-personal")]);
    expect(c.transcriptGlobDirs).toEqual([
      path.join(path.resolve("C:/x/.claude-work"), "projects"),
      path.join(path.resolve("C:/x/.claude-personal"), "projects"),
    ]);
    expect(c.configDir).toBe(path.resolve("C:/x/.claude-work")); // first dir stays the primary
  });
  it("single profile still yields one-element configDirs", () => {
    const c = loadConfig({ CLAUDE_CONFIG_DIR: "C:/x/.claude-work" });
    expect(c.configDirs).toEqual([path.resolve("C:/x/.claude-work")]);
  });
  it("expands ~ to the home directory", () => {
    const c = loadConfig({ TOKEFF_CONFIG_DIRS: "~/.claude-work,~/.claude-personal" });
    expect(c.configDirs).toEqual([
      path.join(os.homedir(), ".claude-work"),
      path.join(os.homedir(), ".claude-personal"),
    ]);
  });
});
