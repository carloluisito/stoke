import { ruleFor } from "../pricing.js";

const M = 1_000_000;
const FIVE_MIN = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const BLOAT_THRESHOLD = 120_000;
const BLOAT_BASELINE = 60_000;
const VERBOSE_OUTPUT = 3_000;
const VERBOSE_MEDIAN_MAX = 800;
const MISMATCH_MIN_COST = 0.5;
const MISMATCH_SHORT_OUTPUT = 300;
const MISMATCH_FRACTION = 0.6;

function allSessions(db) {
  const rows = db.prepare("SELECT * FROM turns ORDER BY session_id, ts").all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.session_id)) map.set(r.session_id, []);
    map.get(r.session_id).push(r);
  }
  return map;
}

function sessionTtlMs(turns) {
  return turns.some(t => t.cache_write_1h > 0) ? ONE_HOUR : FIVE_MIN;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function cacheRewriteEvents(turns, ttlMs) {
  // Turn N+1 re-wrote cache (read=0, writes>0) after prior cache activity.
  const events = [];
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1], cur = turns[i];
    const priorActivity = prev.cache_read > 0 || prev.cache_write_5m > 0 || prev.cache_write_1h > 0;
    const rewrote = cur.cache_read === 0 && (cur.cache_write_5m > 0 || cur.cache_write_1h > 0);
    if (!priorActivity || !rewrote) continue;
    const gapMs = new Date(cur.ts) - new Date(prev.ts);
    events.push({ turn: cur, gapMs, expired: gapMs > ttlMs });
  }
  return events;
}

function rewriteWaste(turn, rules) {
  const rule = ruleFor(turn.model, turn.ts, rules);
  if (!rule) return 0;
  const writeCost = turn.cache_write_5m / M * rule.cache_write_5m + turn.cache_write_1h / M * rule.cache_write_1h;
  const readCost = (turn.cache_write_5m + turn.cache_write_1h) / M * rule.cache_read;
  return writeCost - readCost;
}

export function runDetectors(db, rules) {
  const findings = [];
  for (const [sessionId, turns] of allSessions(db)) {
    const project = turns[0].project;
    const ttlMs = sessionTtlMs(turns);

    // cache_expiry / cache_invalidation
    for (const ev of cacheRewriteEvents(turns, ttlMs)) {
      const wastedUsd = rewriteWaste(ev.turn, rules);
      findings.push(ev.expired ? {
        type: "cache_expiry", session_id: sessionId, project, ts: ev.turn.ts, wastedUsd,
        recommendation: `Gap of ${Math.round(ev.gapMs / 60000)}m exceeded the ${Math.round(ttlMs / 60000)}m cache TTL; the full context was re-billed. Keep sessions active, or /clear when switching topics after a break.`,
        detail: { gapMinutes: Math.round(ev.gapMs / 60000), ttlMinutes: Math.round(ttlMs / 60000) },
      } : {
        type: "cache_invalidation", session_id: sessionId, project, ts: ev.turn.ts, wastedUsd,
        recommendation: "Cache prefix was invalidated mid-session (early context changed — e.g. CLAUDE.md or settings edit). Avoid mutating shared context during active sessions.",
        detail: { gapMinutes: Math.round(ev.gapMs / 60000), ttlMinutes: Math.round(ttlMs / 60000) },
      });
    }

    // session_bloat
    const last3 = turns.slice(-3);
    const meanContext = last3.reduce((a, t) => a + t.cache_read + t.input_tokens, 0) / last3.length;
    if (meanContext > BLOAT_THRESHOLD) {
      const rule = ruleFor(last3[0].model, last3[0].ts, rules);
      const wastedUsd = rule ? (meanContext - BLOAT_BASELINE) / M * rule.cache_read * 3 : 0;
      findings.push({
        type: "session_bloat", session_id: sessionId, project, ts: turns[turns.length - 1].ts, wastedUsd,
        recommendation: `Context is ~${Math.round(meanContext / 1000)}k tokens per turn. Run /compact, or /clear and restate the task, to stop re-billing dead context.`,
        detail: { meanContextTokens: Math.round(meanContext) },
      });
    }

    // output_verbosity
    const med = median(turns.map(t => t.output_tokens));
    if (med < VERBOSE_MEDIAN_MAX) {
      for (const t of turns) {
        if (t.output_tokens > VERBOSE_OUTPUT) {
          const rule = ruleFor(t.model, t.ts, rules);
          findings.push({
            type: "output_verbosity", session_id: sessionId, project, ts: t.ts,
            wastedUsd: rule ? (t.output_tokens - med) / M * rule.output : 0,
            recommendation: "Outlier long response in a normally terse session. Ask for concise output, or add a terseness convention (output tokens cost 5x input).",
            detail: { outputTokens: t.output_tokens, sessionMedian: med },
          });
        }
      }
    }

    // model_mismatch
    const isFrontier = /^claude-(opus|fable)/.test(turns[0].model);
    const cost = turns.reduce((a, t) => a + t.cost_usd, 0);
    const shortFrac = turns.filter(t => t.output_tokens < MISMATCH_SHORT_OUTPUT).length / turns.length;
    if (isFrontier && cost > MISMATCH_MIN_COST && shortFrac > MISMATCH_FRACTION) {
      findings.push({
        type: "model_mismatch", session_id: sessionId, project, ts: turns[0].ts,
        wastedUsd: 0.5 * cost, confidence: "estimate",
        recommendation: "Session looks dominated by mechanical tool loops on a frontier model. Delegate searches/exploration to the cheap-explore / cheap-search Haiku subagents.",
        detail: { sessionCostUsd: cost, shortTurnFraction: Number(shortFrac.toFixed(2)) },
      });
    }
  }
  return findings;
}

