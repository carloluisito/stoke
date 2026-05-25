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

import { readdirSync } from "node:fs";
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

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
