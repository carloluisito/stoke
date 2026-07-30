import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHookState, readHookStates, pruneHookStates } from "../src/hook-state.ts";

const STALE_MS = 900_000;

test("parseHookState accepts each valid state and preserves its timestamp", () => {
  for (const state of ["turn_active", "idle", "ended"]) {
    assert.deepEqual(parseHookState(JSON.stringify({ state, ts: 1000 }), 2000, STALE_MS), {
      state,
      ts: 1000,
    });
  }
});

test("parseHookState rejects malformed, unknown, and incomplete payloads", () => {
  assert.equal(parseHookState("not json", 2000, STALE_MS), null);
  assert.equal(parseHookState("", 2000, STALE_MS), null);
  assert.equal(parseHookState("[]", 2000, STALE_MS), null);
  assert.equal(parseHookState("null", 2000, STALE_MS), null);
  assert.equal(parseHookState(JSON.stringify({ state: "wat", ts: 1000 }), 2000, STALE_MS), null);
  assert.equal(parseHookState(JSON.stringify({ state: "idle" }), 2000, STALE_MS), null);
  assert.equal(parseHookState(JSON.stringify({ ts: 1000 }), 2000, STALE_MS), null);
  assert.equal(parseHookState(JSON.stringify({ state: "idle", ts: "soon" }), 2000, STALE_MS), null);
});

test("parseHookState rejects a state older than the staleness window", () => {
  assert.equal(parseHookState(JSON.stringify({ state: "ended", ts: 0 }), STALE_MS + 1, STALE_MS), null);
  assert.deepEqual(parseHookState(JSON.stringify({ state: "ended", ts: 0 }), STALE_MS, STALE_MS), {
    state: "ended",
    ts: 0,
  });
});

test("parseHookState tolerates a future timestamp rather than discarding it", () => {
  // Clock skew between the hook process and the proxy must not drop a signal.
  assert.deepEqual(parseHookState(JSON.stringify({ state: "ended", ts: 5000 }), 1000, STALE_MS), {
    state: "ended",
    ts: 5000,
  });
});

test("readHookStates maps session_id to record and skips unusable files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookstate-"));
  writeFileSync(join(dir, "alive.json"), JSON.stringify({ state: "turn_active", ts: 1000 }));
  writeFileSync(join(dir, "dead.json"), JSON.stringify({ state: "ended", ts: 1000 }));
  writeFileSync(join(dir, "old.json"), JSON.stringify({ state: "ended", ts: 0 }));
  writeFileSync(join(dir, "junk.json"), "{{{");
  writeFileSync(join(dir, "notjson.txt"), JSON.stringify({ state: "ended", ts: 1000 }));

  const states = readHookStates(dir, STALE_MS + 500, STALE_MS);
  assert.equal(states.get("alive")?.state, "turn_active");
  assert.equal(states.get("dead")?.state, "ended");
  assert.equal(states.get("dead")?.ts, 1000);
  assert.equal(states.get("old"), undefined, "a stale file must not produce a signal");
  assert.equal(states.get("junk"), undefined);
  assert.equal(states.get("notjson"), undefined);
  assert.equal(states.size, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("readHookStates keys on the full session_id, dots included", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookstate-id-"));
  const id = "0199f3c4-1111-4aaa-8bbb-0123456789ab";
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ state: "ended", ts: 1000 }));
  assert.equal(readHookStates(dir, 2000, STALE_MS).get(id)?.state, "ended");
  rmSync(dir, { recursive: true, force: true });
});

test("readHookStates returns an empty map when the directory is absent", () => {
  assert.equal(readHookStates(join(tmpdir(), "definitely-not-here-9f3c"), 0, STALE_MS).size, 0);
});

test("pruneHookStates removes only files past the max age", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookprune-"));
  writeFileSync(join(dir, "fresh.json"), JSON.stringify({ state: "idle", ts: 9000 }));
  writeFileSync(join(dir, "ancient.json"), JSON.stringify({ state: "ended", ts: 0 }));
  writeFileSync(join(dir, "junk.json"), "{{{");
  writeFileSync(join(dir, "keep.txt"), "not ours");

  const removed = pruneHookStates(dir, 10_000, 5000);
  assert.equal(removed, 2, "the ancient and the unparseable file both go");
  assert.equal(existsSync(join(dir, "fresh.json")), true);
  assert.equal(existsSync(join(dir, "ancient.json")), false);
  assert.equal(existsSync(join(dir, "junk.json")), false);
  assert.equal(existsSync(join(dir, "keep.txt")), true, "non-json files are not ours to delete");
  rmSync(dir, { recursive: true, force: true });
});

test("pruneHookStates tolerates a missing directory", () => {
  assert.equal(pruneHookStates(join(tmpdir(), "definitely-not-here-4a7b"), 0, 5000), 0);
});
