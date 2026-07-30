# Hook-Informed Keepalive Braking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the proxy from firing keepalive pings at Claude Code sessions that have closed, and stop certain-return pauses from inflating the adaptive ping cap.

**Architecture:** Claude Code hooks write session lifecycle state (`turn_active` / `idle` / `ended`) to sidecar JSON files under `~/.stoke/session-state/`. The `UserPromptSubmit` hook additionally injects a `<stoke-session>UUID</stoke-session>` marker so the proxy can bind Claude Code's `session_id` to the registry's prefix-hash key. Each scheduler tick reads those files and abandons any session whose owner has ended. Brake-only: no state causes more pings than today.

**Tech Stack:** TypeScript + `tsx` for the proxy (`node:test` + `node:assert/strict`); plain ESM `.mjs` for hooks (vitest in `packages/monitor`).

## Global Constraints

- Hooks MUST keep the fail-open contract: wrap everything in `try { … } catch {}` and always `process.exit(0)`.
- The marker MUST be merged into any existing `additionalContext`, never replace it.
- Nothing may cause more pings in any state than the current hook-less path.
- Any missing, malformed, unknown, or stale signal MUST degrade to today's behavior — never to a wrong signal.
- `hookSignals` config is OPTIONAL in `validateConfig` (like `otel` and `enterpriseCap`) so existing configs and tests keep validating.
- Pure functions carry the existing comment convention: `Pure function — no I/O, safe to test exhaustively.`
- Proxy tests: `cd packages/proxy && npm test`. Monitor tests: `cd packages/monitor && npm test`.

---

### Task 1: Sidecar state helpers + SessionEnd hook

**Files:**
- Modify: `packages/monitor/plugin/hooks/lib.mjs`
- Create: `packages/monitor/plugin/hooks/session-end.mjs`
- Modify: `packages/monitor/scripts/install.mjs:6-11`
- Test: `packages/monitor/tests/hooks.test.js`, `packages/monitor/tests/install.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `sessionStatePath(sessionId) -> string`, `saveSessionState(sessionId, state, cwd) -> void` from `lib.mjs`. State values are the exact strings `"turn_active"`, `"idle"`, `"ended"`. File shape: `{ state: string, ts: number, cwd: string }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/monitor/tests/hooks.test.js`:

```js
import { sessionStatePath } from "../plugin/hooks/lib.mjs";

it("session-end writes an 'ended' state file for the proxy to brake on", () => {
  const { code } = runHook("session-end.mjs", { session_id: "sEnd", cwd: "C:/tmp/p" }, {});
  expect(code).toBe(0);
  const state = JSON.parse(fs.readFileSync(sessionStatePath("sEnd"), "utf8"));
  expect(state.state).toBe("ended");
  expect(state.cwd).toBe("C:/tmp/p");
  expect(typeof state.ts).toBe("number");
});

it("session-end fails open when session_id is missing", () => {
  const { code } = runHook("session-end.mjs", {}, {});
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/monitor && npx vitest run tests/hooks.test.js`
Expected: FAIL — `session-end.mjs` does not exist, and `sessionStatePath` is not exported.

- [ ] **Step 3: Add the helpers to `lib.mjs`**

Append to `packages/monitor/plugin/hooks/lib.mjs`:

```js
// Session lifecycle sidecar: written by the hooks, read by the proxy's
// scheduler each tick. Files rather than an HTTP call so the signal needs no
// auth surface on the proxy and a missing directory simply means "no signal".
export function sessionStatePath(sessionId) {
  return path.join(stokeDir, "session-state", `${sessionId}.json`);
}

export function saveSessionState(sessionId, state, cwd) {
  if (!sessionId) return;
  try {
    const p = sessionStatePath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ state, ts: Date.now(), cwd: cwd || "" }));
  } catch { /* fail open */ }
}
```

- [ ] **Step 4: Create `session-end.mjs`**

```js
import { readStdin, saveSessionState } from "./lib.mjs";

// SessionEnd is the only zero-ambiguity signal the proxy can get: the session
// is gone, so the probability a keepalive ping ever pays off is exactly 0.
// Without this the scheduler keeps pinging a dead session until the consecutive
// cap binds — 2-5 wasted pings per close.
try {
  const input = await readStdin();
  saveSessionState(input.session_id, "ended", input.cwd);
} catch { /* fail open */ }
process.exit(0);
```

- [ ] **Step 5: Register the hook in `install.mjs`**

Modify the `HOOK_EVENTS` map:

```js
const HOOK_EVENTS = {
  SessionStart: "session-start.mjs",
  UserPromptSubmit: "user-prompt-submit.mjs",
  PreToolUse: "pre-tool-use.mjs",
  Stop: "stop.mjs",
  SessionEnd: "session-end.mjs",
};
```

- [ ] **Step 6: Add the install assertion**

In `packages/monitor/tests/install.test.js`, alongside the existing `hooks.UserPromptSubmit` assertion:

```js
expect(s.hooks.SessionEnd).toBeTruthy();
expect(JSON.stringify(s.hooks.SessionEnd)).toContain("session-end.mjs");
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/monitor && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/monitor/plugin/hooks/lib.mjs packages/monitor/plugin/hooks/session-end.mjs packages/monitor/scripts/install.mjs packages/monitor/tests/hooks.test.js packages/monitor/tests/install.test.js
git commit -m "feat(monitor): SessionEnd hook writes session lifecycle sidecar"
```

---

### Task 2: Turn state + session marker injection

**Files:**
- Modify: `packages/monitor/plugin/hooks/stop.mjs`
- Modify: `packages/monitor/plugin/hooks/user-prompt-submit.mjs:7-11,80-89`
- Test: `packages/monitor/tests/hooks.test.js`

**Interfaces:**
- Consumes: `saveSessionState`, `sessionStatePath` from Task 1.
- Produces: the marker string format `<stoke-session>{session_id}</stoke-session>`, emitted inside `hookSpecificOutput.additionalContext`. Task 4's `extractClaudeSessionId` parses exactly this.

- [ ] **Step 1: Write the failing test**

Append to `packages/monitor/tests/hooks.test.js`:

```js
it("stop marks the session idle at the prompt", () => {
  const dbPath = seedDb();
  const { code } = runHook("stop.mjs", { session_id: "sIdle", cwd: "C:/tmp/p" }, { TOKEFF_DB: dbPath });
  expect(code).toBe(0);
  expect(JSON.parse(fs.readFileSync(sessionStatePath("sIdle"), "utf8")).state).toBe("idle");
});

