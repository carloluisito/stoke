// src/config.ts
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.ts";
import { validateConfig } from "./config-schema.ts";

export function defaultConfig(): Config {
  return {
    listen: { host: "127.0.0.1", port: 9876 },
    tickIntervalSeconds: 10,
    cacheTtlSeconds: 300,
    pingCadenceMarginSeconds: 30,
    abandonTtlMultiplier: 6,
    maxConsecutivePings: 5,
    minConsecutivePings: 2,
    adaptiveCapWindow: 50,
    pricing: {
      cacheReadMultiplier: 0.1,
      rebuildMultiplier: 1.25,
    },
    evictAfterHours: 24,
    requireT1: false,
    autoSetEnvVar: true,
    plan: "api-key",
    budgetCap: {
      max5hUtilizationFromPings: 0.01,
      maxPingSpendUsd: { perDay: 20, perMonth: 300, warnAt: 0.5 },
      maxPingsPerSession5h: 20,
    },
    modelPricing: {
      "claude-fable-5": { inputPerMtok: 10.0 },
      "claude-opus-4-8": { inputPerMtok: 5.0 },
      "claude-opus-4-7": { inputPerMtok: 5.0 },
      "claude-sonnet-4-6": { inputPerMtok: 3.0 },
      "claude-haiku-4-5": { inputPerMtok: 1.0 },
    },
    logPath: join(homedir(), ".stoke", "events.jsonl"),
    logRotation: {
      maxSizeBytes: 50 * 1024 * 1024,
      maxFiles: 5,
    },
    otel: { enabled: false },
    authToken: "",
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function mergeConfig(user: DeepPartial<Config>): Config {
  const base = defaultConfig();
  const merged = deepMerge(
    base as unknown as Record<string, unknown>,
    user as unknown as DeepPartial<Record<string, unknown>>,
  );
  // validateConfig owns structural + range checks, including the
  // evictAfterHours > abandonAfterMinutes/60 invariant.
  return validateConfig(merged);
}

function deepMerge<T extends Record<string, unknown>>(a: T, b: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...a };
  for (const key of Object.keys(b)) {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    if (bv === undefined) continue;
    if (
      av && bv &&
      typeof av === "object" && typeof bv === "object" &&
      !Array.isArray(av) && !Array.isArray(bv)
    ) {
      out[key] = deepMerge(av as Record<string, unknown>, bv as DeepPartial<Record<string, unknown>>);
    } else {
      out[key] = bv;
    }
  }
  return out as T;
}

export function configPath(): string {
  return join(homedir(), ".stoke", "config.json");
}

export function loadConfig(path?: string): Config {
  const target = path ?? configPath();
  if (!existsSync(target)) return defaultConfig();
  const raw = readFileSync(target, "utf8");
  return mergeConfig(JSON.parse(raw));
}
