// Dumps exactly the figures the stoke deck needs, and nothing else.
// Project names and session ids are deliberately not included.
const PORT = process.env.STOKE_PORT || 5599;
const base = `http://127.0.0.1:${PORT}/api`;
const get = async (p) => {
  const r = await fetch(base + p);
  if (!r.ok) throw new Error(`${r.status} on ${p}`);
  return r.json();
};
const r2 = (n) => Math.round((n || 0) * 100) / 100;

try {
  const [daily, waste, p30, pAll] = await Promise.all([
    get("/spend/daily-cost?days=30"),
    get("/waste?days=30&rollup=1"),
    get("/proxy/savings?days=30"),
    get("/proxy/savings?days=all"),
  ]);

  const sum = (k) => daily.reduce((a, d) => a + (d[k] || 0), 0);
  const worst = daily.reduce((a, d) => (d.total > (a?.total || 0) ? d : a), null);
  const active = daily.filter((d) => d.total > 0).length;

  console.log(JSON.stringify({
    windowDays: 30,
    days: { withSpend: active, of: daily.length, first: daily[0]?.day, last: daily.at(-1)?.day },
    spend: {
      total: r2(sum("total")),
      cacheRead: r2(sum("cacheRead")),
      cacheWrite: r2(sum("cacheWrite")),
      output: r2(sum("output")),
      input: r2(sum("input")),
      worstDay: { day: worst?.day, usd: r2(worst?.total) },
    },
    avoidable: {
      usd: r2(waste.avoidableUsd),
      pct: r2((waste.avoidablePct || 0) * 100),
      findings: waste.findingCount,
      projects: waste.projectCount,
      // cause type + dollars + count only; no project names
      causes: (waste.causes || []).map((c) => ({ type: c.type, usd: r2(c.usd), count: c.count })),
    },
    keepAlive: {
      last30: { grossUsd: r2(p30.savedUsd), pingUsd: r2(p30.pingSpendUsd), netUsd: r2(p30.netSavedUsd), rebuildsAvoided: p30.rebuildsAvoided },
      allTime: { grossUsd: r2(pAll.savedUsd), pingUsd: r2(pAll.pingSpendUsd), netUsd: r2(pAll.netSavedUsd), rebuildsAvoided: pAll.rebuildsAvoided },
    },
  }, null, 1));
} catch (e) {
  console.error("FAILED:", e.message);
  console.error(`Is the monitor running? Try http://127.0.0.1:${PORT} in a browser, or set STOKE_PORT.`);
  process.exit(1);
}
