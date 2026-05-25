import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, computeSessionKey, detectCacheTtlSeconds } from "../src/registry.ts";

const NO_RL = {
  unified5hUtilization: null,
  unified7dUtilization: null,
  unified5hResetEpoch: null,
  overageStatus: null,
} as const;

const samplePayload = {
  model: "claude-opus-4-7",
  tools: [{ name: "fs", description: "filesystem" }],
  system: "you are helpful",
  messages: [{ role: "user", content: "hi" }],
};

test("Registry.observedReturnRate defaults to 1.0 when no outcomes recorded", () => {
  const r = new Registry();
  assert.equal(r.observedReturnRate(50), 1.0);
  assert.equal(r.pauseOutcomeCount(50), 0);
});

test("Registry.observedReturnRate reports ratio over the configured window", () => {
  const r = new Registry();
  // 3 returned, 2 abandoned → 0.6
  r.recordPauseOutcome(true, 1);
  r.recordPauseOutcome(false, 2);
  r.recordPauseOutcome(true, 3);
  r.recordPauseOutcome(true, 4);
  r.recordPauseOutcome(false, 5);
  assert.equal(r.observedReturnRate(50), 0.6);
  assert.equal(r.pauseOutcomeCount(50), 5);
});

test("Registry.observedReturnRate respects window size (oldest outcomes drop out)", () => {
  const r = new Registry();
  // Window of 3: only the last 3 outcomes count.
  r.recordPauseOutcome(false, 1);
  r.recordPauseOutcome(false, 2);
  r.recordPauseOutcome(true, 3);
  r.recordPauseOutcome(true, 4);
  r.recordPauseOutcome(true, 5);
  // Last 3 are all true → 1.0
  assert.equal(r.observedReturnRate(3), 1.0);
  // Full window of 10 (only 5 exist) → 3/5 = 0.6
  assert.equal(r.observedReturnRate(10), 0.6);
});

test("Registry.upsert records returned=true when resolving pings_without_progress", () => {
  const r = new Registry();
  const { key } = r.upsert(samplePayload, "Bearer x", 0);
  // Force the session into a pings_without_progress pause.
  r.pause(key, "pings_without_progress");
  // Now upsert (a real request) — should record a +returned outcome.
  r.upsert(samplePayload, "Bearer x", 1000);
  assert.equal(r.observedReturnRate(50), 1.0);
  assert.equal(r.pauseOutcomeCount(50), 1);
});

test("Registry.abandonStale records returned=false when abandoning a pings_without_progress session", () => {
  const r = new Registry();
  const { key } = r.upsert(samplePayload, "Bearer x", 0);
  r.pause(key, "pings_without_progress");
  // Advance time past abandon threshold and call abandonStale.
  r.abandonStale(2_000_000, () => 60_000);
  assert.equal(r.observedReturnRate(50), 0);
  assert.equal(r.pauseOutcomeCount(50), 1);
});

test("Registry.abandonStale does NOT record an outcome for sessions paused for other reasons", () => {
  const r = new Registry();
  const { key } = r.upsert(samplePayload, "Bearer x", 0);
  r.pause(key, "auth_error");
  r.abandonStale(2_000_000, () => 60_000);
  assert.equal(r.pauseOutcomeCount(50), 0);
});

test("Registry.upsert exposes previousDetectedTtlSeconds + currentDetectedTtlSeconds for change detection", () => {
  const r = new Registry();
  // First upsert: no prior session.
  const fresh = r.upsert(samplePayload, "Bearer x", 0);
  assert.equal(fresh.previousDetectedTtlSeconds, null, "first upsert has no prior TTL");
  assert.equal(fresh.currentDetectedTtlSeconds, 300, "5-min default when no ttl:'1h' in payload");

  // Same payload again: no change.
  const same = r.upsert(samplePayload, "Bearer x", 1000);
  assert.equal(same.previousDetectedTtlSeconds, 300);
  assert.equal(same.currentDetectedTtlSeconds, 300);

  // Now upsert with a 1h-tagged payload — TTL changes.
  const onehPayload = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "base", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [{ role: "user", content: "hi" }],
  };
  const changed = r.upsert(onehPayload, "Bearer x", 2000);
  assert.notEqual(changed.key, fresh.key,
    "different payload → different session key (so this is a fresh session, not a TTL change on the same session)");

  // Realistic case: same payload key, different TTL on next request.
  // (Simulate by manually toggling detectedTtlSeconds, then re-upserting with same-keyed payload.)
  r.upsert(samplePayload, "Bearer x", 3000);
  // mutate detection on session directly to simulate Anthropic-side change
  // (e.g. user hit plan limit between requests):
  const sess = r.get(fresh.key)!;
  sess.detectedTtlSeconds = 3600;
  const flipped = r.upsert(samplePayload, "Bearer x", 4000);
  assert.equal(flipped.previousDetectedTtlSeconds, 3600);
  assert.equal(flipped.currentDetectedTtlSeconds, 300,
    "samplePayload has no ttl:'1h' block, so detection returns 300 — exposing the change");
});

