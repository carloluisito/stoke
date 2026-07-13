import { describe, it, expect } from "vitest";
import {
  loadPricing,
  multipliersFor,
  inputPerMtok,
  inputPerMtokFromMap,
  defaultModelPricingMap,
} from "../src/pricing.js";

// Parity guarantees between the shared pricing rules and the proxy's
// historical multipliers: cache_read = 0.1× input, 5m rebuild = 1.25×,
// 1h rebuild = 2×. If a future pricing.json edit breaks these ratios the
// proxy's savings math and the monitor's turn pricing would silently diverge.
describe("shared pricing parity", () => {
  const rules = loadPricing();
  const now = "2026-07-13T00:00:00Z";

  it("multipliersFor matches the proxy's published multipliers for every model", () => {
    for (const model of ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]) {
      const m = multipliersFor(model, now, rules);
      expect(m, model).toBeDefined();
      expect(m.cacheRead, model).toBeCloseTo(0.1, 10);
      expect(m.rebuild5m, model).toBeCloseTo(1.25, 10);
      expect(m.rebuild1h, model).toBeCloseTo(2.0, 10);
    }
  });

  it("inputPerMtok resolves dated model ids through prefix rules", () => {
    expect(inputPerMtok("claude-fable-5", now, rules)).toBe(10);
    expect(inputPerMtok("claude-opus-4-8-20260401", now, rules)).toBe(5);
    expect(inputPerMtok("totally-unknown-model", now, rules)).toBe(5); // "" fallback rule
  });

  it("defaultModelPricingMap expands prefixes and inputPerMtokFromMap resolves full ids", () => {
    const map = defaultModelPricingMap(rules, now);
    expect(map["claude-fable-5"]).toEqual({ inputPerMtok: 10 });
    expect(map[""]).toBeUndefined(); // fallback prefix excluded
    expect(inputPerMtokFromMap("claude-fable-5[1m]", map)).toBe(10);
    expect(inputPerMtokFromMap("claude-opus-4-8-20260401", map)).toBe(5);
    expect(inputPerMtokFromMap("unknown-model", map)).toBe(0);
    // Exact entries (user overrides) beat prefix matches.
    expect(inputPerMtokFromMap("claude-fable-5", { ...map, "claude-fable-5": { inputPerMtok: 42 } })).toBe(42);
  });
});
