import { ruleFor } from "../pricing.js";

const M = 1_000_000;

// Daily spend broken down by cost component IN DOLLARS (not tokens) — dollar
// magnitudes are comparable across components; raw token counts are not.
export function costByDay(db, rules, { days = 30 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
  const rows = db.prepare(`SELECT substr(ts,1,10) day, model,
      SUM(input_tokens) i, SUM(output_tokens) o,
      SUM(cache_write_5m) w5, SUM(cache_write_1h) w1, SUM(cache_read) r
    FROM turns WHERE ts >= ? GROUP BY day, model ORDER BY day`).all(cutoff);
  const byDay = new Map();
  for (const x of rows) {
    const rule = ruleFor(x.model, x.day, rules);
    if (!rule) continue;
    const e = byDay.get(x.day) || { day: x.day, output: 0, input: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
    e.output += x.o / M * rule.output;
    e.input += x.i / M * rule.input;
    e.cacheWrite += x.w5 / M * rule.cache_write_5m + x.w1 / M * rule.cache_write_1h;
    e.cacheRead += x.r / M * rule.cache_read;
    e.total = e.output + e.input + e.cacheWrite + e.cacheRead;
    byDay.set(x.day, e);
  }
  return [...byDay.values()];
}

// What cache reads would have cost at full input price, minus what they cost.
export function cacheSavedUsd(db, rules, now = new Date()) {
  const today = now.toISOString();
  let saved = 0;
  for (const m of spendByModel(db)) {
    const rule = ruleFor(m.model, today, rules);
    if (rule) saved += (m.cache_read || 0) / M * (rule.input - rule.cache_read);
  }
  return saved;
}

export function spendByDay(db, { days = 30 } = {}) {
  return db.prepare(`SELECT substr(ts,1,10) day, SUM(cost_usd) cost,
    SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
    SUM(cache_read) cache_read, SUM(cache_write_5m + cache_write_1h) cache_write
    FROM turns WHERE ts >= ? GROUP BY day ORDER BY day`)
    .all(new Date(Date.now() - days * 86400e3).toISOString());
}

export function spendByProject(db) {
  return db.prepare(`SELECT project, SUM(cost_usd) cost, COUNT(*) turns FROM turns GROUP BY project ORDER BY cost DESC`).all();
}

export function spendByModel(db) {
  return db.prepare(`SELECT model, SUM(cost_usd) cost, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(cache_read) cache_read FROM turns GROUP BY model ORDER BY cost DESC`).all();
}

export function sessions(db, { limit = 50 } = {}) {
  return db.prepare(`SELECT session_id, project, MIN(ts) started, MAX(model) model, COUNT(*) turns, SUM(cost_usd) cost
    FROM turns GROUP BY session_id ORDER BY started DESC LIMIT ?`).all(limit);
}

export function sessionDetail(db, sessionId) {
  return db.prepare(`SELECT * FROM turns WHERE session_id = ? ORDER BY ts`).all(sessionId);
}

export function cacheStats(db) {
  const r = db.prepare(`SELECT SUM(cache_read) totalRead, SUM(cache_write_5m) totalWrite5m,
    SUM(cache_write_1h) totalWrite1h, SUM(input_tokens) freshInput FROM turns`).get();
  const totalRead = r.totalRead || 0;
  const fresh = r.freshInput || 0;
  return {
    totalRead,
    totalWrite5m: r.totalWrite5m || 0,
    totalWrite1h: r.totalWrite1h || 0,
    freshInput: fresh,
    hitRate: totalRead + fresh > 0 ? totalRead / (totalRead + fresh) : 0,
  };
}

export function overview(db, now = new Date()) {
  const dayStart = now.toISOString().slice(0, 10);
  const weekStart = new Date(now - 7 * 86400e3).toISOString();
  const monthStart = new Date(now - 30 * 86400e3).toISOString();
  const q = db.prepare("SELECT SUM(cost_usd) c FROM turns WHERE ts >= ?");
  const tot = db.prepare(`SELECT SUM(cost_usd) c, SUM(input_tokens + output_tokens + cache_read + cache_write_5m + cache_write_1h) t FROM turns`).get();
  return {
    today: q.get(dayStart).c || 0,
    week: q.get(weekStart).c || 0,
    month: q.get(monthStart).c || 0,
    effectiveDollarsPerMTok: tot.t ? (tot.c / tot.t) * 1_000_000 : 0,
  };
}
