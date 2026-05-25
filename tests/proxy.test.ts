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

test("proxy forwards POST /v1/messages and records session", async () => {
  const captured: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const { url, server } = await startMockUpstream((req) => {
    captured.push({ headers: req.headers, body: req.body });
    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": "0.04",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        content: [],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 5,
          output_tokens: 10,
          cache_creation_input_tokens: 30000,
          cache_read_input_tokens: 0,
        },
      }),
    };
  });

  const path = join(mkdtempSync(join(tmpdir(), "ckpx-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const proxy = createProxyServer({
    registry,
    logger,
    config: defaultConfig(),
    upstreamUrl: url,
  });
  const listening = await new Promise<{ port: number }>((res) => {
    proxy.listen(0, "127.0.0.1", () => {
      const addr = proxy.address();
      if (addr && typeof addr === "object") res({ port: addr.port });
    });
  });

  // Canonical interactive Claude Code request: must include the cli user-agent
  // and an "Agent" tool entry, otherwise the session-filter rejects it.
  const reqBody = JSON.stringify({
    model: "claude-opus-4-7",
    tools: [{ name: "Agent" }],
    system: "you are a tester",
    messages: [{ role: "user", content: "hi" }],
  });
  const resp = await fetch(`http://127.0.0.1:${listening.port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      "user-agent": "claude-cli/2.1.145 (external, cli)",
    },
    body: reqBody,
  });
  assert.equal(resp.status, 200);
  const responseBody = await resp.json();
  assert.equal((responseBody as any).stop_reason, "end_turn");

  // Mock upstream saw our forwarded request.
  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers.authorization, "Bearer test-token");

  // Registry should have one session, prefix tokens estimated from cache_creation.
  assert.equal(registry.all().length, 1);
  assert.equal(registry.all()[0].prefixTokensEstimate, 30000);

  proxy.close();
  server.close();
  rmSync(path, { force: true });
});

test("proxy registers session for x-api-key auth (no Authorization header)", async () => {
  const captured: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const { url, server } = await startMockUpstream((req) => {
    captured.push({ headers: req.headers, body: req.body });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: [],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 5,
          output_tokens: 10,
          cache_creation_input_tokens: 20000,
          cache_read_input_tokens: 0,
        },
      }),
    };
  });

  const path = join(mkdtempSync(join(tmpdir(), "ckapikey-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const proxy = createProxyServer({
    registry,
    logger,
    config: defaultConfig(),
    upstreamUrl: url,
  });
  const listening = await new Promise<{ port: number }>((res) => {
    proxy.listen(0, "127.0.0.1", () => {
      const addr = proxy.address();
      if (addr && typeof addr === "object") res({ port: addr.port });
    });
  });

  // Send a request with x-api-key only (no Authorization header) — API-key plan flow.
  // Still has to clear the session-filter, so include the cli user-agent and "Agent" tool.
  const resp = await fetch(`http://127.0.0.1:${listening.port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-test-key",
      "user-agent": "claude-cli/2.1.145 (external, cli)",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      tools: [{ name: "Agent" }],
      system: "you are a tester",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(resp.status, 200);
  await resp.json();

  // Mock upstream should have seen the x-api-key forwarded through.
  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers["x-api-key"], "sk-ant-test-key");
  assert.equal(captured[0].headers.authorization, undefined);

  // Session SHOULD be registered even though Authorization was absent.
  assert.equal(registry.all().length, 1);
  const session = registry.all()[0];
  assert.equal(session.lastAuthHeader, ""); // empty Bearer
  assert.equal(session.lastHeaders["x-api-key"], "sk-ant-test-key"); // preserved for ping replay

  proxy.close();
  server.close();
  rmSync(path, { force: true });
});

test("proxy forwards filtered-out requests but does NOT register them", async () => {
  // Verifies the session-filter is enforced at the proxy boundary: an Agent SDK
  // request (user-agent contains `sdk-py`) is still forwarded upstream so the
  // user gets a normal response, but no session is created.
  const captured: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const { url, server } = await startMockUpstream((req) => {
    captured.push({ headers: req.headers, body: req.body });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: [],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    };
  });

  const path = join(mkdtempSync(join(tmpdir(), "ckfilter-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const proxy = createProxyServer({
    registry,
    logger,
    config: defaultConfig(),
    upstreamUrl: url,
  });
  const listening = await new Promise<{ port: number }>((res) => {
    proxy.listen(0, "127.0.0.1", () => {
      const addr = proxy.address();
      if (addr && typeof addr === "object") res({ port: addr.port });
    });
  });

  const resp = await fetch(`http://127.0.0.1:${listening.port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      // Agent SDK signature — must be rejected by the filter.
      "user-agent": "claude-cli/2.1.138 (external, sdk-py, agent-sdk/0.1.80)",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      tools: [{ name: "Agent" }],
      system: "you are a tester",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(resp.status, 200);
  await resp.json();

  // Upstream saw the forwarded request — proxy did its job.
  assert.equal(captured.length, 1);
  // Filter rejected it from the registry — no session for SDK traffic.
  assert.equal(registry.all().length, 0);

  proxy.close();
  server.close();
  rmSync(path, { force: true });
});
