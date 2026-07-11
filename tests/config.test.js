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
});
