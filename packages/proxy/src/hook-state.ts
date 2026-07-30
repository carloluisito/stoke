// src/hook-state.ts
//
// Reads the session-lifecycle sidecar files the Claude Code plugin hooks write.
// This is the proxy's only window into what the editor knows and the API traffic
// cannot show: whether a turn is in flight, whether the user is idle at the
// prompt, or whether the session is gone.
//
// Every failure path here returns "no signal" rather than a guess. A wrong
// signal would brake a live session and cost the user a cache rebuild, which is
// strictly worse than the pre-hook behavior of pinging on a timer.
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type HookState = "turn_active" | "idle" | "ended";

export interface HookStateRecord {
  state: HookState;
  /**
   * When the hook wrote this, ms since epoch. The scheduler compares it against
   * the session's `lastRealRequestAt`, so an outdated signal can never win.
   */
  ts: number;
}

const VALID: ReadonlySet<string> = new Set<string>(["turn_active", "idle", "ended"]);
const JSON_SUFFIX = ".json";

/**
 * Parse one sidecar file. Returns null when the payload is unparseable, is not a
 * plain object, carries an unknown state, has no usable timestamp, or is older
 * than `staleAfterMs`.
 *
 * A timestamp in the FUTURE is accepted: clock skew between the hook process and
 * the proxy must not discard an otherwise-valid signal.
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
 *
 * A missing directory yields an empty map, which the scheduler reads as "no
 * hooks installed" and therefore as the pre-hook behavior. That is the case for
 * anyone running the proxy without the monitor plugin.
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
 *
 * Nothing depends on this for correctness — the staleness window already makes an
 * old file inert — it only keeps the directory from growing without bound on a
 * long-running proxy. Only `.json` files are touched. Returns the number removed.
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
      keep = parseHookState(readFileSync(full, "utf8"), nowMs, maxAgeMs) !== null;
    } catch {
      keep = false;
    }
    if (keep) continue;
    try {
      unlinkSync(full);
      removed += 1;
    } catch { /* a hook may have rewritten or removed it concurrently */ }
  }
  return removed;
}
