// Live-context sidecar: bridge Claude Code's live context_window (only ever
// delivered to the statusline) over to the UserPromptSubmit hook, which never
// receives it. The statusline writes the current context size to a per-session
// file; the hook reads it so its gate/warnings reflect live context instead of
// the last recorded turn (which lags by a turn and is wrong right after /compact).

import path from "node:path";

const DEFAULT_FRESHNESS_MS = 90_000; // statusline runs on events; tolerate a short lag

// Map Claude Code's statusline stdin `context_window` into the sidecar payload.
// Returns null when no usable context figure is present (fail-open: hook then
// falls back to its DB behavior). `total_input_tokens` is preferred because it
// is the input context that gets re-billed each message; pct*size is a fallback.
export function contextSidecarPayload(input, nowIso) {
  const cw = input?.context_window;
  if (!cw) return null;
  const size = num(cw.context_window_size);
  const pct = num(cw.used_percentage);
  let usedTokens = num(cw.total_input_tokens);
  if (usedTokens == null && pct != null && size != null) usedTokens = Math.round((pct / 100) * size);
  if (usedTokens == null) return null;
  return { ts: nowIso, usedTokens, pct: pct ?? null, size: size ?? null };
}

// Decide which context-token count the hook should act on. Prefer the live
// sidecar number when it is present, valid, and fresh; otherwise fall back to
// the last-recorded-turn value from the DB (today's behavior).
export function effectiveContextTokens({ lastTurnCtx, sidecar, now, freshnessMs = DEFAULT_FRESHNESS_MS }) {
  const live = num(sidecar?.usedTokens);
  if (live != null && sidecar?.ts) {
    const age = now - Date.parse(sidecar.ts);
    if (Number.isFinite(age) && age >= 0 && age <= freshnessMs) {
      return { tokens: live, source: "live" };
    }
  }
  return { tokens: lastTurnCtx, source: "db" };
}

export function contextSidecarPath(sessionId, baseDir) {
  return path.join(baseDir, "context", `${sessionId || "unknown"}.json`);
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
