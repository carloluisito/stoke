// The dashboard used to ship every finding to the browser — 1,087 objects and
// 438 KB on a 51-day-old database, growing without bound, re-fetched on a poll.
// Users act on causes, not individual incidents, so aggregate here and send the
// summary. The raw findings are still available un-rolled for the Leaks tab.

/**
 * @param {Array<{type:string,project?:string,ts:string,wastedUsd?:number}>} findings
 * @param {{days?:number, now?:Date, spendUsd?:number, topProjects?:number}} opts
 *   days: window size in days; 0 or negative means all-time.
 * @returns {{windowDays:number, spendUsd:number, avoidableUsd:number,
 *   avoidablePct:number, findingCount:number,
 *   causes:Array<{type:string,usd:number,count:number,topProject:string}>,
 *   byProject:Array<{project:string,usd:number}>, projectCount:number,
 *   byDay:Record<string,number>}}
 */
export function rollupFindings(findings, opts = {}) {
  const { days = 30, now = new Date(), spendUsd = 0, topProjects = 5 } = opts;
  const cutoff = days > 0 ? now.getTime() - days * 86400e3 : -Infinity;

  const inWindow = (findings || []).filter((f) => {
    const t = Date.parse(f?.ts);
    return Number.isFinite(t) ? t >= cutoff : false;
  });

  const byType = new Map(); // type -> { usd, count, projects: Map }
  const byProject = new Map(); // project -> usd
  const byDay = new Map(); // YYYY-MM-DD -> usd

  for (const f of inWindow) {
    const usd = Number(f.wastedUsd) || 0;
    const project = f.project || "unknown";

    let e = byType.get(f.type);
    if (!e) byType.set(f.type, (e = { usd: 0, count: 0, projects: new Map() }));
    e.usd += usd;
    e.count += 1;
    e.projects.set(project, (e.projects.get(project) || 0) + usd);

    byProject.set(project, (byProject.get(project) || 0) + usd);

    // Day key matches how costByDay buckets spend (substr(ts,1,10)) so the two
    // series line up on the trend chart.
    const day = String(f.ts).slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + usd);
  }

  const causes = [...byType.entries()]
    .map(([type, e]) => ({
      type,
      usd: e.usd,
      count: e.count,
      topProject: [...e.projects.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown",
    }))
    .sort((a, b) => b.usd - a.usd);

  const projects = [...byProject.entries()]
    .map(([project, usd]) => ({ project, usd }))
    .sort((a, b) => b.usd - a.usd);

  const avoidableUsd = causes.reduce((a, c) => a + c.usd, 0);

  return {
    windowDays: days,
    spendUsd,
    avoidableUsd,
    // Guard the divide — a fresh install has zero spend and must not render NaN%.
    avoidablePct: spendUsd > 0 ? avoidableUsd / spendUsd : 0,
    findingCount: inWindow.length,
    causes,
    byProject: projects.slice(0, topProjects),
    projectCount: projects.length,
    byDay: Object.fromEntries(byDay),
  };
}
