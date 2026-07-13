// src/registry.ts
import { createHash } from "node:crypto";
import type {
  PauseReason,
  RateLimits,
  ResumeEvent,
  Session,
  SessionKey,
  SessionStateName,
  UsageBlock,
} from "./types.ts";

type Hashable = {
  model?: string;
  tools?: unknown;
  system?: unknown;
  messages?: unknown;
  cache_control?: unknown;
};

/**
 * Compute a session key that matches Anthropic's actual cache lookup identity.
 *
 * Anthropic's prompt cache keys on the canonical bytes up to and including the
 * last `cache_control` breakpoint in API document order (tools → system →
 * messages). Anything after that point — variable system tails, conversation
 * messages, per-turn metadata — does not change which cache entry is hit.
 *
 * Hashing the WHOLE structural fingerprint (the previous behavior) over-
 * discriminated: Claude Code embeds per-turn metadata in `system`, so every
 * turn produced a new session key even though Anthropic served them all from
 * the same cache. Fixing this collapses N "phantom" sessions per real
 * conversation into 1.
 *
 * When no explicit breakpoint exists, we fall back to hashing tools + system
 * verbatim (current behavior) — Anthropic's auto-caching takes over and our
 * hash matches whatever auto-breakpoint it chooses for the same content.
 */
export function computeSessionKey(payload: Hashable): SessionKey {
  const prefix = cacheablePrefix(payload);
  const canonical = canonicalize({
    model: payload.model ?? "",
    prefix,
  });
  return createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 16);
}

function cacheablePrefix(payload: Hashable): unknown {
  // Hash only the structural prefix: tools + system. Messages are
  // deliberately excluded — Claude Code rotates cache_control onto the
  // last user message every turn, which would otherwise fragment a single
  // conversation into one session per turn. The big-money cache (tools +
  // system, often 100k–700k tokens) is what we need to keep warm; the
  // per-turn message tails are small and refreshed naturally by user
  // activity.
  //
  // Within tools and system we still respect cache_control — if a
  // breakpoint sits in one of those sections, we slice up to and including
  // it so per-turn variation AFTER the breakpoint (timestamps in trailing
  // system blocks) is ignored.
  //
  // Claude Code stamps system[0] with a billing-header block that includes a
  // per-turn `cch=` content hash. Even though cache_control usually sits on a
  // later system block, the billing header sits BEFORE it and rotates per
  // turn, fragmenting one conversation into N sessions. Drop that block from
  // the hash when it matches the signature.
  //
  // KNOWN LIMITATION (2026-05-20): a single Claude Code conversation can still
  // appear as 2+ dashboard rows when `tools[]` changes mid-session — observed
  // triggers are sub-agent dispatches and Skill invocations that register new
  // tools dynamically. Our hash includes the full tools array up to the
  // cache_control breakpoint, but Anthropic's actual cache key sits AFTER the
  // breakpoint and is unaffected by tool additions before it. Proved
  // empirically by a "new" session-key receiving cache_read > 0 on its first
  // real request. Harmless functionally; see design doc §11 (2026-05-19).
  const tools = asBlockArray(payload.tools);
  const system = stripBillingHeader(asBlockArray(payload.system));

  let cutSection: "tools" | "system" | null = null;
  let cutIndex = -1;

  const seek = (arr: unknown[], section: "tools" | "system"): void => {
    for (let i = 0; i < arr.length; i++) {
      if (hasCacheControl(arr[i])) {
        cutSection = section;
        cutIndex = i;
      }
    }
  };
  seek(tools, "tools");
  seek(system, "system");

  if (cutSection === null) {
    return { tools, system };
  }

  return {
    tools: cutSection === "tools" ? tools.slice(0, cutIndex + 1) : tools,
    system:
      cutSection === "system"
        ? system.slice(0, cutIndex + 1)
        : /* cutSection === "tools" */ [],
  };
}

function hasCacheControl(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  if ("cache_control" in b && b.cache_control != null) return true;
  // Messages embed their cacheable content in `content`. Recurse one level.
  if (Array.isArray(b.content)) {
    return b.content.some(hasCacheControl);
  }
  return false;
}

/**
 * Inspect the outgoing payload to determine which prompt-cache TTL Claude Code
 * asked for on this request. Per Anthropic docs (2026-05, "On a Claude
 * subscription"), Claude Code sets `cache_control.ttl: "1h"` automatically for
 * plan subscribers and on API-key when `ENABLE_PROMPT_CACHING_1H=1`. Returns
 * 3600 if any tools/system block opts into 1h, else 300. The wire format is
 * ground truth — we don't peek at env vars or auth method.
 */
export function detectCacheTtlSeconds(payload: Hashable): 300 | 3600 {
  const blocks = [...asBlockArray(payload.tools), ...asBlockArray(payload.system)];
  for (const block of blocks) {
    if (blockHas1hTtl(block)) return 3600;
  }
  return 300;
}

