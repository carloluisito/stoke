// src/pricing.ts
import type { Config, UsageBlock } from "./types.ts";
import { inputPerMtokFromMap } from "@stoke/shared/pricing.mjs";

export function computePingCostUsd(
  model: string,
  usage: UsageBlock,
  config: Config,
): number {
  // Prefix-aware: modelPricing defaults are keyed by model prefix (from the
  // shared pricing rules), while live traffic carries full dated model ids.
  const inputPerMtok = inputPerMtokFromMap(model, config.modelPricing);
  if (inputPerMtok <= 0) return 0;
  const readMul = config.pricing.cacheReadMultiplier;
  const readCost =
    (usage.cache_read_input_tokens * inputPerMtok * readMul) / 1e6;
  const inputCost = (usage.input_tokens * inputPerMtok) / 1e6;
  return readCost + inputCost;
}
