---
name: spend
description: Show an instant Claude Code spend report — today / this week / this month, top sessions, and cache hit rate — from the local tokeff database. Use when the user asks about token costs, spend, or /spend.
---

# Spend report

Run this command and present its markdown output to the user verbatim (it is already formatted):

```
node "%TOKEFF_ROOT%/scripts/report.mjs"
```

If `TOKEFF_ROOT` is not set in the environment, the tokeff project root is the directory containing this skill's `scripts/report.mjs` — resolve it relative to the installed tool (default: the token-efficiency repository).

Do not add commentary beyond one sentence of interpretation; the numbers speak for themselves.
