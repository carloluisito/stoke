import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream } from "./integration/mock-upstream.ts";
import { createProxyServer } from "../src/proxy.ts";
import { Registry } from "../src/registry.ts";
import { JsonlLogger } from "../src/logger.ts";
import { defaultConfig } from "../src/config.ts";

/** Parse text/event-stream chunks into typed events. */
function parseSseChunk(buffer: string): Array<{ event: string; data: string }> {
  const out: Array<{ event: string; data: string }> = [];
  for (const block of buffer.split("\n\n")) {
    const lines = block.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) out.push({ event, data: dataLines.join("\n") });
  }
  return out;
}

/**
 * Collect SSE events from a Response.body reader for `windowMs` milliseconds.
 * Uses a master cancel timer rather than racing reader.read() with a per-iteration
 * timeout — the racing pattern drops chunks consumed by abandoned read promises.
 */
async function collectSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  windowMs: number,
  events: Array<{ event: string; data: string }>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const cancelTimer = setTimeout(() => { void reader.cancel(); }, windowMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lastBlankIdx = buffer.lastIndexOf("\n\n");
      if (lastBlankIdx !== -1) {
        const ready = buffer.slice(0, lastBlankIdx + 2);
        buffer = buffer.slice(lastBlankIdx + 2);
        events.push(...parseSseChunk(ready));
      }
    }
  } catch {
    // reader.cancel() rejects the in-flight read with AbortError — expected.
  } finally {
    clearTimeout(cancelTimer);
  }
}

test("/api/stream without query token returns 401", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sse-noauth-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = { ...defaultConfig(), authToken: "b".repeat(32) };
  const proxy = createProxyServer({
    registry, logger, config,
    dashboard: { startedAt: Date.now() },
  });
  await new Promise<void>((res) => proxy.listen(0, "127.0.0.1", () => res()));
  const port = (proxy.address() as { port: number }).port;

  const resp = await fetch(`http://127.0.0.1:${port}/api/stream`);
  assert.equal(resp.status, 401);

  proxy.close();
  rmSync(path, { force: true });
});

test("/api/stream with query token connects", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sse-auth-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = { ...defaultConfig(), authToken: "c".repeat(32) };
  const proxy = createProxyServer({
    registry, logger, config,
    dashboard: { startedAt: Date.now() },
  });
  await new Promise<void>((res) => proxy.listen(0, "127.0.0.1", () => res()));
  const port = (proxy.address() as { port: number }).port;

  const resp = await fetch(`http://127.0.0.1:${port}/api/stream?token=${config.authToken}`);
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type") ?? "", /text\/event-stream/i);

  void resp.body!.cancel();
  proxy.close();
  rmSync(path, { force: true });
});

