import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { install } from "../scripts/install.mjs";

let configDir, projectRoot;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokeff-cfg-"));
  projectRoot = path.resolve(".");
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
    statusLine: { type: "command", command: "my-existing-statusline" },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "existing-hook" }] }],
    },
  }, null, 2));
});

describe("install", () => {
  it("copies agents and skills into the config dir", () => {
    install({ configDir, projectRoot });
    expect(fs.existsSync(path.join(configDir, "agents", "cheap-explore.md"))).toBe(true);
    expect(fs.existsSync(path.join(configDir, "agents", "cheap-search.md"))).toBe(true);
    expect(fs.existsSync(path.join(configDir, "skills", "spend", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(configDir, "skills", "efficiency-audit", "SKILL.md"))).toBe(true);
  });
  it("rewrites %TOKEFF_ROOT% in copied skills", () => {
    install({ configDir, projectRoot });
    const skill = fs.readFileSync(path.join(configDir, "skills", "spend", "SKILL.md"), "utf8");
    expect(skill).not.toMatch(/%TOKEFF_ROOT%/);
    expect(skill).toContain("report.mjs");
  });
  it("appends hooks without removing existing ones and never clobbers statusLine", () => {
    install({ configDir, projectRoot });
    const s = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
    expect(s.statusLine.command).toBe("my-existing-statusline"); // untouched
    const ssHooks = s.hooks.SessionStart.flatMap(m => m.hooks.map(h => h.command));
    expect(ssHooks).toContain("existing-hook");
    expect(ssHooks.some(c => c.includes("session-start.mjs"))).toBe(true);
    expect(s.hooks.UserPromptSubmit).toBeTruthy();
    expect(s.hooks.PreToolUse).toBeTruthy();
    expect(s.hooks.Stop).toBeTruthy();
  });
  it("sets statusLine when none exists", () => {
    fs.writeFileSync(path.join(configDir, "settings.json"), "{}");
    install({ configDir, projectRoot });
    const s = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
    expect(s.statusLine.command).toContain("statusline.mjs");
  });
  it("is idempotent (no duplicate hook entries on second run)", () => {
    install({ configDir, projectRoot });
    install({ configDir, projectRoot });
    const s = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
    const ssHooks = s.hooks.SessionStart.flatMap(m => m.hooks.map(h => h.command));
    expect(ssHooks.filter(c => c.includes("session-start.mjs")).length).toBe(1);
  });
  it("dry-run writes nothing", () => {
    const before = fs.readFileSync(path.join(configDir, "settings.json"), "utf8");
    install({ configDir, projectRoot, dryRun: true });
    expect(fs.readFileSync(path.join(configDir, "settings.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(configDir, "agents", "cheap-explore.md"))).toBe(false);
  });
});
