// src/config-schema.ts
import type { Config, EnterpriseCapConfig, Plan } from "./types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type ReloadBody = Partial<{
  plan: Plan;
  enterpriseCap: EnterpriseCapConfig;
}>;

const ALLOWED_RELOAD_KEYS = new Set(["plan", "enterpriseCap"]);
const PLANS: ReadonlySet<Plan> = new Set<Plan>(["subscription", "api-key", "enterprise"]);
const HEX_TOKEN_RE = /^[a-f0-9]{32}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function requireNumber(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${label} must be a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireInteger(v: unknown, label: string): number {
  const n = requireNumber(v, label);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`${label} must be an integer, got ${n}`);
  }
  return n;
}

function requireBoolean(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") {
    throw new ConfigError(`${label} must be boolean, got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireNonEmptyString(v: unknown, label: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ConfigError(`${label} must be a non-empty string, got ${JSON.stringify(v)}`);
  }
  return v;
}

export function validateEnterpriseCap(raw: unknown): EnterpriseCapConfig {
  if (!isObject(raw)) throw new ConfigError("enterpriseCap must be an object");
  const allowed = new Set(["monthlyCapUsd", "cycleStartDayOfMonth"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new ConfigError(`enterpriseCap: unknown field ${k}`);
  }
  const monthlyCapUsd = requireNumber(raw.monthlyCapUsd, "enterpriseCap.monthlyCapUsd");
  if (monthlyCapUsd <= 0) {
    throw new ConfigError(`enterpriseCap.monthlyCapUsd must be > 0, got ${monthlyCapUsd}`);
  }
  const cycleStartDayOfMonth = requireInteger(raw.cycleStartDayOfMonth, "enterpriseCap.cycleStartDayOfMonth");
  if (cycleStartDayOfMonth < 1 || cycleStartDayOfMonth > 28) {
    throw new ConfigError(
      `enterpriseCap.cycleStartDayOfMonth must be an integer in [1, 28], got ${cycleStartDayOfMonth}`,
    );
  }
  return { monthlyCapUsd, cycleStartDayOfMonth };
}

export function validateReloadBody(raw: unknown): ReloadBody {
  if (!isObject(raw)) throw new ConfigError("body must be a JSON object");
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_RELOAD_KEYS.has(k)) throw new ConfigError(`unknown field: ${k}`);
  }
  const out: ReloadBody = {};
  if ("plan" in raw) {
    if (typeof raw.plan !== "string" || !PLANS.has(raw.plan as Plan)) {
      throw new ConfigError(
        `plan must be 'subscription' | 'api-key' | 'enterprise', got ${JSON.stringify(raw.plan)}`,
      );
    }
    out.plan = raw.plan as Plan;
  }
  if ("enterpriseCap" in raw) {
    out.enterpriseCap = validateEnterpriseCap(raw.enterpriseCap);
  }
  return out;
}

export function validateConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new ConfigError("config must be an object");

  if (!isObject(raw.listen)) throw new ConfigError("listen must be an object");
  const host = requireNonEmptyString(raw.listen.host, "listen.host");
  const port = requireInteger(raw.listen.port, "listen.port");
  if (port < 1 || port > 65535) {
    throw new ConfigError(`listen.port must be in [1, 65535], got ${port}`);
  }

  const tickIntervalSeconds = requireInteger(raw.tickIntervalSeconds, "tickIntervalSeconds");
  if (tickIntervalSeconds < 1) {
    throw new ConfigError(`tickIntervalSeconds must be >= 1, got ${tickIntervalSeconds}`);
  }
  const cacheTtlSeconds = requireInteger(raw.cacheTtlSeconds, "cacheTtlSeconds");
  if (cacheTtlSeconds < 60) {
    throw new ConfigError(`cacheTtlSeconds must be >= 60, got ${cacheTtlSeconds}`);
  }
  const pingCadenceMarginSeconds = requireInteger(raw.pingCadenceMarginSeconds, "pingCadenceMarginSeconds");
  if (pingCadenceMarginSeconds < 5 || pingCadenceMarginSeconds > 600) {
    throw new ConfigError(`pingCadenceMarginSeconds must be in [5, 600], got ${pingCadenceMarginSeconds}`);
  }
  if (pingCadenceMarginSeconds >= cacheTtlSeconds) {
    throw new ConfigError(
      `pingCadenceMarginSeconds (${pingCadenceMarginSeconds}) must be less than cacheTtlSeconds (${cacheTtlSeconds}); the ping must land before the cache expires`,
    );
  }
  const abandonTtlMultiplier = requireInteger(raw.abandonTtlMultiplier, "abandonTtlMultiplier");
  if (abandonTtlMultiplier < 2 || abandonTtlMultiplier > 100) {
    throw new ConfigError(`abandonTtlMultiplier must be in [2, 100], got ${abandonTtlMultiplier}`);
  }
  const maxConsecutivePings = requireInteger(raw.maxConsecutivePings, "maxConsecutivePings");
  if (maxConsecutivePings < 1) {
    throw new ConfigError(`maxConsecutivePings must be >= 1, got ${maxConsecutivePings}`);
  }
  const minConsecutivePings = requireInteger(raw.minConsecutivePings, "minConsecutivePings");
  if (minConsecutivePings < 1) {
    throw new ConfigError(`minConsecutivePings must be >= 1, got ${minConsecutivePings}`);
  }
  if (minConsecutivePings > maxConsecutivePings) {
    throw new ConfigError(
      `minConsecutivePings (${minConsecutivePings}) must be <= maxConsecutivePings (${maxConsecutivePings})`,
    );
  }
  const adaptiveCapWindow = requireInteger(raw.adaptiveCapWindow, "adaptiveCapWindow");
  if (adaptiveCapWindow < 1) {
    throw new ConfigError(`adaptiveCapWindow must be >= 1, got ${adaptiveCapWindow}`);
  }
  if (!isObject(raw.pricing)) throw new ConfigError("pricing must be an object");
  const cacheReadMultiplier = requireNumber(raw.pricing.cacheReadMultiplier, "pricing.cacheReadMultiplier");
  if (cacheReadMultiplier <= 0) {
    throw new ConfigError(`pricing.cacheReadMultiplier must be > 0, got ${cacheReadMultiplier}`);
  }
  const rebuildMultiplier = requireNumber(raw.pricing.rebuildMultiplier, "pricing.rebuildMultiplier");
  if (rebuildMultiplier <= 0) {
    throw new ConfigError(`pricing.rebuildMultiplier must be > 0, got ${rebuildMultiplier}`);
  }
  const evictAfterHours = requireNumber(raw.evictAfterHours, "evictAfterHours");
  if (evictAfterHours <= 0) {
    throw new ConfigError(`evictAfterHours must be > 0, got ${evictAfterHours}`);
  }
  // Eviction must outlast the worst-case abandonment threshold a session can hit
  // (the longest-TTL × multiplier combination we tolerate at runtime).
  const worstCaseAbandonHours =
    (cacheTtlSeconds * abandonTtlMultiplier) / 3600;
  if (evictAfterHours <= worstCaseAbandonHours) {
    throw new ConfigError(
      `Config invariant: evictAfterHours (${evictAfterHours}) must exceed cacheTtlSeconds × abandonTtlMultiplier in hours (${worstCaseAbandonHours.toFixed(2)}).`,
    );
  }

  const requireT1 = requireBoolean(raw.requireT1, "requireT1");
  const autoSetEnvVar = requireBoolean(raw.autoSetEnvVar, "autoSetEnvVar");

  if (typeof raw.plan !== "string" || !PLANS.has(raw.plan as Plan)) {
    throw new ConfigError(
      `plan must be 'subscription' | 'api-key' | 'enterprise', got ${JSON.stringify(raw.plan)}`,
    );
  }
  const plan = raw.plan as Plan;
  let enterpriseCap: EnterpriseCapConfig | undefined;
  if (raw.enterpriseCap !== undefined) {
    enterpriseCap = validateEnterpriseCap(raw.enterpriseCap);
  }

  if (!isObject(raw.budgetCap)) throw new ConfigError("budgetCap must be an object");
  const bc = raw.budgetCap;
  const max5h = requireNumber(bc.max5hUtilizationFromPings, "budgetCap.max5hUtilizationFromPings");
  if (max5h <= 0 || max5h > 1) {
    throw new ConfigError(`budgetCap.max5hUtilizationFromPings must be in (0, 1], got ${max5h}`);
  }
  if (!isObject(bc.maxPingSpendUsd)) throw new ConfigError("budgetCap.maxPingSpendUsd must be an object");
  const perDay = requireNumber(bc.maxPingSpendUsd.perDay, "budgetCap.maxPingSpendUsd.perDay");
  if (perDay <= 0) throw new ConfigError(`budgetCap.maxPingSpendUsd.perDay must be > 0, got ${perDay}`);
  const perMonth = requireNumber(bc.maxPingSpendUsd.perMonth, "budgetCap.maxPingSpendUsd.perMonth");
  if (perMonth <= 0) throw new ConfigError(`budgetCap.maxPingSpendUsd.perMonth must be > 0, got ${perMonth}`);
  const warnAt = requireNumber(bc.maxPingSpendUsd.warnAt, "budgetCap.maxPingSpendUsd.warnAt");
  if (warnAt < 0 || warnAt > 1) {
    throw new ConfigError(`budgetCap.maxPingSpendUsd.warnAt must be in [0, 1], got ${warnAt}`);
  }
  const maxPingsPerSession5h = requireInteger(bc.maxPingsPerSession5h, "budgetCap.maxPingsPerSession5h");
  if (maxPingsPerSession5h < 1) {
    throw new ConfigError(`budgetCap.maxPingsPerSession5h must be >= 1, got ${maxPingsPerSession5h}`);
  }

  if (!isObject(raw.modelPricing)) throw new ConfigError("modelPricing must be an object");
  const modelPricing: Record<string, { inputPerMtok: number }> = {};
  for (const [model, entry] of Object.entries(raw.modelPricing)) {
    if (!isObject(entry)) {
      throw new ConfigError(`modelPricing[${model}] must be an object`);
    }
    const inputPerMtok = requireNumber(entry.inputPerMtok, `modelPricing[${model}].inputPerMtok`);
    if (inputPerMtok <= 0) {
      throw new ConfigError(`modelPricing[${model}].inputPerMtok must be > 0, got ${inputPerMtok}`);
    }
    modelPricing[model] = { inputPerMtok };
  }

  const logPath = requireNonEmptyString(raw.logPath, "logPath");

  if (!isObject(raw.logRotation)) throw new ConfigError("logRotation must be an object");
  const lr = raw.logRotation;
  const maxSizeBytes = requireInteger(lr.maxSizeBytes, "logRotation.maxSizeBytes");
  if (maxSizeBytes <= 0) {
    throw new ConfigError(`logRotation.maxSizeBytes must be > 0, got ${maxSizeBytes}`);
  }
  const maxFiles = requireInteger(lr.maxFiles, "logRotation.maxFiles");
  if (maxFiles < 1) {
    throw new ConfigError(`logRotation.maxFiles must be >= 1, got ${maxFiles}`);
  }

  let otel: Config["otel"];
  if (raw.otel !== undefined) {
    if (!isObject(raw.otel)) throw new ConfigError("otel must be an object");
    const enabled = requireBoolean(raw.otel.enabled, "otel.enabled");
    const o: { enabled: boolean; endpoint?: string; serviceName?: string } = { enabled };
    if (raw.otel.endpoint !== undefined) {
      o.endpoint = requireNonEmptyString(raw.otel.endpoint, "otel.endpoint");
    }
    if (raw.otel.serviceName !== undefined) {
      o.serviceName = requireNonEmptyString(raw.otel.serviceName, "otel.serviceName");
    }
    otel = o;
  }

  if (typeof raw.authToken !== "string") {
    throw new ConfigError(`authToken must be a string, got ${JSON.stringify(raw.authToken)}`);
  }
  if (raw.authToken !== "" && !HEX_TOKEN_RE.test(raw.authToken)) {
    throw new ConfigError(
      `authToken must be empty or 32 lowercase hex characters, got ${JSON.stringify(raw.authToken)}`,
    );
  }
  const authToken = raw.authToken;

  const out: Config = {
    listen: { host, port },
    tickIntervalSeconds,
    cacheTtlSeconds,
    pingCadenceMarginSeconds,
    abandonTtlMultiplier,
    maxConsecutivePings,
    minConsecutivePings,
    adaptiveCapWindow,
    pricing: { cacheReadMultiplier, rebuildMultiplier },
    evictAfterHours,
    requireT1,
    autoSetEnvVar,
    plan,
    budgetCap: {
      max5hUtilizationFromPings: max5h,
      maxPingSpendUsd: { perDay, perMonth, warnAt },
      maxPingsPerSession5h,
    },
    modelPricing,
    logPath,
    logRotation: { maxSizeBytes, maxFiles },
    authToken,
  };
  if (enterpriseCap) out.enterpriseCap = enterpriseCap;
  if (otel) out.otel = otel;
  return out;
}
