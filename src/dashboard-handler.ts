// src/dashboard-handler.ts
// Serves the monitoring dashboard and its data API.
// Mounted ahead of the Anthropic forwarder in src/proxy.ts.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config, Session } from "./types.ts";
import { Registry } from "./registry.ts";
import { JsonlLogger } from "./logger.ts";
import {
  startOfDayMs,
  startOfMonthMs,
  startOfBillingCycleMs,
} from "./time-windows.ts";
import { extractProjectPath } from "./project-path.ts";
import { configPath, loadConfig } from "./config.ts";
import { validateReloadBody } from "./config-schema.ts";
import {
  computeSavingsMulti,
  computeCacheHitRate,
  compute5hSparkline,
} from "./savings.ts";
import { effectiveConsecutivePingCap } from "./scheduler.ts";
import type { EventRecord } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = join(__dirname, "..", "dashboard");

// Heuristic: ~1 rewrite avoided per 7 successful pings, based on the
// strategy doc's break-even math (cache_read 0.1× vs cache_write 1.25×;
// 7 reads roughly equal one write).
const PINGS_PER_REWRITE = 7;

/**
 * Default Anthropic prompt-cache TTL in seconds (5-minute). The runtime path
 * reads `config.cacheTtlSeconds` and passes it to `deriveCacheStatus`; this
 * constant is the back-compat default for callers that don't pass one.
 */
export const CACHE_TTL_SECONDS = 300;

/**
 * The cache-warmth view of a session. Lifecycle state (`Session.state`) tells
 * us whether the scheduler is *willing* to ping; cache status tells us whether
 * the cache is *actually warm right now*. The two diverge when something
 * external (budget cap, rate limit) blocks pings for longer than the TTL — see
 * the bug report from 2026-05-22 where a daily_spend_cap-blocked session sat
 * at "active · 16m idle · 0 pings" while its cache was long gone.
 */
export type CacheStatus = "warm" | "cold" | "paused" | "abandoned";

export function deriveCacheStatus(
  session: { state: "active" | "paused" | "abandoned"; lastSeenAt: number },
  nowMs: number,
  ttlSec: number = CACHE_TTL_SECONDS,
): CacheStatus {
  if (session.state === "paused") return "paused";
  if (session.state === "abandoned") return "abandoned";
  const idleSec = Math.max(0, (nowMs - session.lastSeenAt) / 1000);
  return idleSec < ttlSec ? "warm" : "cold";
}

export interface DashboardDeps {
  registry: Registry;
  logger: JsonlLogger;
  config: Config;
  startedAt: number;
  /** Package version, read from package.json at startup; surfaced via /api/health. */
  version?: string;
  /** Called when /api/reload succeeds; receives the new Config object. */
  onReload?: (next: Config) => void;
}

/**
 * Try to handle a request as a dashboard route.
 * Returns true if handled (response sent), false otherwise.
 */
export function tryHandleDashboard(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardDeps,
): boolean {
  const url = req.url ?? "";
  const pathOnly = url.split("?")[0];

  // /api/health is the only route that bypasses the auth gate. It returns
  // minimal liveness info and intentionally leaks no session metadata.
  if (req.method === "GET" && pathOnly === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      version: deps.version ?? "unknown",
      ts: new Date().toISOString(),
    });
    return true;
  }

  const isGuarded =
    pathOnly === "/dashboard" ||
    pathOnly.startsWith("/dashboard/") ||
    pathOnly.startsWith("/api/");
  if (isGuarded) {
    if (!requireToken(req, deps.config.authToken)) {
      sendJson(res, 401, { ok: false, error: "auth required" });
      return true;
    }
  }

  if (req.method === "GET" && pathOnly === "/api/state") {
    sendJson(res, 200, buildState(deps));
    return true;
  }
  if (req.method === "GET" && pathOnly === "/api/stream") {
    handleStream(req, res, deps);
    return true;
  }
  if (req.method === "POST" && pathOnly === "/api/reload") {
    handleReload(req, res, deps);
    return true;
  }
  if (req.method === "GET" && (pathOnly === "/dashboard" || pathOnly === "/dashboard/")) {
    serveStatic(res, "index.html", deps.config.authToken);
    return true;
  }
  if (req.method === "GET" && pathOnly.startsWith("/dashboard/")) {
    const file = pathOnly.slice("/dashboard/".length);
    serveStatic(res, file, deps.config.authToken);
    return true;
  }
  return false;
}