test("detectCacheTtlSeconds: returns 3600 when any cache_control block carries ttl:'1h'", () => {
  const payload = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "base", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  };
  assert.equal(detectCacheTtlSeconds(payload), 3600);
});

test("detectCacheTtlSeconds: returns 300 when no cache_control carries ttl:'1h'", () => {
  const payload = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "base", cache_control: { type: "ephemeral" } },
    ],
  };
  assert.equal(detectCacheTtlSeconds(payload), 300);
});

test("detectCacheTtlSeconds: defaults to 300 when payload has no cache_control at all", () => {
  const payload = {
    model: "claude-opus-4-7",
    tools: [],
    system: "plain string system",
  };
  assert.equal(detectCacheTtlSeconds(payload), 300);
});

test("detectCacheTtlSeconds: picks 1h when ANY block opts in (system or tools)", () => {
  const payload = {
    model: "claude-opus-4-7",
    tools: [
      { name: "fs", cache_control: { type: "ephemeral" } },
    ],
    system: [
      { type: "text", text: "1h-tagged", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  };
  assert.equal(detectCacheTtlSeconds(payload), 3600);
});

test("detectCacheTtlSeconds: ttl:'5m' explicitly stays at 300", () => {
  const payload = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "base", cache_control: { type: "ephemeral", ttl: "5m" } },
    ],
  };
  assert.equal(detectCacheTtlSeconds(payload), 300);
});

test("computeSessionKey is deterministic and ignores key order", () => {
  const a = computeSessionKey({
    model: "m",
    tools: [{ x: 1, y: 2 }],
    system: "s",
  });
  const b = computeSessionKey({
    system: "s",
    tools: [{ y: 2, x: 1 }],
    model: "m",
  });
  assert.equal(a, b);
});

test("computeSessionKey is sensitive to model changes", () => {
  const a = computeSessionKey({ model: "opus", tools: [], system: "" });
  const b = computeSessionKey({ model: "sonnet", tools: [], system: "" });
  assert.notEqual(a, b);
});

test("computeSessionKey is stable when content AFTER the cache_control breakpoint varies", () => {
  // Same cacheable prefix; tail differs (per-turn metadata).
  const turn1 = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "stable base", cache_control: { type: "ephemeral" } },
      { type: "text", text: "turn timestamp: 100" },
    ],
  };
  const turn2 = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "stable base", cache_control: { type: "ephemeral" } },
      { type: "text", text: "turn timestamp: 200" },
    ],
  };
  assert.equal(computeSessionKey(turn1), computeSessionKey(turn2));
});

test("computeSessionKey is stable when messages vary but tools+system are identical", () => {
  // This is the headline case: many turns of one conversation should
  // collapse to a single session key. Different message tails should NOT
  // change the hash.
  const turnA = {
    model: "claude-opus-4-7",
    tools: [{ name: "fs" }],
    system: "project context",
    messages: [{ role: "user", content: "hi" }],
  };
  const turnB = {
    model: "claude-opus-4-7",
    tools: [{ name: "fs" }],
    system: "project context",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "what is 2+2?" },
    ],
  };
  assert.equal(computeSessionKey(turnA), computeSessionKey(turnB));
});

test("computeSessionKey ignores cache_control placed only on messages", () => {
  // Claude Code typically anchors cache_control on the last user message
  // each turn. That MUST NOT shift the session key — otherwise every turn
  // becomes its own session.
  const t1 = {
    model: "claude-opus-4-7",
    tools: [],
    system: "stable",
    messages: [
      { role: "user", content: "first", cache_control: { type: "ephemeral" } },
    ],
  };
  const t2 = {
    model: "claude-opus-4-7",
    tools: [],
    system: "stable",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second", cache_control: { type: "ephemeral" } },
    ],
  };
  assert.equal(computeSessionKey(t1), computeSessionKey(t2));
});

