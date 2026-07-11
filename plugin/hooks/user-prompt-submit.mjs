import { readStdin, loadOptimizerConfig, openDbSafe, logIntervention, sessionTurns, sessionTtlMs, emit } from "./lib.mjs";

try {
  const input = await readStdin();
  const cfg = loadOptimizerConfig();
  const db = await openDbSafe();
  const turns = sessionTurns(db, input.session_id);
  const warnings = [];

  if (turns.length > 0) {
    const last = turns[turns.length - 1];
    const ttlMs = sessionTtlMs(turns);
    const gapMs = Date.now() - new Date(last.ts).getTime();
    const hadCache = last.cache_read > 0 || last.cache_write_5m > 0 || last.cache_write_1h > 0;
    const expiryMode = cfg.levers.cache_expiry_warning || "suggest";
    if (hadCache && gapMs > ttlMs && expiryMode !== "observe") {
      const ctxTokens = last.cache_read + last.input_tokens;
      warnings.push(`[tokeff] Prompt cache likely expired (gap ${Math.round(gapMs / 60000)}m > TTL ${Math.round(ttlMs / 60000)}m). This turn will re-bill ~${Math.round(ctxTokens / 1000)}k context tokens at full input price. If you're starting a new topic, /clear is cheaper.`);
      logIntervention(db, { session_id: input.session_id, lever: "cache_expiry_warning", mode: expiryMode, message: warnings[warnings.length - 1] });
    }

    const bloatMode = cfg.levers.context_bloat_warning || "suggest";
    const last3 = turns.slice(-3);
    const meanContext = last3.reduce((a, t) => a + t.cache_read + t.input_tokens, 0) / last3.length;
    if (meanContext > (cfg.thresholds.bloatContextTokens || 120000) && bloatMode !== "observe") {
      warnings.push(`[tokeff] Context is ~${Math.round(meanContext / 1000)}k tokens per turn. /compact (or /clear + restate the task) will stop re-billing dead context.`);
      logIntervention(db, { session_id: input.session_id, lever: "context_bloat_warning", mode: bloatMode, message: warnings[warnings.length - 1] });
    }
  }

  if (warnings.length > 0) emit({ systemMessage: warnings.join("\n") });
} catch { /* fail open */ }
process.exit(0);
