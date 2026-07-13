// src/usage-parser.ts
import type { UsageBlock, RateLimits } from "./types.ts";

export function parseJsonResponse(body: string): UsageBlock | null {
  try {
    const parsed = JSON.parse(body) as { usage?: Partial<UsageBlock> };
    if (!parsed.usage) return null;
    return normalize(parsed.usage);
  } catch {
    return null;
  }
}

export function parseSseStream(body: string): UsageBlock | null {
  let latest: UsageBlock | null = null;
  for (const block of body.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const json = dataLine.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      const event = JSON.parse(json) as {
        type?: string;
        message?: { usage?: Partial<UsageBlock> };
        usage?: Partial<UsageBlock>;
      };
      const u = event.usage ?? event.message?.usage;
      if (u) latest = mergeUsage(latest, normalize(u));
    } catch {
      // ignore malformed event
    }
  }
  return latest;
}

export function parseRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
): RateLimits {
  const h = (k: string): string | null => {
    const v = headers[k];
    if (Array.isArray(v)) return v[0] ?? null;
    return v ?? null;
  };
  const num = (k: string): number | null => {
    const v = h(k);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const overage = h("anthropic-ratelimit-unified-overage-status");
  return {
    unified5hUtilization: num("anthropic-ratelimit-unified-5h-utilization"),
    unified7dUtilization: num("anthropic-ratelimit-unified-7d-utilization"),
    unified5hResetEpoch: num("anthropic-ratelimit-unified-5h-reset"),
    overageStatus:
      overage === "allowed" || overage === "rejected" ? overage : null,
  };
}

function normalize(u: Partial<UsageBlock>): UsageBlock {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}

function mergeUsage(a: UsageBlock | null, b: UsageBlock): UsageBlock {
  if (!a) return b;
  return {
    input_tokens: Math.max(a.input_tokens, b.input_tokens),
    output_tokens: Math.max(a.output_tokens, b.output_tokens),
    cache_creation_input_tokens: Math.max(
      a.cache_creation_input_tokens,
      b.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: Math.max(
      a.cache_read_input_tokens,
      b.cache_read_input_tokens,
    ),
  };
}