test("computeSessionKey differs when content BEFORE the breakpoint changes", () => {
  const a = {
    model: "m",
    tools: [],
    system: [
      { type: "text", text: "version A" },
      { type: "text", text: "more", cache_control: { type: "ephemeral" } },
    ],
  };
  const b = {
    model: "m",
    tools: [],
    system: [
      { type: "text", text: "version B" },
      { type: "text", text: "more", cache_control: { type: "ephemeral" } },
    ],
  };
  assert.notEqual(computeSessionKey(a), computeSessionKey(b));
});

test("computeSessionKey collapses turns despite per-turn `cch=` rotation in Claude Code billing header", () => {
  // Claude Code stamps system[0] with `x-anthropic-billing-header:
  // cc_version=...; cc_entrypoint=...; cch=<per-turn-hash>;` which rotates
  // every API call. That block sits BEFORE the cache_control marker, so the
  // naive cacheable-prefix hash includes it and fragments one conversation
  // into N sessions. Verified empirically against captured 2026-05-20 traffic.
  const turn1 = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.145.249; cc_entrypoint=cli; cch=7d6cf;" },
      { type: "text", text: "main Claude Code system prompt, large stable body", cache_control: { type: "ephemeral" } },
    ],
  };
  const turn2 = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.145.249; cc_entrypoint=cli; cch=a243d;" },
      { type: "text", text: "main Claude Code system prompt, large stable body", cache_control: { type: "ephemeral" } },
    ],
  };
  assert.equal(computeSessionKey(turn1), computeSessionKey(turn2));
});

test("computeSessionKey still differs when bulk system content changes (billing-header skip is targeted)", () => {
  // Sanity: the cch= exemption must not over-collapse. Same billing header
  // + different real system body → different session keys.
  const a = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.145.249; cc_entrypoint=cli; cch=7d6cf;" },
      { type: "text", text: "project A system prompt", cache_control: { type: "ephemeral" } },
    ],
  };
  const b = {
    model: "claude-opus-4-7",
    tools: [],
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.145.249; cc_entrypoint=cli; cch=7d6cf;" },
      { type: "text", text: "project B system prompt", cache_control: { type: "ephemeral" } },
    ],
  };
  assert.notEqual(computeSessionKey(a), computeSessionKey(b));
});

test("computeSessionKey falls back to full-prefix hash when no cache_control is set", () => {
  // No breakpoint anywhere → behaves like the original hash for the cacheable
  // pair (tools + system). Different system text still yields different keys.
  const a = computeSessionKey({ model: "m", tools: [], system: "A" });
  const b = computeSessionKey({ model: "m", tools: [], system: "B" });
  assert.notEqual(a, b);
});

test("Registry upsert + recordRealUsage stores session", () => {
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 1_000);
  reg.recordRealUsage(key, {
    input_tokens: 1,
    output_tokens: 0,
    cache_creation_input_tokens: 10000,
    cache_read_input_tokens: 0,
  }, NO_RL);
  const session = reg.get(key);
  assert.ok(session);
  assert.equal(session!.model, "claude-opus-4-7");
  assert.equal(session!.prefixTokensEstimate, 10000);
  assert.equal(session!.state, "active");
});

test("Registry pause marks session paused", () => {
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 1_000);
  reg.pause(key, "cache_miss");
  const session = reg.get(key);
  assert.equal(session!.state, "paused");
  assert.equal(session!.pauseReason, "cache_miss");
});

test("Registry upsert revives a paused session", () => {
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 1_000);
  reg.pause(key, "cache_miss");
  reg.upsert(samplePayload, "Bearer abc", 2_000);
  assert.equal(reg.get(key)!.state, "active");
});

test("Registry.activeSessions returns only sessions idle ≥ threshold", () => {
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 0);
  reg.recordRealUsage(key, {
    input_tokens: 1,
    output_tokens: 0,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 0,
  }, NO_RL);
  // At t=270_000 with threshold 270_000, session is exactly at boundary → active.
  const active = reg.activeSessions(270_000, 270_000);
  assert.equal(active.length, 1);
  // At t=100_000 with threshold 270_000, session has not been idle long enough.
  const tooEarly = reg.activeSessions(100_000, 270_000);
  assert.equal(tooEarly.length, 0);
});