test("/api/stream sends initial snapshot and live events on logger writes", async () => {
  const { url: upstreamUrl, server: upstream } = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: [], stop_reason: "end_turn",
      usage: {
        input_tokens: 5, output_tokens: 12,
        cache_creation_input_tokens: 20000, cache_read_input_tokens: 0,
      },
    }),
  }));

  const path = join(mkdtempSync(join(tmpdir(), "sse-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = { ...defaultConfig(), authToken: "d".repeat(32) };
  const proxy = createProxyServer({
    registry, logger, config, upstreamUrl,
    dashboard: { startedAt: Date.now() },
  });
  await new Promise<void>((res) => proxy.listen(0, "127.0.0.1", () => res()));
  const port = (proxy.address() as { port: number }).port;

  // Open SSE connection. Node 18+ fetch returns a streaming ReadableStream
  // which we can iterate as text chunks.
  const sseResp = await fetch(`http://127.0.0.1:${port}/api/stream?token=${config.authToken}`);
  assert.equal(sseResp.status, 200);
  assert.match(
    sseResp.headers.get("content-type") ?? "",
    /text\/event-stream/i,
  );
  const reader = sseResp.body!.getReader();
  const events: Array<{ event: string; data: string }> = [];

  // Drive a real request through the proxy *concurrently* with the SSE read,
  // so the log + debounced snapshot land inside the collection window.
  const driver = (async () => {
    // Tiny delay so the initial snapshot is emitted before the request lands.
    await new Promise((r) => setTimeout(r, 100));
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test",
        "user-agent": "claude-cli/2.1.145 (external, cli)",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        tools: [{ name: "Agent" }], system: "you are a tester",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  })();

  // Collect for 1500ms: covers initial snapshot, the request, the log, and
  // the 500ms-debounced snapshot.
  await collectSseEvents(reader, 1500, events);
  await driver;

  assert.ok(events.length >= 1, "expected at least one initial event");
  assert.equal(events[0].event, "snapshot");
  const initialSnapshot = JSON.parse(events[0].data);
  assert.equal(initialSnapshot.plan, "api-key");
  // Value-redesign fields — shape only, no exact values.
  assert.ok(initialSnapshot.savings, "snapshot.savings missing");
  assert.ok(initialSnapshot.savings.today, "snapshot.savings.today missing");
  assert.equal(typeof initialSnapshot.savings.today.savedUsd, "number");
  assert.equal(typeof initialSnapshot.savings.today.rebuildsAvoided, "number");
  assert.ok("roiMultiple" in initialSnapshot.savings.today);
  assert.ok(initialSnapshot.savings.month, "snapshot.savings.month missing");
  assert.equal(typeof initialSnapshot.savings.month.savedUsd, "number");
  assert.equal(typeof initialSnapshot.savings.month.rebuildsAvoided, "number");
  assert.ok(initialSnapshot.savings.last5h, "snapshot.savings.last5h missing");
  assert.equal(typeof initialSnapshot.savings.last5h.savedUsd, "number");
  assert.ok(Array.isArray(initialSnapshot.savings.last5h.buckets));
  assert.equal(initialSnapshot.savings.last5h.buckets.length, 20);
  assert.ok(initialSnapshot.cacheHealth, "snapshot.cacheHealth missing");
  assert.ok("hitRate" in initialSnapshot.cacheHealth);
  assert.equal(typeof initialSnapshot.cacheHealth.realRequestsToday, "number");
  assert.equal(typeof initialSnapshot.cacheHealth.cacheHitsToday, "number");
  assert.equal(initialSnapshot.sessions.length, 0);

  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes("log"), `expected a 'log' event, got: ${kinds.join(",")}`);
  assert.ok(
    kinds.filter((k) => k === "snapshot").length >= 2,
    "expected at least two 'snapshot' events (initial + post-write)",
  );

  // The latest snapshot should reflect the new session.
  const lastSnapshot = JSON.parse(
    events.filter((e) => e.event === "snapshot").pop()!.data,
  );
  assert.equal(lastSnapshot.sessions.length, 1);
  assert.equal(lastSnapshot.totals.sessionsActive, 1);
  assert.equal(typeof lastSnapshot.sessions[0].savedUsdAllTime, "number");

  proxy.close();
  upstream.close();
  rmSync(path, { force: true });
});

