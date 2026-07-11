import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "pricing.json");

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
