import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { JsonlLogger } from "../src/logger.ts";
import { Registry } from "../src/registry.ts";
import { defaultConfig } from "../src/config.ts";
import { buildDigest, emitDigest } from "../src/digest.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "ckdig-")), "events.jsonl");
}

test("buildDigest produces text containing today/month/all-time labels", () => {
  const path = tmpFile();
  const logger = new JsonlLogger(path);
  const registry = new Registry();
  const config = { ...defaultConfig(), logPath: path };
  logger.write({
    ts: new Date().toISOString(),
    kind: "ping_fired",
    sessionKey: "k",
    model: "claude-opus-4-7",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 60000 },
    ratelimits: { unified5hUtilization: null, unified7dUtilization: null, unified5hResetEpoch: null, overageStatus: null },
    costUsd: 0.003,
  } as never);
  const text = buildDigest({ registry, logger, config, nowMs: Date.now() });
  assert.match(text, /digest/i);
  assert.match(text, /Today/);
  assert.match(text, /This month/i);
  assert.match(text, /All time/i);
  rmSync(dirname(path), { recursive: true, force: true });
});

test("emitDigest appends to digest.log next to events.jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "ckdig2-"));
  const eventsPath = join(dir, "events.jsonl");
  const digestPath = join(dir, "digest.log");
  const logger = new JsonlLogger(eventsPath);
  const registry = new Registry();
  const config = { ...defaultConfig(), logPath: eventsPath };
  emitDigest({ registry, logger, config, nowMs: Date.now() });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.ok(existsSync(digestPath), "digest.log should exist");
      const content = readFileSync(digestPath, "utf8");
      assert.match(content, /digest/i);
      rmSync(dir, { recursive: true, force: true });
      resolve();
    }, 200);
  });
});
