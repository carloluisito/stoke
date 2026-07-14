import { describe, it, expect } from "vitest";
import { filterSessions, sortSessions } from "../sessionsFilter.js";

const NOW = new Date("2026-07-14T12:00:00Z").getTime();
const rows = [
  { session_id: "aaa", project: "work/my-app", model: "claude-fable-5", started: "2026-07-14T08:00:00Z", turns: 100, cost: 60, ttlMs: 3600000 },
  { session_id: "bbb", project: "work/api", model: "claude-fable-5-fast", started: "2026-07-13T08:00:00Z", turns: 40, cost: 10, ttlMs: 300000 },
  { session_id: "ccc", project: "work/my-app", model: "claude-fable-5", started: "2026-07-01T08:00:00Z", turns: 200, cost: 90, ttlMs: 3600000 },
];

describe("filterSessions", () => {
  it("filters by project", () => {
    const r = filterSessions(rows, { project: "work/api", range: "30d" }, NOW);
    expect(r.map((x) => x.session_id)).toEqual(["bbb"]);
  });
  it("filters by day", () => {
    const r = filterSessions(rows, { day: "2026-07-14", range: "30d" }, NOW);
    expect(r.map((x) => x.session_id)).toEqual(["aaa"]);
  });
  it("applies the date range", () => {
    const r = filterSessions(rows, { range: "7d" }, NOW);
    expect(r.map((x) => x.session_id).sort()).toEqual(["aaa", "bbb"]);
  });
  it("searches id and project", () => {
    expect(filterSessions(rows, { query: "api", range: "30d" }, NOW).map((x) => x.session_id)).toEqual(["bbb"]);
    expect(filterSessions(rows, { query: "ccc", range: "30d" }, NOW).map((x) => x.session_id)).toEqual(["ccc"]);
  });
  it("treats 'all' as no filter", () => {
    expect(filterSessions(rows, { project: "all", model: "all", range: "30d" }, NOW)).toHaveLength(3);
  });
});

describe("sortSessions", () => {
  it("sorts by cost desc", () => {
    expect(sortSessions(rows, { key: "cost", dir: "desc" }).map((x) => x.cost)).toEqual([90, 60, 10]);
  });
  it("sorts by ttl via ttlMs", () => {
    expect(sortSessions(rows, { key: "ttl", dir: "asc" })[0].ttlMs).toBe(300000);
  });
  it("sorts strings", () => {
    expect(sortSessions(rows, { key: "project", dir: "asc" })[0].project).toBe("work/api");
  });
});
