// src/savings.ts
//
// Pure computation of the stoke value metrics surfaced on the
// dashboard. No I/O — the caller is responsible for reading events from
// disk and passing them in. Comments below cite Anthropic's published
// cache pricing as of the 2026-05 design pass.

import type { Config, EventRecord, SessionKey } from "./types.ts";

/**
 * Anthropic's default 5-minute prompt-cache TTL, in ms. Retained as a constant
 * for tests and back-compat; the runtime path uses `config.cacheTtlSeconds`,
 * which is what `ttlMs()` reads. Users on Anthropic's 1-hour cache opt-in set
 * cacheTtlSeconds=3600 in config — savings math then uses 1h, not 5m.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

function ttlMs(config: Config): number {
  return config.cacheTtlSeconds * 1000;
}

/**
 * TTL that was active on the given real_request event. Prefers the auto-
 * detected per-event value; falls back to config.cacheTtlSeconds for logs
 * written before TTL detection landed. Returns ms.
 */
function eventTtlMs(
  ev: Extract<EventRecord, { kind: "real_request" }>,
  config: Config,
): number {
  if (typeof ev.cacheTtlSeconds === "number") return ev.cacheTtlSeconds * 1000;
  return ttlMs(config);
}

/**
 * Default rebuild multiplier (Anthropic's published 5-min cache-write rate as
 * a multiple of input rate). Surfaced for tests and back-compat — the runtime
 * path reads `config.pricing.rebuildMultiplier`.
 */
export const REBUILD_MULTIPLIER = 1.25;

export interface SavingsResult {
  /** Sum of avoided rebuild costs in USD over the requested window. */
  savedUsd: number;
  /** Count of real_request events that hit cache after a > TTL gap. */
  rebuildsAvoided: number;
  /** Per-session $ aggregate over the same window. */
  perSession: Map<SessionKey, number>;
  /** Sum of ping_fired.costUsd inside the window. */
  pingSpendUsd: number;
  /** savedUsd - pingSpendUsd. Can be negative when pings outspent rebuilds. */
  netSavedUsd: number;
}

export interface CacheHitRateResult {
  /** 0..1, or null when no real_request occurred in the window. */
  hitRate: number | null;
  realRequests: number;
  cacheHits: number;
}

export interface SparklineBucket {
  /** ISO timestamp of the bucket's start. */
  tsIso: string;
  savedUsd: number;
  /** Sum of ping_fired.costUsd in this bucket. Net per bucket = savedUsd - pingSpendUsd. */
  pingSpendUsd: number;
}

/** Requires `events` sorted by `ts` ascending. */
export function computeSavings(
  events: readonly EventRecord[],
  config: Config,
  windowFromMs: number,
  windowToMs: number,
): SavingsResult {
  const result: SavingsResult = {
    savedUsd: 0,
    rebuildsAvoided: 0,
    perSession: new Map(),
    pingSpendUsd: 0,
    netSavedUsd: 0,
  };
  // Track the most-recent real_request ts seen per session, regardless of
  // whether it falls inside the window. The spec requires the predecessor
  // lookup to span the full event log so an event at the window's edge can
  // still be compared to its true predecessor from before the window.
  const lastTsBySession = new Map<SessionKey, number>();

  for (const ev of events) {
    const tsMs = Date.parse(ev.ts);
    if (!Number.isFinite(tsMs)) continue;
    const inWindow = tsMs >= windowFromMs && tsMs <= windowToMs;

    if (ev.kind === "ping_fired") {
      if (inWindow && typeof ev.costUsd === "number") {
        result.pingSpendUsd += ev.costUsd;
      }
      continue;
    }
    if (ev.kind !== "real_request") continue;

    const prevTs = lastTsBySession.get(ev.sessionKey);
    const cacheRead = ev.usage.cache_read_input_tokens;

    if (inWindow && prevTs != null && cacheRead > 0) {
      const gapMs = tsMs - prevTs;
      if (gapMs > eventTtlMs(ev, config)) {
        const inputPerMtok = config.modelPricing[ev.model]?.inputPerMtok ?? 0;
        const saved = (cacheRead * inputPerMtok * config.pricing.rebuildMultiplier) / 1e6;
        result.savedUsd += saved;
        result.rebuildsAvoided += 1;
        result.perSession.set(
          ev.sessionKey,
          (result.perSession.get(ev.sessionKey) ?? 0) + saved,
        );
      }
    }

    lastTsBySession.set(ev.sessionKey, tsMs);
  }

  result.netSavedUsd = result.savedUsd - result.pingSpendUsd;
  return result;
}

