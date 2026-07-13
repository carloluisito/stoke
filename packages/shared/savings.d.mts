export const CACHE_TTL_MS: number;
export const REBUILD_MULTIPLIER: number;

export interface SavingsResult {
  savedUsd: number;
  rebuildsAvoided: number;
  perSession: Map<string, number>;
  pingSpendUsd: number;
  netSavedUsd: number;
}

export interface CacheHitRateResult {
  hitRate: number | null;
  realRequests: number;
  cacheHits: number;
}

export interface SparklineBucket {
  tsIso: string;
  savedUsd: number;
  pingSpendUsd: number;
}

export function computeSavings(
  events: readonly unknown[],
  config: unknown,
  windowFromMs: number,
  windowToMs: number,
): SavingsResult;

export function computeSavingsMulti(
  events: readonly unknown[],
  config: unknown,
  windows: Array<{ fromMs: number; toMs: number }>,
): SavingsResult[];

export function computeCacheHitRate(
  events: readonly unknown[],
  windowFromMs: number,
  windowToMs: number,
): CacheHitRateResult;

export function compute5hSparkline(
  events: readonly unknown[],
  config: unknown,
  nowMs: number,
  bucketCount?: number,
): SparklineBucket[];
