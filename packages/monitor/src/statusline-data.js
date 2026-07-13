const FIVE_MIN = 300_000;
const ONE_HOUR = 3600_000;

export function statuslineData(db, sessionId, now = Date.now()) {
  const turns = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY ts").all(sessionId);
  const sessionCost = turns.reduce((a, t) => a + (t.cost_usd || 0), 0);
  const today = new Date(now).toISOString().slice(0, 10);
  const todayCost = db.prepare("SELECT SUM(cost_usd) c FROM turns WHERE ts >= ?").get(today).c || 0;
  let cacheWarm = false;
  if (turns.length > 0) {
    const last = turns[turns.length - 1];
    const ttl = turns.some(t => t.cache_write_1h > 0) ? ONE_HOUR : FIVE_MIN;
    const hadCache = last.cache_read > 0 || last.cache_write_5m > 0 || last.cache_write_1h > 0;
    cacheWarm = hadCache && now - new Date(last.ts).getTime() < ttl;
  }
  return { sessionCost, todayCost, cacheWarm };
}