const HEX32 = 32;
function requireToken(req: IncomingMessage, expected: string): boolean {
  if (!expected || expected.length !== HEX32) return false;

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const presented = auth.slice("Bearer ".length);
    if (constantTimeEq(presented, expected)) return true;
  }

  const url = req.url ?? "";
  const qIndex = url.indexOf("?");
  if (qIndex !== -1) {
    const pathOnly = url.slice(0, qIndex);
    const queryAllowed = pathOnly === "/dashboard" || pathOnly === "/api/stream";
    if (queryAllowed) {
      const params = new URLSearchParams(url.slice(qIndex + 1));
      const presented = params.get("token") ?? "";
      if (constantTimeEq(presented, expected)) return true;
    }
  }
  return false;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// ===== state construction ============================================

function buildState(deps: DashboardDeps): Record<string, unknown> {
  const now = new Date();
  const nowMs = now.getTime();
  const sessions = deps.registry.all();

  const dayStartMs = startOfDayMs(now);
  const monthStartMs =
    deps.config.plan === "enterprise" && deps.config.enterpriseCap
      ? startOfBillingCycleMs(deps.config.enterpriseCap.cycleStartDayOfMonth, now)
      : startOfMonthMs(now);

  const dayStats = deps.logger.statsSinceMs(dayStartMs);
  const monthStats = deps.logger.statsSinceMs(monthStartMs);

  // Read events once and reuse for savings, cache-health, sparkline, and
  // per-session all-time aggregates. One pass produces all three savings
  // windows (today / month / all-time) instead of three independent walks.
  const events = deps.logger.snapshot();
  const [savingsToday, savingsMonth, savingsAllTime] = computeSavingsMulti(
    events,
    deps.config,
    [
      { fromMs: dayStartMs, toMs: nowMs },
      { fromMs: monthStartMs, toMs: nowMs },
      { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER },
    ],
  );
  const sparklineBuckets = compute5hSparkline(events, deps.config, nowMs);
  const hitRate = computeCacheHitRate(events, dayStartMs, nowMs);
  const resumesToday = computeResumesInWindow(events, dayStartMs, nowMs);

  const sparklineTotalUsd = sparklineBuckets.reduce(
    (acc, b) => acc + b.savedUsd,
    0,
  );
  const sparklinePingSpendUsd = sparklineBuckets.reduce(
    (acc, b) => acc + b.pingSpendUsd,
    0,
  );

  const enterprise = buildEnterpriseCap(
    deps.config,
    monthStartMs,
    monthStats.totalPingSpendUsd,
    nowMs,
  );

  // Adaptive cap math: surface the live observed return-rate and the
  // effective ping cap derived from it. Lets users see whether their
  // current cap is at the ceiling (lots of users return), floor (most
  // walk away), or somewhere in between.
  const adaptiveWindow = deps.config.adaptiveCapWindow;
  const observedReturnRate = deps.registry.observedReturnRate(adaptiveWindow);
  const observedPauseCount = deps.registry.pauseOutcomeCount(adaptiveWindow);
  const effectiveCap = effectiveConsecutivePingCap(
    observedReturnRate,
    deps.config.pricing.cacheReadMultiplier,
    deps.config.pricing.rebuildMultiplier,
    deps.config.minConsecutivePings,
    deps.config.maxConsecutivePings,
  );

  return {
    now: now.toISOString(),
    uptimeSeconds: Math.floor((nowMs - deps.startedAt) / 1000),
    plan: deps.config.plan,
    enterpriseCap: enterprise,
    ratelimits: latestRatelimits(sessions),
    budget: {
      dailyCapUsd: deps.config.budgetCap.maxPingSpendUsd.perDay,
      monthlyCapUsd: deps.config.budgetCap.maxPingSpendUsd.perMonth,
      spentToday: dayStats.totalPingSpendUsd,
      spentMonth: monthStats.totalPingSpendUsd,
    },
    spendWindows: {
      today: {
        pingsFired: dayStats.pingsFired,
        totalUsd: dayStats.totalPingSpendUsd,
        windowStart: new Date(dayStartMs).toISOString(),
      },
      month: {
        pingsFired: monthStats.pingsFired,
        totalUsd: monthStats.totalPingSpendUsd,
        windowStart: new Date(monthStartMs).toISOString(),
      },
    },
    totals: buildTotals(sessions, dayStats.pingsFired, deps.logger, nowMs, deps.config.cacheTtlSeconds),
    savings: {
      today: {
        savedUsd: round(savingsToday.savedUsd, 2),
        pingSpendUsd: round(savingsToday.pingSpendUsd, 2),
        netSavedUsd: round(savingsToday.netSavedUsd, 2),
        rebuildsAvoided: savingsToday.rebuildsAvoided,
        roiMultiple:
          savingsToday.pingSpendUsd > 0
            ? round(savingsToday.savedUsd / savingsToday.pingSpendUsd, 1)
            : null,
      },
      month: {
        savedUsd: round(savingsMonth.savedUsd, 2),
        pingSpendUsd: round(savingsMonth.pingSpendUsd, 2),
        netSavedUsd: round(savingsMonth.netSavedUsd, 2),
        rebuildsAvoided: savingsMonth.rebuildsAvoided,
      },
      last5h: {
        savedUsd: round(sparklineTotalUsd, 2),
        pingSpendUsd: round(sparklinePingSpendUsd, 2),
        netSavedUsd: round(sparklineTotalUsd - sparklinePingSpendUsd, 2),
        buckets: sparklineBuckets,
      },
    },
    cacheHealth: {
      hitRate: hitRate.hitRate,
      realRequestsToday: hitRate.realRequests,
      cacheHitsToday: hitRate.cacheHits,
    },
    resumes: {
      today: {
        survived: resumesToday.survived,
        partial: resumesToday.partial,
        rebuilt: resumesToday.rebuilt,
        rebuildSpentUsd: round(resumesToday.rebuildSpentUsd, 2),
      },
    },
    adaptiveCap: {
      observedReturnRate: round(observedReturnRate, 3),
      observedSampleCount: observedPauseCount,
      effectiveCap,
      minConsecutivePings: deps.config.minConsecutivePings,
      maxConsecutivePings: deps.config.maxConsecutivePings,
      adaptiveCapWindow: adaptiveWindow,
    },
    sessions: sessions.map((s) =>
      serializeSession(
        s,
        nowMs,
        savingsAllTime.perSession.get(s.key) ?? 0,
        deps.registry,
        deps.config.cacheTtlSeconds,
      ),
    ),
    recentEvents: tailEvents(events, 30, deps.registry),
  };
}

