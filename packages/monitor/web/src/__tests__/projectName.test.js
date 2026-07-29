import { describe, it, expect } from "vitest";
import { projectName } from "../lib/projectName.js";

describe("projectName", () => {
  it("keeps the last two segments of a mangled Windows path", () => {
    expect(projectName("C--Users-carlo-Desktop-repositories-personal-omnidesk"))
      .toBe("personal/omnidesk");
  });
  it("keeps a multi-word trailing segment intact", () => {
    expect(projectName("C--Users-carlo-Desktop-repositories-personal-windlass-lms"))
      .toBe("personal/windlass-lms");
  });
  it("drops the repositories/Desktop scaffolding", () => {
    expect(projectName("C--Users-carlo-Desktop-repositories-ispade")).toBe("ispade");
  });
  it("handles a posix path", () => {
    expect(projectName("/home/me/code/work/api")).toBe("work/api");
  });
  it("returns a placeholder for empty input", () => {
    expect(projectName(null)).toBe("unknown");
    expect(projectName("")).toBe("unknown");
  });
  it("passes through a name that is already short", () => {
    expect(projectName("stoke")).toBe("stoke");
  });
  it("never returns an empty string for odd input", () => {
    expect(projectName("C--")).not.toBe("");
    expect(projectName("---")).not.toBe("");
  });

  // Regression: an earlier version stripped scaffolding words from anywhere in
  // the path, so a project genuinely named "project-home" collapsed to
  // "unknown" because "home" was on the strip list. Caught against real data.
  it("keeps scaffolding words that are part of the project name", () => {
    expect(projectName("C--Users-carlo-Desktop-repositories-work-project-home"))
      .toBe("work/project-home");
    expect(projectName("C--Users-carlo-Desktop-repositories-work-project-home-mychoreo-showcase"))
      .toBe("work/project-home-mychoreo-showcase");
  });

  it("keeps the group and name for a nested worktree path", () => {
    expect(projectName("C--Users-carlo-Desktop-repositories-personal-omnidesk--claude-worktrees-docs-align-cockpit"))
      .toMatch(/^personal\/omnidesk/);
  });

  it("never yields 'unknown' for any real project path", () => {
    const real = [
      "C--Users-carlo-Desktop-repositories-work-project-home",
      "C--Users-carlo-Desktop-repositories-ispade",
      "C--Users-carlo-Desktop-repositories-personal-windlass-lms",
      "C--Users-carlo-Desktop-repositories-personal-omnidesk",
      "C--Users-carlo-Desktop-repositories-work-resto-backend",
      "C--Users-carlo-Desktop-repositories-ispade-api",
      "C--Users-carlo-Desktop-repositories-work-my-brain",
      "C--Windows-System32",
    ];
    for (const p of real) {
      expect(projectName(p), p).not.toBe("unknown");
      expect(projectName(p), p).not.toBe("");
    }
  });
});
