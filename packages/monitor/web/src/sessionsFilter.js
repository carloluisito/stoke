// Pure client-side filtering + sorting for the sessions table, so the day-bar and
// project/model drill-downs work without any new server query params.
export function filterSessions(list, f = {}, nowMs = Date.now()) {
  const rangeDays = f.range === "today" ? 1 : f.range === "30d" ? 30 : 7;
  const q = (f.query || "").toLowerCase();
  return (list || []).filter((x) => {
    if (f.project && f.project !== "all" && x.project !== f.project) return false;
    if (f.model && f.model !== "all" && x.model !== f.model) return false;
    const when = x.started || x.ended || "";
    if (f.day && when.slice(0, 10) !== f.day) return false;
    const ts = new Date(when).getTime();
    if (Number.isFinite(ts) && (nowMs - ts) / 86400000 > rangeDays) return false;
    if (q && !(x.session_id || "").toLowerCase().includes(q) && !(x.project || "").toLowerCase().includes(q))
      return false;
    return true;
  });
}

export function sortSessions(rows, sort) {
  const s = sort.dir === "asc" ? 1 : -1;
  const key = sort.key;
  return [...rows].sort((a, b) => {
    let x = a[key];
    let y = b[key];
    if (key === "ttl") {
      x = a.ttlMs;
      y = b.ttlMs;
    }
    if (typeof x === "string") return x.localeCompare(y) * s;
    return ((x ?? 0) - (y ?? 0)) * s;
  });
}
