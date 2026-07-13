import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetGuard } from "../src/budget.ts";
import { defaultConfig } from "../src/config.ts";
import type { RateLimits, Session } from "../src/types.ts";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    key: "abc",
    model: "claude-opus-4-7",
    prefixTokensEstimate: 60000,
    lastSeenAt: 0,
    firstRealRequestAt: 0,
    lastRealRequestAt: 0,
    lastPayload: {},
    lastAuthHeader: "",
    lastPath: "/v1/messages",
    lastHeaders: {},
    lastRealUsage: null,
    detectedTtlSeconds: 300,
    pingsSinceLastReal: 0,
    pingHistory5h: [],
    lastRatelimits: null,
    state: "active",
    ...overrides,
  };
}

test("allows ping under all caps", () => {
  const guard = new BudgetGuard(defaultConfig());
  const ratelimits: RateLimits = {
    unified5hUtilization: 0.05,
    unified7dUtilization: 0.1,
    unified5hResetEpoch: null,
    overageStatus: "allowed",
  };
  const got = guard.shouldPause(makeSession(), {
    lastRatelimits: ratelimits,
    pingCountInWindow: 0,
    pingsToday: 5,
    spendUsdToday: 0.1,
    spendUsdMonth: 0.5,
  });
  assert.equal(got.pause, false);
});

test("pauses when per-session 5h ping count exceeded", () => {
  const guard = new BudgetGuard(defaultConfig());
  const got = guard.shouldPause(makeSession(), {
    lastRatelimits: null,
    pingCountInWindow: 20,
    pingsToday: 0,
    spendUsdToday: 0,
    spendUsdMonth: 0,
  });
  assert.equal(got.pause, true);
  assert.equal(got.reason, "per_session_cap");
});

test("pauses when daily spend cap reached", () => {
  const guard = new BudgetGuard(defaultConfig());
  const got = guard.shouldPause(makeSession(), {
    lastRatelimits: null,
    pingCountInWindow: 0,
    pingsToday: 0,
    spendUsdToday: 25,
    spendUsdMonth: 50,
  });
  assert.equal(got.pause, true);
  assert.equal(got.reason, "daily_spend_cap");
});

test("pauses on overage rejected + high utilization", () => {
  const guard = new BudgetGuard(defaultConfig());
  const ratelimits: RateLimits = {
    unified5hUtilization: 0.97,
    unified7dUtilization: 0.5,
    unified5hResetEpoch: null,
    overageStatus: "rejected",
  };
  const got = guard.shouldPause(makeSession(), {
    lastRatelimits: ratelimits,
    pingCountInWindow: 0,
    pingsToday: 0,
    spendUsdToday: 0,
    spendUsdMonth: 0,
  });
  assert.equal(got.pause, true);
  assert.equal(got.reason, "ratelimit_near_overage");
});

test("enterprise plan pauses pings at 95% of monthly cap", () => {
  const enterpriseConfig = {
    ...defaultConfig(),
    plan: "enterprise" as const,
    enterpriseCap: { monthlyCapUsd: 1000, cycleStartDayOfMonth: 1 },
    // Raise the generic monthly cap above the enterprise cap so the
    // enterprise rule is the binding constraint, not the generic spend cap.
    budgetCap: {
      ...defaultConfig().budgetCap,
      maxPingSpendUsd: { perDay: 10000, perMonth: 10000, warnAt: 0.5 },
    },
  };
  const guard = new BudgetGuard(enterpriseConfig);

  // At 94% of the cap, pings should still fire.
  const under = guard.shouldPause(makeSession(), {
    lastRatelimits: null,
    pingCountInWindow: 0,
    pingsToday: 0,
    spendUsdToday: 0,
    spendUsdMonth: 940,
  });
  assert.equal(under.pause, false);

  // At 95%, pings should pause.
  const over = guard.shouldPause(makeSession(), {
    lastRatelimits: null,
    pingCountInWindow: 0,
    pingsToday: 0,
    spendUsdToday: 0,
    spendUsdMonth: 950,
  });
  assert.equal(over.pause, true);
  assert.equal(over.reason, "enterprise_cap_near");
});

test("enterprise cap is ignored when plan is not enterprise", () => {
  // Even with an enterpriseCap object present, a subscription/api-key plan
  // ignores it. The generic spend caps are the only monthly gate.
  const config = {
    ...defaultConfig(),
    plan: "subscription" as const,
    enterpriseCap: { monthlyCapUsd: 1000, cycleStartDayOfMonth: 1 },
    budgetCap: {
      ...defaultConfig().budgetCap,
      maxPingSpendUsd: { perDay: 10000, perMonth: 10000, warnAt: 0.5 },
    },
  };
  const guard = new BudgetGuard(config);
  const got = guard.shouldPause(makeSession(), {
    lastRatelimits: null,
    pingCountInWindow: 0,
    pingsToday: 0,
    spendUsdToday: 0,
    spendUsdMonth: 950, // would trip if enterprise rule were active
  });
  assert.equal(got.pause, false);
});
