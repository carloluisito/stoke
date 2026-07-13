// tests/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, mergeConfig } from "../src/config.ts";

test("defaultConfig returns expected defaults", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.listen.port, 9876);
  assert.equal(cfg.cacheTtlSeconds, 300);
  assert.equal(cfg.pingCadenceMarginSeconds, 30);
  assert.equal(cfg.abandonTtlMultiplier, 6);
  assert.equal(cfg.requireT1, false);
  assert.equal(cfg.autoSetEnvVar, true);
  assert.equal(cfg.plan, "api-key");
  assert.equal(cfg.enterpriseCap, undefined);
  assert.equal(cfg.budgetCap.max5hUtilizationFromPings, 0.01);
  assert.equal(cfg.budgetCap.maxPingSpendUsd.perDay, 20);
  assert.equal(cfg.budgetCap.maxPingSpendUsd.perMonth, 300);
});

test("mergeConfig accepts cacheTtlSeconds = 3600 (1h cache opt-in)", () => {
  const c = mergeConfig({ cacheTtlSeconds: 3600 });
  assert.equal(c.cacheTtlSeconds, 3600);
  // Derived behavior: cadence = 3600 - 30 = 3570; abandon = 3600 × 6 = 21,600s.
  assert.equal(c.pingCadenceMarginSeconds, 30);
  assert.equal(c.abandonTtlMultiplier, 6);
});

test("mergeConfig rejects pingCadenceMarginSeconds >= cacheTtlSeconds", () => {
  // 60s margin against a 60s TTL leaves nothing to ping under — must reject.
  assert.throws(
    () => mergeConfig({ cacheTtlSeconds: 60, pingCadenceMarginSeconds: 60 }),
    /pingCadenceMarginSeconds.*must be less than.*cacheTtlSeconds/,
  );
});

test("mergeConfig overrides defaults with user values", () => {
  const merged = mergeConfig({
    pingCadenceMarginSeconds: 45,
    budgetCap: { maxPingsPerSession5h: 50 },
  });
  assert.equal(merged.pingCadenceMarginSeconds, 45);
  assert.equal(merged.budgetCap.maxPingsPerSession5h, 50);
  assert.equal(merged.budgetCap.max5hUtilizationFromPings, 0.01);
});

test("mergeConfig leaves defaults untouched on empty input", () => {
  const merged = mergeConfig({});
  const def = defaultConfig();
  assert.deepEqual(merged, def);
});

test("defaultConfig sets evictAfterHours to 24", () => {
  const c = defaultConfig();
  assert.equal(c.evictAfterHours, 24);
});

test("mergeConfig throws when evictAfterHours <= worst-case abandon hours", () => {
  // 1h TTL × 6 multiplier = 6h worst-case abandon. evictAfterHours of 5 is too small.
  assert.throws(
    () => mergeConfig({ evictAfterHours: 5, cacheTtlSeconds: 3600, abandonTtlMultiplier: 6 }),
    /evictAfterHours.*must exceed/,
  );
});

test("mergeConfig accepts evictAfterHours > worst-case abandon hours", () => {
  const c = mergeConfig({ evictAfterHours: 10, cacheTtlSeconds: 3600, abandonTtlMultiplier: 6 });
  assert.equal(c.evictAfterHours, 10);
});

test("loadConfig throws ConfigError on a file with invalid cacheTtlSeconds type", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cfg-bad-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ cacheTtlSeconds: "fast" }));
  const { loadConfig } = await import("../src/config.ts");
  const { ConfigError } = await import("../src/config-schema.ts");
  assert.throws(() => loadConfig(path), ConfigError);
  rmSync(path, { force: true });
});

test("loadConfig accepts a file with valid partial overrides", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cfg-ok-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ pingCadenceMarginSeconds: 45 }));
  const { loadConfig } = await import("../src/config.ts");
  const cfg = loadConfig(path);
  assert.equal(cfg.pingCadenceMarginSeconds, 45);
  rmSync(path, { force: true });
});
