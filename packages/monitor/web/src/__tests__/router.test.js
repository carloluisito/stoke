import { describe, it, expect } from "vitest";
import { parseHash, sessionsHash } from "../router.js";

describe("parseHash", () => {
  it("defaults to overview", () => {
    expect(parseHash("")).toEqual({ tab: "overview", parts: [], query: {} });
    expect(parseHash("#overview").tab).toBe("overview");
  });
  it("parses a session id", () => {
    const r = parseHash("#sessions/abc123");
    expect(r.tab).toBe("sessions");
    expect(r.parts[1]).toBe("abc123");
  });
  it("parses query params", () => {
    const r = parseHash("#sessions?project=work/api&model=claude-fable-5&day=2026-07-14");
    expect(r.query).toEqual({ project: "work/api", model: "claude-fable-5", day: "2026-07-14" });
  });
  it("parses the waste log subview", () => {
    expect(parseHash("#waste/log").parts).toEqual(["waste", "log"]);
  });
});

describe("sessionsHash", () => {
  it("drops all/empty values", () => {
    expect(sessionsHash({ project: "all", model: "", day: "2026-07-14" })).toBe("sessions?day=2026-07-14");
  });
  it("is bare when nothing is set", () => {
    expect(sessionsHash({ project: "all" })).toBe("sessions");
  });
  it("round-trips through parseHash", () => {
    const h = sessionsHash({ project: "work/api", model: "claude-fable-5" });
    expect(parseHash("#" + h).query).toEqual({ project: "work/api", model: "claude-fable-5" });
  });
});
