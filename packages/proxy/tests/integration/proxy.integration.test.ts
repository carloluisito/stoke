import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream } from "./mock-upstream.ts";
import { createProxyServer } from "../../src/proxy.ts";
import { Registry } from "../../src/registry.ts";
import { JsonlLogger } from "../../src/logger.ts";
import { defaultConfig } from "../../src/config.ts";
import { BudgetGuard } from "../../src/budget.ts";
import { runSchedulerTick } from "../../src/scheduler.ts";

test("end-to-end: real request -> ping -> cache_read populated", async () => {
  let pingSeen = false;
  const { url, server } = await startMockUpstream((req) => {
    const body = JSON.parse(req.body);
    if (body.max_tokens === 0) {
      pingSeen = true;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: [],
          stop_reason: "max_tokens",
          usage: {
            input_tokens: 2,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 50000,
          },
        }),
      };
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: [],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 5,
          output_tokens: 10,
          cache_creation_input_tokens: 50000,
          cache_read_input_tokens: 0,
        },
      }),
    };
  });

  const path = join(mkdtempSync(join(tmpdir(), "ckint-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = { ...defaultConfig(), requireT1: false };
  const proxy = createProxyServer({ registry, logger, config, upstreamUrl: url });
  await new Promise<void>((res) => proxy.listen(0, "127.0.0.1", () => res()));
  const proxyPort = (proxy.address() as { port: number }).port;

  // Send a real request through the proxy. Must clear the session-filter:
  // interactive cli user-agent + an "Agent" tool entry.
  const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      "user-agent": "claude-cli/2.1.145 (external, cli)",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      tools: [{ name: "Agent" }],
      system: "you are tester",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(resp.status, 200);
  await resp.json();

  // One session in registry, idle past threshold → scheduler will ping.
  const guard = new BudgetGuard(config);
  // Inject fake "now" = realLastSeen + ping threshold + 1 ms.
  const session = registry.all()[0];
  // Per-session cadence: (detectedTtlSeconds - marginSeconds) × 1000. For a
  // 5-min default session that's (300 - 30) × 1000 = 270_000ms, same as before.
  const cadenceMs =
    ((session.detectedTtlSeconds || config.cacheTtlSeconds) -
      config.pingCadenceMarginSeconds) *
    1000;
  const fakeNow = session.lastSeenAt + cadenceMs + 1;

  const fetcher = async (payload: Record<string, unknown>, auth: string) => {
    const r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(payload),
    });
    const body = await r.json();
    return {
      status: r.status,
      usage: (body as { usage: any }).usage ?? null,
      ratelimits: {
        unified5hUtilization: null,
        unified7dUtilization: null,
        unified5hResetEpoch: null,
        overageStatus: null,
      },
    };
  };

  await runSchedulerTick({
    registry,
    logger,
    config,
    guard,
    fetcher,
    nowMs: fakeNow,
    spendUsdToday: 0,
    spendUsdMonth: 0,
    pingsToday: 0,
  });

  assert.equal(pingSeen, true, "scheduler should have fired one ping");
  // Read events from the in-memory snapshot — async writes may not have
  // flushed to disk yet, and the snapshot is the canonical source.
  const log = logger.snapshot();
  const real = log.filter((e) => e.kind === "real_request");
  const pings = log.filter((e) => e.kind === "ping_fired");
  assert.equal(real.length, 1);
  assert.equal(pings.length, 1);
  assert.equal((pings[0] as { usage: { cache_read_input_tokens: number } }).usage.cache_read_input_tokens, 50000);

  proxy.close();
  server.close();
  rmSync(path, { force: true });
});