export function ttlAdvisor(db, rules) {
  const byProject = new Map();
  for (const [, turns] of allSessions(db)) {
    const p = turns[0].project;
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p).push(turns);
  }
  const out = [];
  for (const [project, sessionsList] of byProject) {
    let savings = 0;
    let premium = 0;
    for (const turns of sessionsList) {
      // Evaluate against 5m TTL: which rewrites would a 1h TTL have turned into reads?
      for (const ev of cacheRewriteEvents(turns, FIVE_MIN)) {
        if (ev.expired && ev.gapMs <= ONE_HOUR) savings += rewriteWaste(ev.turn, rules);
      }
      for (const t of turns) {
        const rule = ruleFor(t.model, t.ts, rules);
        if (rule) premium += t.cache_write_5m / M * (rule.cache_write_1h - rule.cache_write_5m);
      }
    }
    const delta = savings - premium;
    out.push({
      project,
      verdict: savings > 0 && delta > 0 ? "switch-1h" : "keep-5m",
      monthlyDeltaUsd: delta,
      reasoning: savings === 0
        ? "No cache-expiry losses observed; the 1h write premium (2x vs 1.25x) would be pure cost."
        : `Expiry losses recoverable with 1h TTL: $${savings.toFixed(2)}; extra 1h write premium: $${premium.toFixed(2)}.`,
    });
  }
  return out;
}

const LEVER_FINDING_TYPES = {
  cache_expiry_warning: ["cache_expiry", "cache_invalidation"],
  context_bloat_warning: ["session_bloat"],
  efficiency_conventions: ["output_verbosity", "model_mismatch"],
  wasteful_read_warning: [],
};

export function savingsAttribution(db, rules) {
  const findings = runDetectors(db, rules);
  const sessionStarts = new Map(
    db.prepare("SELECT session_id, MIN(ts) started FROM turns GROUP BY session_id").all()
      .map(r => [r.session_id, r.started])
  );
  const levers = db.prepare("SELECT lever, MIN(ts) first_ts FROM interventions GROUP BY lever").all();
  const out = [];
  for (const { lever, first_ts } of levers) {
    const types = LEVER_FINDING_TYPES[lever] || [];
    const related = findings.filter(f => types.includes(f.type));
    const before = [...sessionStarts].filter(([, ts]) => ts < first_ts).map(([id]) => id);
    const after = [...sessionStarts].filter(([, ts]) => ts >= first_ts).map(([id]) => id);
    const countIn = ids => related.filter(f => ids.includes(f.session_id)).length;
    const rateBefore = before.length ? countIn(before) / before.length : 0;
    const rateAfter = after.length ? countIn(after) / after.length : 0;
    const meanWasted = related.length ? related.reduce((a, f) => a + f.wastedUsd, 0) / related.length : 0;
    out.push({
      lever,
      eventsPerSessionBefore: rateBefore,
      eventsPerSessionAfter: rateAfter,
      estSavedUsd: Math.max(0, (rateBefore - rateAfter) * meanWasted * after.length),
    });
  }
  return out;
}
