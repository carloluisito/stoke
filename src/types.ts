// src/types.ts

export type SessionKey = string;

export type SessionStateName = "active" | "paused" | "abandoned";

/** Captured every time a session transitions paused/abandoned → active via a real request. */
export interface ResumeEvent {
  /** ms since epoch when the resume happened. */
  ts: number;
  fromState: "paused" | "abandoned";
  /** ms since the previous real request before this resume. */
  gapMs: number;
  /**
   * Three-way classification based on usage on the resuming request:
   *  - "survived": cache_creation == 0 → clean cache hit, no new writes.
   *  - "partial":  cache_read > 0 AND cache_creation > 0 → cache largely survived,
   *                small natural growth (e.g., a new message appended).
   *                NOT a proxy failure — Anthropic supports incremental cache growth.
   *  - "rebuilt":  cache_read == 0 AND cache_creation > 0 → cache was fully cold;
   *                the user paid the full rebuild cost. THIS is what keep-alive aims to prevent.
   */
  cacheOutcome: "rebuilt" | "survived" | "partial";
  /** $ paid for cache_creation on the resuming request. 0 when cacheOutcome === "survived". */
  rebuildCostUsd: number;
  /** Cache-read tokens on the resuming request — surfaced for transparency / future reanalysis. */
  cacheReadTokens?: number;
  /** Cache-creation tokens on the resuming request — surfaced for transparency. */
  cacheCreationTokens?: number;
}
export type PauseReason =
  | "cache_miss"
  | "auth_error"
  | "upstream_5xx_repeat"
  | "budget_cap"
  | "malformed_response"
  | "needs_real_request"
  /** Fired N consecutive pings with no real request in between — user has likely stepped away. */
  | "pings_without_progress";

