// @stoke/shared/pricing.mjs
//
// The single source of model-pricing truth for the whole stoke monorepo.
// The monitor prices transcript turns with priceTurn(); the proxy derives
// its modelPricing defaults and savings multipliers from the same rules.
// Edit pricing.json to track price changes — no code changes needed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "pricing.json");

export function loadPricing(filePath = defaultPath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")).rules;
}

export function ruleFor(model, ts, rules) {
  const date = ts.slice(0, 10);
  const candidates = rules.filter(r => model.startsWith(r.model_prefix) && r.effective_from <= date);
  if (candidates.length === 0) return null;
  const maxPrefixLen = Math.max(...candidates.map(r => r.model_prefix.length));
  return candidates
    .filter(r => r.model_prefix.length === maxPrefixLen)
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
}

export function priceTurn(turn, rules) {
  const rule = ruleFor(turn.model, turn.ts, rules);
  const unknownModel = !rule || rule.model_prefix === "";
  if (!rule) return { costUsd: 0, unknownModel };
  const M = 1_000_000;
  const costUsd =
    (turn.input_tokens || 0) / M * rule.input +
    (turn.output_tokens || 0) / M * rule.output +
    (turn.cache_write_5m || 0) / M * rule.cache_write_5m +
    (turn.cache_write_1h || 0) / M * rule.cache_write_1h +
    (turn.cache_read || 0) / M * rule.cache_read;
  return { costUsd, unknownModel };
}

/** Input price per MTok for a model at a point in time, or undefined when no rule matches. */
export function inputPerMtok(model, ts, rules) {
  const rule = ruleFor(model, ts, rules);
  return rule ? rule.input : undefined;
}

/**
 * Cache-price multipliers relative to input price for a model at a point in
 * time: cacheRead = cache_read/input, rebuild5m = cache_write_5m/input,
 * rebuild1h = cache_write_1h/input. Undefined when no rule matches or the
 * rule's input price is 0.
 */
export function multipliersFor(model, ts, rules) {
  const rule = ruleFor(model, ts, rules);
  if (!rule || !(rule.input > 0)) return undefined;
  return {
    cacheRead: rule.cache_read / rule.input,
    rebuild5m: rule.cache_write_5m / rule.input,
    rebuild1h: rule.cache_write_1h / rule.input,
  };
}

/**
 * Prefix-aware lookup over a `modelPricing`-shaped map
 * (`{ [modelOrPrefix]: { inputPerMtok } }`). Exact key wins; otherwise the
 * longest prefix key that the model id starts with. Returns 0 when nothing
 * matches — mirroring the proxy's historical unknown-model behavior.
 */
export function inputPerMtokFromMap(model, map) {
  if (!map) return 0;
  const exact = map[model];
  if (exact && typeof exact.inputPerMtok === "number") return exact.inputPerMtok;
  let best = null;
  for (const key of Object.keys(map)) {
    if (key && model.startsWith(key) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  return best !== null ? map[best].inputPerMtok : 0;
}

/**
 * Expand pricing rules into a `modelPricing`-shaped map keyed by rule prefix,
 * using each prefix's rule effective at `tsIso`. The empty fallback prefix is
 * excluded — map lookups treat unmatched models as unknown.
 */
export function defaultModelPricingMap(rules, tsIso) {
  const out = {};
  for (const prefix of new Set(rules.map(r => r.model_prefix).filter(p => p !== ""))) {
    const rule = ruleFor(prefix, tsIso, rules);
    if (rule && rule.input > 0) out[prefix] = { inputPerMtok: rule.input };
  }
  return out;
}
