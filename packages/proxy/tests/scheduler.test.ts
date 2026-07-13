import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSchedulerTick,
  classifyPingResponse,
  effectiveConsecutivePingCap,
  effectiveCadenceMs,
  effectiveAbandonMs,
} from "../src/scheduler.ts";
import type { Session } from "../src/types.ts";
import { Registry } from "../src/registry.ts";
import { JsonlLogger } from "../src/logger.ts";
import { BudgetGuard } from "../src/budget.ts";
import { defaultConfig } from "../src/config.ts";
import type { UsageBlock, RateLimits } from "../src/types.ts";

const NO_RL: RateLimits = {
  unified5hUtilization: null,
  unified7dUtilization: null,
  unified5hResetEpoch: null,
  overageStatus: null,
};

test("runSchedulerTick fires ping for idle session and records cache_read", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "csch-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = defaultConfig();
  const guard = new BudgetGuard(config);

  const { key } = registry.upsert(
    {
      model: "claude-opus-4-7",
      tools: [],
      system: "s",
      messages: [{ role: "user", content: "hi" }],
    },
    "Bearer abc",
    0,
  );
  registry.recordRealUsage(key, {
    input_tokens: 1,
    output_tokens: 0,
    cache_creation_input_tokens: 60000,
    cache_read_input_tokens: 0,
  }, NO_RL);

  let receivedBody: Record<string, unknown> | null = null;
  const fakeFetcher = async (payload: Record<string, unknown>) => {
    receivedBody = payload;
    const usage: UsageBlock = {
      input_tokens: 2,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 60000,
    };
    const ratelimits: RateLimits = {
      unified5hUtilization: 0.05,
      unified7dUtilization: 0.1,
      unified5hResetEpoch: null,
      overageStatus: "allowed",
    };
    return { status: 200, usage, ratelimits };
  };

  await runSchedulerTick({
    registry,
    logger,
    config,
    guard,
    fetcher: fakeFetcher,
    nowMs: 300_000, // 5 minutes later
    spendUsdToday: 0,
    spendUsdMonth: 0,
    pingsToday: 0,
  });

  assert.ok(receivedBody);
  assert.equal((receivedBody as Record<string, unknown>).max_tokens, 0);
  assert.equal((receivedBody as Record<string, unknown>).stream, false);

  const session = registry.get(key)!;
  assert.equal(session.pingHistory5h.length, 1);
  assert.ok(session.pingHistory5h[0].costUsd > 0);
  assert.equal(session.lastSeenAt, 300_000);
  rmSync(path, { force: true });
});

function makeSessionWithTtl(ttlSec: number): Session {
  return {
    key: "x",
    model: "claude-opus-4-7",
    prefixTokensEstimate: 0,
    lastSeenAt: 0,
    firstRealRequestAt: 0,
    lastRealRequestAt: 0,
    lastPayload: {},
    lastAuthHeader: "",
    lastPath: "/v1/messages",
    lastHeaders: {},
    lastRealUsage: null,
    detectedTtlSeconds: ttlSec,
    pingsSinceLastReal: 0,
    pingHistory5h: [],
    lastRatelimits: null,
    state: "active",
  };
}

test("effectiveCadenceMs: 5-min TTL → 270s cadence (matches the old static default)", () => {
  const cfg = defaultConfig();
  assert.equal(effectiveCadenceMs(makeSessionWithTtl(300), cfg), 270_000);
});

test("effectiveCadenceMs: 1-hour TTL → 3570s cadence (13× fewer pings than the 5m default)", () => {
  const cfg = defaultConfig();
  assert.equal(effectiveCadenceMs(makeSessionWithTtl(3600), cfg), 3_570_000);
});

test("effectiveCadenceMs: floors at 60s for tiny TTLs to avoid pathological tight loops", () => {
  const cfg = defaultConfig();
  // 60s TTL with 30s margin would derive 30s — floor lifts it to 60s.
  const s = makeSessionWithTtl(60);
  assert.equal(effectiveCadenceMs(s, cfg), 60_000);
});