function blockHas1hTtl(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  const cc = b.cache_control;
  if (cc && typeof cc === "object") {
    const ttl = (cc as Record<string, unknown>).ttl;
    if (typeof ttl === "string" && ttl === "1h") return true;
  }
  if (Array.isArray(b.content)) {
    return b.content.some(blockHas1hTtl);
  }
  return false;
}

/**
 * Drop a leading Claude Code billing-header block when present. That block
 * carries `cc_version=...; cc_entrypoint=...; cch=<per-turn-hash>;` and rotates
 * every API call, so including it in the prefix hash fragments one
 * conversation into one session per turn. Verified against captured
 * 2026-05-20 traffic.
 */
function stripBillingHeader(blocks: unknown[]): unknown[] {
  if (blocks.length === 0) return blocks;
  const first = blocks[0];
  if (!first || typeof first !== "object") return blocks;
  const text = (first as { text?: unknown }).text;
  if (typeof text !== "string") return blocks;
  // Tight signature so we don't strip user content that happens to start with similar bytes.
  if (
    text.startsWith("x-anthropic-billing-header:") &&
    text.includes("cc_version=") &&
    text.includes("cch=")
  ) {
    return blocks.slice(1);
  }
  return blocks;
}

function asBlockArray(field: unknown): unknown[] {
  if (field == null) return [];
  if (typeof field === "string") return [{ type: "text", text: field }];
  if (Array.isArray(field)) return field;
  return [field];
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}

export interface PersistedSession {
  key: string;
  model: string;
  prefixTokensEstimate: number;
  firstRealRequestAt: number;
  lastRealRequestAt: number;
  lastSeenAt: number;
  pingHistory5h: { ts: number; costUsd: number }[];
  state: "active" | "paused" | "abandoned";
  pauseReason?: PauseReason;
  /** Preserved across restarts so the resume badge survives a proxy bounce. */
  lastResume?: ResumeEvent;
  /**
   * Preserved across restarts so the scheduler picks up the right cadence on
   * the first tick after a bounce instead of defaulting to 5-min until the
   * next real_request re-runs detection.
   */
  detectedTtlSeconds?: number;
}

/** One pause→resolution outcome used for the adaptive cap's observed return-rate. */
export interface PauseOutcome {
  ts: number;
  returned: boolean;
}

/** Result of Registry.upsert. Surfaces lifecycle transition context so the caller can emit a `session_resumed` or `session_ttl_changed` event when appropriate. */
export interface UpsertResult {
  key: SessionKey;
  /** State the session was in BEFORE this upsert. Null for brand-new sessions. */
  previousState: SessionStateName | null;
  /** ms since lastRealRequestAt before this upsert. 0 for new sessions. */
  gapMs: number;
  /** detectedTtlSeconds BEFORE this upsert (null for brand-new sessions). */
  previousDetectedTtlSeconds: number | null;
  /** detectedTtlSeconds AFTER this upsert (always set — fresh detection from payload). */
  currentDetectedTtlSeconds: number;
}

export class Registry {
  private sessions = new Map<SessionKey, Session>();
  /**
   * Rolling buffer of `pings_without_progress` pause outcomes. Push on
   * resolution: returned=true when the user comes back (upsert finds a paused
   * session), returned=false when the session abandons. Soft-capped at 1000 to
   * bound memory; `observedReturnRate(window)` reads only the last `window`.
   */
  private pauseOutcomes: PauseOutcome[] = [];
  private static readonly PAUSE_OUTCOMES_HARD_CAP = 1000;

  recordPauseOutcome(returned: boolean, nowMs: number): void {
    this.pauseOutcomes.push({ ts: nowMs, returned });
    if (this.pauseOutcomes.length > Registry.PAUSE_OUTCOMES_HARD_CAP) {
      this.pauseOutcomes.splice(0, this.pauseOutcomes.length - Registry.PAUSE_OUTCOMES_HARD_CAP);
    }
  }

  /**
   * Observed return-rate over the last `windowSize` resolved pause outcomes.
   * Returns 1.0 when there is no data yet — optimistic default so a fresh
   * proxy starts at the configured ceiling and only adapts downward after
   * actual abandonments are observed.
   */
  observedReturnRate(windowSize: number): number {
    const start = Math.max(0, this.pauseOutcomes.length - windowSize);
    const slice = this.pauseOutcomes.slice(start);
    if (slice.length === 0) return 1.0;
    let returned = 0;
    for (const o of slice) if (o.returned) returned += 1;
    return returned / slice.length;
  }

  /** Count of pause outcomes inside the window. Surfaced on the dashboard. */
  pauseOutcomeCount(windowSize: number): number {
    return Math.min(this.pauseOutcomes.length, windowSize);
  }