/** Same as computeSavings but for multiple windows in one pass. Requires events sorted by ts ascending. */
export function computeSavingsMulti(
  events: readonly EventRecord[],
  config: Config,
  windows: Array<{ fromMs: number; toMs: number }>,
): SavingsResult[] {
  const results: SavingsResult[] = windows.map(() => ({
    savedUsd: 0,
    rebuildsAvoided: 0,
    perSession: new Map<SessionKey, number>(),
    pingSpendUsd: 0,
    netSavedUsd: 0,
  }));
  // Shared predecessor map: like computeSavings, the predecessor lookup spans
  // the full event log regardless of window membership.
  const lastTsBySession = new Map<SessionKey, number>();

  for (const ev of events) {
    const tsMs = Date.parse(ev.ts);
    if (!Number.isFinite(tsMs)) continue;

    if (ev.kind === "ping_fired") {
      if (typeof ev.costUsd === "number") {
        for (let i = 0; i < windows.length; i++) {
          const w = windows[i];
          if (tsMs >= w.fromMs && tsMs <= w.toMs) {
            results[i].pingSpendUsd += ev.costUsd;
          }
        }
      }
      continue;
    }
    if (ev.kind !== "real_request") continue;

    const prevTs = lastTsBySession.get(ev.sessionKey);
    const cacheRead = ev.usage.cache_read_input_tokens;

    if (prevTs != null && cacheRead > 0) {
      const gapMs = tsMs - prevTs;
      if (gapMs > eventTtlMs(ev, config)) {
        const inputPerMtok = config.modelPricing[ev.model]?.inputPerMtok ?? 0;
        const saved = (cacheRead * inputPerMtok * config.pricing.rebuildMultiplier) / 1e6;
        for (let i = 0; i < windows.length; i++) {
          const w = windows[i];
          if (tsMs >= w.fromMs && tsMs <= w.toMs) {
            const r = results[i];
            r.savedUsd += saved;
            r.rebuildsAvoided += 1;
            r.perSession.set(
              ev.sessionKey,
              (r.perSession.get(ev.sessionKey) ?? 0) + saved,
            );
          }
        }
      }
    }

    lastTsBySession.set(ev.sessionKey, tsMs);
  }

  for (const r of results) {
    r.netSavedUsd = r.savedUsd - r.pingSpendUsd;
  }
  return results;
}

export function computeCacheHitRate(
  events: readonly EventRecord[],
  windowFromMs: number,
  windowToMs: number,
): CacheHitRateResult {
  let realRequests = 0;
  let cacheHits = 0;
  for (const ev of events) {
    if (ev.kind !== "real_request") continue;
    const tsMs = Date.parse(ev.ts);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < windowFromMs || tsMs > windowToMs) continue;
    realRequests += 1;
    if (ev.usage.cache_read_input_tokens > 0) cacheHits += 1;
  }
  return {
    hitRate: realRequests > 0 ? cacheHits / realRequests : null,
    realRequests,
    cacheHits,
  };
}

/** Requires `events` sorted by `ts` ascending. */
export function compute5hSparkline(
  events: readonly EventRecord[],
  config: Config,
  nowMs: number,
  bucketCount: number = 20,
): SparklineBucket[] {
  const FIVE_H_MS = 5 * 60 * 60 * 1000;
  const bucketMs = FIVE_H_MS / bucketCount;
  const windowFromMs = nowMs - FIVE_H_MS;

  // Initialize bucket array with zero savedUsd / pingSpendUsd.
  const buckets: SparklineBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      tsIso: new Date(windowFromMs + i * bucketMs).toISOString(),
      savedUsd: 0,
      pingSpendUsd: 0,
    });
  }

  // Walk every event: real_request contributes to savedUsd, ping_fired
  // contributes to pingSpendUsd. Predecessor lookup spans the full event log.
  const lastTsBySession = new Map<SessionKey, number>();
  for (const ev of events) {
    const tsMs = Date.parse(ev.ts);
    if (!Number.isFinite(tsMs)) continue;
    const inWindow = tsMs >= windowFromMs && tsMs <= nowMs;

    if (ev.kind === "ping_fired") {
      if (inWindow && typeof ev.costUsd === "number") {
        const idx = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor((tsMs - windowFromMs) / bucketMs)),
        );
        buckets[idx].pingSpendUsd += ev.costUsd;
      }
      continue;
    }
    if (ev.kind !== "real_request") continue;

    const prevTs = lastTsBySession.get(ev.sessionKey);
    const cacheRead = ev.usage.cache_read_input_tokens;

    if (inWindow && prevTs != null && cacheRead > 0) {
      const gapMs = tsMs - prevTs;
      if (gapMs > eventTtlMs(ev, config)) {
        const inputPerMtok = config.modelPricing[ev.model]?.inputPerMtok ?? 0;
        const saved = (cacheRead * inputPerMtok * config.pricing.rebuildMultiplier) / 1e6;
        const idx = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor((tsMs - windowFromMs) / bucketMs)),
        );
        buckets[idx].savedUsd += saved;
      }
    }

    lastTsBySession.set(ev.sessionKey, tsMs);
  }

  return buckets;
}