test("/api/stream: bursts of writes are coalesced into one debounced snapshot", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sse-burst-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = { ...defaultConfig(), authToken: "e".repeat(32) };
  const proxy = createProxyServer({
    registry, logger, config,
    dashboard: { startedAt: Date.now() },
  });
  await new Promise<void>((res) => proxy.listen(0, "127.0.0.1", () => res()));
  const port = (proxy.address() as { port: number }).port;

  const sseResp = await fetch(`http://127.0.0.1:${port}/api/stream?token=${config.authToken}`);
  const reader = sseResp.body!.getReader();
  const events: Array<{ event: string; data: string }> = [];

  // Drive 10 writes concurrently with the read window.
  const driver = (async () => {
    await new Promise((r) => setTimeout(r, 200)); // let initial snapshot arrive
    for (let i = 0; i < 10; i++) {
      logger.write({
        ts: new Date().toISOString(),
        kind: "ping_fired",
        sessionKey: "k", model: "m",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 },
        ratelimits: { unified5hUtilization: null, unified7dUtilization: null, unified5hResetEpoch: null, overageStatus: null },
        costUsd: 0.001,
      } as any);
    }
  })();

  // Collect for 1200ms: 200ms warmup + 500ms debounce + 500ms slack.
  await collectSseEvents(reader, 1200, events);
  await driver;

  const snapshots = events.filter((e) => e.event === "snapshot");
  const logs = events.filter((e) => e.event === "log");
  assert.equal(snapshots.length, 2, `expected initial + one debounced snapshot, got ${snapshots.length}`);
  assert.equal(logs.length, 10, "every raw log event must be emitted immediately");

  proxy.close();
  rmSync(path, { force: true });
});

test("/api/stream: writes spaced past the debounce window produce a snapshot each", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sse-space-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = { ...defaultConfig(), authToken: "f".repeat(32) };
  const proxy = createProxyServer({
    registry, logger, config,
    dashboard: { startedAt: Date.now() },
  });
  await new Promise<void>((res) => proxy.listen(0, "127.0.0.1", () => res()));
  const port = (proxy.address() as { port: number }).port;

  const sseResp = await fetch(`http://127.0.0.1:${port}/api/stream?token=${config.authToken}`);
  const reader = sseResp.body!.getReader();
  const events: Array<{ event: string; data: string }> = [];

  const writeOne = () => logger.write({
    ts: new Date().toISOString(),
    kind: "ping_fired",
    sessionKey: "k", model: "m",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 },
    ratelimits: { unified5hUtilization: null, unified7dUtilization: null, unified5hResetEpoch: null, overageStatus: null },
    costUsd: 0.001,
  } as any);

  // Drive two writes ~800ms apart, both inside the read window.
  const driver = (async () => {
    await new Promise((r) => setTimeout(r, 200));
    writeOne();
    await new Promise((r) => setTimeout(r, 800));
    writeOne();
  })();

  // Collect for 2000ms: 200ms warmup + 800ms gap + 500ms debounce + 500ms slack.
  await collectSseEvents(reader, 2000, events);
  await driver;

  const snapshots = events.filter((e) => e.event === "snapshot");
  assert.equal(snapshots.length, 3, `expected initial + two debounced, got ${snapshots.length}`);

  proxy.close();
  rmSync(path, { force: true });
});

test("/api/stream subscription is cleaned up when the client disconnects", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sse-clean-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = { ...defaultConfig(), authToken: "9".repeat(32) };
  const proxy = createProxyServer({
    registry, logger, config,
    dashboard: { startedAt: Date.now() },
  });
  await new Promise<void>((res) => proxy.listen(0, "127.0.0.1", () => res()));
  const port = (proxy.address() as { port: number }).port;

  // Open and immediately close the stream.
  const ac = new AbortController();
  const sseResp = await fetch(`http://127.0.0.1:${port}/api/stream?token=${config.authToken}`, {
    signal: ac.signal,
  });
  // Read one chunk to make sure we've connected, then abort.
  const reader = sseResp.body!.getReader();
  await reader.read();
  ac.abort();
  // Give the server a moment to notice the close.
  await new Promise((r) => setTimeout(r, 100));

  // After client disconnect, writing to the logger must not throw or hang
  // (because the dead subscriber is gone). If it did, this assertion would
  // never complete and the test would time out.
  logger.write({
    ts: new Date().toISOString(),
    kind: "real_request",
    sessionKey: "deadbeef",
    model: "x", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ratelimits: { unified5hUtilization: null, unified7dUtilization: null, unified5hResetEpoch: null, overageStatus: null },
  } as any);

  assert.ok(true);
  proxy.close();
  rmSync(path, { force: true });
});
