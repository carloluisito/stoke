# Hook-informed keepalive: brake the scheduler with real session lifecycle signals

Date: 2026-07-30
Status: approved

## Problem

The proxy's scheduler cannot distinguish three situations with completely different
economics, and treats all of them identically:

| Situation | Probability a real request follows | Today's behavior |
|---|---|---|
| A turn is in flight (long tool call) | ~1.0 | ping, capped |
| Idle at the prompt | uncertain | ping, same cap |
| Claude Code was closed | 0.0 | **ping, same cap** |

The third row is pure waste. With defaults (`cacheTtlSeconds: 300`,
`pingCadenceMarginSeconds: 30`, cap adaptive in `[2, 5]`), closing a session leaves
the scheduler firing its first ping 4.5 minutes later and continuing until the
consecutive cap binds — **2–5 wasted pings per closed session**. The 30-minute
abandon threshold (`abandonTtlMultiplier: 6`) is far too late to prevent them.

There is a second-order cost. A closed session that gets paused with
`pings_without_progress` and then abandoned records a `–returned` outcome
(`registry.ts:494`), which feeds `observedReturnRate` (`registry.ts:260`) and thus
throttles `effectiveConsecutivePingCap` (`scheduler.ts:69`) for every *other*
session. Dead sessions degrade the adaptive math for live ones.

There is also pollution in the opposite direction. A long tool call that exceeds the
cap pauses the session; when the tool returns, the real request records `+returned`.
That outcome was never speculative — the return was certain — so it inflates the
observed return rate, inflating the cap, making the proxy more aggressive on
genuinely speculative idle sessions. The cap's single blended input conflates
"came back from a coffee break" with "a build finished".

The proxy has no signal for any of this because it only sees API traffic. Claude Code
knows all three states, and stoke already ships hooks — but
`packages/monitor/plugin/hooks/*` only writes to `~/.stoke/stoke.db` and never
communicates with the proxy. There is no `SessionEnd` hook at all.

## Non-goals

Explicitly rejected during design:

- **No on-demand arm/disarm.** No `/stoke-keep` command, CLI verb, or dashboard
  toggle. Requiring the user to opt in before stepping away fails precisely when
  they forget, which is when it matters.
- **No prompting the user at idle.** Claude Code hooks cannot render an interactive
  prompt. They can print text, inject context, fire an allowlisted OS notification,
  or block a tool — there is no channel to ask a question and read an answer. The
  idea is also self-defeating: the moment you need to be asked is the moment you
  have walked away and cannot answer.
- **No mid-turn acceleration.** Knowing a turn is in flight would justify pinging
  *more* there (near-certain payoff), but this design never pings more than today in
  any state. The turn-in-flight signal is used only as a guard against
  over-braking.

## Design

### Signal transport: sidecar state files

Hooks write one JSON file per Claude Code session to
`~/.stoke/session-state/<session_id>.json`:

```json
{ "state": "turn_active" | "idle" | "ended", "ts": 1753900000000, "cwd": "C:/path" }
```

The proxy reads that directory on each scheduler tick (10s default).

Sidecar files rather than a new proxy HTTP endpoint because: `lib.mjs` already uses
this pattern (`session-reads/`, the context sidecar), it needs no authentication
surface on the proxy, it fails open by construction (missing directory = no
signal = today's behavior), and a 10s read of a handful of small files is free.

`cwd` is recorded for dashboard and debugging value only. It is **not** used for
correlation.

### Correlating a Claude Code session with a proxy session

A hook knows `session_id`. The registry keys on
`sha256(model + cacheable prefix of tools/system)` (`registry.ts:39`). These are
unrelated, and with several concurrent sessions the proxy cannot tell which
registry entry a `SessionEnd` refers to.

`user-prompt-submit.mjs` therefore injects a marker via `additionalContext`:

```
<stoke-session>0199f3c4-...-8ab1</stoke-session>
```

The proxy extracts it from `payload.messages` during `upsert` and stores
`claudeSessionId` on the `Session`.

Why this is safe and correct:

- **It cannot fragment the session key.** `cacheablePrefix` deliberately excludes
  `messages` (`registry.ts:52-58`), so nothing in the marker affects the hash.
- **Injected every turn, not once.** Roughly 20 tokens per turn (~$0.0003 at Opus
  input rates). Paying that repeatedly buys independence from whether Claude Code
  persists an injected system-reminder into subsequent requests, and makes the
  binding self-healing across a proxy restart.
- **Last match wins.** A resumed or forked session carries the old marker in
  history plus a fresh one; reading the last occurrence yields the current
  `session_id`.
- **Subagents stay unbound.** A subagent's request has its own tools/system (a
  different key) and a fresh message array with no marker. Unbound sessions fall
  through to today's behavior — correct, since subagents are short-lived and the
  scheduler already prefers the longest-lived session (`scheduler.ts:145`).

Rejected alternative: a zero-token temporal handshake, binding the registry key to
whichever `UserPromptSubmit` fired within a few seconds. Exactness was preferred
over saving a negligible number of tokens, since concurrent sessions make
same-window submits plausible.