function buildEnterpriseCap(
  config: Config,
  cycleStartMs: number,
  spentThisCycleUsd: number,
  nowMs: number,
): Record<string, unknown> | undefined {
  if (config.plan !== "enterprise" || !config.enterpriseCap) return undefined;

  const elapsedMs = Math.max(1, nowMs - cycleStartMs);
  // Project end-of-cycle ~30 days later for a calendar-month cycle.
  const cycleLengthMs = 30 * 24 * 60 * 60 * 1000;
  const projectedEndOfCycleUsd = (spentThisCycleUsd / elapsedMs) * cycleLengthMs;
  const cycleResetDate = new Date(cycleStartMs + cycleLengthMs).toISOString().slice(0, 10);

  return {
    monthlyCapUsd: config.enterpriseCap.monthlyCapUsd,
    cycleStartDayOfMonth: config.enterpriseCap.cycleStartDayOfMonth,
    spentThisCycleUsd,
    cycleResetDate,
    projectedEndOfCycleUsd: round(projectedEndOfCycleUsd, 2),
    pauseThreshold: 0.95,
  };
}

/**
 * Lifecycle counts (sessionsActive/Paused/Abandoned) match `Session.state`
 * for backward compat. `sessionsCold` is a derived subset: it counts the
 * active sessions whose cache has expired (idle > TTL). The renderer
 * computes warm = sessionsActive - sessionsCold.
 */
/**
 * Aggregate `session_resumed` events in [fromMs, toMs]. Split between
 * "survived" (proxy succeeded — cache outlasted the pause/abandon) and
 * "rebuilt" (proxy failed — user paid the rebuild cost on resume).
 */
export function computeResumesInWindow(
  events: readonly EventRecord[],
  fromMs: number,
  toMs: number,
): {
  survived: number;
  partial: number;
  rebuilt: number;
  rebuildSpentUsd: number;
} {
  let survived = 0;
  let partial = 0;
  let rebuilt = 0;
  let rebuildSpentUsd = 0;
  for (const ev of events) {
    if (ev.kind !== "session_resumed") continue;
    const ts = Date.parse(ev.ts);
    if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
    if (ev.cacheOutcome === "survived") survived += 1;
    else if (ev.cacheOutcome === "partial") {
      partial += 1;
      rebuildSpentUsd += ev.rebuildCostUsd;
    } else {
      rebuilt += 1;
      rebuildSpentUsd += ev.rebuildCostUsd;
    }
  }
  return { survived, partial, rebuilt, rebuildSpentUsd };
}

