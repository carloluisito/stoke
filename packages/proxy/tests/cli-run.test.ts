import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let nextPort = 39800;
function reservePort(): number {
  return nextPort++;
}

function runCli(args: string[], timeoutMs = 15000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const logDir = mkdtempSync(join(tmpdir(), "ckrun-"));
    const env = {
      ...process.env,
      CACHE_KEEPALIVE_PORT: String(reservePort()),
      CACHE_KEEPALIVE_HOST: "127.0.0.1",
      CACHE_KEEPALIVE_LOG_PATH: join(logDir, "events.jsonl"),
      CACHE_KEEPALIVE_AUTO_SET_ENV: "0",
    };
    // Spawn node with --import tsx rather than the "tsx" bin shim: the shim
    // lives in the workspace root's node_modules/.bin (hoisted), which is not
    // on PATH when tests run from the package directory.
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/cli.ts"), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
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
      rmSync(logDir, { recursive: true, force: true });
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

test("run with no -- separator prints usage and exits 2", async () => {
  const r = await runCli(["run"]);
  assert.equal(r.code, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr + r.stdout, /usage.*--/);
});

test("run -- <child that exits 5> propagates the child exit code", async () => {
  // Use a temp .js file rather than -e to avoid Windows-cmd quoting issues
  // (the '>' inside '=>' would be interpreted as redirection by cmd.exe).
  const dir = mkdtempSync(join(tmpdir(), "ckrun-script-"));
  const scriptPath = join(dir, "child.js");
  writeFileSync(scriptPath, "setTimeout(function(){ process.exit(5); }, 200);");
  try {
    const r = await runCli(["run", "--", "node", scriptPath], 20000);
    assert.equal(r.code, 5, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run -- <missing command> exits with a failure code", async () => {
  // POSIX convention is 127 for command-not-found. On Windows the child is
  // spawned via cmd.exe (shell:true), which masks ENOENT as its own exit
  // code (1). Either way is a non-zero failure that does NOT propagate as
  // success.
  const r = await runCli(["run", "--", "nope-no-such-cmd-zzz"], 15000);
  assert.notEqual(r.code, 0, `expected non-zero exit, got 0; stderr: ${r.stderr}`);
  if (process.platform !== "win32") {
    assert.equal(r.code, 127, `POSIX should report 127; stderr: ${r.stderr}`);
  }
});
