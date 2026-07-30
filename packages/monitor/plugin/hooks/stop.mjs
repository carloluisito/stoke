import { readStdin, loadOptimizerConfig, openDbSafe, logIntervention, sessionTurns, saveSessionState } from "./lib.mjs";

try {
  const input = await readStdin();
  // The turn finished, so the user is now idle at the prompt and any further
  // keepalive ping is speculative. Recorded before the DB work so a database
  // problem cannot lose the signal.
  saveSessionState(input.session_id, "idle", input.cwd);
  const cfg = loadOptimizerConfig();
  const mode = cfg.levers.session_cost_record || "enforce";
  if (mode !== "observe") {
    const db = await openDbSafe();
    const turns = sessionTurns(db, input.session_id);
    const cost = turns.reduce((a, t) => a + (t.cost_usd || 0), 0);
    logIntervention(db, {
      session_id: input.session_id, lever: "session_cost_record", mode,
      message: `session cost so far: $${cost.toFixed(4)} across ${turns.length} turns`,
    });
  }
} catch { /* fail open */ }
process.exit(0);
