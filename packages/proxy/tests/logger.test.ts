import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLogger } from "../src/logger.ts";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ckll-"));
  return join(dir, "events.jsonl");
}

test("write appends one line per call", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  log.write({ ts: "t1", kind: "proxy_started", config: {} });
  log.write({
    ts: "t2",
    kind: "ping_skipped",
    sessionKey: "abc",
    reason: "budget_cap",
  });
  log.flushSync();
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).kind, "proxy_started");
  assert.equal(JSON.parse(lines[1]).kind, "ping_skipped");
  rmSync(path, { force: true });
});

test("summary counts events by kind", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  log.write({ ts: "t1", kind: "real_request" } as any);
  log.write({ ts: "t2", kind: "real_request" } as any);
  log.write({ ts: "t3", kind: "ping_fired", costUsd: 0.01 } as any);
  log.write({ ts: "t4", kind: "ping_fired", costUsd: 0.02 } as any);
  const s = log.summary();
  assert.equal(s.realRequests, 2);
  assert.equal(s.pingsFired, 2);
  assert.equal(Math.round(s.totalPingSpendUsd * 100) / 100, 0.03);
  rmSync(path, { force: true });
});

test("statsSinceMs filters ping_fired events by timestamp", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  // Three pings across two days
  log.write({
    ts: "2026-05-18T10:00:00.000Z",
    kind: "ping_fired",
    costUsd: 0.04,
  } as any);
  log.write({
    ts: "2026-05-19T01:00:00.000Z",
    kind: "ping_fired",
    costUsd: 0.04,
  } as any);
  log.write({
    ts: "2026-05-19T05:00:00.000Z",
    kind: "ping_fired",
    costUsd: 0.04,
  } as any);

  // Since start-of-2026-05-19 UTC: should include only the last two pings
  const startOfMay19 = new Date("2026-05-19T00:00:00.000Z").getTime();
  const today = log.statsSinceMs(startOfMay19);
  assert.equal(today.pingsFired, 2);
  assert.equal(Math.round(today.totalPingSpendUsd * 100) / 100, 0.08);

  // Since 0 (epoch start): should include all three
  const all = log.statsSinceMs(0);
  assert.equal(all.pingsFired, 3);
  assert.equal(Math.round(all.totalPingSpendUsd * 100) / 100, 0.12);

  // Since a future timestamp: should include none
  const future = log.statsSinceMs(Date.now() + 24 * 60 * 60 * 1000);
  assert.equal(future.pingsFired, 0);
  assert.equal(future.totalPingSpendUsd, 0);

  rmSync(path, { force: true });
});

test("subscribe receives events on every write", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  const received: string[] = [];
  const unsubscribe = log.subscribe((e) => received.push((e as any).kind));
  log.write({ ts: "t1", kind: "real_request" } as any);
  log.write({ ts: "t2", kind: "ping_fired", costUsd: 0.01 } as any);
  unsubscribe();
  log.write({ ts: "t3", kind: "ping_skipped", reason: "x" } as any);
  assert.deepEqual(received, ["real_request", "ping_fired"]);
  rmSync(path, { force: true });
});

test("a throwing subscriber does not break logger.write", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  log.subscribe(() => { throw new Error("boom"); });
  let other = 0;
  log.subscribe(() => { other += 1; });
  // Should not throw — both the file write and the other subscriber must run.
  log.write({ ts: "t1", kind: "real_request" } as any);
  assert.equal(other, 1);
  log.flushSync();
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  rmSync(path, { force: true });
});

test("snapshot returns events appended via write, in order", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  log.write({ ts: "t1", kind: "real_request" } as any);
  log.write({ ts: "t2", kind: "ping_fired", costUsd: 0.01 } as any);
  const snap = log.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].kind, "real_request");
  assert.equal(snap[1].kind, "ping_fired");
  rmSync(path, { force: true });
});

test("new JsonlLogger replays existing JSONL into snapshot on startup", () => {
  const path = tmpFile();
  const first = new JsonlLogger(path);
  first.write({ ts: "t1", kind: "real_request" } as any);
  first.write({ ts: "t2", kind: "ping_fired", costUsd: 0.05 } as any);
  first.flushSync();

  const second = new JsonlLogger(path);
  const snap = second.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].kind, "real_request");
  assert.equal(snap[1].kind, "ping_fired");
  rmSync(path, { force: true });
});

test("summary reads from the in-memory cache, not the file", () => {
  const path = tmpFile();
  const first = new JsonlLogger(path);
  first.write({ ts: "t1", kind: "real_request" } as any);
  first.write({ ts: "t2", kind: "ping_fired", costUsd: 0.05 } as any);
  first.flushSync();

  const second = new JsonlLogger(path);
  second.write({ ts: "t3", kind: "ping_fired", costUsd: 0.07 } as any);

  assert.equal(first.summary().pingsFired, 1);
  assert.equal(second.summary().pingsFired, 2);
  rmSync(path, { force: true });
});

test("snapshot is sync; file may lag until flushSync drains the queue", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  log.write({ ts: "t1", kind: "real_request" } as any);
  log.write({ ts: "t2", kind: "ping_fired", costUsd: 0.01 } as any);
  // Cache is sync — snapshot sees both immediately.
  assert.equal(log.snapshot().length, 2);
  log.flushSync();
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).kind, "real_request");
  assert.equal(JSON.parse(lines[1]).kind, "ping_fired");
  rmSync(path, { force: true });
});

test("flushSync drains a batch of writes without losing events", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  for (let i = 0; i < 20; i++) {
    log.write({ ts: `t${i}`, kind: "ping_fired", costUsd: 0.001 } as any);
  }
  log.flushSync();
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 20);
  rmSync(path, { force: true });
});

test("flushSync is a no-op when there are no pending writes", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  log.flushSync();
  log.flushSync();
  rmSync(path, { force: true });
});

test("statsSinceMs ignores non-ping_fired events", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path);
  log.write({
    ts: "2026-05-19T01:00:00.000Z",
    kind: "real_request",
  } as any);
  log.write({
    ts: "2026-05-19T02:00:00.000Z",
    kind: "ping_skipped",
    reason: "x",
  } as any);
  log.write({
    ts: "2026-05-19T03:00:00.000Z",
    kind: "ping_fired",
    costUsd: 0.04,
  } as any);

  const got = log.statsSinceMs(0);
  assert.equal(got.pingsFired, 1);
  assert.equal(got.totalPingSpendUsd, 0.04);
  rmSync(path, { force: true });
});
