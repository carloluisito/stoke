// src/time-windows.ts
// Helpers that compute start-of-window epoch ms for spend/usage tracking.
// All windows are anchored to the user's local timezone — what "today" means
// to a human typing in a terminal at midnight is the local calendar day.

export function startOfDayMs(now: Date = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
}

export function startOfMonthMs(now: Date = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
}

/**
 * For enterprise plans: the start of the *current* billing cycle.
 * If today's day-of-month is >= cycleStartDay, the cycle started this month
 * on that day. Otherwise it started in the previous month on that day.
 */
export function startOfBillingCycleMs(
  cycleStartDay: number,
  now: Date = new Date(),
): number {
  const day = now.getDate();
  if (day >= cycleStartDay) {
    return new Date(now.getFullYear(), now.getMonth(), cycleStartDay, 0, 0, 0, 0).getTime();
  }
  // JavaScript Date handles month=-1 → previous December of the prior year.
  return new Date(now.getFullYear(), now.getMonth() - 1, cycleStartDay, 0, 0, 0, 0).getTime();
}