test("effectiveCadenceMs: falls back to config.cacheTtlSeconds when detection has no data", () => {
  const cfg = { ...defaultConfig(), cacheTtlSeconds: 3600 };
  // Session with detectedTtlSeconds = 0 (no detection yet) → fall back to config.
  const s = { ...makeSessionWithTtl(300), detectedTtlSeconds: 0 };
  assert.equal(effectiveCadenceMs(s, cfg), 3_570_000);
});

test("effectiveAbandonMs: 5-min TTL × 6 → 30 min (matches old static default)", () => {
  const cfg = defaultConfig();
  assert.equal(effectiveAbandonMs(makeSessionWithTtl(300), cfg), 30 * 60_000);
});

test("effectiveAbandonMs: 1-hour TTL × 6 → 6 hours", () => {
  const cfg = defaultConfig();
  assert.equal(effectiveAbandonMs(makeSessionWithTtl(3600), cfg), 6 * 3600_000);
});

test("effectiveAbandonMs: multiplier knob honored", () => {
  const cfg = { ...defaultConfig(), abandonTtlMultiplier: 12 };
  assert.equal(effectiveAbandonMs(makeSessionWithTtl(300), cfg), 60 * 60_000);
});

test("effectiveConsecutivePingCap: full return rate clamps to ceiling", () => {
  // Math says 12.5 × 1.0 = 12 → clamped to ceiling 5.
  assert.equal(effectiveConsecutivePingCap(1.0, 0.1, 1.25, 2, 5), 5);
});

test("effectiveConsecutivePingCap: low return rate clamps to floor", () => {
  // Math says 12.5 × 0.05 = 0 → clamped to floor 2.
  assert.equal(effectiveConsecutivePingCap(0.05, 0.1, 1.25, 2, 5), 2);
});

test("effectiveConsecutivePingCap: mid return rate lands between floor and ceiling", () => {
  // 12.5 × 0.4 = 5 → at ceiling
  assert.equal(effectiveConsecutivePingCap(0.4, 0.1, 1.25, 2, 5), 5);
  // 12.5 × 0.3 = 3.75 → floor → 3
  assert.equal(effectiveConsecutivePingCap(0.3, 0.1, 1.25, 2, 5), 3);
});

test("effectiveConsecutivePingCap: alternate multipliers (e.g. Anthropic changes prices)", () => {
  // If readMul rises to 0.2 (worse for proxy), break-even ratio drops to 6.25.
  // At rate 1.0 derived = 6, clamped to ceiling 10.
  assert.equal(effectiveConsecutivePingCap(1.0, 0.2, 1.25, 2, 10), 6);
});

test("runSchedulerTick uses the adaptive cap (low observed rate → low cap)", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "csch-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  // Window = 4 outcomes, all abandoned → return rate = 0 → cap = floor (2).
  registry.recordPauseOutcome(false, 1);
  registry.recordPauseOutcome(false, 2);
  registry.recordPauseOutcome(false, 3);
  registry.recordPauseOutcome(false, 4);
  const config = { ...defaultConfig(), adaptiveCapWindow: 4 };
  const guard = new BudgetGuard(config);

  const { key } = registry.upsert(
    { model: "claude-opus-4-7", tools: [], system: "s" },
    "Bearer abc",
    0,
  );
  // The session has 2 prior pings — meets the adaptive cap of 2.
  registry.get(key)!.pingsSinceLastReal = 2;

  let pingFired = false;
  const fakeFetcher = async () => {
    pingFired = true;
    return {
      status: 200,
      usage: {
        input_tokens: 1, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 60000,
      },
      ratelimits: NO_RL,
    };
  };

  await runSchedulerTick({
    registry, logger, config, guard,
    fetcher: fakeFetcher,
    nowMs: 300_000,
    spendUsdToday: 0, spendUsdMonth: 0, pingsToday: 0,
  });
  assert.equal(pingFired, false, "low return rate should pause before pinging");
  assert.equal(registry.get(key)!.pauseReason, "pings_without_progress");
  rmSync(path, { force: true });
});