it("user-prompt-submit marks the turn active and emits the binding marker", () => {
  const dbPath = seedDb();
  const { code, out } = runHook("user-prompt-submit.mjs", { session_id: "sTurn", cwd: "C:/tmp/p" }, { TOKEFF_DB: dbPath });
  expect(code).toBe(0);
  expect(JSON.parse(fs.readFileSync(sessionStatePath("sTurn"), "utf8")).state).toBe("turn_active");
  expect(out).toContain("<stoke-session>sTurn</stoke-session>");
});

it("user-prompt-submit keeps optimizer directives alongside the marker", () => {
  const dbPath = seedDb({ bloat: true });
  const { out } = runHook("user-prompt-submit.mjs", { session_id: "sBoth" }, { TOKEFF_DB: dbPath });
  expect(out).toContain("<stoke-session>sBoth</stoke-session>");
  expect(out).toContain("tokeff-directives");
});
```

Reuse whatever DB seeding helper the existing tests in this file use; `seedDb({ bloat: true })` above stands for the same seeding the existing `"user-prompt-submit on bloat"` test performs.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/monitor && npx vitest run tests/hooks.test.js`
Expected: FAIL — no state file written, `out` contains no marker.

- [ ] **Step 3: Update `stop.mjs`**

Change the import line and write the state first, so it lands even if the DB work is skipped:

```js
import { readStdin, loadOptimizerConfig, openDbSafe, logIntervention, sessionTurns, saveSessionState } from "./lib.mjs";

try {
  const input = await readStdin();
  // Turn finished: the user is now idle at the prompt, so any further ping is
  // speculative. Recorded before the DB work so a DB problem can't lose it.
  saveSessionState(input.session_id, "idle", input.cwd);
  const cfg = loadOptimizerConfig();
```

Leave the rest of the file unchanged.

- [ ] **Step 4: Update `user-prompt-submit.mjs`**