  /** Snapshot the registry as plain JSON-safe metadata. Credentials are deliberately omitted. */
  serialize(): PersistedSession[] {
    const out: PersistedSession[] = [];
    for (const s of this.sessions.values()) {
      out.push({
        key: s.key,
        model: s.model,
        prefixTokensEstimate: s.prefixTokensEstimate,
        firstRealRequestAt: s.firstRealRequestAt,
        lastRealRequestAt: s.lastRealRequestAt,
        lastSeenAt: s.lastSeenAt,
        pingHistory5h: [...s.pingHistory5h],
        state: s.state,
        ...(s.pauseReason ? { pauseReason: s.pauseReason } : {}),
        ...(s.lastResume ? { lastResume: { ...s.lastResume } } : {}),
        detectedTtlSeconds: s.detectedTtlSeconds,
      });
    }
    return out;
  }

  /**
   * Insert sessions loaded from a previously-serialised registry. Restored
   * sessions enter `state: "paused", pauseReason: "needs_real_request"` because
   * we don't persist auth headers or request bodies — the scheduler can't
   * replay pings until a real request reattaches those.
   */
  hydrate(entries: PersistedSession[]): void {
    for (const e of entries) {
      if (typeof e?.key !== "string" || typeof e?.model !== "string") continue;
      if (typeof e?.lastRealRequestAt !== "number" || typeof e?.lastSeenAt !== "number") continue;
      if (typeof e?.firstRealRequestAt !== "number") continue;
      if (typeof e?.prefixTokensEstimate !== "number") continue;
      if (!Array.isArray(e?.pingHistory5h)) continue;
      this.sessions.set(e.key, {
        key: e.key,
        model: e.model,
        prefixTokensEstimate: e.prefixTokensEstimate,
        firstRealRequestAt: e.firstRealRequestAt,
        lastRealRequestAt: e.lastRealRequestAt,
        lastSeenAt: e.lastSeenAt,
        lastPayload: {},
        lastAuthHeader: "",
        lastPath: "/v1/messages",
        lastHeaders: {},
        lastRealUsage: null,
        detectedTtlSeconds:
          typeof e.detectedTtlSeconds === "number" ? e.detectedTtlSeconds : 300,
        pingsSinceLastReal: 0,
        pingHistory5h: e.pingHistory5h.slice(),
        lastRatelimits: null,
        state: "paused",
        pauseReason: "needs_real_request",
        ...(e.lastResume ? { lastResume: { ...e.lastResume } } : {}),
      });
    }
  }

  upsert(
    payload: Record<string, unknown>,
    authHeader: string,
    nowMs: number,
    path: string = "/v1/messages",
    headers: Record<string, string | string[] | undefined> = {},
  ): UpsertResult {
    const key = computeSessionKey(payload as Hashable);
    const ttlSec = detectCacheTtlSeconds(payload as Hashable);
    const existing = this.sessions.get(key);
    if (existing) {
      const previousState: SessionStateName = existing.state;
      const gapMs = Math.max(0, nowMs - existing.lastRealRequestAt);
      const previousDetectedTtlSeconds = existing.detectedTtlSeconds;
      // If the session was paused with `pings_without_progress` and a real
      // request just arrived, the user came back — record a +returned outcome
      // for the adaptive-cap math BEFORE we mutate state.
      if (
        existing.state === "paused" &&
        existing.pauseReason === "pings_without_progress"
      ) {
        this.recordPauseOutcome(true, nowMs);
      }
      existing.lastPayload = payload;
      existing.lastAuthHeader = authHeader;
      existing.lastPath = path;
      existing.lastHeaders = headers;
      existing.lastSeenAt = nowMs;
      existing.lastRealRequestAt = nowMs;
      existing.detectedTtlSeconds = ttlSec;
      existing.pingsSinceLastReal = 0;
      if (existing.state !== "active") {
        existing.state = "active";
        delete existing.pauseReason;
      }
      return {
        key,
        previousState,
        gapMs,
        previousDetectedTtlSeconds,
        currentDetectedTtlSeconds: ttlSec,
      };
    }
    const fresh: Session = {
      key,
      model: typeof payload.model === "string" ? payload.model : "unknown",
      prefixTokensEstimate: 0,
      lastSeenAt: nowMs,
      firstRealRequestAt: nowMs,
      lastRealRequestAt: nowMs,
      lastPayload: payload,
      lastAuthHeader: authHeader,
      lastPath: path,
      lastHeaders: headers,
      lastRealUsage: null,
      detectedTtlSeconds: ttlSec,
      pingsSinceLastReal: 0,
      pingHistory5h: [],
      lastRatelimits: null,
      state: "active",
    };
    this.sessions.set(key, fresh);
    return {
      key,
      previousState: null,
      gapMs: 0,
      previousDetectedTtlSeconds: null,
      currentDetectedTtlSeconds: ttlSec,
    };
  }

