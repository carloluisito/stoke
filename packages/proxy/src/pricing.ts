// src/pricing.ts
import type { Config, UsageBlock } from "./types.ts";

export function computePingCostUsd(
  model: string,
  usage: UsageBlock,
  config: Config,
): number {
  const price = config.modelPricing[model];
  if (!price) return 0;
  const readMul = config.pricing.cacheReadMultiplier;
  const readCost =
    (usage.cache_read_input_tokens * price.inputPerMtok * readMul) / 1e6;
  const inputCost = (usage.input_tokens * price.inputPerMtok) / 1e6;
  return readCost + inputCost;
}
