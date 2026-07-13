// src/proxy.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import type { Config } from "./types.ts";
import { Registry } from "./registry.ts";
import { JsonlLogger } from "./logger.ts";
import {
  parseJsonResponse,
  parseSseStream,
  parseRateLimitHeaders,
} from "./usage-parser.ts";
import { tryHandleStats, type StatsDeps } from "./stats-handler.ts";
import { shouldTrackSession } from "./session-filter.ts";
import type { OtelHandle } from "./otel.ts";

function decodeResponseBody(chunks: Buffer[], contentEncoding: string | undefined): string {
  const raw = Buffer.concat(chunks);
  const enc = (contentEncoding ?? "").toLowerCase();
  try {
    if (enc === "gzip") return gunzipSync(raw).toString("utf8");
    if (enc === "deflate") return inflateSync(raw).toString("utf8");
    if (enc === "br") return brotliDecompressSync(raw).toString("utf8");
  } catch {
    // fall through to raw decode
  }
  return raw.toString("utf8");
}

const UPSTREAM_DEFAULT = "https://api.anthropic.com";

export interface ProxyDeps {
  registry: Registry;
  logger: JsonlLogger;
  config: Config;
  upstreamUrl?: string;
  /** When set, stats routes (/api/health, /_stoke/stats) are served from this proxy. */
  stats?: Omit<StatsDeps, "registry" | "logger" | "config">;
  /** Optional OpenTelemetry handle. When null/undefined, no telemetry. */
  otel?: OtelHandle | null;
}

