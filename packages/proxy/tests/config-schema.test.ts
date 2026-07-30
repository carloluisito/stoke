import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConfigError,
  validateReloadBody,
  validateConfig,
} from "../src/config-schema.ts";
import { defaultConfig } from "../src/config.ts";

test("validateReloadBody accepts empty object", () => {
  assert.deepEqual(validateReloadBody({}), {});
});

test("validateReloadBody accepts plan", () => {
  assert.deepEqual(validateReloadBody({ plan: "enterprise" }), { plan: "enterprise" });
});

test("validateReloadBody accepts enterpriseCap with valid shape", () => {
  const body = { enterpriseCap: { monthlyCapUsd: 1000, cycleStartDayOfMonth: 5 } };
  assert.deepEqual(validateReloadBody(body), body);
});

test("validateReloadBody rejects unknown top-level keys", () => {
  assert.throws(
    () => validateReloadBody({ plan: "api-key", spendUsdMonth: 99 }),
    (err: unknown) => err instanceof ConfigError && /unknown field: spendUsdMonth/.test((err as Error).message),
  );
});

test("validateReloadBody rejects non-object input", () => {
  assert.throws(() => validateReloadBody(null), ConfigError);
  assert.throws(() => validateReloadBody("string"), ConfigError);
  assert.throws(() => validateReloadBody([1, 2]), ConfigError);
});

test("validateReloadBody rejects bad plan enum", () => {
  assert.throws(
    () => validateReloadBody({ plan: "free-tier" }),
    (err: unknown) => err instanceof ConfigError && /plan must be/.test((err as Error).message),
  );
});

test("validateReloadBody rejects bad enterpriseCap shape", () => {
  assert.throws(
    () => validateReloadBody({ enterpriseCap: { monthlyCapUsd: -1, cycleStartDayOfMonth: 5 } }),
    ConfigError,
  );
  assert.throws(
    () => validateReloadBody({ enterpriseCap: { monthlyCapUsd: 1000, cycleStartDayOfMonth: 0 } }),
    ConfigError,
  );
  assert.throws(
    () => validateReloadBody({ enterpriseCap: { monthlyCapUsd: 1000, cycleStartDayOfMonth: 29 } }),
    ConfigError,
  );
  assert.throws(
    () => validateReloadBody({ enterpriseCap: { monthlyCapUsd: 1000, cycleStartDayOfMonth: 5.5 } }),
    ConfigError,
  );
  assert.throws(
    () => validateReloadBody({ enterpriseCap: { monthlyCapUsd: NaN, cycleStartDayOfMonth: 5 } }),
    ConfigError,
  );
});

test("validateConfig accepts defaultConfig with empty authToken", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.authToken, "");
  validateConfig(cfg);
});

test("validateConfig accepts defaultConfig with a real 32-hex token", () => {
  const cfg = { ...defaultConfig(), authToken: "a".repeat(32) };
  validateConfig(cfg);
});

test("validateConfig rejects authToken that is not empty and not 32-lowercase-hex", () => {
  assert.throws(() => validateConfig({ ...defaultConfig(), authToken: "short" }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), authToken: "A".repeat(32) }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), authToken: "g".repeat(32) }), ConfigError);
});

test("validateConfig rejects pingCadenceMarginSeconds out of [5, 600] or non-integer", () => {
  assert.throws(() => validateConfig({ ...defaultConfig(), pingCadenceMarginSeconds: 4 }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), pingCadenceMarginSeconds: 601 }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), pingCadenceMarginSeconds: 30.5 }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), pingCadenceMarginSeconds: NaN }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), pingCadenceMarginSeconds: "30" as unknown as number }), ConfigError);
});

test("validateConfig rejects abandonTtlMultiplier out of [2, 100]", () => {
  assert.throws(() => validateConfig({ ...defaultConfig(), abandonTtlMultiplier: 1 }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), abandonTtlMultiplier: 101 }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), abandonTtlMultiplier: 6.5 }), ConfigError);
});

test("validateConfig rejects listen.port out of range", () => {
  assert.throws(
    () => validateConfig({ ...defaultConfig(), listen: { host: "127.0.0.1", port: 0 } }),
    ConfigError,
  );
  assert.throws(
    () => validateConfig({ ...defaultConfig(), listen: { host: "127.0.0.1", port: 70000 } }),
    ConfigError,
  );
});

test("validateConfig rejects empty listen.host", () => {
  assert.throws(
    () => validateConfig({ ...defaultConfig(), listen: { host: "", port: 9876 } }),
    ConfigError,
  );
});

test("validateConfig rejects budget caps that are zero, negative, or out of range", () => {
  const cfg = defaultConfig();
  assert.throws(
    () => validateConfig({ ...cfg, budgetCap: { ...cfg.budgetCap, maxPingSpendUsd: { perDay: 0, perMonth: 30, warnAt: 0.5 } } }),
    ConfigError,
  );
  assert.throws(
    () => validateConfig({ ...cfg, budgetCap: { ...cfg.budgetCap, maxPingSpendUsd: { perDay: 20, perMonth: -1, warnAt: 0.5 } } }),
    ConfigError,
  );
  assert.throws(
    () => validateConfig({ ...cfg, budgetCap: { ...cfg.budgetCap, maxPingSpendUsd: { perDay: 20, perMonth: 300, warnAt: 1.5 } } }),
    ConfigError,
  );
});

test("validateConfig enforces evictAfterHours invariant (must exceed worst-case abandon)", () => {
  // 1h TTL × 6 multiplier = 6h worst case. evictAfterHours of 5 is too small.
  assert.throws(
    () => validateConfig({
      ...defaultConfig(),
      evictAfterHours: 5,
      cacheTtlSeconds: 3600,
      abandonTtlMultiplier: 6,
    }),
    (err: unknown) => err instanceof ConfigError && /evictAfterHours/.test((err as Error).message),
  );
});