test("runSchedulerTick pauses session with pings_without_progress after maxConsecutivePings", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "csch-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = { ...defaultConfig(), maxConsecutivePings: 3 };
  const guard = new BudgetGuard(config);

  const { key } = registry.upsert(
    { model: "claude-opus-4-7", tools: [], system: "s" },
    "Bearer abc",
    0,
  );
  // Simulate 3 prior successful pings (= maxConsecutivePings) by mutating state.
  const session = registry.get(key)!;
  session.pingsSinceLastReal = 3;

  let pingFired = false;
  const fakeFetcher = async () => {
    pingFired = true;
    return {
      status: 200,
      usage: {
        input_tokens: 1, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 60000,
      },
      ratelimits: NO_RL,
    };
  };

  await runSchedulerTick({
    registry, logger, config, guard,
    fetcher: fakeFetcher,
    nowMs: 300_000,
    spendUsdToday: 0, spendUsdMonth: 0, pingsToday: 3,
  });

  assert.equal(pingFired, false, "should not fire ping when at maxConsecutivePings");
  const after = registry.get(key)!;
  assert.equal(after.state, "paused");
  assert.equal(after.pauseReason, "pings_without_progress");
  rmSync(path, { force: true });
});

test("upsert (a new real_request) resets pingsSinceLastReal to 0", () => {
  const registry = new Registry();
  const payload = { model: "claude-opus-4-7", tools: [], system: "s" };
  const { key } = registry.upsert(payload, "Bearer abc", 0);
  const session = registry.get(key)!;
  session.pingsSinceLastReal = 5;
  session.state = "paused";
  session.pauseReason = "pings_without_progress";

  // Same payload → upsert returns same key and resets counter + unpauses.
  registry.upsert(payload, "Bearer abc", 1000);
  const after = registry.get(key)!;
  assert.equal(after.pingsSinceLastReal, 0);
  assert.equal(after.state, "active");
  assert.equal(after.pauseReason, undefined);
});

test("runSchedulerTick pauses session on cache_read=0", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "csch-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = defaultConfig();
  const guard = new BudgetGuard(config);

  const { key } = registry.upsert(
    { model: "claude-opus-4-7", tools: [], system: "s" },
    "Bearer abc",
    0,
  );
  registry.recordRealUsage(key, {
    input_tokens: 1,
    output_tokens: 0,
    cache_creation_input_tokens: 60000,
    cache_read_input_tokens: 0,
  }, NO_RL);

  const fakeFetcher = async () => ({
    status: 200,
    usage: {
      input_tokens: 2,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ratelimits: {
      unified5hUtilization: null,
      unified7dUtilization: null,
      unified5hResetEpoch: null,
      overageStatus: null,
    } as RateLimits,
  });

  await runSchedulerTick({
    registry,
    logger,
    config,
    guard,
    fetcher: fakeFetcher,
    nowMs: 300_000,
    spendUsdToday: 0,
    spendUsdMonth: 0,
    pingsToday: 0,
  });

  const session = registry.get(key)!;
  assert.equal(session.state, "paused");
  assert.equal(session.pauseReason, "cache_miss");
  rmSync(path, { force: true });
});

