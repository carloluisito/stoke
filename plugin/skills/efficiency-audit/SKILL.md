---
name: efficiency-audit
description: Audit the current Claude Code session for token waste (cache expiry, context bloat, verbosity, model mismatch) and get concrete recommendations. Use when the user asks why a session is expensive or invokes /efficiency-audit.
---

# Efficiency audit (current session)

1. Determine the current session id (available in hook/statusline context, or the newest session in the DB).
2. Run:

```
node "%TOKEFF_ROOT%/scripts/audit-session.mjs" <session_id>
```

If no session id is available, run it with no argument — it audits the most recent session.

3. Present the findings table verbatim, then apply the recommendations that are in your control right now (e.g. suggest `/compact`, delegate remaining exploration to cheap subagents, tighten your own output).
