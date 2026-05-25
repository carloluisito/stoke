import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runCli(args: string[], timeoutMs = 10000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CACHE_KEEPALIVE_AUTO_SET_ENV: "0",
    };
    const child = spawn("tsx", [join(process.cwd(), "src/cli.ts"), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString();
    });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

test("replay missing path exits 2 with usage", async () => {
  const r = await runCli(["replay"]);
  assert.equal(r.code, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr + r.stdout, /usage.*replay/);
});

test("replay non-existent file exits 1", async () => {
  const r = await runCli(["replay", join(tmpdir(), "definitely-does-not-exist.jsonl")]);
  assert.equal(r.code, 1, `stderr: ${r.stderr}`);
});

test("replay against a small fixture prints today/month/all-time labels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ckrep-"));
  const path = join(dir, "events.jsonl");
  writeFileSync(
    path,
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: "ping_fired",
      sessionKey: "k",
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 60000 },
      ratelimits: { unified5hUtilization: null, unified7dUtilization: null, unified5hResetEpoch: null, overageStatus: null },
      costUsd: 0.003,
    }) + "\n",
  );
  const r = await runCli(["replay", path]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.match(r.stdout, /Today/);
  assert.match(r.stdout, /This month/i);
  assert.match(r.stdout, /All time/i);
  rmSync(dir, { recursive: true, force: true });
});