export interface UsageBlock {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface RateLimits {
  unified5hUtilization: number | null;
  unified7dUtilization: number | null;
  unified5hResetEpoch: number | null;
  overageStatus: "allowed" | "rejected" | null;
}

export interface Session {
  key: SessionKey;
  model: string;
  prefixTokensEstimate: number;
  /** Last activity of any kind (real request OR successful ping). Drives ping cadence. */
  lastSeenAt: number;
  /** First REAL Claude Code request. Drives the "longest-lived session wins" ping-target selection. */
  firstRealRequestAt: number;
  /** Last REAL Claude Code request only. Drives abandonment. Pings do NOT update this. */
  lastRealRequestAt: number;
  lastPayload: Record<string, unknown>;
  lastAuthHeader: string;
  /** Full request path including query string (e.g. "/v1/messages?beta=true"). Replayed by pings. */
  lastPath: string;
  /** All request headers from the last real request. Replayed by pings (with overrides for content-length / accept-encoding). */
  lastHeaders: Record<string, string | string[] | undefined>;
  lastRealUsage: UsageBlock | null;
  /**
   * Cache TTL the last real request opted into (300 = 5min, 3600 = 1h).
   * Auto-detected from cache_control.ttl on the payload. Reflects what Claude
   * Code actually negotiated with Anthropic — handles subscription's auto-1h
   * default, the credit-fallback to 5min, and the api-key opt-in.
   */
  detectedTtlSeconds: number;
  /**
   * Count of successful pings fired since the last real_request. Reset to 0 on
   * upsert(). When this exceeds Config.maxConsecutivePings, scheduler pauses
   * with `pings_without_progress` — the user has likely stepped away.
   */
  pingsSinceLastReal: number;
  /**
   * Most-recent lifecycle resume (paused/abandoned → active), if any. Surfaced
   * on the dashboard so users can see "this session just came back, cache
   * survived" or "...cache was rebuilt — $0.32 paid." Persists across the
   * session's lifetime; refreshed only when another resume happens.
   */
  lastResume?: ResumeEvent;
  /** Append-only timestamped log of ping fires within the last 5h. Pruned by Registry. */
  pingHistory5h: { ts: number; costUsd: number }[];
  /** Most-recent rate-limit headers from a real_request or ping response (account-scoped). */
  lastRatelimits: RateLimits | null;
  state: SessionStateName;
  pauseReason?: PauseReason;
}

export interface BudgetCapConfig {
  max5hUtilizationFromPings: number;
  maxPingSpendUsd: {
    perDay: number;
    perMonth: number;
    warnAt: number;
  };
  maxPingsPerSession5h: number;
}

export type Plan = "subscription" | "api-key" | "enterprise";

export interface EnterpriseCapConfig {
  /** Fixed monthly $ commitment from the enterprise contract. */
  monthlyCapUsd: number;
  /** Day of month the billing cycle resets (1-28). Used by dashboard projection logic. */
  cycleStartDayOfMonth: number;
}

export interface Config {
  listen: { host: string; port: number };
  tickIntervalSeconds: number;
  /**
   * Anthropic prompt-cache TTL the user is on. 300 (5-minute default) or 3600
   * (1-hour, opt-in via ENABLE_PROMPT_CACHING_1H / auto for subscription).
   * Used as a FALLBACK when per-session auto-detection has no data; the
   * runtime path always prefers session.detectedTtlSeconds.
   */
  cacheTtlSeconds: number;
  /**
   * Safety margin in seconds: the proxy fires its ping (cacheTtlSeconds - margin)
   * after the last activity, so the ping lands BEFORE the cache expires. Floor
   * applied at 60s to avoid pathological tight loops.
   */
  pingCadenceMarginSeconds: number;
  /**
   * Abandon a session after this many TTL periods of no real_request. Default 6
   * (30 min for 5-min TTL, 6h for 1h TTL). Keeps abandonment proportional to
   * how long the cache could plausibly survive on its own.
   */
  abandonTtlMultiplier: number;
  /**
   * Ceiling on consecutive successful pings before a session is paused with
   * `pings_without_progress`. The runtime cap may be LOWER than this when the
   * observed return-rate justifies it — see `minConsecutivePings` and the
   * scheduler's effective-cap math.
   */
  maxConsecutivePings: number;
  /**
   * Floor on consecutive successful pings. The adaptive cap never drops below
   * this — guarantees a session gets at least N pings of chance to come back,
   * even when observed return-rate is low.
   */
  minConsecutivePings: number;
  /**
   * Rolling-window size (count of recent pause-outcomes) used to compute
   * observed return-rate. Larger = more stable but slower to adapt.
   */
  adaptiveCapWindow: number;
  /**
   * Anthropic pricing multipliers. Surfaced in config so users can update if
   * Anthropic changes the published rates without a code change.
   */
  pricing: {
    /** Cache-read cost as a fraction of input rate. Anthropic published: 0.1. */
    cacheReadMultiplier: number;
    /** Cache-rebuild cost as a multiple of input rate. Anthropic published (5-min cache): 1.25. */
    rebuildMultiplier: number;
  };
  /** Hours since lastRealRequestAt after which a session is removed from the in-memory map. Must exceed abandonAfterMinutes/60. */
  evictAfterHours: number;
  requireT1: boolean;
  /** When true (default on Windows), `npm start` writes ANTHROPIC_BASE_URL to the user-scope
   * registry so every future PowerShell/cmd inherits it. Set to false to opt out. */
  autoSetEnvVar: boolean;
  /** Which Anthropic plan this proxy is serving. Defaults to "api-key". */
  plan: Plan;
  /** Enterprise contract cap. Required when plan === "enterprise"; ignored otherwise. */
  enterpriseCap?: EnterpriseCapConfig;
  budgetCap: BudgetCapConfig;
  modelPricing: Record<string, { inputPerMtok: number }>;
  logPath: string;
  /** Rotate events.jsonl when it exceeds maxSizeBytes; keep maxFiles rotations. */
  logRotation: {
    maxSizeBytes: number;
    maxFiles: number;
  };
  /** Optional OpenTelemetry export. Disabled by default. When enabled, pulls @opentelemetry/* optional deps. */
  otel?: {
    enabled: boolean;
    endpoint?: string;
    serviceName?: string;
  };
  /** Per-process random 32-char lowercase hex auth token. Generated by cli.ts at startup. Empty in defaultConfig until cli sets the real value. */
  authToken: string;
}

export type EventRecord =
  | { ts: string; kind: "proxy_started"; config: Partial<Config> }
  | {
      ts: string;
      kind: "real_request";
      sessionKey: SessionKey;
      model: string;
      usage: UsageBlock;
      ratelimits: RateLimits;
      /** Optional for back-compat with logs written before TTL auto-detection. */
      cacheTtlSeconds?: number;
    }
  | {
      ts: string;
      kind: "ping_fired";
      sessionKey: SessionKey;
      model: string;
      usage: UsageBlock;
      ratelimits: RateLimits;
      costUsd: number;
    }
  | {
      ts: string;
      kind: "ping_skipped";
      sessionKey: SessionKey;
      reason: string;
    }
  | {
      ts: string;
      kind: "session_paused";
      sessionKey: SessionKey;
      reason: PauseReason;
    }
  | {
      ts: string;
      kind: "session_resumed";
      sessionKey: SessionKey;
      fromState: "paused" | "abandoned";
      gapMs: number;
      cacheOutcome: "rebuilt" | "survived" | "partial";
      rebuildCostUsd: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }
  | {
      ts: string;
      kind: "session_ttl_changed";
      sessionKey: SessionKey;
      /** TTL the session was on before this request (seconds). */
      fromTtlSeconds: number;
      /** TTL the session is now on (seconds). */
      toTtlSeconds: number;
    };
