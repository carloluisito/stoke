export interface PricingRule {
  model_prefix: string;
  effective_from: string;
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

export interface TurnUsage {
  model: string;
  ts: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_write_5m?: number;
  cache_write_1h?: number;
  cache_read?: number;
}

export function loadPricing(filePath?: string): PricingRule[];
export function ruleFor(model: string, ts: string, rules: PricingRule[]): PricingRule | null;
export function priceTurn(turn: TurnUsage, rules: PricingRule[]): { costUsd: number; unknownModel: boolean };
export function inputPerMtok(model: string, ts: string, rules: PricingRule[]): number | undefined;
export function multipliersFor(
  model: string,
  ts: string,
  rules: PricingRule[],
): { cacheRead: number; rebuild5m: number; rebuild1h: number } | undefined;
export function inputPerMtokFromMap(
  model: string,
  map: Record<string, { inputPerMtok: number }> | undefined,
): number;
export function defaultModelPricingMap(
  rules: PricingRule[],
  tsIso: string,
): Record<string, { inputPerMtok: number }>;
