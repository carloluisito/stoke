import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCacheStatus,
  buildSessionStateTotals,
  latestRatelimits,
  serializeSession,
  tryHandleStats,
  isLoopback,
  CACHE_TTL_SECONDS,
  type StatsDeps,
} from "../src/stats-handler.ts";
import { Registry } from "../src/registry.ts";
import { JsonlLogger } from "../src/logger.ts";
import { defaultConfig } from "../src/config.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Session } from "../src/types.ts";

// ===== helpers ========================================================
//
// Route tests drive tryHandleStats directly with stub req/res objects —
// no real sockets. The old dashboard-handler tests started real HTTP
// servers whose keep-alive connections could outlive the test file.

function stubReq(opts: { method?: string; url: string; remoteAddress?: string }): IncomingMessage {
  return {
    method: opts.method ?? "GET",
    url: opts.url,
    headers: {},
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function stubRes(): ServerResponse & { captured: { status?: number; body?: string } } {
  const captured: { status?: number; body?: string } = {};
  const res = {
    captured,
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(text?: string | Buffer) {
      if (text != null) captured.body = text.toString();
    },
  };
  return res as unknown as ServerResponse & { captured: { status?: number; body?: string } };
}

function makeDeps(): StatsDeps & { path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "sh-")), "events.jsonl");
  return {
    registry: new Registry(),
    logger: new JsonlLogger(path),
    config: defaultConfig(),
    startedAt: Date.now(),
    version: "test",
    path,
  };
}

function baseSession(overrides: Partial<Session>): Session {
  return {
    key: "abc",
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
    detectedTtlSeconds: 300,
    pingsSinceLastReal: 0,
    pingHistory5h: [],
    lastRatelimits: null,
    state: "active",
    ...overrides,
  };
}

// ===== cache status (pure) ============================================

test("cacheStatus is 'warm' when active and idle is under the TTL", () => {
  const now = 10_000_000;
  const s = baseSession({
    state: "active",
    lastSeenAt: now - (CACHE_TTL_SECONDS - 1) * 1000,
  });
  assert.equal(deriveCacheStatus(s, now), "warm");
});

test("cacheStatus is 'cold' when active but idle has exceeded the TTL", () => {
  // The headline bug: scheduler is blocked from pinging (e.g. daily spend cap)
  // long enough that Anthropic's ephemeral cache has expired, but the session
  // still sits in 'active' until abandonAfterMinutes (30m default).
  const now = 10_000_000;
  const s = baseSession({
    state: "active",
    lastSeenAt: now - (CACHE_TTL_SECONDS + 1) * 1000,
  });
  assert.equal(deriveCacheStatus(s, now), "cold");
});

test("cacheStatus passes 'paused' through unchanged", () => {
  const now = 10_000_000;
  const s = baseSession({
    state: "paused",
    pauseReason: "cache_miss",
    lastSeenAt: now - 9 * 60 * 1000,
  });
  assert.equal(deriveCacheStatus(s, now), "paused");
});

test("cacheStatus passes 'abandoned' through unchanged", () => {
  const now = 10_000_000;
  const s = baseSession({
    state: "abandoned",
    lastSeenAt: now - 31 * 60 * 1000,
  });
  assert.equal(deriveCacheStatus(s, now), "abandoned");
});

test("cacheStatus uses lastSeenAt — successful pings refresh warmth", () => {
  // After a successful ping (cache_read > 0), recordPingResult updates
  // lastSeenAt. So a session with old lastRealRequestAt but recent ping
  // activity must still read as warm.
  const now = 10_000_000;
  const s = baseSession({
    state: "active",
    lastRealRequestAt: now - 20 * 60 * 1000, // 20m since real request
    lastSeenAt: now - 60 * 1000,             // ping fired 1m ago
  });
  assert.equal(deriveCacheStatus(s, now), "warm");
});

test("session totals count cold sessions separately from active lifecycle count", () => {
  // sessionsActive remains the lifecycle count (state === "active") for
  // backward compat; sessionsCold is the subset of those whose cache has
  // expired. The renderer derives warm = active - cold.
  const now = 10_000_000;
  const warm = baseSession({ key: "w", state: "active", lastSeenAt: now - 60_000 });
  const cold = baseSession({ key: "c", state: "active", lastSeenAt: now - 16 * 60_000 });
  const paused = baseSession({ key: "p", state: "paused", lastSeenAt: now - 60_000 });
  const abandoned = baseSession({ key: "a", state: "abandoned", lastSeenAt: now - 60_000 });
  const totals = buildSessionStateTotals([warm, cold, paused, abandoned], now);
  assert.equal(totals.sessionsActive, 2);
  assert.equal(totals.sessionsCold, 1);
  assert.equal(totals.sessionsPaused, 1);
  assert.equal(totals.sessionsAbandoned, 1);
});

// ===== ratelimits + session serialization (pure) ======================