  recordRealUsage(key: SessionKey, usage: UsageBlock, ratelimits: RateLimits): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.lastRealUsage = usage;
    s.lastRatelimits = ratelimits;
    const estimate = Math.max(
      usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens,
    );
    if (estimate > 0) s.prefixTokensEstimate = estimate;
  }

  recordPingResult(
    key: SessionKey,
    success: boolean,
    usage: UsageBlock | null,
    costUsd: number,
    nowMs: number,
    ratelimits: RateLimits,
  ): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.lastRatelimits = ratelimits;
    const cutoff = nowMs - 5 * 60 * 60 * 1000;
    s.pingHistory5h = s.pingHistory5h.filter((p) => p.ts >= cutoff);
    s.pingHistory5h.push({ ts: nowMs, costUsd });
    if (success && usage && usage.cache_read_input_tokens > 0) {
      s.lastSeenAt = nowMs;
      s.prefixTokensEstimate = usage.cache_read_input_tokens;
      s.pingsSinceLastReal += 1;
    }
  }

  pingStatsInWindow(key: SessionKey, nowMs: number): { count: number; costUsd: number } {
    const s = this.sessions.get(key);
    if (!s) return { count: 0, costUsd: 0 };
    const cutoff = nowMs - 5 * 60 * 60 * 1000;
    s.pingHistory5h = s.pingHistory5h.filter((p) => p.ts >= cutoff);
    let costUsd = 0;
    for (const p of s.pingHistory5h) costUsd += p.costUsd;
    return { count: s.pingHistory5h.length, costUsd };
  }

  /** Record a resume event on the session for later dashboard rendering. */
  recordResume(key: SessionKey, ev: ResumeEvent): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.lastResume = ev;
  }

  pause(key: SessionKey, reason: PauseReason): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.state = "paused";
    s.pauseReason = reason;
  }

  /**
   * Remove sessions whose lastRealRequestAt is older than `evictAfterMs`. Distinct from
   * abandonStale: that marks state, this removes the entry. Lets the dashboard surface
   * abandoned sessions during the grace period while bounding map size on long-running
   * proxies.
   */
  evictAbandoned(nowMs: number, evictAfterMs: number): SessionKey[] {
    const removed: SessionKey[] = [];
    for (const [key, s] of this.sessions) {
      if (nowMs - s.lastRealRequestAt > evictAfterMs) {
        this.sessions.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  /**
   * Abandon sessions whose lastRealRequestAt is older than the per-session
   * threshold returned by `thresholdMsFor(session)`. Per-session because the
   * effective abandon time scales with each session's detected TTL.
   */
  abandonStale(nowMs: number, thresholdMsFor: (s: Session) => number): SessionKey[] {
    const abandoned: SessionKey[] = [];
    for (const s of this.sessions.values()) {
      if (s.state === "abandoned") continue;
      // Abandonment uses lastRealRequestAt — pings never refresh this.
      // Closed Claude Code sessions get abandoned even if pings have been
      // keeping the cache warm in the meantime.
      if (nowMs - s.lastRealRequestAt > thresholdMsFor(s)) {
        // If this session was paused with `pings_without_progress` and is now
        // being abandoned without a return, that's a –returned outcome for
        // the adaptive-cap math. (No outcome recorded for sessions abandoned
        // from other states — those are not the cap's responsibility.)
        if (s.state === "paused" && s.pauseReason === "pings_without_progress") {
          this.recordPauseOutcome(false, nowMs);
        }
        s.state = "abandoned";
        abandoned.push(s.key);
      }
    }
    return abandoned;
  }

  activeSessions(nowMs: number, idleAtLeastMs: number): Session[] {
    const out: Session[] = [];
    for (const s of this.sessions.values()) {
      if (s.state !== "active") continue;
      if (nowMs - s.lastSeenAt >= idleAtLeastMs) out.push(s);
    }
    return out;
  }

  /**
   * Active sessions whose idle time meets the per-session threshold returned
   * by `idleAtLeastMsFor(session)`. Drives TTL-aware ping cadence — a 1h-TTL
   * session has to be idle ~55min before becoming eligible, while a 5m-TTL
   * session only needs ~4.5min.
   */
  activeSessionsBy(nowMs: number, idleAtLeastMsFor: (s: Session) => number): Session[] {
    const out: Session[] = [];
    for (const s of this.sessions.values()) {
      if (s.state !== "active") continue;
      if (nowMs - s.lastSeenAt >= idleAtLeastMsFor(s)) out.push(s);
    }
    return out;
  }

  get(key: SessionKey): Session | undefined {
    return this.sessions.get(key);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }
}
