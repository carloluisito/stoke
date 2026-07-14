import { describe, it, expect } from "vitest";
import { dayTotal, sparkGeometry } from "../charts.jsx";

describe("dayTotal", () => {
  it("sums the four token-cost series", () => {
    expect(dayTotal({ output: 1, input: 2, cacheWrite: 3, cacheRead: 4 })).toBe(10);
  });
});

describe("sparkGeometry", () => {
  it("maps a flat series to the baseline without NaN", () => {
    const g = sparkGeometry([5, 5, 5], 30);
    expect(g.line).not.toContain("NaN");
    expect(g.area.startsWith("0,30")).toBe(true);
    expect(g.area.endsWith("100,30")).toBe(true);
  });
  it("puts the max at the top (smallest y) and min at the bottom", () => {
    const g = sparkGeometry([0, 10], 30);
    const pts = g.line.split(" ").map((p) => Number(p.split(",")[1]));
    expect(pts[1]).toBeLessThan(pts[0]); // higher value -> smaller y
  });
  it("handles an empty series", () => {
    expect(sparkGeometry([], 30).line).toBe("");
  });
});
