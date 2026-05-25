// scripts/dashboard-smoke.mjs
// Spins up the proxy with the dashboard enabled, pumps a fake real_request
// through a mock upstream so /api/state has actual session data, then prints
// what the dashboard would render.

import { createProxyServer } from "../src/proxy.ts";
import { Registry } from "../src/registry.ts";
import { JsonlLogger } from "../src/logger.ts";
import { defaultConfig } from "../src/config.ts";
import { startMockUpstream } from "../tests/integration/mock-upstream.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const path = join(mkdtempSync(join(tmpdir(), "dash-smoke-")), "events.jsonl");
const registry = new Registry();
const logger = new JsonlLogger(path);

const { url: upstreamUrl, server: upstream } = await startMockUpstream((req) => {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: [], stop_reason: "end_turn",
      usage: {
        input_tokens: 5, output_tokens: 12,
        cache_creation_input_tokens: 30000,
        cache_read_input_tokens: 50000,
      },
    }),
  };
});

const config = defaultConfig();
const proxy = createProxyServer({
  registry, logger, config, upstreamUrl,
  dashboard: { startedAt: Date.now() - 5 * 60 * 1000 },
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const port = proxy.address().port;
console.log(`proxy listening on 127.0.0.1:${port}`);
console.log(`dashboard:   http://127.0.0.1:${port}/dashboard`);
console.log(`api state:   http://127.0.0.1:${port}/api/state`);

// Send a real request through the proxy so the registry has a session.
const reqBody = JSON.stringify({
  model: "claude-opus-4-7",
  tools: [],
  system: "<env>\n  cwd: C:\\Users\\carlo\\Desktop\\repositories\\work\\resto-backend\n</env>",
  messages: [{ role: "user", content: "hi" }],
});
await fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer test-token" },
  body: reqBody,
});

// Wait a tick for the response-end handler to register usage.
await new Promise((r) => setTimeout(r, 100));

// Now fetch /api/state and pretty-print the parts the dashboard renders.
const resp = await fetch(`http://127.0.0.1:${port}/api/state`);
const api = await resp.json();
console.log("\n--- /api/state (real data) ---");
console.log("plan:               ", api.plan);
console.log("uptime:             ", api.uptimeSeconds, "sec");
console.log("totals:             ", api.totals);
console.log("spendWindows.today: ", api.spendWindows.today);
console.log("spendWindows.month: ", api.spendWindows.month);
console.log("sessions[0]:");
for (const [k, v] of Object.entries(api.sessions[0] ?? {})) {
  console.log("  " + k.padEnd(22), v);
}
console.log("recentEvents[0]:");
console.log("  " + JSON.stringify(api.recentEvents[0] ?? null));

proxy.close();
upstream.close();
rmSync(path, { force: true });
