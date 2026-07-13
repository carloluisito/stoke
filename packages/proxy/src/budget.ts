// src/budget.ts
import type { Config, RateLimits, Session } from "./types.ts";

export interface BudgetInputs {
  lastRatelimits: RateLimits | null;
  /** Successful pings recorded for this session within the last 5h. Derived by the caller via Registry.pingStatsInWindow. */
  pingCountInWindow: number;
  pingsToday: number;
  spendUsdToday: number;
  spendUsdMonth: number;
}

export interface BudgetDecision {
  pause: boolean;
  reason?:
    | "per_session_cap"
    | "daily_spend_cap"
    | "monthly_spend_cap"
    | "ratelimit_near_overage"
    | "ratelimit_pings_cap"
    | "enterprise_cap_near";
}

/** Fraction of an enterprise monthly cap at which we pause pinging — leaves headroom for real requests. */
const ENTERPRISE_CAP_PAUSE_THRESHOLD = 0.95;

export class BudgetGuard {
  constructor(private readonly config: Config) {}

  shouldPause(_session: Session, inputs: BudgetInputs): BudgetDecision {
    const cap = this.config.budgetCap;
    if (inputs.pingCountInWindow >= cap.maxPingsPerSession5h) {
      return { pause: true, reason: "per_session_cap" };
    }
    if (inputs.spendUsdToday >= cap.maxPingSpendUsd.perDay) {
      return { pause: true, reason: "daily_spend_cap" };
    }
    if (inputs.spendUsdMonth >= cap.maxPingSpendUsd.perMonth) {
      return { pause: true, reason: "monthly_spend_cap" };
    }
    // Enterprise: pause pings well before exhausting the contracted monthly cap,
    // so the user keeps headroom for real requests through end of cycle.
    if (this.config.plan === "enterprise" && this.config.enterpriseCap) {
      const threshold =
        this.config.enterpriseCap.monthlyCapUsd * ENTERPRISE_CAP_PAUSE_THRESHOLD;
      if (inputs.spendUsdMonth >= threshold) {
        return { pause: true, reason: "enterprise_cap_near" };
      }
    }
    const rl = inputs.lastRatelimits;
    if (
      rl &&
      rl.overageStatus === "rejected" &&
      typeof rl.unified5hUtilization === "number" &&
      rl.unified5hUtilization > 0.95
    ) {
      return { pause: true, reason: "ratelimit_near_overage" };
    }
    return { pause: false };
  }
}
