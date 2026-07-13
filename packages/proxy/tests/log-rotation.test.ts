import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { JsonlLogger } from "../src/logger.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "ckrot-")), "events.jsonl");
}

test("rotation triggers when size exceeds maxSizeBytes", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path, { maxSizeBytes: 200, maxFiles: 3 });
  for (let i = 0; i < 20; i++) {
    log.write({ ts: `t${i}`, kind: "ping_fired", costUsd: 0.001 } as never);
  }
  log.flushSync();
  assert.ok(existsSync(path + ".1"), "rotated file .1 should exist");
  if (existsSync(path)) {
    const size = statSync(path).size;
    assert.ok(size < 200, `events.jsonl should be fresh after rotation, got ${size} bytes`);
  }
  rmSync(dirname(path), { recursive: true, force: true });
});

test("maxFiles is honored — oldest is dropped", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path, { maxSizeBytes: 100, maxFiles: 2 });
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 10; i++) {
      log.write({ ts: `r${round}t${i}`, kind: "ping_fired", costUsd: 0.001 } as never);
    }
    log.flushSync();
  }
  assert.ok(existsSync(path + ".1"));
  assert.ok(existsSync(path + ".2"));
  assert.ok(!existsSync(path + ".3"), "third rotated file should be dropped");
  rmSync(dirname(path), { recursive: true, force: true });
});

test("rotation does NOT affect the in-memory cache", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path, { maxSizeBytes: 100, maxFiles: 3 });
  for (let i = 0; i < 20; i++) {
    log.write({ ts: `t${i}`, kind: "ping_fired", costUsd: 0.001 } as never);
  }
  log.flushSync();
  assert.equal(log.snapshot().length, 20);
  rmSync(dirname(path), { recursive: true, force: true });
});

test("logger with no rotation config never rotates", () => {
  const path = tmpFile();
  const log = new JsonlLogger(path); // no rotation
  for (let i = 0; i < 50; i++) {
    log.write({ ts: `t${i}`, kind: "ping_fired", costUsd: 0.001 } as never);
  }
  log.flushSync();
  assert.ok(!existsSync(path + ".1"), "no rotation should have happened");
  rmSync(dirname(path), { recursive: true, force: true });
});