export function buildSessionStateTotals(
  sessions: Session[],
  nowMs: number,
  defaultTtlSec: number = CACHE_TTL_SECONDS,
): {
  sessionsActive: number;
  sessionsCold: number;
  sessionsPaused: number;
  sessionsAbandoned: number;
} {
  let active = 0, cold = 0, paused = 0, abandoned = 0;
  for (const s of sessions) {
    // Per-session TTL drives cache-warmth. Falls back to the config-wide
    // default only if detection hasn't run for this session yet.
    const ttlSec = s.detectedTtlSeconds || defaultTtlSec;
    if (s.state === "active") {
      active += 1;
      if (deriveCacheStatus(s, nowMs, ttlSec) === "cold") cold += 1;
    } else if (s.state === "paused") {
      paused += 1;
    } else if (s.state === "abandoned") {
      abandoned += 1;
    }
  }
  return { sessionsActive: active, sessionsCold: cold, sessionsPaused: paused, sessionsAbandoned: abandoned };
}

function buildTotals(
  sessions: Session[],
  pingsToday: number,
  logger: JsonlLogger,
  nowMs: number,
  ttlSec: number = CACHE_TTL_SECONDS,
): Record<string, unknown> {
  const summary = logger.summary();
  return {
    realRequestsToday: summary.realRequests, // lifetime; replace with windowed read if needed
    pingsToday,
    ...buildSessionStateTotals(sessions, nowMs, ttlSec),
  };
}

export function serializeSession(
  s: Session,
  nowMs: number,
  savedUsdAllTime: number,
  registry: Registry,
  defaultTtlSec: number = CACHE_TTL_SECONDS,
): Record<string, unknown> {
  const window = registry.pingStatsInWindow(s.key, nowMs);
  const effectiveTtlSec = s.detectedTtlSeconds || defaultTtlSec;
  return {
    key: s.key,
    projectPath: extractProjectPath(s.lastPayload) ?? "unknown",
    model: s.model,
    prefixTokensEstimate: s.prefixTokensEstimate,
    lastRealRequestAt: new Date(s.lastRealRequestAt).toISOString(),
    lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    idleSec: Math.max(0, Math.floor((nowMs - s.lastSeenAt) / 1000)),
    lastSeenSec: Math.max(0, Math.floor((nowMs - s.lastSeenAt) / 1000)),
    state: s.state,
    cacheStatus: deriveCacheStatus(s, nowMs, effectiveTtlSec),
    pauseReason: s.pauseReason ?? null,
    detectedTtlSeconds: effectiveTtlSec,
    pingCount5h: window.count,
    pingCostUsd5h: round(window.costUsd, 4),
    savedUsdAllTime: round(savedUsdAllTime, 2),
    savedRewrites: Math.floor(window.count / PINGS_PER_REWRITE),
    authScheme: s.lastAuthHeader ? "bearer" : "api-key",
    lastResume: s.lastResume
      ? {
          tsIso: new Date(s.lastResume.ts).toISOString(),
          ageSec: Math.max(0, Math.floor((nowMs - s.lastResume.ts) / 1000)),
          fromState: s.lastResume.fromState,
          gapSec: Math.round(s.lastResume.gapMs / 1000),
          cacheOutcome: s.lastResume.cacheOutcome,
          rebuildCostUsd: round(s.lastResume.rebuildCostUsd, 4),
        }
      : null,
  };
}

export function latestRatelimits(sessions: Session[]): {
  unified5hUtilization: number | null;
  unified7dUtilization: number | null;
} {
  let chosen: Session | null = null;
  for (const s of sessions) {
    if (!s.lastRatelimits) continue;
    if (!chosen || s.lastSeenAt > chosen.lastSeenAt) chosen = s;
  }
  if (!chosen || !chosen.lastRatelimits) {
    return { unified5hUtilization: null, unified7dUtilization: null };
  }
  return {
    unified5hUtilization: chosen.lastRatelimits.unified5hUtilization,
    unified7dUtilization: chosen.lastRatelimits.unified7dUtilization,
  };
}

