import { test } from "node:test";
import assert from "node:assert/strict";
import { computePingCostUsd } from "../src/pricing.ts";
import { defaultConfig } from "../src/config.ts";

test("computePingCostUsd: 100k Opus prefix at cache-read rate is $0.05", () => {
  const cfg = defaultConfig();
  const cost = computePingCostUsd(
    "claude-opus-4-7",
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 100_000,
    },
    cfg,
  );
  assert.equal(cost, 0.05);
});

test("computePingCostUsd: 61k Opus prefix ≈ $0.0031", () => {
  const cfg = defaultConfig();
  const cost = computePingCostUsd(
    "claude-opus-4-7",
    {
      input_tokens: 2,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 61_325,
    },
    cfg,
  );
  assert.equal(Math.round(cost * 1e6) / 1e6, 0.030673);
});

test("computePingCostUsd: unknown model returns 0", () => {
  const cfg = defaultConfig();
  const cost = computePingCostUsd("claude-unknown", {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 100_000,
  }, cfg);
  assert.equal(cost, 0);
});
