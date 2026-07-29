import { describe, it, expect } from "vitest";
import { CAUSES, causeFor, KNOWN_TYPES } from "../lib/causes.js";

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
