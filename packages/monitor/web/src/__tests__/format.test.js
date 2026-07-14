import { describe, it, expect } from "vitest";
import { money, pct, mmss, agoStr, dayLabel, tok, typeLabel, verdictLabel } from "../api.js";

describe("formatters", () => {
  it("money always shows two decimals", () => {
    expect(money(74.31)).toBe("$74.31");
    expect(money(0)).toBe("$0.00");
    expect(money(null)).toBe("$0.00");
    expect(money(1234.5)).toBe("$1234.50");
  });
  it("pct", () => {
    expect(pct(0.998)).toBe("99.8%");
    expect(pct(0)).toBe("0.0%");
  });
  it("mmss clamps at zero and pads seconds", () => {
    expect(mmss(0)).toBe("0:00");
    expect(mmss(65)).toBe("1:05");
    expect(mmss(-10)).toBe("0:00");
  });
  it("agoStr scales s/m/h", () => {
    expect(agoStr(12)).toBe("12s ago");
    expect(agoStr(120)).toBe("2m ago");
    expect(agoStr(7200)).toBe("2h ago");
  });
  it("dayLabel formats a UTC day", () => {
    expect(dayLabel("2026-07-14")).toBe("Jul 14");
  });
  it("tok abbreviates", () => {
    expect(tok(9_100_000_000)).toBe("9.1B");
    expect(tok(1_800_000)).toBe("1.8M");
    expect(tok(1200)).toBe("1k");
  });
  it("typeLabel + verdictLabel map known keys", () => {
    expect(typeLabel("cache_expiry")).toBe("Cache expiry");
    expect(typeLabel("unknown")).toBe("unknown");
    expect(verdictLabel("switch-1h")).toBe("Switch to 1h");
    expect(verdictLabel("keep")).toBe("Keep current");
  });
});
