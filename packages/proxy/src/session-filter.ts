// src/session-filter.ts
//
// Predicate: should this incoming /v1/messages request be tracked as a
// keep-alive session?
//
// Goal: register ONLY the main interactive Claude Code REPL session.
// Reject Agent SDK, `claude -p`, and Task sub-agents. They either don't
// stay around long enough to benefit from keep-alive pings, or
// (sub-agents) they share the parent's process and would pollute the
// dashboard with duplicate rows per Task spawn.
//
// Two layers, both must pass:
//   1. user-agent ends with `(external, cli)` — drops sdk-py and agent-sdk
//   2. tools[] contains a tool named "Agent" — drops sub-agents
//      (sub-agents cannot dispatch further sub-agents, so they lack the tool;
//      verified empirically against the Explore agent's request signature).
//
// Caveat: a `general-purpose` sub-agent has `Tools: *` and would slip past
// layer 2. Tolerated for now; close the gap with a third layer if it shows up
// as noise.

import type { IncomingHttpHeaders } from "node:http";

const INTERACTIVE_USER_AGENT_RE =
  /^claude-cli\/[\d.]+ \(external, cli\)$/;

export function shouldTrackSession(
  headers: IncomingHttpHeaders,
  body: Record<string, unknown>,
): boolean {
  return hasInteractiveUserAgent(headers) && bodyHasAgentTool(body);
}

function hasInteractiveUserAgent(headers: IncomingHttpHeaders): boolean {
  const value = headers["user-agent"];
  if (typeof value !== "string" || value.length === 0) return false;
  return INTERACTIVE_USER_AGENT_RE.test(value);
}

function bodyHasAgentTool(body: Record<string, unknown>): boolean {
  const tools = body.tools;
  if (!Array.isArray(tools)) return false;
  return tools.some((t) => {
    if (!t || typeof t !== "object") return false;
    const name = (t as { name?: unknown }).name;
    return typeof name === "string" && name === "Agent";
  });
}
