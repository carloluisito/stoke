// scripts/run-tests.mjs
// Cross-platform test entry point.
//
// We discover `tests/**/*.test.ts` ourselves rather than passing a glob to
// `node --test`, because glob expansion is unreliable across our CI matrix:
//   - PowerShell (Windows) does not expand globs for external commands, so the
//     literal `tests/**/*.test.ts` reaches node.
//   - Node's `--test` only gained native glob support in v21; our floor is v20
//     (see package.json engines), so Node 20 errors with "Could not find ...".
//   - POSIX `sh` (how npm runs scripts) lacks `globstar`, so `**` collapses to
//     `*` and only matches one directory level — silently skipping most tests.
// Enumerating files in Node and passing explicit paths sidesteps all three.

import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const TEST_DIR = "tests";

const files = readdirSync(TEST_DIR, { recursive: true })
  .map((entry) => entry.toString())
  .filter((entry) => entry.endsWith(".test.ts"))
  .map((entry) => path.join(TEST_DIR, entry));

if (files.length === 0) {
  console.error(`No test files found under ${TEST_DIR}/`);
  process.exit(1);
}

// Point session-state at a throwaway directory for the whole suite. The
// scheduler both READS and PRUNES (deletes from) config.hookSignals.stateDir,
// which defaults to ~/.stoke/session-state — so without this, tests would see
// the developer's live sessions and could delete their sidecars.
const stateDir = mkdtempSync(path.join(tmpdir(), "stoke-test-state-"));

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { stdio: "inherit", env: { ...process.env, STOKE_SESSION_STATE_DIR: stateDir } },
);

rmSync(stateDir, { recursive: true, force: true });

process.exit(result.status ?? 1);