test("validateConfig accepts plan enum values", () => {
  for (const plan of ["subscription", "api-key", "enterprise"] as const) {
    const cfg: ReturnType<typeof defaultConfig> = { ...defaultConfig(), plan };
    if (plan === "enterprise") cfg.enterpriseCap = { monthlyCapUsd: 1000, cycleStartDayOfMonth: 1 };
    validateConfig(cfg);
  }
});

test("validateConfig rejects unknown plan", () => {
  assert.throws(
    () => validateConfig({ ...defaultConfig(), plan: "free" as unknown as "api-key" }),
    ConfigError,
  );
});

test("validateConfig rejects modelPricing with non-positive inputPerMtok", () => {
  assert.throws(
    () => validateConfig({ ...defaultConfig(), modelPricing: { "claude-opus-4-7": { inputPerMtok: 0 } } }),
    ConfigError,
  );
  assert.throws(
    () => validateConfig({ ...defaultConfig(), modelPricing: { "claude-opus-4-7": { inputPerMtok: -1 } } }),
    ConfigError,
  );
});

test("validateConfig accepts cacheTtlSeconds = 300 or 3600", () => {
  validateConfig({ ...defaultConfig(), cacheTtlSeconds: 300 });
  // 1h TTL × default abandonTtlMultiplier=6 = 6h worst-case → evictAfterHours must
  // exceed that.
  validateConfig({
    ...defaultConfig(),
    cacheTtlSeconds: 3600,
    evictAfterHours: 24,
  });
});

test("validateConfig rejects cacheTtlSeconds < 60, non-integer, or non-number", () => {
  assert.throws(() => validateConfig({ ...defaultConfig(), cacheTtlSeconds: 30 }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), cacheTtlSeconds: 300.5 }), ConfigError);
  assert.throws(() => validateConfig({ ...defaultConfig(), cacheTtlSeconds: 0 }), ConfigError);
  assert.throws(
    () => validateConfig({ ...defaultConfig(), cacheTtlSeconds: "300" as unknown as number }),
    ConfigError,
  );
});

test("validateConfig rejects pingCadenceMarginSeconds >= cacheTtlSeconds (no room to ping under TTL)", () => {
  // A 60s margin against a 60s TTL leaves nothing to ping under — must reject.
  assert.throws(
    () => validateConfig({ ...defaultConfig(), pingCadenceMarginSeconds: 60, cacheTtlSeconds: 60 }),
    (err: unknown) =>
      err instanceof ConfigError &&
      /pingCadenceMarginSeconds.*must be less than.*cacheTtlSeconds/.test((err as Error).message),
  );
});

test("validateConfig accepts a hookSignals block", () => {
  const cfg = validateConfig({
    ...defaultConfig(),
    hookSignals: { enabled: true, stateDir: "/tmp/state", staleAfterSeconds: 900 },
  });
  assert.equal(cfg.hookSignals?.enabled, true);
  assert.equal(cfg.hookSignals?.stateDir, "/tmp/state");
  assert.equal(cfg.hookSignals?.staleAfterSeconds, 900);
});

test("validateConfig rejects unknown hookSignals fields", () => {
  assert.throws(
    () => validateConfig({
      ...defaultConfig(),
      hookSignals: { enabled: true, stateDir: "/t", staleAfterSeconds: 900, nope: 1 },
    }),
    (err: unknown) => err instanceof ConfigError && /hookSignals: unknown field nope/.test((err as Error).message),
  );
});

test("validateConfig rejects a too-small hookSignals.staleAfterSeconds", () => {
  assert.throws(
    () => validateConfig({
      ...defaultConfig(),
      hookSignals: { enabled: true, stateDir: "/t", staleAfterSeconds: 10 },
    }),
    (err: unknown) => err instanceof ConfigError && /staleAfterSeconds must be >= 60/.test((err as Error).message),
  );
});

test("validateConfig rejects a non-object hookSignals", () => {
  assert.throws(
    () => validateConfig({ ...defaultConfig(), hookSignals: "yes" }),
    (err: unknown) => err instanceof ConfigError && /hookSignals must be an object/.test((err as Error).message),
  );
});

test("validateConfig still accepts a config with no hookSignals block", () => {
  const raw: Record<string, unknown> = { ...defaultConfig() };
  delete raw.hookSignals;
  assert.equal(validateConfig(raw).hookSignals, undefined);
});

test("defaultConfig ships hookSignals enabled, requiring a bound session", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.hookSignals?.enabled, true);
  assert.equal(cfg.hookSignals?.requireBoundSession, true);
  assert.equal(cfg.hookSignals?.staleAfterSeconds, 900);
});

test("defaultConfig stateDir falls back to ~/.stoke/session-state, and honors the override", () => {
  // The test runner sets STOKE_SESSION_STATE_DIR to keep the suite hermetic
  // (the scheduler PRUNES this directory), so check both branches explicitly.
  const override = process.env.STOKE_SESSION_STATE_DIR;
  try {
    delete process.env.STOKE_SESSION_STATE_DIR;
    assert.match(defaultConfig().hookSignals?.stateDir ?? "", /session-state$/);
    process.env.STOKE_SESSION_STATE_DIR = "Z:/elsewhere";
    assert.equal(defaultConfig().hookSignals?.stateDir, "Z:/elsewhere");
  } finally {
    if (override === undefined) delete process.env.STOKE_SESSION_STATE_DIR;
    else process.env.STOKE_SESSION_STATE_DIR = override;
  }
});
