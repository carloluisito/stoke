import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startSupervisor } from "../src/supervisor.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const child = (name, script) => ({
  name,
  command: process.execPath,
  args: [path.join(fixtures, script)],
  cwd: fixtures,
});

test("a crashing child is restarted with growing backoff", async () => {
  const lines = [];
  const sup = startSupervisor([child("crashy", "crashy.mjs")], {
    backoffBaseMs: 30,
    backoffCapMs: 200,
    log: (l) => lines.push(l),
  });
  await sleep(1200);
  sup.stop();
  const restarts = sup.statuses().crashy.restarts;
  assert.ok(restarts >= 2, `expected >=2 restarts, got ${restarts}`);
  const delays = lines
    .map((l) => /restarting in (\d+)ms/.exec(l)?.[1])
    .filter(Boolean)
    .map(Number);
  assert.ok(delays.length >= 2, "expected backoff log lines");
  assert.ok(delays[1] > delays[0], `backoff should grow: ${delays.join(",")}`);
  assert.ok(Math.max(...delays) <= 200, "backoff must respect the cap");
});

test("children are isolated — killing one never touches the other", async () => {
  const sup = startSupervisor(
    [child("a", "steady.mjs"), child("b", "steady.mjs")],
    { backoffBaseMs: 30, backoffCapMs: 100, log: () => {} },
  );
  await sleep(300);
  const before = sup.statuses();
  assert.ok(before.a.pid && before.b.pid, "both children running");

  process.kill(before.a.pid); // crash child a
  await sleep(500);

  const after = sup.statuses();
  assert.equal(after.b.pid, before.b.pid, "child b must be untouched");
  assert.ok(after.a.restarts >= 1, "child a must have been restarted");
  assert.ok(after.a.pid && after.a.pid !== before.a.pid, "child a has a new pid");
  sup.stop();
});

test("stop() kills children and suppresses restarts", async () => {
  const sup = startSupervisor([child("s", "steady.mjs")], {
    backoffBaseMs: 30,
    log: () => {},
  });
  await sleep(300);
  const pid = sup.statuses().s.pid;
  assert.ok(pid);
  sup.stop();
  await sleep(400);
  assert.equal(sup.statuses().s.restarts, 0, "no restart after stop()");
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, "child process must be dead");
});

test("child marked UNSTABLE after repeated crashes inside the window", async () => {
  const sup = startSupervisor([child("crashy", "crashy.mjs")], {
    backoffBaseMs: 10,
    backoffCapMs: 20,
    unstableThreshold: 3,
    unstableWindowMs: 60_000,
    log: () => {},
  });
  await sleep(1000);
  sup.stop();
  assert.equal(sup.statuses().crashy.unstable, true);
});
