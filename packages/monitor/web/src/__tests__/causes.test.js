import { describe, it, expect } from "vitest";
import { CAUSES, causeFor, KNOWN_TYPES, interventionCopy, KIND_BADGE } from "../lib/causes.js";

// Every type runDetectors() can emit, per src/analytics/detectors.js.
const DETECTOR_TYPES = [
  "cache_expiry",
  "cache_invalidation",
  "session_bloat",
  "output_verbosity",
  "model_mismatch",
];

describe("causes taxonomy", () => {
  it("covers every type the detectors emit", () => {
    for (const t of DETECTOR_TYPES) {
      expect(CAUSES[t], `missing copy for detector type "${t}"`).toBeDefined();
    }
  });

  it("exports the known types for iteration", () => {
    expect([...KNOWN_TYPES].sort()).toEqual([...DETECTOR_TYPES].sort());
  });

  it("gives every cause a title, a why, a fix and a route", () => {
    for (const [type, c] of Object.entries(CAUSES)) {
      expect(c.title, `${type}.title`).toBeTruthy();
      expect(c.why, `${type}.why`).toBeTruthy();
      expect(c.fix, `${type}.fix`).toBeTruthy();
      expect(c.route, `${type}.route`).toBeTruthy();
    }
  });

  it("uses no jargon in landing-screen copy", () => {
    const banned = /\bTTL\b|\bMTok\b|cache write|cache read|fresh input|\bproxy\b|attribution|\blever\b/i;
    for (const [type, c] of Object.entries(CAUSES)) {
      expect(banned.test(c.title), `${type}.title has jargon: ${c.title}`).toBe(false);
      expect(banned.test(c.why), `${type}.why has jargon: ${c.why}`).toBe(false);
    }
  });

  it("routes every cause to a real dashboard tab", () => {
    const TABS = new Set(["overview", "sessions", "proxy", "waste"]);
    for (const [type, c] of Object.entries(CAUSES)) {
      expect(TABS.has(c.route), `${type}.route "${c.route}" is not a tab`).toBe(true);
    }
  });

  it("falls back to the raw type instead of rendering blank", () => {
    const c = causeFor("some_new_detector");
    expect(c.title).toBe("some_new_detector");
    expect(c.why).toBeTruthy();
    expect(c.fix).toBeTruthy();
    expect(c.route).toBe("waste");
  });

  it("never returns undefined for junk input", () => {
    for (const bad of [null, undefined, "", 0]) {
      expect(causeFor(bad)).toBeTruthy();
      expect(causeFor(bad).why).toBeTruthy();
    }
  });
});

// The exact strings the hooks in plugin/hooks/*.mjs write into the interventions
// table. This list is the contract: if a hook's wording changes, the matching
// test fails and the copy has to be updated with it.
const REAL_MESSAGES = [
  ["efficiency_conventions", "injected efficiency conventions", "enforce"],
  ["efficiency_conventions", "session started (observe only)", "observe"],
  ["efficiency_conventions", "verbosity directive injected (mean output ~3120 tokens over last 3 turns)", "enforce"],
  ["cache_expiry_warning", "[tokeff] Prompt cache expired (gap 268m > TTL 60m) — this turn re-bills ~184k context tokens at full input price.", "enforce"],
  ["context_bloat_warning", "[tokeff] Context is ~152k tokens per turn. /compact (or /clear + restate the task) will stop re-billing dead context.", "enforce"],
  ["bloat_hard_gate", "BLOCKED prompt at ~409k context tokens", "enforce"],
  ["wasteful_read_warning", "BLOCKED full re-read of C:\\repo\\big.js (412KB); redirected to targeted read", "enforce"],
  ["wasteful_read_warning", "[tokeff] C:\\repo\\big.js (412KB) was already read this session — a full re-read re-bills all of it. Prefer a targeted range or grep.", "suggest"],
  ["session_cost_record", "session cost so far: $12.3456 across 48 turns", "enforce"],
];

