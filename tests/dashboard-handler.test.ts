import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCacheStatus,
  buildSessionStateTotals,
  latestRatelimits,
  serializeSession,
  CACHE_TTL_SECONDS,
} from "../src/dashboard-handler.ts";
import { Registry } from "../src/registry.ts";
import { JsonlLogger } from "../src/logger.ts";
import { defaultConfig } from "../src/config.ts";
import { createProxyServer } from "../src/proxy.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/types.ts";

function startProxyForReloadTest(): Promise<{ port: number; close: () => void; token: string; path: string }> {
  const path = join(mkdtempSync(join(tmpdir(), "dh-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = { ...defaultConfig(), authToken: "a".repeat(32) };
  const proxy = createProxyServer({
    registry, logger, config,
    dashboard: { startedAt: Date.now() },
  });
  return new Promise((resolve) => {
    proxy.listen(0, "127.0.0.1", () => {
      const port = (proxy.address() as { port: number }).port;
      resolve({ port, close: () => proxy.close(), token: config.authToken, path });
    });
  });
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

test("/api/reload rejects unknown top-level keys", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/api/reload`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${t.token}`,
    },
    body: JSON.stringify({ spendUsdMonth: 999 }),
  });
  assert.equal(resp.status, 400);
  const body = await resp.json() as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /unknown field/i);
  t.close();
  rmSync(t.path, { force: true });
});

test("/api/reload rejects bad plan enum", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/api/reload`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${t.token}`,
    },
    body: JSON.stringify({ plan: "free-tier" }),
  });
  assert.equal(resp.status, 400);
  t.close();
  rmSync(t.path, { force: true });
});

test("/api/reload accepts valid plan + enterpriseCap", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/api/reload`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${t.token}`,
    },
    body: JSON.stringify({
      plan: "enterprise",
      enterpriseCap: { monthlyCapUsd: 500, cycleStartDayOfMonth: 1 },
    }),
  });
  assert.equal(resp.status, 200);
  const body = await resp.json() as { ok: boolean; plan: string };
  assert.equal(body.ok, true);
  assert.equal(body.plan, "enterprise");
  t.close();
  rmSync(t.path, { force: true });
});

test("/api/state without token returns 401", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/api/state`);
  assert.equal(resp.status, 401);
  const body = await resp.json() as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /auth required/i);
  t.close();
  rmSync(t.path, { force: true });
});

test("/api/state with wrong token returns 401", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/api/state`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(resp.status, 401);
  t.close();
  rmSync(t.path, { force: true });
});

test("/api/state with correct token returns 200", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/api/state`, {
    headers: { authorization: `Bearer ${t.token}` },
  });
  assert.equal(resp.status, 200);
  t.close();
  rmSync(t.path, { force: true });
});

test("/api/state with query token returns 401 (header-only for state)", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/api/state?token=${t.token}`);
  assert.equal(resp.status, 401);
  t.close();
  rmSync(t.path, { force: true });
});

test("/dashboard without token returns 401", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/dashboard`);
  assert.equal(resp.status, 401);
  t.close();
  rmSync(t.path, { force: true });
});

test("/dashboard with query token returns 200 (browser-bootstrap path)", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/dashboard?token=${t.token}`);
  assert.equal(resp.status, 200);
  t.close();
  rmSync(t.path, { force: true });
});

test("/api/health is reachable WITHOUT a token", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/api/health`);
  assert.equal(resp.status, 200);
  const body = await resp.json() as { ok: boolean; uptimeSeconds: number; version: string; ts: string };
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptimeSeconds, "number");
  assert.equal(typeof body.version, "string");
  assert.match(body.ts, /^\d{4}-\d{2}-\d{2}T/);
  t.close();
  rmSync(t.path, { force: true });
});

test("/api/health does not leak session counts or auth metadata", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/api/health`);
  const text = await resp.text();
  assert.doesNotMatch(text, /sessions/i);
  assert.doesNotMatch(text, /ratelimits/i);
  assert.doesNotMatch(text, /authToken/i);
  t.close();
  rmSync(t.path, { force: true });
});

test("/dashboard?token=… returns HTML with the token in a meta tag", async () => {
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/dashboard?token=${t.token}`);
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.match(html, /<meta name="stoke-token" content="a{32}">/);
  t.close();
  rmSync(t.path, { force: true });
});

test("/v1/messages does NOT require the dashboard token", async () => {
  // The proxy forwards /v1/messages to Anthropic, which may reject our bogus
  // auth with its own 401. To prove the dashboard gate didn't intercept,
  // confirm the body isn't OUR gate's auth-required shape.
  const t = await startProxyForReloadTest();
  const resp = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test",
      "user-agent": "claude-cli/2.1.145 (external, cli)",
    },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await resp.text();
  // Our gate emits exactly { ok: false, error: "auth required" }.
  assert.doesNotMatch(text, /"error":\s*"auth required"/);
  t.close();
  rmSync(t.path, { force: true });
});
