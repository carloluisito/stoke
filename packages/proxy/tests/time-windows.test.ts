import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startOfDayMs,
  startOfMonthMs,
  startOfBillingCycleMs,
} from "../src/time-windows.ts";

test("startOfDayMs returns midnight local time of the given date", () => {
  const now = new Date(2026, 4, 19, 14, 30, 0, 0); // 2026-05-19 14:30:00 local
  const start = startOfDayMs(now);
  const startDate = new Date(start);
  assert.equal(startDate.getFullYear(), 2026);
  assert.equal(startDate.getMonth(), 4); // May
  assert.equal(startDate.getDate(), 19);
  assert.equal(startDate.getHours(), 0);
  assert.equal(startDate.getMinutes(), 0);
});

test("startOfMonthMs returns midnight of the first of the month", () => {
  const now = new Date(2026, 4, 19, 14, 30, 0, 0);
  const start = startOfMonthMs(now);
  const startDate = new Date(start);
  assert.equal(startDate.getMonth(), 4);
  assert.equal(startDate.getDate(), 1);
  assert.equal(startDate.getHours(), 0);
});

test("startOfBillingCycleMs returns this month's cycle-start day when today is past it", () => {
  // Today is May 19. Cycle starts on day 5. Current cycle began May 5.
  const now = new Date(2026, 4, 19, 14, 30, 0, 0);
  const start = startOfBillingCycleMs(5, now);
  const startDate = new Date(start);
  assert.equal(startDate.getMonth(), 4); // May
  assert.equal(startDate.getDate(), 5);
});

test("startOfBillingCycleMs returns last month's cycle-start day when today is before it", () => {
  // Today is May 3. Cycle starts on day 15. Current cycle began April 15.
  const now = new Date(2026, 4, 3, 14, 30, 0, 0);
  const start = startOfBillingCycleMs(15, now);
  const startDate = new Date(start);
  assert.equal(startDate.getMonth(), 3); // April
  assert.equal(startDate.getDate(), 15);
});

test("startOfBillingCycleMs handles year boundary (January with cycle in December)", () => {
  // Today is Jan 5, 2027. Cycle starts on day 20. Cycle began Dec 20, 2026.
  const now = new Date(2027, 0, 5, 14, 30, 0, 0);
  const start = startOfBillingCycleMs(20, now);
  const startDate = new Date(start);
  assert.equal(startDate.getFullYear(), 2026);
  assert.equal(startDate.getMonth(), 11); // December
  assert.equal(startDate.getDate(), 20);
});