function tailEvents(events: readonly EventRecord[], n: number, registry: Registry): unknown[] {
  // Take the last `n` events from the already-parsed list and enrich them
  // with the shape the dashboard renderer expects: flat `tokensIn`/`tokensOut`
  // (from `usage.input_tokens`/`output_tokens`) and `projectPath` from the
  // session lookup. The raw EventRecord keeps the canonical structure; this
  // is a view layer.
  const tail = events.slice(-n);

  // Build a session-key → projectPath lookup once.
  const projectByKey = new Map<string, string>();
  for (const s of registry.all()) {
    const p = extractProjectPath(s.lastPayload);
    if (p) projectByKey.set(s.key, p);
  }

  const out: unknown[] = [];
  for (const ev of tail) {
    const enriched: Record<string, unknown> = { ...(ev as unknown as Record<string, unknown>) };
    const usage = (ev as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    if (usage) {
      if (typeof usage.input_tokens === "number") enriched.tokensIn = usage.input_tokens;
      if (typeof usage.output_tokens === "number") enriched.tokensOut = usage.output_tokens;
    }
    const key = typeof (ev as { sessionKey?: unknown }).sessionKey === "string"
      ? (ev as { sessionKey: string }).sessionKey
      : "";
    if (key && projectByKey.has(key)) {
      enriched.projectPath = projectByKey.get(key);
    }
    out.push(enriched);
  }
  // Dashboard expects newest first.
  return out.reverse();
}

// ===== /api/stream (Server-Sent Events) ==============================
//
// On connect: send an initial `snapshot` event. After that, every time the
// JsonlLogger receives a write, we re-emit both the raw `log` event and a
// fresh `snapshot`. A 15s heartbeat keeps the connection alive when the
// proxy is idle (no real requests, no pings firing).

const HEARTBEAT_MS = 15_000;
const SNAPSHOT_DEBOUNCE_MS = 500;

function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardDeps,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, must-revalidate",
    connection: "keep-alive",
    "x-accel-buffering": "no", // disable proxy buffering if anything upstream looks at this
  });

  // Disable Nagle so small SSE writes (especially debounced snapshots after
  // an idle gap) ship immediately instead of being held in the TCP send buffer.
  if (res.socket) res.socket.setNoDelay(true);

  const sendEvent = (event: string, data: unknown): void => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Connection closed mid-write; cleanup happens via 'close' handler.
    }
  };

  // Send the initial snapshot immediately so the dashboard renders without
  // waiting for the first proxy event.
  sendEvent("snapshot", buildState(deps));

  // Push raw events immediately; coalesce snapshot rebuilds at SNAPSHOT_DEBOUNCE_MS
  // so a burst of writes costs one buildState, not N.
  let pendingSnapshot: NodeJS.Timeout | null = null;
  const unsubscribe = deps.logger.subscribe((rawEvent) => {
    sendEvent("log", rawEvent);
    if (pendingSnapshot) return;
    pendingSnapshot = setTimeout(() => {
      pendingSnapshot = null;
      sendEvent("snapshot", buildState(deps));
    }, SNAPSHOT_DEBOUNCE_MS);
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      // Ignored — close handler below will clean up.
    }
  }, HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    if (pendingSnapshot) {
      clearTimeout(pendingSnapshot);
      pendingSnapshot = null;
    }
    unsubscribe();
    try { res.end(); } catch { /* already ended */ }
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
}

// ===== /api/reload ===================================================

function handleReload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardDeps,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const bodyStr = Buffer.concat(chunks).toString("utf8");
    try {
      if (bodyStr.trim().length > 0) {
        // Validate the incoming body BEFORE touching disk. Unknown keys,
        // wrong types, and out-of-range numbers all reject at this gate.
        const incoming = validateReloadBody(JSON.parse(bodyStr));
        const targetPath = configPath();
        let existing: Record<string, unknown> = {};
        if (existsSync(targetPath)) {
          try {
            existing = JSON.parse(readFileSync(targetPath, "utf8"));
          } catch {
            existing = {};
          }
        }
        const merged = { ...existing, ...incoming };
        // Ensure ~/.stoke/ exists. Fresh installs (proxy ran but config dir
        // was wiped) hit this path before any other component creates the dir.
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(merged, null, 2));
      }
      const next = loadConfig();
      if (deps.onReload) deps.onReload(next);
      sendJson(res, 200, { ok: true, plan: next.plan });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: (err as Error).message });
    }
  });
  req.on("error", () => sendJson(res, 500, { ok: false, error: "request stream error" }));
}

// ===== static file serving ===========================================

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".jsx":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(res: ServerResponse, file: string, authToken: string): void {
  // Prevent path traversal: the resolved file MUST live inside DASHBOARD_DIR.
  const resolved = normalize(join(DASHBOARD_DIR, file));
  if (!resolved.startsWith(DASHBOARD_DIR + sep) && resolved !== DASHBOARD_DIR) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!existsSync(resolved)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = resolved.slice(resolved.lastIndexOf("."));
  const contentType = MIME[ext] ?? "application/octet-stream";
  let content: Buffer | string = readFileSync(resolved);
  if (ext === ".html") {
    content = content.toString("utf8").replace("__TOKEN_PLACEHOLDER__", authToken);
  }
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  });
  res.end(content);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  });
  res.end(text);
}

function round(n: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(n * m) / m;
}
