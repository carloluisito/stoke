# Decision: Live-context source for tokeff gate
Date: 2026-07-16
Status: Accepted

## Problem
tokeff's `UserPromptSubmit` hook gates/warns on the last recorded turn
(`cache_read + input_tokens`), which is one turn behind live context. After
`/compact` — before the next turn runs — that value is the big pre-compact
context while live context is small, producing a false HARD GATE and a re-bill
number that contradicts the status line (e.g. 572k vs 90k). Constraint: Claude
Code delivers live `context_window` only to the statusline, never to hooks.

## Options considered
- **A — Statusline live-context sidecar:** the statusline writes live
  `context_window` to `~/.stoke/context/<session>.json`; the hook reads it and
  acts on the live number when fresh, else falls back to the last DB turn.
- **B — PreCompact marker suppress:** a `PreCompact` hook writes a marker; the
  UPS hook suppresses the gate when the last turn is known-stale.
- Differ on axis: **measure-the-truth (A) vs. detect-and-suppress (B).**

## Decision
**Approach A.** It is the only option that fixes both reported symptoms — the
false gate *and* the displayed number disagreeing with the status line —
because it is the only one that actually knows the live context size. Evidence
from `~/.stoke/stoke.db` shows context frequently re-inflates the turn after a
compact (e.g. 125k → 405k), so B would wrongly suppress warnings that are
sometimes legitimately needed, and would leave the displayed figure wrong.

## Revisit if
The active statusline cannot be relied on to emit the sidecar (e.g. the product
ships without a tokeff-aware statusline). Then B's zero-dependency suppression
becomes the only thing that works and would win.

## Implementation
- `src/context-sidecar.js` — pure `contextSidecarPayload` + `effectiveContextTokens` (unit-tested).
- `plugin/statusline.mjs` — writes the sidecar from `context_window`.
- `plugin/hooks/lib.mjs` — `saveContext` / `loadContext`.
- `plugin/hooks/user-prompt-submit.mjs` — gate + cache/bloat warnings use the effective live context.
- Freshness window: 90s; fail-open (missing/stale sidecar → prior DB behavior).