### Hook responsibilities

| Hook | File | Writes | Status |
|---|---|---|---|
| `UserPromptSubmit` | `user-prompt-submit.mjs` | `turn_active` + marker | exists, extend |
| `Stop` | `stop.mjs` | `idle` | exists, extend |
| `SessionEnd` | `session-end.mjs` | `ended` | **new** |

`install.mjs` gains one entry in `HOOK_EVENTS`. All hooks keep the existing
`try { … } catch {}` + `process.exit(0)` fail-open contract, and the marker must be
merged into any `additionalContext` the optimizer already emits, never clobber it.

### The scheduler gate

A new pure function in `scheduler.ts`, matching the style of the existing
`effectiveCadenceMs` / `classifyPingResponse` / `effectiveConsecutivePingCap`
("no I/O, safe to test exhaustively"):

```
decidePingGate(session, hookState, config) -> "proceed" | "abandon"
```

| Bound hook state | Gate | Change vs today |
|---|---|---|
| `ended` | `abandon` — abandon immediately, zero pings | **saves 2–5 pings per close** |
| `idle` | `proceed` | unchanged here; see cap accounting below |
| `turn_active` | `proceed` | unchanged |
| unbound / missing / stale | `proceed` | unchanged — graceful degradation |

No row in this table pings more than today; `ended` is the only behavior change,
and it only ever *prevents* pings.

There is exactly **one** consecutive-ping cap, still computed by
`effectiveConsecutivePingCap`. The hook state does not select between different
caps. What changes is the honesty of the cap's *input*: `turn_active` pauses stop
contributing misleading outcomes to `observedReturnRate` (see below). The
`turn_active` state is therefore consulted at *pause* time, not at gate time.

A new `PauseReason` value, `claude_session_ended`, distinguishes hook-driven
abandonment in the event log and on the dashboard.

### Honest cap accounting

`recordPauseOutcome` is currently called for every `pings_without_progress` pause
that resolves. It becomes conditional on the pause having been **speculative** —
that is, the session was `idle` (or unbound) rather than `turn_active` when it hit
the cap. A new `pausedWhileIdle` field on `Session`, set at pause time, records
this.

Effects:

- A long tool call that trips the cap and then returns no longer records a
  misleading `+returned`, so it stops inflating the cap for genuinely speculative
  sessions.
- A session closed while paused-and-idle still records `–returned`. That is the
  correct signal: it genuinely did not come back.

### Configuration

One new block, validated in `config-schema.ts` alongside the rest:

```json
"hookSignals": {
  "enabled": true,
  "stateDir": "<homedir>/.stoke/session-state",
  "staleAfterSeconds": 900
}
```

`enabled: true` by default, but with no state files present the behavior is
byte-identical to today, so an installation without the hooks is unaffected.

## Failure modes

| Failure | Handling |
|---|---|
| Hard kill (terminal closed, crash) — no `SessionEnd` fires | The existing `abandonTtlMultiplier` threshold remains as backstop. Unchanged from today. |
| Real request arrives after `ended` (session resumed, same prefix) | The request is ground truth. `upsert` reactivates the session (`registry.ts:363-366`), and the gate compares the signal's timestamp against `lastRealRequestAt` — a signal older than the last real request loses. Without that comparison, a stale `ended` file left behind by a stopped hook (while the binding marker lingers in message history) would re-abandon a live session on every tick for the whole staleness window. |
| State file malformed, unreadable, or older than `staleAfterSeconds` | Treated as unknown → today's behavior. |
| `session-state/` directory absent | Treated as no signal → today's behavior. |
| Hook throws | Existing fail-open contract; the proxy simply sees no state file. |
| Stale state files accumulate | Pruned when older than `evictAfterHours`, alongside existing session eviction. |

## Testing

Pure functions, tested exhaustively per the existing convention:

- `decidePingGate` — every combination of hook state × session state × staleness.
- `extractClaudeSessionId` — absent, present, multiple (last wins), malformed,
  string vs block-array message content, non-UUID payloads.
- `parseHookState` — valid, unknown `state` value, missing fields, stale `ts`.
- Cap accounting — `+returned` suppressed for `turn_active` pauses, `–returned`
  still recorded for idle ones.

Integration, in the existing `packages/proxy/tests` harness:

- A session bound and then marked `ended` fires **zero** further pings.
- An unbound session behaves byte-identically to today (regression guard).
- A `turn_active` session is not braked by the tighter idle cap.

Hook tests extend `packages/monitor/tests/hooks.test.js`:

- Each hook writes the expected state file.
- The marker is emitted and merged with existing optimizer directives rather than
  replacing them.
- `install.mjs` registers `SessionEnd` (extends `tests/install.test.js`).

## Expected outcome

- Closing a Claude Code session stops keepalive pings within one tick (~10s)
  instead of 9–22 minutes, eliminating 2–5 wasted pings per close, per session.
- The adaptive cap stops being skewed upward by certain-return pauses and skewed
  downward by dead sessions, so it reflects actual idle-return behavior.
- Zero new pings in any state; no new user-facing surface to learn or remember.
