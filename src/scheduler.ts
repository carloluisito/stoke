// src/scheduler.ts
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import type {
  Config,
  PauseReason,
  RateLimits,
  Session,
  UsageBlock,
} from "./types.ts";
import { Registry } from "./registry.ts";
import { JsonlLogger } from "./logger.ts";
import { BudgetGuard } from "./budget.ts";
import { computePingCostUsd } from "./pricing.ts";
import {
  parseJsonResponse,
  parseRateLimitHeaders,
} from "./usage-parser.ts";
import type { OtelHandle } from "./otel.ts";

/**
 * Effective cadence (ms) for a session: ping (detectedTtlSeconds - margin)
 * after the last activity. Detection runs on every upsert; if it has no data
 * for this session yet, fall back to config.cacheTtlSeconds. Floor at 60s to
 * avoid pathological tight loops on misconfigured TTL.
 *
 * Pure function — no I/O, safe to test exhaustively.
 */
export function effectiveCadenceMs(session: Session, config: Config): number {
  const ttlSec = session.detectedTtlSeconds || config.cacheTtlSeconds;
  return Math.max(60, ttlSec - config.pingCadenceMarginSeconds) * 1000;
}

/**
 * Effective abandon threshold (ms): drop a session after N TTL periods of no
 * real_request. Scales naturally — 5-min TTL × 6 = 30 min, 1h TTL × 6 = 6h.
 *
 * Pure function — no I/O, safe to test exhaustively.
 */
export function effectiveAbandonMs(session: Session, config: Config): number {
  const ttlSec = session.detectedTtlSeconds || config.cacheTtlSeconds;
  return ttlSec * config.abandonTtlMultiplier * 1000;
}

export interface PingResponse {
  status: number;
  usage: UsageBlock | null;
  ratelimits: RateLimits;
  /** Truncated response body, captured only on non-2xx for diagnostics. */
  errorBody?: string;
}

export type PingAction =
  | { kind: "success" }
  | { kind: "pause"; reason: PauseReason }
  | { kind: "retry_transient"; logReason: string };

/**
 * Adaptive cap on consecutive pings, derived from the live observed
 * return-rate and the configured pricing multipliers. The math: each
 * rebuild prevented is worth `rebuildMultiplier / cacheReadMultiplier`
 * pings (12.5× with default constants). At the observed return rate
 * `p`, breaking even requires `cap × cacheReadMultiplier <= rebuildMultiplier × p`.
 * The result is clamped between `minConsecutivePings` and `maxConsecutivePings`.
 *
 * Pure function — no I/O, safe to test exhaustively.
 */
export function effectiveConsecutivePingCap(
  observedReturnRate: number,
  cacheReadMultiplier: number,
  rebuildMultiplier: number,
  minConsecutivePings: number,
  maxConsecutivePings: number,
): number {
  const ratio = rebuildMultiplier / cacheReadMultiplier;
  const derived = Math.floor(ratio * observedReturnRate);
  return Math.max(minConsecutivePings, Math.min(maxConsecutivePings, derived));
}

/**
 * Pure classifier — maps a PingResponse to the action the scheduler should take.
 * No side effects; safe to test exhaustively.
 */
export function classifyPingResponse(response: PingResponse): PingAction {
  const { status, usage } = response;
  if (status >= 200 && status < 300) {
    if (!usage) return { kind: "pause", reason: "malformed_response" };
    if (usage.cache_read_input_tokens > 0) return { kind: "success" };
    return { kind: "pause", reason: "cache_miss" };
  }
  if (status === 401 || status === 403) {
    return { kind: "pause", reason: "auth_error" };
  }
  if (status >= 500) {
    return { kind: "pause", reason: "upstream_5xx_repeat" };
  }
  if (status >= 400) {
    return { kind: "pause", reason: "upstream_5xx_repeat" };
  }
  return { kind: "retry_transient", logReason: "network_error" };
}

export type PingFetcher = (
  payload: Record<string, unknown>,
  authHeader: string,
  path?: string,
  headers?: Record<string, string | string[] | undefined>,
) => Promise<PingResponse>;

