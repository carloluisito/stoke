import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePersistentBaseUrl,
  removePersistentBaseUrl,
  _testHooks,
} from "../src/env-setup.ts";

function withTempHome<T>(shell: string, plat: NodeJS.Platform, fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "ckenv-"));
  _testHooks.setOverrides({ platform: plat, home, shell });
  try {
    return fn(home);
  } finally {
    _testHooks.setOverrides(null);
    rmSync(home, { recursive: true, force: true });
  }
}

test("ensurePersistentBaseUrl creates ~/.zshrc with marked block on macOS+zsh", () => {
  withTempHome("/bin/zsh", "darwin", (home) => {
    const r = ensurePersistentBaseUrl("http://127.0.0.1:9876");
    assert.equal(r.action, "set");
    const rc = readFileSync(join(home, ".zshrc"), "utf8");
    assert.match(rc, /# >>> stoke: env auto-set >>>/);
    assert.match(rc, /export ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:9876"/);
    assert.match(rc, /# <<< stoke: env auto-set <<</);
  });
});

test("ensurePersistentBaseUrl updates the marked block when URL changes", () => {
  withTempHome("/bin/zsh", "darwin", (home) => {
    ensurePersistentBaseUrl("http://127.0.0.1:9876");
    const r = ensurePersistentBaseUrl("http://127.0.0.1:9999");
    assert.equal(r.action, "updated");
    const rc = readFileSync(join(home, ".zshrc"), "utf8");
    assert.match(rc, /export ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:9999"/);
    assert.doesNotMatch(rc, /http:\/\/127\.0\.0\.1:9876/);
  });
});

test("ensurePersistentBaseUrl is already-set when block matches", () => {
  withTempHome("/bin/zsh", "darwin", (home) => {
    void home;
    ensurePersistentBaseUrl("http://127.0.0.1:9876");
    const r = ensurePersistentBaseUrl("http://127.0.0.1:9876");
    assert.equal(r.action, "already-set");
  });
});

test("ensurePersistentBaseUrl on Linux+bash writes to ~/.bashrc", () => {
  withTempHome("/bin/bash", "linux", (home) => {
    ensurePersistentBaseUrl("http://127.0.0.1:9876");
    assert.ok(existsSync(join(home, ".bashrc")));
    assert.ok(!existsSync(join(home, ".zshrc")));
  });
});

test("removePersistentBaseUrl deletes the marked block but leaves other content alone", () => {
  withTempHome("/bin/zsh", "darwin", (home) => {
    const rcPath = join(home, ".zshrc");
    writeFileSync(rcPath, "alias ll='ls -la'\n");
    ensurePersistentBaseUrl("http://127.0.0.1:9876");
    const r = removePersistentBaseUrl();
    assert.equal(r.action, "set");
    const rc = readFileSync(rcPath, "utf8");
    assert.match(rc, /alias ll='ls -la'/);
    assert.doesNotMatch(rc, /stoke: env auto-set/);
  });
});

test("ensurePersistentBaseUrl preserves existing content above and below the block", () => {
  withTempHome("/bin/zsh", "darwin", (home) => {
    const rcPath = join(home, ".zshrc");
    writeFileSync(rcPath, "# my zshrc\nalias g='git'\n");
    ensurePersistentBaseUrl("http://127.0.0.1:9876");
    const rc = readFileSync(rcPath, "utf8");
    assert.match(rc, /# my zshrc/);
    assert.match(rc, /alias g='git'/);
    assert.match(rc, /stoke: env auto-set/);
  });
});