export function createProxyServer(deps: ProxyDeps): Server {
  const upstream = new URL(deps.upstreamUrl ?? UPSTREAM_DEFAULT);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Stats routes are plain GETs — handle before buffering the body, since
    // they don't need request body parsing the way Anthropic forwarding does.
    if (deps.stats && tryHandleStats(req, res, {
      ...deps.stats,
      registry: deps.registry,
      logger: deps.logger,
      config: deps.config,
    })) {
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handleRequest(req, res, Buffer.concat(chunks), upstream, deps));
    req.on("error", () => {
      res.writeHead(502);
      res.end();
    });
  });
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  upstream: URL,
  deps: ProxyDeps,
): void {
  const url = req.url ?? "";
  const pathOnly = url.split("?")[0];

  // Only register sessions for the main /v1/messages endpoint (and its query-string
  // variants like /v1/messages?beta=true). Skip subpaths like /v1/messages/count_tokens —
  // those don't accept the max_tokens:0 ping shape and would 404.
  const isMessagesPath = pathOnly === "/v1/messages";

  let parsedBody: Record<string, unknown> | null = null;
  if (req.method === "POST" && isMessagesPath) {
    try {
      parsedBody = JSON.parse(body.toString("utf8"));
    } catch {
      // forward anyway; non-JSON request still needs to pass through.
    }
  }

  // Accept either OAuth Bearer (subscription / Claude Code default) or x-api-key
  // (API-key plan users). Either one indicates an authenticated session worth tracking.
  const authorizationHeader =
    typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const apiKeyHeader =
    typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";
  const hasAuth = authorizationHeader !== "" || apiKeyHeader !== "";

  let sessionKey: string | null = null;
  let upsertResult: ReturnType<typeof deps.registry.upsert> | null = null;
  if (parsedBody && hasAuth && shouldTrackSession(req.headers, parsedBody)) {
    // lastAuthHeader stores the Bearer value (empty for API-key users; in that case
    // the fetcher relies on x-api-key being preserved via lastHeaders).
    upsertResult = deps.registry.upsert(
      parsedBody,
      authorizationHeader,
      Date.now(),
      url,
      req.headers,
    );
    sessionKey = upsertResult.key;
  }

  const isHttps = upstream.protocol === "https:";
  const requester = isHttps ? httpsRequest : httpRequest;
  const upstreamReq = requester(
    {
      host: upstream.hostname,
      port: upstream.port || (isHttps ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: upstream.hostname },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      const responseChunks: Buffer[] = [];
      upstreamRes.on("data", (c: Buffer) => {
        responseChunks.push(c);
        res.write(c);
      });
      upstreamRes.on("end", () => {
        res.end();
        if (sessionKey) {
          const contentEncoding = upstreamRes.headers["content-encoding"];
          const responseBody = decodeResponseBody(
            responseChunks,
            Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding,
          );
          const ratelimits = parseRateLimitHeaders(upstreamRes.headers);
          const usage =
            parseSseStream(responseBody) ?? parseJsonResponse(responseBody);
          if (usage) {
            deps.registry.recordRealUsage(sessionKey, usage, ratelimits);
            const session = deps.registry.get(sessionKey);
            const tsIso = new Date().toISOString();
            deps.logger.write({
              ts: tsIso,
              kind: "real_request",
              sessionKey,
              model: session?.model ?? "unknown",
              usage,
              ratelimits,
              cacheTtlSeconds: session?.detectedTtlSeconds ?? 300,
            });
            deps.otel?.incrementCounter?.("cache_keepalive.real_requests_total", 1, {
              model: session?.model ?? "unknown",
            });

            // TTL-change detection: if the session existed before this upsert
            // AND the wire format's cache_control.ttl just changed (e.g., user
            // hit plan limit and Claude Code dropped from "1h" to default 5min),
            // surface that in the event feed so the user can SEE the change.
            if (
              upsertResult &&
              upsertResult.previousDetectedTtlSeconds !== null &&
              upsertResult.previousDetectedTtlSeconds !==
                upsertResult.currentDetectedTtlSeconds
            ) {
              deps.logger.write({
                ts: tsIso,
                kind: "session_ttl_changed",
                sessionKey,
                fromTtlSeconds: upsertResult.previousDetectedTtlSeconds,
                toTtlSeconds: upsertResult.currentDetectedTtlSeconds,
              });
              deps.otel?.incrementCounter?.(
                "cache_keepalive.session_ttl_changed_total",
                1,
                {
                  from_ttl: String(upsertResult.previousDetectedTtlSeconds),
                  to_ttl: String(upsertResult.currentDetectedTtlSeconds),
                },
              );
            }

            // Resume detection: if the session was paused/abandoned before
            // this request, emit a session_resumed event with the cache
            // outcome and the $ cost of any rebuild we couldn't prevent.
            if (
              upsertResult &&
              (upsertResult.previousState === "paused" ||
                upsertResult.previousState === "abandoned")
            ) {
              const model = session?.model ?? "unknown";
              const inputPerMtok = deps.config.modelPricing[model]?.inputPerMtok ?? 0;
              const cacheCreationTokens = usage.cache_creation_input_tokens;
              const cacheReadTokens = usage.cache_read_input_tokens;
              // Three-way classification — see ResumeEvent.cacheOutcome docs.
              // Anthropic supports incremental cache growth: a turn that hits
              // the cache (cache_read > 0) AND writes a few new tokens
              // (cache_creation > 0) is NOT a rebuild — it's a partial cache
              // hit. Only cache_read == 0 indicates a real rebuild we failed
              // to prevent.
              let cacheOutcome: "survived" | "partial" | "rebuilt";
              if (cacheCreationTokens === 0) {
                cacheOutcome = "survived";
              } else if (cacheReadTokens > 0) {
                cacheOutcome = "partial";
              } else {
                cacheOutcome = "rebuilt";
              }
              const rebuildCostUsd =
                (cacheCreationTokens * inputPerMtok *
                  deps.config.pricing.rebuildMultiplier) /
                1e6;
              deps.registry.recordResume(sessionKey, {
                ts: Date.parse(tsIso),
                fromState: upsertResult.previousState,
                gapMs: upsertResult.gapMs,
                cacheOutcome,
                rebuildCostUsd,
                cacheReadTokens,
                cacheCreationTokens,
              });
              deps.logger.write({
                ts: tsIso,
                kind: "session_resumed",
                sessionKey,
                fromState: upsertResult.previousState,
                gapMs: upsertResult.gapMs,
                cacheOutcome,
                rebuildCostUsd,
                cacheReadTokens,
                cacheCreationTokens,
              });
              deps.otel?.incrementCounter?.(
                "cache_keepalive.session_resumed_total",
                1,
                { outcome: cacheOutcome, from_state: upsertResult.previousState },
              );
            }
          }
        }
      });
    },
  );
  upstreamReq.on("error", (err: Error) => {
    res.writeHead(502);
    res.end(`proxy error: ${err.message}`);
  });
  upstreamReq.write(body);
  upstreamReq.end();
}
