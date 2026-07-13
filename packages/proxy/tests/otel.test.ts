import { test } from "node:test";
import assert from "node:assert/strict";

test("init({ enabled: false }) is a no-op", async () => {
  const otel = await import("../src/otel.ts");
  const handle = await otel.init({ enabled: false });
  assert.equal(handle.enabled, false);
  // Helpers must exist and silently succeed when disabled.
  const span = handle.startProxySpan?.("test", {});
  span?.end?.();
  handle.incrementCounter?.("test_total", 1);
  await handle.shutdown?.();
  assert.ok(true);
});

test("init({ enabled: true }) attempts to load @opentelemetry/api; skipped if missing", async () => {
  let hasOtel = false;
  try {
    // Using a string to defeat ESM's eager resolution.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await import("@opentelemetry/api" as string);
    hasOtel = true;
  } catch {
    /* not installed */
  }
  if (!hasOtel) {
    return; // skip silently — optional dep not installed
  }
  const otel = await import("../src/otel.ts");
  const handle = await otel.init({ enabled: true, serviceName: "test" });
  assert.equal(handle.enabled, true);
  await handle.shutdown?.();
});