test("latestRatelimits returns ratelimits from the most-recent session that has them", () => {
  const now = 10_000_000;
  const a = baseSession({ key: "a", lastSeenAt: now - 60_000, lastRatelimits: { unified5hUtilization: 0.3, unified7dUtilization: 0.1, unified5hResetEpoch: 1, overageStatus: "allowed" } });
  const b = baseSession({ key: "b", lastSeenAt: now - 30_000, lastRatelimits: { unified5hUtilization: 0.7, unified7dUtilization: 0.2, unified5hResetEpoch: 2, overageStatus: "allowed" } });
  const c = baseSession({ key: "c", lastSeenAt: now - 10_000, lastRatelimits: null });
  const out = latestRatelimits([a, b, c]);
  assert.equal(out.unified5hUtilization, 0.7);
  assert.equal(out.unified7dUtilization, 0.2);
});

test("latestRatelimits returns nulls when no session has ratelimits yet", () => {
  const a = baseSession({ key: "a", lastRatelimits: null });
  const out = latestRatelimits([a]);
  assert.equal(out.unified5hUtilization, null);
  assert.equal(out.unified7dUtilization, null);
});

test("serializeSession derives pingCount5h and pingCostUsd5h from pingHistory5h via Registry", () => {
  const reg = new Registry();
  const { key } = reg.upsert({ model: "claude-opus-4-7", tools: [], system: "s" }, "Bearer abc", 0);
  const rl = { unified5hUtilization: null, unified7dUtilization: null, unified5hResetEpoch: null, overageStatus: null } as const;
  const usage = { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 60_000 };
  const FIVE_H = 5 * 60 * 60 * 1000;
  const now = FIVE_H + 1;
  reg.recordPingResult(key, true, usage, 0.002, now - FIVE_H - 1, rl); // aged out
  reg.recordPingResult(key, true, usage, 0.003, now - 1000, rl);
  reg.recordPingResult(key, true, usage, 0.004, now - 500, rl);
  const s = reg.get(key)!;
  const dto = serializeSession(s, now, 0, reg);
  assert.equal(dto.pingCount5h, 2);
  assert.ok(Math.abs((dto.pingCostUsd5h as number) - 0.007) < 1e-9);
});

// ===== loopback gate ===================================================

test("isLoopback accepts IPv4, IPv6, and IPv4-mapped loopback addresses", () => {
  for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopback(stubReq({ url: "/", remoteAddress: addr })), true, addr);
  }
  for (const addr of ["192.168.1.5", "10.0.0.2", "203.0.113.7", ""]) {
    assert.equal(isLoopback(stubReq({ url: "/", remoteAddress: addr })), false, addr || "(empty)");
  }
});

// ===== routes (stubbed req/res — no sockets) ===========================

test("/api/health is reachable and reports liveness", () => {
  const deps = makeDeps();
  const res = stubRes();
  const handled = tryHandleStats(stubReq({ url: "/api/health" }), res, deps);
  assert.equal(handled, true);
  assert.equal(res.captured.status, 200);
  const body = JSON.parse(res.captured.body!) as { ok: boolean; uptimeSeconds: number; version: string; ts: string };
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptimeSeconds, "number");
  assert.equal(body.version, "test");
  assert.match(body.ts, /^\d{4}-\d{2}-\d{2}T/);
  rmSync(deps.path, { force: true });
});

test("/api/health does not leak session counts or auth metadata", () => {
  const deps = makeDeps();
  const res = stubRes();
  tryHandleStats(stubReq({ url: "/api/health" }), res, deps);
  assert.doesNotMatch(res.captured.body!, /sessions/i);
  assert.doesNotMatch(res.captured.body!, /ratelimits/i);
  assert.doesNotMatch(res.captured.body!, /authToken/i);
  rmSync(deps.path, { force: true });
});

test("/_stoke/stats from loopback returns the full state payload", () => {
  const deps = makeDeps();
  const res = stubRes();
  const handled = tryHandleStats(stubReq({ url: "/_stoke/stats" }), res, deps);
  assert.equal(handled, true);
  assert.equal(res.captured.status, 200);
  const body = JSON.parse(res.captured.body!) as Record<string, unknown>;
  assert.ok(Array.isArray(body.sessions));
  assert.ok(body.budget && typeof body.budget === "object");
  assert.ok(body.savings && typeof body.savings === "object");
  assert.ok(body.totals && typeof body.totals === "object");
  assert.equal(typeof body.uptimeSeconds, "number");
  rmSync(deps.path, { force: true });
});

test("/_stoke/stats from a non-loopback address returns 403", () => {
  const deps = makeDeps();
  const res = stubRes();
  const handled = tryHandleStats(
    stubReq({ url: "/_stoke/stats", remoteAddress: "192.168.1.5" }),
    res,
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.captured.status, 403);
  const body = JSON.parse(res.captured.body!) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /loopback/i);
  rmSync(deps.path, { force: true });
});

test("/v1/messages and unknown routes are not handled (fall through to forwarder)", () => {
  const deps = makeDeps();
  for (const url of ["/v1/messages", "/dashboard", "/api/state", "/api/stream", "/api/reload"]) {
    const res = stubRes();
    const method = url === "/api/reload" || url === "/v1/messages" ? "POST" : "GET";
    const handled = tryHandleStats(stubReq({ method, url }), res, deps);
    assert.equal(handled, false, url);
  }
  rmSync(deps.path, { force: true });
});
