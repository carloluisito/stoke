---
name: setup-tokeff
description: Use when setting up tokeff on a machine for the first time — after cloning the token-efficiency repo, when hooks/statusline aren't active, when /spend or /efficiency-audit are missing, or when the dashboard won't start on a new computer.
---

# Set up tokeff on this machine

## Prerequisites (check first)

- Node.js >= 20 (`node --version`). better-sqlite3 compiles a native module; on Windows this works out of the box with official Node installers.
- If this machine uses a non-default Claude Code config dir, `CLAUDE_CONFIG_DIR` must be set in the environment (the setup honors it; default is `~/.claude`).

## Run

From the repository root:

```
node scripts/setup.mjs
```

The script is idempotent (safe to re-run) and stops before installing anything if the test suite fails on this machine. It performs: dependency install (root + web) → dashboard build → full test suite → additive registration of hooks/agents/skills into the config dir (never clobbers existing settings or statusline) → live API verification. It prints `[setup] ✅ COMPLETE` with the config dir, turn count, and observed spend.

## Verify

1. `npm start` → open the printed dashboard URL (default http://localhost:5599; falls back to 5600–5610, never 9876).
2. Open a NEW Claude Code session → `/spend` should return a spend table.

## Troubleshooting

- **Tests fail on `better-sqlite3`**: wrong Node major version for the prebuilt binary — `npm rebuild better-sqlite3` or reinstall Node >= 20 and re-run.
- **0 turns ingested**: config dir mismatch — check `CLAUDE_CONFIG_DIR` points at the dir containing `projects/`.
- **Existing statusline**: intentionally left untouched. To use the tokeff cost statusline, set `statusLine.command` in settings.json to `node <repo>/plugin/statusline.mjs`.