test("Registry.abandonStale marks sessions idle past threshold as abandoned", () => {
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 0);
  const abandoned = reg.abandonStale(60 * 60 * 1000, () => 30 * 60 * 1000);
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0], key);
  assert.equal(reg.get(key)!.state, "abandoned");
});

test("Registry.abandonStale uses lastRealRequestAt, not lastSeenAt — pings do NOT extend the abandonment timer", () => {
  // This is the closed-Claude-Code-session fix: pings should keep the cache
  // warm for *cadence* purposes but must not delay abandonment.
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 0);
  // Simulate 5 successful pings, each refreshing lastSeenAt — but
  // lastRealRequestAt stays at 0.
  for (let i = 1; i <= 5; i++) {
    reg.recordPingResult(
      key,
      true,
      {
        input_tokens: 2,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 50_000,
      },
      0.003,
      i * 270_000,
      NO_RL,
    );
  }
  const session = reg.get(key)!;
  assert.equal(session.lastSeenAt, 5 * 270_000); // ~22 min
  assert.equal(session.lastRealRequestAt, 0); // never updated by pings

  // Now t = 35 min — lastRealRequestAt was 0, so 35 min ≥ 30 min → abandon.
  const abandoned = reg.abandonStale(35 * 60_000, () => 30 * 60_000);
  assert.equal(abandoned.length, 1);
  assert.equal(reg.get(key)!.state, "abandoned");
});

test("pingStatsInWindow prunes entries older than 5h and returns count+cost", () => {
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 0);
  const FIVE_H = 5 * 60 * 60 * 1000;
  const now = 10 * FIVE_H;
  const usage = {
    input_tokens: 1,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 50_000,
  };
  reg.recordPingResult(key, true, usage, 0.002, now - FIVE_H - 1, NO_RL);
  reg.recordPingResult(key, true, usage, 0.005, now - FIVE_H + 1, NO_RL);
  reg.recordPingResult(key, true, usage, 0.007, now - 60_000, NO_RL);
  const stats = reg.pingStatsInWindow(key, now);
  assert.equal(stats.count, 2);
  assert.ok(Math.abs(stats.costUsd - 0.012) < 1e-9);
  assert.equal(reg.get(key)!.pingHistory5h.length, 2);
});

test("recordRealUsage stores lastRatelimits on the session", () => {
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 0);
  const rl = {
    unified5hUtilization: 0.42,
    unified7dUtilization: 0.1,
    unified5hResetEpoch: 12345,
    overageStatus: "allowed" as const,
  };
  reg.recordRealUsage(
    key,
    { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 },
    rl,
  );
  assert.deepEqual(reg.get(key)!.lastRatelimits, rl);
});

test("recordPingResult stores lastRatelimits on the session", () => {
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 0);
  const rl = {
    unified5hUtilization: 0.7,
    unified7dUtilization: 0.2,
    unified5hResetEpoch: 22222,
    overageStatus: "allowed" as const,
  };
  reg.recordPingResult(
    key,
    true,
    { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000 },
    0.001,
    1000,
    rl,
  );
  assert.deepEqual(reg.get(key)!.lastRatelimits, rl);
});

test("evictAbandoned removes sessions whose lastRealRequestAt is older than threshold", () => {
  const reg = new Registry();
  const { key: k1 } = reg.upsert(samplePayload, "Bearer abc", 0);
  const { key: k2 } = reg.upsert({ ...samplePayload, system: "other" }, "Bearer abc", 1_000);
  const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
  const now = TWENTY_FOUR_H + 1;
  const evicted = reg.evictAbandoned(now, TWENTY_FOUR_H);
  assert.deepEqual(evicted, [k1]);
  assert.equal(reg.get(k1), undefined);
  assert.ok(reg.get(k2));
});

test("evictAbandoned leaves sessions inside the grace period alone (state irrelevant)", () => {
  const reg = new Registry();
  const { key } = reg.upsert(samplePayload, "Bearer abc", 0);
  reg.pause(key, "cache_miss");
  const evicted = reg.evictAbandoned(60 * 60 * 1000, 24 * 60 * 60 * 1000);
  assert.equal(evicted.length, 0);
  assert.ok(reg.get(key));
});