Add `saveSessionState` to the import on line 1. Then, immediately after the hard-gate block closes (after line 42's `}`), insert:

```js
  // A turn is now in flight, so a real request is near-certain to follow.
  // Written AFTER the hard gate: a blocked prompt starts no turn, so the
  // previous `idle` state must stand.
  saveSessionState(input.session_id, "turn_active", input.cwd);
```

Then replace the output assembly at lines 80-89 with:

```js
  const out = {};
  if (notes.length) out.systemMessage = notes.join("\n");

  // The marker binds Claude Code's session_id to the proxy's prefix-hash
  // session key. It lives in `messages`, which `cacheablePrefix` excludes, so
  // it cannot fragment the key. Re-emitted every turn (~20 tokens) so the
  // binding survives a proxy restart and does not depend on Claude Code
  // persisting an injected reminder into later requests.
  const contextParts = [];
  if (input.session_id) contextParts.push(`<stoke-session>${input.session_id}</stoke-session>`);
  if (directives.length) contextParts.push(`<tokeff-directives>\n${directives.join("\n\n")}\n</tokeff-directives>`);
  if (contextParts.length) {
    out.hookSpecificOutput = {
      hookEventName: "UserPromptSubmit",
      additionalContext: contextParts.join("\n"),
    };
  }
  if (Object.keys(out).length) emit(out);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/monitor && npm test`
Expected: PASS. The pre-existing `"user-prompt-submit stays silent on a warm small session"` test asserts empty output — update it to assert that the *only* output is the marker, since the hook now always emits the binding.

- [ ] **Step 6: Commit**

```bash
git add packages/monitor/plugin/hooks/stop.mjs packages/monitor/plugin/hooks/user-prompt-submit.mjs packages/monitor/tests/hooks.test.js
git commit -m "feat(monitor): record turn state and inject session-binding marker"
```

---

### Task 3: `hookSignals` config block

**Files:**
- Modify: `packages/proxy/src/types.ts:31-39,119+`
- Modify: `packages/proxy/src/config.ts:22-55`
- Modify: `packages/proxy/src/config-schema.ts:230-281`
- Test: `packages/proxy/tests/config-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config["hookSignals"]` typed `{ enabled: boolean; stateDir: string; staleAfterSeconds: number } | undefined`. New `PauseReason` member `"claude_session_ended"`. New optional `Session` fields `claudeSessionId?: string` and `pausedWhileIdle?: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `packages/proxy/tests/config-schema.test.ts`:

```ts
test("validateConfig accepts a hookSignals block", () => {
  const cfg = validateConfig({
    ...baseRawConfig(),
    hookSignals: { enabled: true, stateDir: "/tmp/state", staleAfterSeconds: 900 },
  });
  assert.equal(cfg.hookSignals?.enabled, true);
  assert.equal(cfg.hookSignals?.stateDir, "/tmp/state");
});

test("validateConfig rejects unknown hookSignals fields", () => {
  assert.throws(
    () => validateConfig({ ...baseRawConfig(), hookSignals: { enabled: true, stateDir: "/t", staleAfterSeconds: 900, nope: 1 } }),
    /hookSignals: unknown field nope/,
  );
});

test("validateConfig rejects a too-small staleAfterSeconds", () => {
  assert.throws(
    () => validateConfig({ ...baseRawConfig(), hookSignals: { enabled: true, stateDir: "/t", staleAfterSeconds: 10 } }),
    /staleAfterSeconds must be >= 60/,
  );
});

test("validateConfig still accepts a config with no hookSignals block", () => {
  const cfg = validateConfig(baseRawConfig());
  assert.equal(cfg.hookSignals, undefined);
});
```

Use whatever helper the existing tests in this file use to build a valid raw config; `baseRawConfig()` above stands for that same construction.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/proxy && npm test`
Expected: FAIL — `hookSignals: unknown field` or a type error, since `validateConfig` rejects unrecognized top-level keys only for nested blocks and has no `hookSignals` branch.

- [ ] **Step 3: Extend `types.ts`**

Add `"claude_session_ended"` to the `PauseReason` union:

```ts
export type PauseReason =
  | "cache_miss"
  | "auth_error"
  | "upstream_5xx_repeat"
  | "budget_cap"
  | "malformed_response"
  | "needs_real_request"
  /** Fired N consecutive pings with no real request in between — user has likely stepped away. */
  | "pings_without_progress"
  /** A Claude Code hook reported the owning session ended — return probability is exactly 0. */
  | "claude_session_ended";
```

Add the config interface near `BudgetCapConfig`:

```ts
/**
 * Lifecycle signals published by the Claude Code hooks. Optional: with no
 * state files present the scheduler behaves exactly as it did before hooks
 * existed, so an install without the plugin is unaffected.
 */
export interface HookSignalsConfig {
  enabled: boolean;
  /** Directory of `<session_id>.json` sidecar files written by the hooks. */
  stateDir: string;
  /** Ignore any state file older than this — a stale signal must never win. */
  staleAfterSeconds: number;
}
```

Add these two fields to `interface Session`:

```ts
  /**
   * Claude Code's own session_id, recovered from the `<stoke-session>` marker
   * the UserPromptSubmit hook injects. Absent for subagents (fresh message
   * array, no marker) and for installs without the hooks — both fall through
   * to the hook-less behavior.
   */
  claudeSessionId?: string;
  /**
   * Whether the `pings_without_progress` pause happened while the session was
   * idle at the prompt (speculative) rather than mid-turn (certain return).
   * Only speculative pauses feed the adaptive cap. `undefined` counts as
   * speculative, preserving pre-hook behavior.
   */
  pausedWhileIdle?: boolean;
```

Add to `interface Config`, alongside the optional `otel`:

```ts
  hookSignals?: HookSignalsConfig;
```

- [ ] **Step 4: Add the default in `config.ts`**

Add to the object returned by `defaultConfig()`, after `logRotation`:

```ts
    hookSignals: {
      enabled: true,
      stateDir: join(homedir(), ".stoke", "session-state"),
      staleAfterSeconds: 900,
    },
```

- [ ] **Step 5: Validate in `config-schema.ts`**

Insert before the `authToken` check, mirroring the existing `otel` block:

```ts
  let hookSignals: Config["hookSignals"];
  if (raw.hookSignals !== undefined) {
    if (!isObject(raw.hookSignals)) throw new ConfigError("hookSignals must be an object");
    const allowed = new Set(["enabled", "stateDir", "staleAfterSeconds"]);
    for (const k of Object.keys(raw.hookSignals)) {
      if (!allowed.has(k)) throw new ConfigError(`hookSignals: unknown field ${k}`);
    }
    const enabled = requireBoolean(raw.hookSignals.enabled, "hookSignals.enabled");
    const stateDir = requireNonEmptyString(raw.hookSignals.stateDir, "hookSignals.stateDir");
    const staleAfterSeconds = requireInteger(
      raw.hookSignals.staleAfterSeconds,
      "hookSignals.staleAfterSeconds",
    );
    if (staleAfterSeconds < 60) {
      throw new ConfigError(
        `hookSignals.staleAfterSeconds must be >= 60, got ${staleAfterSeconds}`,
      );
    }
    hookSignals = { enabled, stateDir, staleAfterSeconds };
  }
```

And add to the tail of `validateConfig`, next to the other optional blocks:

```ts
  if (hookSignals) out.hookSignals = hookSignals;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/proxy && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/proxy/src/types.ts packages/proxy/src/config.ts packages/proxy/src/config-schema.ts packages/proxy/tests/config-schema.test.ts
git commit -m "feat(proxy): hookSignals config block and claude_session_ended pause reason"
```

---

### Task 4: Marker extraction and session binding

**Files:**
- Modify: `packages/proxy/src/registry.ts:39-49,332-400`
- Test: `packages/proxy/tests/registry.test.ts`

**Interfaces:**
- Consumes: `Session.claudeSessionId` from Task 3.
- Produces: `extractClaudeSessionId(payload: Hashable) -> string | null`, exported from `registry.ts`. `upsert` sets `session.claudeSessionId` when a marker is present and leaves it untouched when absent.

- [ ] **Step 1: Write the failing test**

Append to `packages/proxy/tests/registry.test.ts`:

```ts
import { extractClaudeSessionId } from "../src/registry.ts";

const UUID_A = "0199f3c4-1111-4aaa-8bbb-0123456789ab";
const UUID_B = "0199f3c4-2222-4aaa-8bbb-0123456789ab";

test("extractClaudeSessionId reads the marker from a string message", () => {
  const got = extractClaudeSessionId({
    messages: [{ role: "user", content: `<stoke-session>${UUID_A}</stoke-session>\nhello` }],
  } as never);
  assert.equal(got, UUID_A);
});

test("extractClaudeSessionId reads the marker from block-array content", () => {
  const got = extractClaudeSessionId({
    messages: [{ role: "user", content: [{ type: "text", text: `<stoke-session>${UUID_A}</stoke-session>` }] }],
  } as never);
  assert.equal(got, UUID_A);
});

test("extractClaudeSessionId returns the LAST marker so a resumed session wins", () => {
  const got = extractClaudeSessionId({
    messages: [
      { role: "user", content: `<stoke-session>${UUID_A}</stoke-session>` },
      { role: "user", content: `<stoke-session>${UUID_B}</stoke-session>` },
    ],
  } as never);
  assert.equal(got, UUID_B);
});

test("extractClaudeSessionId returns null when absent or malformed", () => {
  assert.equal(extractClaudeSessionId({ messages: [{ role: "user", content: "hi" }] } as never), null);
  assert.equal(extractClaudeSessionId({ messages: "not-an-array" } as never), null);
  assert.equal(extractClaudeSessionId({} as never), null);
  assert.equal(
    extractClaudeSessionId({ messages: [{ role: "user", content: "<stoke-session>nope</stoke-session>" }] } as never),
    null,
  );
});

test("upsert binds claudeSessionId and a later markerless request does not clear it", () => {
  const registry = new Registry();
  const withMarker = {
    model: "claude-opus-4-7",
    tools: [],
    system: "s",
    messages: [{ role: "user", content: `<stoke-session>${UUID_A}</stoke-session>` }],
  };
  const { key } = registry.upsert(withMarker, "Bearer x", 0);
  assert.equal(registry.get(key)?.claudeSessionId, UUID_A);

  registry.upsert(
    { model: "claude-opus-4-7", tools: [], system: "s", messages: [{ role: "user", content: "no marker" }] },
    "Bearer x",
    1000,
  );
  assert.equal(registry.get(key)?.claudeSessionId, UUID_A);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/proxy && npm test`
Expected: FAIL — `extractClaudeSessionId` is not exported from `registry.ts`.

- [ ] **Step 3: Implement extraction in `registry.ts`**

Add after `computeSessionKey`:

```ts
const SESSION_MARKER_RE = /<stoke-session>([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})<\/stoke-session>/g;

/**
 * Recover Claude Code's session_id from the marker its UserPromptSubmit hook
 * injects. Scans `messages` only — the marker is deliberately placed where
 * `cacheablePrefix` excludes it, so it cannot fragment the session key.
 *
 * Returns the LAST match: a resumed or forked conversation carries the old
 * marker in history plus a fresh one, and the newest is the live session.
 *
 * Pure function — no I/O, safe to test exhaustively.
 */
export function extractClaudeSessionId(payload: Hashable): string | null {
  const messages = (payload as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return null;
  let found: string | null = null;
  for (const msg of messages) {
    for (const text of markerTexts(msg)) {
      for (const m of text.matchAll(SESSION_MARKER_RE)) found = m[1];
    }
  }
  return found;
}

/** Every plain-text string reachable in a message's content, string or blocks. */
function markerTexts(msg: unknown): string[] {
  if (!msg || typeof msg !== "object") return [];
  const content = (msg as Record<string, unknown>).content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      out.push(block);
    } else if (block && typeof block === "object") {
      const t = (block as Record<string, unknown>).text;
      if (typeof t === "string") out.push(t);
    }
  }
  return out;
}
```

- [ ] **Step 4: Bind in `upsert`**

In `upsert`, after `const ttlSec = detectCacheTtlSeconds(...)`, add:

```ts
    // Only overwrite when a marker is actually present: a markerless request
    // (subagent, or a turn where the hook did not run) must not clear a good
    // binding.
    const claudeSessionId = extractClaudeSessionId(payload as Hashable);
```

In the `if (existing)` branch, alongside the other field updates:

```ts
      if (claudeSessionId) existing.claudeSessionId = claudeSessionId;
```

In the new-session construction, add the field:

```ts
      claudeSessionId: claudeSessionId ?? undefined,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/proxy && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/proxy/src/registry.ts packages/proxy/tests/registry.test.ts
git commit -m "feat(proxy): bind Claude Code session_id via injected marker"
```

---

### Task 5: Hook state reader

**Files:**
- Create: `packages/proxy/src/hook-state.ts`
- Test: `packages/proxy/tests/hook-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type HookState = "turn_active" | "idle" | "ended"`; `interface HookStateRecord { state: HookState; ts: number }`; `parseHookState(raw: string, nowMs: number, staleAfterMs: number) -> HookStateRecord | null`; `readHookStates(stateDir: string, nowMs: number, staleAfterMs: number) -> Map<string, HookStateRecord>`; `pruneHookStates(stateDir: string, nowMs: number, maxAgeMs: number) -> number`.

The record carries `ts` because Task 6's gate must be able to tell that a signal
predates the session's last real request, and therefore no longer describes
reality. Without it, a stale `ended` file left behind by a stopped hook would
make the proxy re-abandon a live session on every tick for the whole staleness
window.

- [ ] **Step 1: Write the failing test**

Create `packages/proxy/tests/hook-state.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHookState, readHookStates, pruneHookStates } from "../src/hook-state.ts";

const STALE_MS = 900_000;

test("parseHookState accepts each valid state and preserves its timestamp", () => {
  for (const state of ["turn_active", "idle", "ended"]) {
    assert.deepEqual(parseHookState(JSON.stringify({ state, ts: 1000 }), 2000, STALE_MS), {
      state,
      ts: 1000,
    });
  }
});

test("parseHookState rejects malformed, unknown, and incomplete payloads", () => {
  assert.equal(parseHookState("not json", 2000, STALE_MS), null);
  assert.equal(parseHookState("[]", 2000, STALE_MS), null);
  assert.equal(parseHookState(JSON.stringify({ state: "wat", ts: 1000 }), 2000, STALE_MS), null);
  assert.equal(parseHookState(JSON.stringify({ state: "idle" }), 2000, STALE_MS), null);
  assert.equal(parseHookState(JSON.stringify({ ts: 1000 }), 2000, STALE_MS), null);
});

test("parseHookState rejects a state older than the staleness window", () => {
  assert.equal(parseHookState(JSON.stringify({ state: "ended", ts: 0 }), STALE_MS + 1, STALE_MS), null);
  assert.deepEqual(parseHookState(JSON.stringify({ state: "ended", ts: 0 }), STALE_MS, STALE_MS), {
    state: "ended",
    ts: 0,
  });
});

test("readHookStates maps session_id to record and skips unusable files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookstate-"));
  writeFileSync(join(dir, "alive.json"), JSON.stringify({ state: "turn_active", ts: 1000 }));
  writeFileSync(join(dir, "dead.json"), JSON.stringify({ state: "ended", ts: 1000 }));
  writeFileSync(join(dir, "old.json"), JSON.stringify({ state: "ended", ts: 0 }));
  writeFileSync(join(dir, "junk.json"), "{{{");
  writeFileSync(join(dir, "notjson.txt"), JSON.stringify({ state: "ended", ts: 1000 }));

  const states = readHookStates(dir, STALE_MS + 500, STALE_MS);
  assert.equal(states.get("alive")?.state, "turn_active");
  assert.equal(states.get("dead")?.state, "ended");
  assert.equal(states.get("dead")?.ts, 1000);
  assert.equal(states.get("old"), undefined);
  assert.equal(states.get("junk"), undefined);
  assert.equal(states.get("notjson"), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("readHookStates returns an empty map when the directory is absent", () => {
  assert.equal(readHookStates(join(tmpdir(), "definitely-not-here-9f3c"), 0, STALE_MS).size, 0);
});

test("pruneHookStates removes only files past the max age", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookprune-"));
  writeFileSync(join(dir, "fresh.json"), JSON.stringify({ state: "idle", ts: 9000 }));
  writeFileSync(join(dir, "ancient.json"), JSON.stringify({ state: "ended", ts: 0 }));
  writeFileSync(join(dir, "junk.json"), "{{{");

  const removed = pruneHookStates(dir, 10_000, 5000);
  assert.equal(removed, 2, "the ancient and the unparseable file both go");
  assert.equal(existsSync(join(dir, "fresh.json")), true);
  assert.equal(existsSync(join(dir, "ancient.json")), false);
  assert.equal(existsSync(join(dir, "junk.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("pruneHookStates tolerates a missing directory", () => {
  assert.equal(pruneHookStates(join(tmpdir(), "definitely-not-here-4a7b"), 0, 5000), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/proxy && npm test`
Expected: FAIL — `src/hook-state.ts` does not exist.

- [ ] **Step 3: Create `packages/proxy/src/hook-state.ts`**

```ts
// src/hook-state.ts
//
// Reads the session-lifecycle sidecar files the Claude Code hooks write. This
// is the proxy's only window into what the editor knows: whether a turn is in
// flight, whether the user is idle at the prompt, or whether the session is
// gone. Every failure path here returns "no signal" rather than a guess —
// a wrong signal would brake a live session.
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type HookState = "turn_active" | "idle" | "ended";

export interface HookStateRecord {
  state: HookState;
  /** When the hook wrote this, ms since epoch. Compared against the session's
   * last real request so an outdated signal can never win. */
  ts: number;
}

const VALID: ReadonlySet<string> = new Set<string>(["turn_active", "idle", "ended"]);
const JSON_SUFFIX = ".json";

/**
 * Parse one sidecar file. Returns null when the payload is unparseable, is not
 * an object, carries an unknown state, has no usable timestamp, or is older
 * than `staleAfterMs`.
 *
 * A timestamp in the future is accepted — clock skew must not discard an
 * otherwise-valid signal.
 *
 * Pure function — no I/O, safe to test exhaustively.
 */
export function parseHookState(
  raw: string,
  nowMs: number,
  staleAfterMs: number,
): HookStateRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.state !== "string" || !VALID.has(rec.state)) return null;
  if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return null;
  if (nowMs - rec.ts > staleAfterMs) return null;
  return { state: rec.state as HookState, ts: rec.ts };
}

/**
 * Read every sidecar file in `stateDir` into a `session_id -> record` map.
 * A missing directory yields an empty map, which the scheduler treats as
 * "no hooks installed" and therefore as the pre-hook behavior.
 */
export function readHookStates(
  stateDir: string,
  nowMs: number,
  staleAfterMs: number,
): Map<string, HookStateRecord> {
  const out = new Map<string, HookStateRecord>();
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(JSON_SUFFIX)) continue;
    let raw: string;
    try {
      raw = readFileSync(join(stateDir, entry), "utf8");
    } catch {
      continue;
    }
    const record = parseHookState(raw, nowMs, staleAfterMs);
    if (record) out.set(entry.slice(0, -JSON_SUFFIX.length), record);
  }
  return out;
}

/**
 * Delete sidecar files older than `maxAgeMs`, plus any that no longer parse.
 * Nothing depends on this for correctness — `staleAfterMs` already makes an old
 * file inert — it only keeps the directory from growing without bound on a
 * long-running proxy. Returns the number of files removed.
 */
export function pruneHookStates(
  stateDir: string,
  nowMs: number,
  maxAgeMs: number,
): number {
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(JSON_SUFFIX)) continue;
    const full = join(stateDir, entry);
    let keep = false;
    try {
      const rec = parseHookState(readFileSync(full, "utf8"), nowMs, maxAgeMs);
      keep = rec !== null;
    } catch {
      keep = false;
    }
    if (keep) continue;
    try {
      unlinkSync(full);
      removed += 1;
    } catch { /* another process may have removed it already */ }
  }
  return removed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/proxy && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/hook-state.ts packages/proxy/tests/hook-state.test.ts
git commit -m "feat(proxy): read Claude Code session lifecycle sidecar files"
```

---

### Task 6: Scheduler brake and honest cap accounting

**Files:**
- Modify: `packages/proxy/src/registry.ts:349-354,453-460,482-502`
- Modify: `packages/proxy/src/scheduler.ts:124-191`
- Test: `packages/proxy/tests/scheduler.test.ts`, `packages/proxy/tests/registry.test.ts`

**Interfaces:**
- Consumes: `readHookStates`, `pruneHookStates`, and `HookStateRecord` from Task 5; `Session.claudeSessionId` and `Session.pausedWhileIdle` from Tasks 3-4; `Config["hookSignals"]` from Task 3.
- Produces: `decidePingGate(session: Session, hookStates: Map<string, HookStateRecord>) -> "proceed" | "abandon"` from `scheduler.ts`; `Registry.abandonNow(key: SessionKey, nowMs: number) -> void`; `Registry.pause(key, reason, pausedWhileIdle?: boolean)` with the third parameter defaulting to `true`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/proxy/tests/scheduler.test.ts`:

```ts
import { decidePingGate } from "../src/scheduler.ts";
import type { HookStateRecord } from "../src/hook-state.ts";
import { mkdtempSync, writeFileSync } from "node:fs";

function sessionWith(id?: string, lastRealRequestAt = 0): Session {
  return { claudeSessionId: id, lastRealRequestAt } as Session;
}

test("decidePingGate abandons only a session whose owner ended", () => {
  const states = new Map<string, HookStateRecord>([
    ["dead", { state: "ended", ts: 100 }],
    ["idle", { state: "idle", ts: 100 }],
    ["busy", { state: "turn_active", ts: 100 }],
  ]);
  assert.equal(decidePingGate(sessionWith("dead"), states), "abandon");
  assert.equal(decidePingGate(sessionWith("idle"), states), "proceed");
  assert.equal(decidePingGate(sessionWith("busy"), states), "proceed");
});

test("decidePingGate proceeds for unbound or unknown sessions", () => {
  const states = new Map<string, HookStateRecord>([["dead", { state: "ended", ts: 100 }]]);
  assert.equal(decidePingGate(sessionWith(undefined), states), "proceed");
  assert.equal(decidePingGate(sessionWith("never-seen"), states), "proceed");
  assert.equal(decidePingGate(sessionWith("dead"), new Map()), "proceed");
});

test("decidePingGate ignores an 'ended' signal older than the last real request", () => {
  // A stopped hook can leave an `ended` file behind while the marker persists
  // in message history. A real request after that timestamp proves the session
  // is alive, and must win — otherwise a live session gets re-abandoned every
  // tick for the whole staleness window.
  const states = new Map<string, HookStateRecord>([["revived", { state: "ended", ts: 100 }]]);
  assert.equal(decidePingGate(sessionWith("revived", 500), states), "proceed");
  assert.equal(decidePingGate(sessionWith("revived", 100), states), "abandon");
  assert.equal(decidePingGate(sessionWith("revived", 50), states), "abandon");
});

test("runSchedulerTick fires no ping for a session whose Claude Code session ended", async () => {
  const dir = mkdtempSync(join(tmpdir(), "csch-state-"));
  const path = join(mkdtempSync(join(tmpdir(), "csch-")), "events.jsonl");
  const registry = new Registry();
  const logger = new JsonlLogger(path);
  const config = defaultConfig();
  config.hookSignals = { enabled: true, stateDir: dir, staleAfterSeconds: 900 };
  const guard = new BudgetGuard(config);

  const uuid = "0199f3c4-3333-4aaa-8bbb-0123456789ab";
  const { key } = registry.upsert(
    {
      model: "claude-opus-4-7",
      tools: [],
      system: "s",
      messages: [{ role: "user", content: `<stoke-session>${uuid}</stoke-session>` }],
    },
    "Bearer abc",
    0,
  );
  registry.recordRealUsage(key, {
    input_tokens: 1,
    output_tokens: 0,
    cache_creation_input_tokens: 60000,
    cache_read_input_tokens: 0,
  }, NO_RL);

  writeFileSync(join(dir, `${uuid}.json`), JSON.stringify({ state: "ended", ts: 0 }));

  let pinged = false;
  await runSchedulerTick({
    registry, logger, config, guard,
    fetcher: async () => { pinged = true; return { status: 200, usage: null, ratelimits: NO_RL }; },
    nowMs: 300_000,
    spendUsdToday: 0, spendUsdMonth: 0, pingsToday: 0,
  });

  assert.equal(pinged, false, "no ping may be fired at an ended session");
  assert.equal(registry.get(key)?.state, "abandoned");
});
```

Append to `packages/proxy/tests/registry.test.ts`:

```ts
test("a certain-return pause does not feed the adaptive cap", () => {
  const registry = new Registry();
  const payload = { model: "claude-opus-4-7", tools: [], system: "s", messages: [{ role: "user", content: "hi" }] };
  const { key } = registry.upsert(payload, "Bearer x", 0);

  // Paused mid-turn: the return was certain, so its outcome must be ignored.
  registry.pause(key, "pings_without_progress", false);
  registry.upsert(payload, "Bearer x", 1000);
  assert.equal(registry.pauseOutcomeCount(50), 0);

  // Paused while idle at the prompt: genuinely speculative, so it counts.
  registry.pause(key, "pings_without_progress", true);
  registry.upsert(payload, "Bearer x", 2000);
  assert.equal(registry.pauseOutcomeCount(50), 1);
});

test("abandonNow records a -returned outcome only for speculative pauses", () => {
  const registry = new Registry();
  const payload = { model: "claude-opus-4-7", tools: [], system: "s", messages: [{ role: "user", content: "hi" }] };
  const { key } = registry.upsert(payload, "Bearer x", 0);

  registry.pause(key, "pings_without_progress", false);
  registry.abandonNow(key, 1000);
  assert.equal(registry.get(key)?.state, "abandoned");
  assert.equal(registry.pauseOutcomeCount(50), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/proxy && npm test`
Expected: FAIL — `decidePingGate` and `Registry.abandonNow` do not exist, and `pause` takes two arguments.

- [ ] **Step 3: Extend `Registry`**

Change the `pause` signature to record why the pause happened:

```ts
  /**
   * `pausedWhileIdle` records whether the pause was speculative (user idle at
   * the prompt) or certain-return (mid-turn). Only speculative pauses feed the
   * adaptive cap. Defaults to true so pre-hook callers keep their semantics.
   */
  pause(key: SessionKey, reason: PauseReason, pausedWhileIdle = true): void {
```

and inside it, alongside the existing state/reason assignment:

```ts
    s.pausedWhileIdle = pausedWhileIdle;
```

Gate the resume outcome at `registry.ts:349-354` on the same flag:

```ts
      if (
        existing.state === "paused" &&
        existing.pauseReason === "pings_without_progress" &&
        existing.pausedWhileIdle !== false
      ) {
        this.recordPauseOutcome(true, nowMs);
      }
```

Gate the abandonment outcome in `abandonStale` the same way:

```ts
        if (
          s.state === "paused" &&
          s.pauseReason === "pings_without_progress" &&
          s.pausedWhileIdle !== false
        ) {
          this.recordPauseOutcome(false, nowMs);
        }
```

Add `abandonNow` next to `abandonStale`:

```ts
  /**
   * Abandon one session immediately. Used when a hook reports the owning Claude
   * Code session ended, where the probability a keepalive ping ever pays off is
   * exactly 0 — waiting for the `abandonTtlMultiplier` threshold would burn
   * 2-5 pings first.
   */
  abandonNow(key: SessionKey, nowMs: number): void {
    const s = this.sessions.get(key);
    if (!s || s.state === "abandoned") return;
    if (
      s.state === "paused" &&
      s.pauseReason === "pings_without_progress" &&
      s.pausedWhileIdle !== false
    ) {
      this.recordPauseOutcome(false, nowMs);
    }
    s.state = "abandoned";
  }
```

- [ ] **Step 4: Add the gate to `scheduler.ts`**

Add the import:

```ts
import { readHookStates, pruneHookStates, type HookStateRecord } from "./hook-state.ts";
```

Add the pure gate next to the other pure helpers:

```ts
export type PingGate = "proceed" | "abandon";

/**
 * Brake decision for one session given what Claude Code reports about its
 * owner. This only ever PREVENTS pings: no state returns a verdict that
 * causes more pings than the hook-less path would. An unbound session, an
 * unknown session_id, or a stale/absent signal all proceed unchanged.
 *
 * An `ended` signal is honored only if nothing newer contradicts it. A real
 * request recorded AFTER the hook wrote the file proves the session is alive —
 * which is what happens if the hooks stop running while the binding marker
 * lingers in message history — so `lastRealRequestAt` wins any tie-break.
 *
 * Pure function — no I/O, safe to test exhaustively.
 */
export function decidePingGate(
  session: Session,
  hookStates: Map<string, HookStateRecord>,
): PingGate {
  const id = session.claudeSessionId;
  if (!id) return "proceed";
  const record = hookStates.get(id);
  if (!record || record.state !== "ended") return "proceed";
  if (session.lastRealRequestAt > record.ts) return "proceed";
  return "abandon";
}
```

- [ ] **Step 5: Wire the gate into `runSchedulerTick`**

Immediately after the existing `inputs.registry.abandonStale(...)` call, insert:

```ts
  // What Claude Code knows that the API traffic cannot show: which sessions are
  // gone. Read once per tick and used both to brake ended sessions and to
  // classify a pause as speculative or certain-return.
  const hookStates: Map<string, HookStateRecord> =
    inputs.config.hookSignals?.enabled
      ? readHookStates(
          inputs.config.hookSignals.stateDir,
          inputs.nowMs,
          inputs.config.hookSignals.staleAfterSeconds * 1000,
        )
      : new Map<string, HookStateRecord>();
  if (inputs.config.hookSignals?.enabled) {
    // Disk hygiene only — staleness already makes old files inert. Reuses the
    // session eviction horizon so sidecars outlive the sessions they describe.
    pruneHookStates(
      inputs.config.hookSignals.stateDir,
      inputs.nowMs,
      inputs.config.evictAfterHours * 3600 * 1000,
    );
  }

  for (const session of inputs.registry.all()) {
    if (session.state === "abandoned") continue;
    if (decidePingGate(session, hookStates) !== "abandon") continue;
    inputs.registry.abandonNow(session.key, inputs.nowMs);
    inputs.logger.write({
      ts: new Date(inputs.nowMs).toISOString(),
      kind: "session_paused",
      sessionKey: session.key,
      reason: "claude_session_ended",
    });
    inputs.otel?.incrementCounter?.("cache_keepalive.pings_skipped_total", 1, {
      reason: "claude_session_ended",
    });
  }
```

Then, at the consecutive-cap pause site, pass whether the pause was speculative:

```ts
  if (target.pingsSinceLastReal >= cap) {
    // Mid-turn the return is certain, so this pause must not be counted as
    // evidence about whether idle users come back.
    const speculative =
      !target.claudeSessionId ||
      hookStates.get(target.claudeSessionId)?.state !== "turn_active";
    inputs.registry.pause(target.key, "pings_without_progress", speculative);
```

Leave the rest of that block unchanged.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/proxy && npm test`
Expected: PASS

- [ ] **Step 7: Run the full workspace suite**

Run: `cd packages/proxy && npm test` then `cd ../monitor && npm test`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add packages/proxy/src/registry.ts packages/proxy/src/scheduler.ts packages/proxy/tests/scheduler.test.ts packages/proxy/tests/registry.test.ts
git commit -m "feat(proxy): brake keepalive on ended sessions, fix cap accounting"
```

---

### Task 7: Document the behavior

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Add a CHANGELOG entry**

Under the unreleased heading, matching the file's existing style:

```markdown
### Added
- Keepalive now stops within one tick when a Claude Code session closes, instead
  of burning 2-5 pings before the consecutive cap binds. A new `SessionEnd` hook
  publishes session lifecycle state to `~/.stoke/session-state/`, and the
  `UserPromptSubmit` hook injects a marker binding Claude Code's `session_id` to
  the proxy's session key. Configurable via the `hookSignals` block; with the
  hooks absent, behavior is unchanged.

### Fixed
- The adaptive consecutive-ping cap no longer counts mid-turn pauses as evidence
  that idle users return. A long tool call that tripped the cap previously
  recorded a misleading `+returned` outcome, inflating the cap for genuinely
  speculative sessions.
```

- [ ] **Step 2: Document `hookSignals` in the README**

Add to the configuration reference, matching the surrounding table or list style:

```markdown
| `hookSignals.enabled` | `true` | Honor Claude Code session lifecycle signals from the plugin hooks. |
| `hookSignals.stateDir` | `~/.stoke/session-state` | Directory of per-session sidecar files written by the hooks. |
| `hookSignals.staleAfterSeconds` | `900` | Ignore lifecycle signals older than this. |
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: hook-informed keepalive braking and hookSignals config"
```
