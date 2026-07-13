// @stoke/shared/savings.mjs
//
// Pure computation of stoke's value metrics (rebuilds avoided, ping spend,
// net savings, cache hit rate, 5h sparkline). No I/O — callers read events
// from disk (proxy: events.jsonl snapshot; monitor: proxy_events rows) and
// pass them in. Single implementation consumed by both sides; the proxy's
// src/savings.ts re-exports these functions with TypeScript signatures.
//
// Event shape: the proxy's EventRecord — `{ ts, kind, ... }` with kinds
// proxy_started | real_request | ping_fired | ping_skipped | session_paused |
// session_resumed | session_ttl_changed. real_request carries `sessionKey`,
// `model`, `usage.cache_read_input_tokens`, optional `cacheTtlSeconds`;
// ping_fired carries `costUsd`.

import { inputPerMtokFromMap } from "./pricing.mjs";

/**
 * Anthropic's default 5-minute prompt-cache TTL, in ms. Retained as a constant
 * for tests and back-compat; the runtime path uses `config.cacheTtlSeconds`,
 * which is what `ttlMs()` reads. Users on Anthropic's 1-hour cache opt-in set
 * cacheTtlSeconds=3600 in config — savings math then uses 1h, not 5m.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Default rebuild multiplier (Anthropic's published 5-min cache-write rate as
 * a multiple of input rate). Surfaced for tests and back-compat — the runtime
 * path reads `config.pricing.rebuildMultiplier` (and `rebuildMultiplier1h`
 * when the event's detected TTL is 1 hour).
 */
export const REBUILD_MULTIPLIER = 1.25;

const ONE_HOUR_MS = 3600 * 1000;

function ttlMs(config) {
  return config.cacheTtlSeconds * 1000;
}

/**
 * TTL that was active on the given real_request event. Prefers the auto-
 * detected per-event value; falls back to config.cacheTtlSeconds for logs
 * written before TTL detection landed. Returns ms.
 */
function eventTtlMs(ev, config) {
  if (typeof ev.cacheTtlSeconds === "number") return ev.cacheTtlSeconds * 1000;
  return ttlMs(config);
}

/**
 * Rebuild multiplier for the event's TTL: 1-hour cache writes cost 2× input
 * (vs 1.25× for 5-minute). `rebuildMultiplier1h` is optional in config; when
 * absent, the single `rebuildMultiplier` is used for both TTLs (historical
 * behavior).
 */
function rebuildMultiplierFor(evTtlMs, config) {
  if (evTtlMs >= ONE_HOUR_MS && typeof config.pricing.rebuildMultiplier1h === "number") {
    return config.pricing.rebuildMultiplier1h;
  }
  return config.pricing.rebuildMultiplier;
}

function avoidedRebuildUsd(ev, evTtlMs, config) {
  const cacheRead = ev.usage.cache_read_input_tokens;
  const perMtok = inputPerMtokFromMap(ev.model, config.modelPricing);
  return (cacheRead * perMtok * rebuildMultiplierFor(evTtlMs, config)) / 1e6;
}

/** Requires `events` sorted by `ts` ascending. */
export function computeSavings(events, config, windowFromMs, windowToMs) {
  const result = {
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
  const lastTsBySession = new Map();

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
      const evTtl = eventTtlMs(ev, config);
      if (gapMs > evTtl) {
        const saved = avoidedRebuildUsd(ev, evTtl, config);
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
export function computeSavingsMulti(events, config, windows) {
  const results = windows.map(() => ({
    savedUsd: 0,
    rebuildsAvoided: 0,
    perSession: new Map(),
    pingSpendUsd: 0,
    netSavedUsd: 0,
  }));
  // Shared predecessor map: like computeSavings, the predecessor lookup spans
  // the full event log regardless of window membership.
  const lastTsBySession = new Map();

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
      const evTtl = eventTtlMs(ev, config);
      if (gapMs > evTtl) {
        const saved = avoidedRebuildUsd(ev, evTtl, config);
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

export function computeCacheHitRate(events, windowFromMs, windowToMs) {
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
export function compute5hSparkline(events, config, nowMs, bucketCount = 20) {
  const FIVE_H_MS = 5 * 60 * 60 * 1000;
  const bucketMs = FIVE_H_MS / bucketCount;
  const windowFromMs = nowMs - FIVE_H_MS;

  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      tsIso: new Date(windowFromMs + i * bucketMs).toISOString(),
      savedUsd: 0,
      pingSpendUsd: 0,
    });
  }

  // Walk every event: real_request contributes to savedUsd, ping_fired
  // contributes to pingSpendUsd. Predecessor lookup spans the full event log.
  const lastTsBySession = new Map();
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
      const evTtl = eventTtlMs(ev, config);
      if (gapMs > evTtl) {
        const saved = avoidedRebuildUsd(ev, evTtl, config);
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
