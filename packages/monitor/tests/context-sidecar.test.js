import { describe, it, expect } from "vitest";
import { contextSidecarPayload, effectiveContextTokens } from "../src/context-sidecar.js";

describe("contextSidecarPayload", () => {
  const NOW = "2026-07-16T12:00:00.000Z";

  it("returns null when the statusline input has no context_window", () => {
    expect(contextSidecarPayload({}, NOW)).toBeNull();
    expect(contextSidecarPayload({ context_window: {} }, NOW)).toBeNull();
  });

  it("prefers total_input_tokens as the live context size", () => {
    const p = contextSidecarPayload({
      context_window: { total_input_tokens: 90000, total_output_tokens: 1200, context_window_size: 1000000, used_percentage: 9 },
    }, NOW);
    expect(p).toMatchObject({ usedTokens: 90000, pct: 9, size: 1000000, ts: NOW });
  });

  it("falls back to pct * size when total_input_tokens is absent", () => {
    const p = contextSidecarPayload({
      context_window: { context_window_size: 200000, used_percentage: 50 },
    }, NOW);
    expect(p.usedTokens).toBe(100000);
    expect(p.pct).toBe(50);
  });
});

describe("effectiveContextTokens", () => {
  const now = new Date("2026-07-16T12:00:00.000Z").getTime();
  const fresh = "2026-07-16T11:59:30.000Z"; // 30s ago
  const stale = "2026-07-16T11:55:00.000Z"; // 5m ago

  it("uses the live sidecar number when it is fresh", () => {
    const r = effectiveContextTokens({ lastTurnCtx: 572000, sidecar: { usedTokens: 90000, ts: fresh }, now });
    expect(r.tokens).toBe(90000);
    expect(r.source).toBe("live");
  });

  it("THE FIX: post-compact stale big DB turn is overridden by fresh small live number", () => {
    // last recorded turn (pre-compact) = 572k, live context after /compact = 90k
    const r = effectiveContextTokens({ lastTurnCtx: 572000, sidecar: { usedTokens: 90000, ts: fresh }, now });
    expect(r.tokens).toBe(90000); // gate must see 90k, not 572k
  });

  it("does NOT wrongly suppress: fresh live number that re-inflated is honored", () => {
    // compact dropped to 125k but this turn re-read files -> live 405k
    const r = effectiveContextTokens({ lastTurnCtx: 125000, sidecar: { usedTokens: 405000, ts: fresh }, now });
    expect(r.tokens).toBe(405000);
    expect(r.source).toBe("live");
  });

  it("falls back to the DB turn when the sidecar is stale", () => {
    const r = effectiveContextTokens({ lastTurnCtx: 572000, sidecar: { usedTokens: 90000, ts: stale }, now });
    expect(r.tokens).toBe(572000);
    expect(r.source).toBe("db");
  });

  it("falls back to the DB turn when the sidecar is missing", () => {
    const r = effectiveContextTokens({ lastTurnCtx: 572000, sidecar: null, now });
    expect(r.tokens).toBe(572000);
    expect(r.source).toBe("db");
  });

  it("falls back to the DB turn when the sidecar has an invalid usedTokens", () => {
    expect(effectiveContextTokens({ lastTurnCtx: 300000, sidecar: { usedTokens: null, ts: fresh }, now }).tokens).toBe(300000);
    expect(effectiveContextTokens({ lastTurnCtx: 300000, sidecar: { usedTokens: NaN, ts: fresh }, now }).tokens).toBe(300000);
  });

  it("respects a custom freshness window", () => {
    const r = effectiveContextTokens({ lastTurnCtx: 572000, sidecar: { usedTokens: 90000, ts: stale }, now, freshnessMs: 10 * 60000 });
    expect(r.tokens).toBe(90000); // 5m < 10m window
    expect(r.source).toBe("live");
  });
});
