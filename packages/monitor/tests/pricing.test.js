import { describe, it, expect } from "vitest";
import { loadPricing, priceTurn, ruleFor } from "../src/pricing.js";

const rules = loadPricing();
const base = { input_tokens: 0, output_tokens: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 };

describe("priceTurn", () => {
  it("prices opus 4.8 input+output", () => {
    const { costUsd } = priceTurn({ ...base, model: "claude-opus-4-8", ts: "2026-07-11T10:00:00Z", input_tokens: 1_000_000, output_tokens: 1_000_000 }, rules);
    expect(costUsd).toBeCloseTo(30, 6);
  });
  it("applies TTL-specific cache write pricing", () => {
    const { costUsd } = priceTurn({ ...base, model: "claude-opus-4-8", ts: "2026-07-11T10:00:00Z", cache_write_5m: 1_000_000, cache_write_1h: 1_000_000 }, rules);
    expect(costUsd).toBeCloseTo(6.25 + 10, 6);
  });
  it("sonnet 5 intro pricing rolls over after 2026-08-31", () => {
    const before = priceTurn({ ...base, model: "claude-sonnet-5", ts: "2026-08-30T00:00:00Z", input_tokens: 1_000_000 }, rules).costUsd;
    const after  = priceTurn({ ...base, model: "claude-sonnet-5", ts: "2026-09-02T00:00:00Z", input_tokens: 1_000_000 }, rules).costUsd;
    expect(before).toBeCloseTo(2, 6);
    expect(after).toBeCloseTo(3, 6);
  });
  it("flags unknown models and uses fallback pricing", () => {
    const r = priceTurn({ ...base, model: "mystery-model", ts: "2026-07-11T00:00:00Z", input_tokens: 1_000_000 }, rules);
    expect(r.unknownModel).toBe(true);
    expect(r.costUsd).toBeCloseTo(5, 6);
  });
  it("ruleFor returns the matched rule", () => {
    const r = ruleFor("claude-haiku-4-5", "2026-07-11", rules);
    expect(r.input).toBe(1);
  });
});
