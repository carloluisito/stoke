import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/registry.ts";

test("Registry.serialize captures metadata, omits credentials", () => {
  const reg = new Registry();
  const { key } = reg.upsert(
    { model: "claude-opus-4-7", tools: [], system: "s", messages: [{ role: "user", content: "hi" }] },
    "Bearer secret",
    1000,
    "/v1/messages",
    { "x-api-key": "shhhh" },
  );
  reg.recordRealUsage(
    key,
    { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 50000, cache_read_input_tokens: 0 },
    { unified5hUtilization: null, unified7dUtilization: null, unified5hResetEpoch: null, overageStatus: null },
  );

  const serialized = reg.serialize();
  assert.equal(serialized.length, 1);
  const s = serialized[0] as unknown as Record<string, unknown>;
  assert.equal(s.model, "claude-opus-4-7");
  assert.equal(s.prefixTokensEstimate, 50000);
  assert.equal(s.lastAuthHeader, undefined);
  assert.equal(s.lastHeaders, undefined);
  assert.equal(s.lastPayload, undefined);
});

test("Registry.hydrate restores metadata; session is paused needs_real_request", () => {
  const reg = new Registry();
  reg.hydrate([
    {
      key: "abcdef0123456789",
      model: "claude-opus-4-7",
      prefixTokensEstimate: 40000,
      firstRealRequestAt: 1000,
      lastRealRequestAt: 1000,
      lastSeenAt: 1000,
      pingHistory5h: [],
      state: "active",
    },
  ]);
  const s = reg.get("abcdef0123456789")!;
  assert.equal(s.model, "claude-opus-4-7");
  assert.equal(s.state, "paused");
  assert.equal(s.pauseReason, "needs_real_request");
  assert.equal(s.lastAuthHeader, "");
  assert.deepEqual(s.lastPayload, {});
});

test("Registry.hydrate ignores malformed entries", () => {
  const reg = new Registry();
  reg.hydrate([
    {
      key: "good",
      model: "m",
      prefixTokensEstimate: 0,
      firstRealRequestAt: 0,
      lastRealRequestAt: 0,
      lastSeenAt: 0,
      pingHistory5h: [],
      state: "active",
    },
    {} as never,
  ]);
  assert.ok(reg.get("good"));
  assert.equal(reg.all().length, 1);
});

test("Registry.hydrate followed by abandonStale demotes stale entries", () => {
  const reg = new Registry();
  reg.hydrate([
    {
      key: "stale",
      model: "m",
      prefixTokensEstimate: 0,
      firstRealRequestAt: 0,
      lastRealRequestAt: 0,
      lastSeenAt: 0,
      pingHistory5h: [],
      state: "active",
    },
  ]);
  const abandoned = reg.abandonStale(60 * 60_000, () => 30 * 60_000);
  assert.equal(abandoned.length, 1);
  assert.equal(reg.get("stale")!.state, "abandoned");
});

test("Registry round-trips detectedTtlSeconds across serialize/hydrate", () => {
  const reg = new Registry();
  // Upsert a payload that triggers 1h detection.
  reg.upsert(
    {
      model: "claude-opus-4-7",
      tools: [],
      system: [
        { type: "text", text: "base", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    },
    "Bearer abc",
    0,
  );
  const serialized = reg.serialize();
  assert.equal(serialized[0].detectedTtlSeconds, 3600);

  const reg2 = new Registry();
  reg2.hydrate(serialized);
  const restored = reg2.all()[0];
  assert.equal(restored.detectedTtlSeconds, 3600,
    "hydrated session preserves detectedTtlSeconds so scheduler uses 1h cadence immediately after restart");
});

test("Registry.hydrate falls back to 300 for old log lines missing detectedTtlSeconds", () => {
  const reg = new Registry();
  reg.hydrate([
    {
      key: "legacy",
      model: "claude-opus-4-7",
      prefixTokensEstimate: 0,
      firstRealRequestAt: 0,
      lastRealRequestAt: 0,
      lastSeenAt: 0,
      pingHistory5h: [],
      state: "active",
      // detectedTtlSeconds intentionally omitted to simulate pre-feature log.
    },
  ]);
  assert.equal(reg.get("legacy")!.detectedTtlSeconds, 300);
});
