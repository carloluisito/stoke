import { readStdin, loadOptimizerConfig, openDbSafe, logIntervention, emit } from "./lib.mjs";

const CONVENTIONS = `<token-efficiency>
Cost-efficiency conventions for this session (output tokens cost 5x input; cached input is 10x cheaper than fresh):
- Keep final responses terse: lead with the outcome, skip restating context the user already has.
- Delegate mechanical fan-out work (broad searches, multi-file exploration) to the cheap-explore / cheap-search subagents instead of doing it in the main loop.
- Prefer targeted reads (specific line ranges, grep first) over re-reading whole large files.
- Avoid editing CLAUDE.md or settings mid-session: it invalidates the prompt cache and re-bills the whole conversation.
</token-efficiency>`;

try {
  const input = await readStdin();
  const cfg = loadOptimizerConfig();
  const mode = cfg.levers.efficiency_conventions || "suggest";
  const db = await openDbSafe();
  if (mode !== "observe") {
    emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: CONVENTIONS } });
  }
  logIntervention(db, {
    session_id: input.session_id, lever: "efficiency_conventions", mode,
    message: mode === "observe" ? "session started (observe only)" : "injected efficiency conventions",
  });
} catch { /* fail open */ }
process.exit(0);