describe("intervention log copy", () => {
  it("rewrites every real hook message into plain language", () => {
    for (const [lever, message, mode] of REAL_MESSAGES) {
      const c = interventionCopy(lever, message, mode);
      expect(c.title, `${lever} title`).toBeTruthy();
      // The whole point: the reader must not be shown the raw hook string.
      expect(c.title, `${lever} still shows the raw message`).not.toBe(message);
      expect(KIND_BADGE[c.kind], `${lever} kind "${c.kind}" has no badge`).toBeTruthy();
    }
  });

  it("uses no jargon in either line", () => {
    const banned = /\bTTL\b|\bMTok\b|cache write|cache read|fresh input|\bproxy\b|attribution|\blever\b|directive|inject|context tokens|re-bills ~/i;
    for (const [lever, message, mode] of REAL_MESSAGES) {
      const c = interventionCopy(lever, message, mode);
      expect(banned.test(c.title), `${lever}.title has jargon: ${c.title}`).toBe(false);
      expect(banned.test(c.detail), `${lever}.detail has jargon: ${c.detail}`).toBe(false);
    }
  });

  it("keeps the numbers that make a row meaningful", () => {
    expect(interventionCopy("bloat_hard_gate", "BLOCKED prompt at ~409k context tokens").title).toContain("409k");
    const stale = interventionCopy("cache_expiry_warning", REAL_MESSAGES[3][1]);
    expect(stale.detail).toContain("4 hours"); // 268 minutes, said in a unit a person reads
    expect(stale.detail).toContain("60-minute");
    expect(stale.detail).toContain("184k");
    expect(interventionCopy("context_bloat_warning", REAL_MESSAGES[4][1]).title).toContain("152k");
    expect(interventionCopy("efficiency_conventions", REAL_MESSAGES[2][1]).detail).toContain("3,120");
    expect(interventionCopy("session_cost_record", REAL_MESSAGES[8][1]).title).toContain("$12.35");
    expect(interventionCopy("session_cost_record", REAL_MESSAGES[8][1]).detail).toContain("48 messages");
  });

  it("says an idle gap in a unit a person reads", () => {
    const gap = (m) => interventionCopy("cache_expiry_warning", `[tokeff] Prompt cache expired (gap ${m}m > TTL 60m) — this turn re-bills ~10k context tokens at full input price.`).detail;
    expect(gap(1)).toContain("1 minute,");     // singular
    expect(gap(65)).toContain("65 minutes");   // still minutes below 90
    expect(gap(268)).toContain("4 hours");
    expect(gap(1488)).toContain("25 hours");
    expect(gap(4320)).toContain("3 days");     // 72h reads as days
  });

  it("names the file on a re-read, in both blocked and warned form", () => {
    const blocked = interventionCopy("wasteful_read_warning", REAL_MESSAGES[6][1]);
    expect(blocked.kind).toBe("blocked");
    expect(blocked.detail).toContain("big.js");
    expect(blocked.detail).toContain("412KB");
    const warned = interventionCopy("wasteful_read_warning", REAL_MESSAGES[7][1], "suggest");
    expect(warned.kind).toBe("warned");
    expect(warned.detail).toContain("big.js");
  });

  it("says nothing happened when a lever is only watching", () => {
    for (const [lever, message] of REAL_MESSAGES) {
      expect(interventionCopy(lever, message, "observe").kind).toBe("watched");
    }
  });

  it("marks cost records as bookkeeping rather than a step stoke took", () => {
    const c = interventionCopy("session_cost_record", REAL_MESSAGES[8][1]);
    expect(c.kind).toBe("logged");
    expect(c.detail).toMatch(/did not step in/i);
  });

  it("marks only the rows that repeat every session as routine", () => {
    const routine = (i) => interventionCopy(REAL_MESSAGES[i][0], REAL_MESSAGES[i][1], REAL_MESSAGES[i][2]).routine;
    expect(routine(0), "session-start rules").toBe(true);   // injected efficiency conventions
    expect(routine(1), "observe-only start").toBe(true);
    expect(routine(8), "session cost record").toBe(true);
    // Everything else is news and must never be collapsed behind the toggle.
    for (const i of [2, 3, 4, 5, 6, 7]) {
      expect(routine(i), `${REAL_MESSAGES[i][0]} #${i} was hidden as routine`).toBe(false);
    }
  });

  it("keeps the verbosity nudge visible even though it shares a lever with the routine one", () => {
    const nudge = interventionCopy("efficiency_conventions", REAL_MESSAGES[2][1]);
    const start = interventionCopy("efficiency_conventions", REAL_MESSAGES[0][1]);
    expect(nudge.routine).toBe(false);
    expect(start.routine).toBe(true);
    expect(nudge.title).not.toBe(start.title);
  });

  it("falls back to the raw message for a lever added server-side", () => {
    const c = interventionCopy("some_new_lever", "did a new thing");
    expect(c.title).toBe("did a new thing");
    expect(KIND_BADGE[c.kind]).toBeTruthy();
  });

  it("never throws or returns undefined on junk input", () => {
    for (const bad of [null, undefined, "", 0, 123, {}]) {
      const c = interventionCopy(bad, bad, bad);
      expect(c).toBeTruthy();
      expect(typeof c.title).toBe("string");
      expect(typeof c.detail).toBe("string");
    }
  });
});
