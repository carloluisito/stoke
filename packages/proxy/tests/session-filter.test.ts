import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldTrackSession } from "../src/session-filter.ts";

// Captured signatures from real traffic 2026-05-20:
//
// Interactive Claude Code REPL (main session):
//   user-agent: claude-cli/2.1.145 (external, cli)
//   tools[]: includes "Agent"
//   systemTotalChars: ~28k
//
// Sub-agent (Explore agent) — same Claude Code process:
//   user-agent: claude-cli/2.1.145 (external, cli)   ← SAME as main
//   tools[]: does NOT include "Agent"               ← differs
//   systemTotalChars: ~3.4k
//
// Agent SDK / `claude -p`:
//   user-agent: claude-cli/2.1.138 (external, sdk-py, agent-sdk/0.1.80)

test("session-filter: accepts interactive Claude Code main session", () => {
  const result = shouldTrackSession(
    { "user-agent": "claude-cli/2.1.145 (external, cli)" },
    { tools: [{ name: "Agent" }, { name: "Bash" }, { name: "Read" }] },
  );
  assert.equal(result, true);
});

test("session-filter: rejects Agent SDK / claude-agent-sdk", () => {
  const result = shouldTrackSession(
    {
      "user-agent":
        "claude-cli/2.1.138 (external, sdk-py, agent-sdk/0.1.80)",
    },
    { tools: [{ name: "Agent" }, { name: "Bash" }] },
  );
  assert.equal(result, false);
});

test("session-filter: rejects `claude -p` / sdk-py entrypoint", () => {
  // Same shape as Agent SDK — Claude Code's print mode uses the sdk-py path.
  const result = shouldTrackSession(
    { "user-agent": "claude-cli/2.1.145 (external, sdk-py)" },
    { tools: [{ name: "Agent" }] },
  );
  assert.equal(result, false);
});

test("session-filter: rejects sub-agent (cli user-agent, no Agent tool)", () => {
  const result = shouldTrackSession(
    { "user-agent": "claude-cli/2.1.145 (external, cli)" },
    { tools: [{ name: "Bash" }, { name: "Read" }, { name: "Grep" }] },
  );
  assert.equal(result, false);
});

test("session-filter: rejects request with missing user-agent", () => {
  const result = shouldTrackSession({}, { tools: [{ name: "Agent" }] });
  assert.equal(result, false);
});

test("session-filter: rejects request with non-string tools", () => {
  const result = shouldTrackSession(
    { "user-agent": "claude-cli/2.1.145 (external, cli)" },
    { tools: "not an array" },
  );
  assert.equal(result, false);
});

test("session-filter: rejects request with no tools field", () => {
  const result = shouldTrackSession(
    { "user-agent": "claude-cli/2.1.145 (external, cli)" },
    {},
  );
  assert.equal(result, false);
});

test("session-filter: tool with non-string name is ignored safely", () => {
  // Defensive: a malformed tool object should not throw, just be skipped.
  const result = shouldTrackSession(
    { "user-agent": "claude-cli/2.1.145 (external, cli)" },
    { tools: [{ name: 123 }, { name: "Agent" }] },
  );
  assert.equal(result, true);
});
