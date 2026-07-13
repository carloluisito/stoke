import { readStdin, loadOptimizerConfig, openDbSafe, logIntervention, sessionTurns } from "./lib.mjs";

try {
  const input = await readStdin();
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