export interface TickInputs {
  registry: Registry;
  logger: JsonlLogger;
  config: Config;
  guard: BudgetGuard;
  fetcher: PingFetcher;
  nowMs: number;
  spendUsdToday: number;
  spendUsdMonth: number;
  pingsToday: number;
  otel?: OtelHandle | null;
}

export async function runSchedulerTick(inputs: TickInputs): Promise<void> {
  // Per-session abandonment: each session's threshold is detectedTtl × multiplier.
  // A 5-min TTL session abandons after 30 min idle; a 1h TTL session after 6h.
  inputs.registry.abandonStale(inputs.nowMs, (s) =>
    effectiveAbandonMs(s, inputs.config),
  );

  // Per-session cadence: only sessions idle longer than their effective cadence
  // are eligible to ping. detectedTtlSeconds drives this; the config knob
  // pingCadenceMarginSeconds is the safety margin before TTL expiry.
  const active = inputs.registry.activeSessionsBy(
    inputs.nowMs,
    (s) => effectiveCadenceMs(s, inputs.config),
  );
  if (active.length === 0) return;

  // Pick the LONGEST-LIVED active session as the ping target. Subagents are
  // inherently short-lived (seconds to a few minutes), so they never
  // out-rank the user's persistent main session — even if a subagent's
  // lastRealRequestAt is more recent. This keeps the main cache warm
  // during coffee/alt-tab breaks regardless of which model it uses.
  const target = active.reduce((longest, s) =>
    s.firstRealRequestAt < longest.firstRealRequestAt ? s : longest,
  );

  // Early-exit: if we've already fired N consecutive successful pings since
  // the last real_request, the user has likely stepped away. The cap is
  // ADAPTIVE — it shrinks when observed return-rate is low (most idle users
  // don't come back) and rises toward `maxConsecutivePings` when they do.
  // A real_request resets `pingsSinceLastReal` (via Registry.upsert) and
  // un-pauses the session.
  const cap = effectiveConsecutivePingCap(
    inputs.registry.observedReturnRate(inputs.config.adaptiveCapWindow),
    inputs.config.pricing.cacheReadMultiplier,
    inputs.config.pricing.rebuildMultiplier,
    inputs.config.minConsecutivePings,
    inputs.config.maxConsecutivePings,
  );
  if (target.pingsSinceLastReal >= cap) {
    inputs.registry.pause(target.key, "pings_without_progress");
    inputs.logger.write({
      ts: new Date(inputs.nowMs).toISOString(),
      kind: "session_paused",
      sessionKey: target.key,
      reason: "pings_without_progress",
    });
    return;
  }

  const windowStats = inputs.registry.pingStatsInWindow(target.key, inputs.nowMs);
  const decision = inputs.guard.shouldPause(target, {
    lastRatelimits: target.lastRatelimits,
    pingCountInWindow: windowStats.count,
    pingsToday: inputs.pingsToday,
    spendUsdToday: inputs.spendUsdToday,
    spendUsdMonth: inputs.spendUsdMonth,
  });
  if (decision.pause) {
    inputs.logger.write({
      ts: new Date(inputs.nowMs).toISOString(),
      kind: "ping_skipped",
      sessionKey: target.key,
      reason: decision.reason ?? "unknown",
    });
    return;
  }
  await firePing(target, inputs);
}

