// src/savings.ts
//
// Typed facade over @stoke/shared/savings.mjs — the single savings
// implementation shared with the monitor. All math lives in the shared
// package; this module pins the proxy's TypeScript types onto it.

import type { Config, EventRecord, SessionKey } from "./types.ts";
import {
  CACHE_TTL_MS as SHARED_CACHE_TTL_MS,
  REBUILD_MULTIPLIER as SHARED_REBUILD_MULTIPLIER,
  computeSavings as sharedComputeSavings,
  computeSavingsMulti as sharedComputeSavingsMulti,
  computeCacheHitRate as sharedComputeCacheHitRate,
  compute5hSparkline as sharedCompute5hSparkline,
} from "@stoke/shared/savings.mjs";

export const CACHE_TTL_MS: number = SHARED_CACHE_TTL_MS;
export const REBUILD_MULTIPLIER: number = SHARED_REBUILD_MULTIPLIER;

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
  return sharedComputeSavings(events, config, windowFromMs, windowToMs) as SavingsResult;
}

/** Same as computeSavings but for multiple windows in one pass. Requires events sorted by ts ascending. */
export function computeSavingsMulti(
  events: readonly EventRecord[],
  config: Config,
  windows: Array<{ fromMs: number; toMs: number }>,
): SavingsResult[] {
  return sharedComputeSavingsMulti(events, config, windows) as SavingsResult[];
}

export function computeCacheHitRate(
  events: readonly EventRecord[],
  windowFromMs: number,
  windowToMs: number,
): CacheHitRateResult {
  return sharedComputeCacheHitRate(events, windowFromMs, windowToMs);
}

/** Requires `events` sorted by `ts` ascending. */
export function compute5hSparkline(
  events: readonly EventRecord[],
  config: Config,
  nowMs: number,
  bucketCount: number = 20,
): SparklineBucket[] {
  return sharedCompute5hSparkline(events, config, nowMs, bucketCount);
}