test("runSchedulerTick pings only the LONGEST-LIVED active session, not the most recent", async () => {
  // Models a coffee-break-during-subagent-burst scenario:
  //   - mainSession started at T=0 (the user's actual long-lived session)
  //   - subagentSession dispatched at T=600_000 (10 min later) and got a
  //     request right then, making it the *most recently* active
  // The user walks away. At T=900_000 (idle 5 min), only the main should
  // be pinged because it has the smaller firstRealRequestAt (lived longest).
  const path = join(mkdtempSync(join(tmpdir(), "long-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = defaultConfig();
  const guard = new BudgetGuard(config);

  const { key: mainKey } = registry.upsert(
    {
      model: "claude-opus-4-7",
      tools: [{ name: "main" }],
      system: "main session",
      messages: [{ role: "user", content: "real work" }],
    },
    "Bearer main",
    0, // firstRealRequestAt = 0
  );
  registry.recordRealUsage(mainKey, {
    input_tokens: 5,
    output_tokens: 10,
    cache_creation_input_tokens: 100_000,
    cache_read_input_tokens: 0,
  }, NO_RL);

  const { key: subKey } = registry.upsert(
    {
      model: "claude-sonnet-4-6",
      tools: [{ name: "subagent" }],
      system: "subagent agent",
      messages: [{ role: "user", content: "dispatched task" }],
    },
    "Bearer main",
    600_000, // 10 min after main started
  );
  registry.recordRealUsage(subKey, {
    input_tokens: 5,
    output_tokens: 10,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
  }, NO_RL);

  // Both sessions are now > 270s idle as of T = 900_000.
  // The subagent's lastRealRequestAt is more recent (600k vs 0) — under the
  // earlier "most-recent" heuristic, it would have been pinged. With
  // longest-lived selection, MAIN wins because it has the smaller
  // firstRealRequestAt.
  let pingedKey: string | null = null;
  const fakeFetcher = async (
    payload: Record<string, unknown>,
    auth: string,
  ) => {
    pingedKey = (payload as { _testHint?: string })._testHint ?? null;
    return {
      status: 200,
      usage: {
        input_tokens: 2,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100_000,
      },
      ratelimits: {
        unified5hUtilization: null,
        unified7dUtilization: null,
        unified5hResetEpoch: null,
        overageStatus: null,
      } as RateLimits,
    };
  };

  // Inject a hint via the payload so the fetcher can identify which session
  // got pinged. Replace each session's lastPayload with a tagged version.
  registry.get(mainKey)!.lastPayload = {
    ...registry.get(mainKey)!.lastPayload,
    _testHint: "main",
  };
  registry.get(subKey)!.lastPayload = {
    ...registry.get(subKey)!.lastPayload,
    _testHint: "subagent",
  };

  await runSchedulerTick({
    registry,
    logger,
    config,
    guard,
    fetcher: fakeFetcher,
    nowMs: 900_000,
    spendUsdToday: 0,
    spendUsdMonth: 0,
    pingsToday: 0,
  });

  assert.equal(pingedKey, "main", "expected main (longest-lived) to be pinged, not subagent");
  rmSync(path, { force: true });
});

test("classify: 2xx + cache_read > 0 → success", () => {
  const action = classifyPingResponse({
    status: 200,
    usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 50_000 },
    ratelimits: NO_RL,
  });
  assert.equal(action.kind, "success");
});

test("classify: 2xx + cache_read === 0 → pause cache_miss", () => {
  const action = classifyPingResponse({
    status: 200,
    usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ratelimits: NO_RL,
  });
  assert.deepEqual(action, { kind: "pause", reason: "cache_miss" });
});

test("classify: 2xx + null usage → pause malformed_response", () => {
  const action = classifyPingResponse({ status: 200, usage: null, ratelimits: NO_RL });
  assert.deepEqual(action, { kind: "pause", reason: "malformed_response" });
});

test("classify: 401 → pause auth_error", () => {
  const action = classifyPingResponse({ status: 401, usage: null, ratelimits: NO_RL });
  assert.deepEqual(action, { kind: "pause", reason: "auth_error" });
});

test("classify: 403 → pause auth_error", () => {
  const action = classifyPingResponse({ status: 403, usage: null, ratelimits: NO_RL });
  assert.deepEqual(action, { kind: "pause", reason: "auth_error" });
});

test("classify: 5xx → pause upstream_5xx_repeat", () => {
  const action = classifyPingResponse({ status: 502, usage: null, ratelimits: NO_RL });
  assert.deepEqual(action, { kind: "pause", reason: "upstream_5xx_repeat" });
});

test("classify: non-auth 4xx → pause upstream_5xx_repeat", () => {
  const action = classifyPingResponse({ status: 400, usage: null, ratelimits: NO_RL });
  assert.deepEqual(action, { kind: "pause", reason: "upstream_5xx_repeat" });
});

test("classify: status === 0 → retry_transient network_error", () => {
  const action = classifyPingResponse({ status: 0, usage: null, ratelimits: NO_RL });
  assert.deepEqual(action, { kind: "retry_transient", logReason: "network_error" });
});

test("runSchedulerTick pauses with malformed_response when usage is null", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "csch-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = defaultConfig();
  const guard = new BudgetGuard(config);

  const { key } = registry.upsert(
    { model: "claude-opus-4-7", tools: [], system: "s" },
    "Bearer abc",
    0,
  );
  registry.recordRealUsage(
    key,
    { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 60000, cache_read_input_tokens: 0 },
    NO_RL,
  );

  const fakeFetcher = async () => ({ status: 200, usage: null, ratelimits: NO_RL });

  await runSchedulerTick({
    registry, logger, config, guard, fetcher: fakeFetcher,
    nowMs: 300_000, spendUsdToday: 0, spendUsdMonth: 0, pingsToday: 0,
  });

  const session = registry.get(key)!;
  assert.equal(session.state, "paused");
  assert.equal(session.pauseReason, "malformed_response");
  rmSync(path, { force: true });
});

test("runSchedulerTick on status=0 does NOT pause and logs network_error skip", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "csch-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = defaultConfig();
  const guard = new BudgetGuard(config);

  const { key } = registry.upsert(
    { model: "claude-opus-4-7", tools: [], system: "s" },
    "Bearer abc",
    0,
  );
  registry.recordRealUsage(
    key,
    { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 60000, cache_read_input_tokens: 0 },
    NO_RL,
  );

  const fakeFetcher = async () => ({ status: 0, usage: null, ratelimits: NO_RL });

  await runSchedulerTick({
    registry, logger, config, guard, fetcher: fakeFetcher,
    nowMs: 300_000, spendUsdToday: 0, spendUsdMonth: 0, pingsToday: 0,
  });

  const session = registry.get(key)!;
  assert.equal(session.state, "active");
  // Read events from the in-memory snapshot instead of disk — async writes
  // may not have flushed yet, and the snapshot is the canonical source.
  const skip = logger.snapshot().find((e) => e.kind === "ping_skipped");
  assert.ok(skip);
  assert.ok((skip as { reason: string }).reason.startsWith("network_error"));
  rmSync(path, { force: true });
});