async function firePing(session: Session, inputs: TickInputs): Promise<void> {
  const pingPayload: Record<string, unknown> = {
    ...session.lastPayload,
    max_tokens: 0,
    stream: false,
  };
  const response = await inputs.fetcher(
    pingPayload,
    session.lastAuthHeader,
    session.lastPath,
    session.lastHeaders,
  );
  const action = classifyPingResponse(response);
  const tsIso = new Date(inputs.nowMs).toISOString();

  switch (action.kind) {
    case "success": {
      const usage = response.usage!;
      const costUsd = computePingCostUsd(session.model, usage, inputs.config);
      inputs.registry.recordPingResult(
        session.key,
        true,
        usage,
        costUsd,
        inputs.nowMs,
        response.ratelimits,
      );
      inputs.logger.write({
        ts: tsIso,
        kind: "ping_fired",
        sessionKey: session.key,
        model: session.model,
        usage,
        ratelimits: response.ratelimits,
        costUsd,
      });
      inputs.otel?.incrementCounter?.("cache_keepalive.pings_fired_total", 1, { model: session.model });
      return;
    }
    case "pause": {
      // cache_miss still represents a fired ping that consumed quota; record cost.
      // Other pause reasons (auth_error, upstream_5xx_repeat, malformed_response)
      // either didn't consume metered quota or we can't determine cost without usage.
      if (action.reason === "cache_miss" && response.usage) {
        const costUsd = computePingCostUsd(session.model, response.usage, inputs.config);
        inputs.registry.recordPingResult(
          session.key,
          false,
          response.usage,
          costUsd,
          inputs.nowMs,
          response.ratelimits,
        );
        inputs.logger.write({
          ts: tsIso,
          kind: "ping_fired",
          sessionKey: session.key,
          model: session.model,
          usage: response.usage,
          ratelimits: response.ratelimits,
          costUsd,
        });
      }
      inputs.registry.pause(session.key, action.reason);
      inputs.logger.write({
        ts: tsIso,
        kind: "session_paused",
        sessionKey: session.key,
        reason: action.reason,
      });
      inputs.otel?.incrementCounter?.("cache_keepalive.pings_skipped_total", 1, { reason: action.reason });
      return;
    }
    case "retry_transient": {
      const errSnippet = response.errorBody
        ? ` body=${response.errorBody.slice(0, 300).replace(/\s+/g, " ")}`
        : "";
      inputs.logger.write({
        ts: tsIso,
        kind: "ping_skipped",
        sessionKey: session.key,
        reason: `${action.logReason}${errSnippet}`,
      });
      return;
    }
  }
}

// Headers we always control ourselves on a ping; remove any inherited value.
const PING_OVERRIDE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "accept-encoding",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

export function makeHttpFetcher(upstreamUrl: string): PingFetcher {
  const upstream = new URL(upstreamUrl);
  const isHttps = upstream.protocol === "https:";
  const requester = isHttps ? httpsRequest : httpRequest;

  return (payload, authHeader, path, originalHeaders) =>
    new Promise<PingResponse>((resolve) => {
      const bodyStr = JSON.stringify(payload);
      const resolvedPath = path ?? "/v1/messages";

      // Start from the original request's headers (preserves anthropic-version,
      // anthropic-beta, x-app, user-agent, etc.) and override the few that pings
      // must control.
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(originalHeaders ?? {})) {
        if (v === undefined) continue;
        if (PING_OVERRIDE_HEADERS.has(k.toLowerCase())) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(bodyStr).toString();
      // Only set Authorization when we captured a Bearer token. For API-key plan users
      // the captured `authHeader` is empty and the `x-api-key` header is preserved
      // by the originalHeaders spread above — overwriting Authorization with "" would
      // produce a malformed header that some upstreams reject.
      if (authHeader) {
        headers["authorization"] = authHeader;
      }
      headers["accept-encoding"] = "identity";
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = "2023-06-01";
      }

      const req = requester(
        {
          host: upstream.hostname,
          port: upstream.port || (isHttps ? 443 : 80),
          method: "POST",
          path: resolvedPath,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 502;
            resolve({
              status,
              usage: parseJsonResponse(text),
              ratelimits: parseRateLimitHeaders(res.headers),
              errorBody: status >= 400 ? text.slice(0, 500) : undefined,
            });
          });
        },
      );
      req.on("error", (err: Error) =>
        resolve({
          status: 0,
          usage: null,
          ratelimits: {
            unified5hUtilization: null,
            unified7dUtilization: null,
            unified5hResetEpoch: null,
            overageStatus: null,
          },
          errorBody: err.message,
        }),
      );
      req.write(bodyStr);
      req.end();
    });
}
