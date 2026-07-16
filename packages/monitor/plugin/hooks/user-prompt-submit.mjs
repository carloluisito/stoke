import { readStdin, loadOptimizerConfig, openDbSafe, logIntervention, sessionTurns, sessionTtlMs, loadContext, emit } from "./lib.mjs";
import { effectiveContextTokens } from "../../src/context-sidecar.js";

// Agentic optimizer: in enforce mode each detection becomes a DIRECTIVE injected
// into Claude's context so the agent self-corrects this very turn — the brief
// systemMessage to the human is informational, never the mechanism.
try {
  const input = await readStdin();
  const cfg = loadOptimizerConfig();
  const db = await openDbSafe();
  const turns = sessionTurns(db, input.session_id);
  const notes = [];      // -> user (systemMessage)
  const directives = []; // -> Claude (additionalContext)
  const act = (lever) => (cfg.levers[lever] || "suggest") === "enforce";
  const on = (lever) => (cfg.levers[lever] || "suggest") !== "observe";

  // Effective current-context size: prefer the live statusline sidecar when it
  // is fresh, else fall back to the last recorded turn. This is what makes the
  // gate/warnings reflect reality right after /compact instead of the stale,
  // one-turn-behind DB value.
  const last = turns.length ? turns[turns.length - 1] : null;
  const lastCtx = last ? last.cache_read + last.input_tokens : 0;
  const ctx = effectiveContextTokens({ lastTurnCtx: lastCtx, sidecar: loadContext(input.session_id), now: Date.now() });

  // HARD GATE: above the block threshold, refuse the prompt entirely until the
  // context shrinks. Blocks at most once per assistant turn — after one block,
  // the next prompt passes (post-/compact the context is small again; if the
  // user pushed through without compacting, the next turn re-arms the gate).
  if (last && act("bloat_hard_gate")) {
    const blockAt = cfg.thresholds.blockContextTokens || 300000;
    if (ctx.tokens > blockAt) {
      const blockedSinceLastTurn = db?.prepare(
        "SELECT COUNT(*) c FROM interventions WHERE session_id = ? AND lever = 'bloat_hard_gate' AND ts > ?"
      ).get(input.session_id, last.ts)?.c > 0;
      if (!blockedSinceLastTurn) {
        const reason = `[tokeff] HARD GATE: this session re-bills ~${Math.round(ctx.tokens / 1000)}k context tokens per message (limit ${Math.round(blockAt / 1000)}k). Run /compact (or /clear and restate the task) before continuing. To push through anyway, just resend the prompt.`;
        logIntervention(db, { session_id: input.session_id, lever: "bloat_hard_gate", mode: "enforce", message: `BLOCKED prompt at ~${Math.round(ctx.tokens / 1000)}k context tokens` });
        emit({ decision: "block", reason });
        process.exit(0);
      }
    }
  }

  if (last) {
    const ttlMs = sessionTtlMs(turns);
    const gapMs = Date.now() - new Date(last.ts).getTime();
    const hadCache = last.cache_read > 0 || last.cache_write_5m > 0 || last.cache_write_1h > 0;

    if (on("cache_expiry_warning") && hadCache && gapMs > ttlMs) {
      const ctxK = Math.round(ctx.tokens / 1000);
      const gapM = Math.round(gapMs / 60000), ttlM = Math.round(ttlMs / 60000);
      notes.push(`[tokeff] Prompt cache expired (gap ${gapM}m > TTL ${ttlM}m) — this turn re-bills ~${ctxK}k context tokens at full input price.`);
      if (act("cache_expiry_warning")) {
        directives.push(`The prompt cache for this session expired (${gapM}m pause > ${ttlM}m TTL); this turn re-bills ~${ctxK}k context tokens at full input price. Minimize further damage: do not re-read files already in context, keep this turn tightly scoped, and if the user's new request is a fresh topic unrelated to the prior work, recommend a fresh session (or /clear) in one short line.`);
      }
      logIntervention(db, { session_id: input.session_id, lever: "cache_expiry_warning", mode: cfg.levers.cache_expiry_warning || "suggest", message: notes[notes.length - 1] });
    }

    const last3 = turns.slice(-3);
    const meanContext = last3.reduce((a, t) => a + t.cache_read + t.input_tokens, 0) / last3.length;
    // Trust the live sidecar number when fresh; else use the smoothed mean of
    // recent turns. Prevents a false "bloat" nudge right after /compact.
    const bloatCtx = ctx.source === "live" ? ctx.tokens : meanContext;
    if (on("context_bloat_warning") && bloatCtx > (cfg.thresholds.bloatContextTokens || 120000)) {
      const ctxK = Math.round(bloatCtx / 1000);
      notes.push(`[tokeff] Context is ~${ctxK}k tokens per turn. /compact (or /clear + restate the task) will stop re-billing dead context.`);
      if (act("context_bloat_warning")) {
        directives.push(`This session's context is ~${ctxK}k tokens per turn — every message re-bills it. Reduce spend autonomously: never re-read files already in context (use targeted ranges or grep); delegate any exploration or multi-file search to the cheap-explore / cheap-search subagents; keep your response minimal and free of restatement; and recommend /compact to the user in one short line at the end of your reply.`);
      }
      logIntervention(db, { session_id: input.session_id, lever: "context_bloat_warning", mode: cfg.levers.context_bloat_warning || "suggest", message: notes[notes.length - 1] });
    }

    const meanOut = last3.reduce((a, t) => a + t.output_tokens, 0) / last3.length;
    if (act("efficiency_conventions") && meanOut > (cfg.thresholds.verboseOutputTokens || 2500)) {
      directives.push(`Your last few responses averaged ~${Math.round(meanOut)} output tokens. Output tokens cost 5x input: tighten — lead with the outcome, cut restatement, boilerplate, and unrequested detail.`);
      logIntervention(db, { session_id: input.session_id, lever: "efficiency_conventions", mode: "enforce", message: `verbosity directive injected (mean output ~${Math.round(meanOut)} tokens over last 3 turns)` });
    }
  }

  const out = {};
  if (notes.length) out.systemMessage = notes.join("\n");
  if (directives.length) {
    out.hookSpecificOutput = {
      hookEventName: "UserPromptSubmit",
      additionalContext: `<tokeff-directives>\n${directives.join("\n\n")}\n</tokeff-directives>`,
    };
  }
  if (notes.length || directives.length) emit(out);
} catch { /* fail open */ }
process.exit(0);
