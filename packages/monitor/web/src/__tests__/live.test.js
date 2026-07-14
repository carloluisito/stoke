import { describe, it, expect } from "vitest";
import { diffProxyEvents, sessionCountdown } from "../live.js";

const base = {
  up: true,
  today: { rebuildsAvoided: 5, savedUsd: 4.0, pingsFired: 20, resumes: { survived: 3, partial: 1, rebuilt: 0 } },
  live: { sessions: [{ projectPath: "work/my-app" }] },
};

describe("diffProxyEvents", () => {
  it("emits nothing without a previous poll", () => {
    expect(diffProxyEvents(null, base, 1000)).toEqual({ events: [], toasts: [] });
  });
  it("emits nothing when the proxy is down", () => {
    expect(diffProxyEvents(base, { ...base, up: false }, 1000).events).toHaveLength(0);
  });
  it("emits a prevented-rebuild event + toast when rebuildsAvoided rises", () => {
    const next = { ...base, today: { ...base.today, rebuildsAvoided: 6, savedUsd: 4.5 } };
    const { events, toasts } = diffProxyEvents(base, next, 1000);
    expect(events.find((e) => e.kind === "prevented_rebuild")).toBeTruthy();
    expect(toasts[0].text).toContain("$0.50");
  });
  it("emits a ping event when pingsFired rises", () => {
    const next = { ...base, today: { ...base.today, pingsFired: 22 } };
    const { events } = diffProxyEvents(base, next, 1000);
    expect(events[0].kind).toBe("ping_fired");
    expect(events[0].text).toContain("×2");
  });
  it("emits nothing when counters are unchanged", () => {
    expect(diffProxyEvents(base, { ...base }, 1000)).toEqual({ events: [], toasts: [] });
  });
});

describe("sessionCountdown", () => {
  const now = 100000;
  it("counts down from (ttl-30) minus idle plus elapsed", () => {
    const s = { cacheStatus: "warm", detectedTtlSeconds: 300, idleSec: 100 };
    const cd = sessionCountdown(s, now, now); // no elapsed
    expect(cd.seconds).toBe(170); // 270 - 100
    expect(cd.active).toBe(true);
    expect(cd.pinging).toBe(false);
  });
  it("marks a ping when the window is exhausted", () => {
    const s = { cacheStatus: "warm", detectedTtlSeconds: 300, idleSec: 300 };
    const cd = sessionCountdown(s, now, now);
    expect(cd.seconds).toBe(0);
    expect(cd.pinging).toBe(true);
  });
  it("is inactive for abandoned/paused sessions", () => {
    expect(sessionCountdown({ cacheStatus: "abandoned", detectedTtlSeconds: 3600, idleSec: 10 }, now, now).active).toBe(false);
  });
});