test("runSchedulerTick passes session.lastRatelimits into BudgetGuard.shouldPause", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "csch-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = defaultConfig();
  const seenRl: (RateLimits | null)[] = [];
  const fakeGuard = {
    shouldPause(_s: unknown, inputs: { lastRatelimits: RateLimits | null }) {
      seenRl.push(inputs.lastRatelimits);
      return { pause: false };
    },
  } as unknown as BudgetGuard;

  const rl: RateLimits = {
    unified5hUtilization: 0.5, unified7dUtilization: 0.1, unified5hResetEpoch: 1, overageStatus: "allowed",
  };
  const { key } = registry.upsert({ model: "claude-opus-4-7", tools: [], system: "s" }, "Bearer abc", 0);
  registry.recordRealUsage(
    key,
    { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 60000, cache_read_input_tokens: 0 },
    rl,
  );

  const fakeFetcher = async () => ({
    status: 200,
    usage: { input_tokens: 2, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 60000 },
    ratelimits: rl,
  });

  await runSchedulerTick({
    registry, logger, config, guard: fakeGuard, fetcher: fakeFetcher,
    nowMs: 300_000, spendUsdToday: 0, spendUsdMonth: 0, pingsToday: 0,
  });
  assert.deepEqual(seenRl, [rl]);
  rmSync(path, { force: true });
});
