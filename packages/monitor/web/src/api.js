export async function api(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export const usd = (n) => {
  const v = n ?? 0;
  if (v >= 100) return `$${Math.round(v).toLocaleString()}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(2)}`;
};

export const tok = (n) => {
  const v = n ?? 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(0)}k`;
  return `${v}`;
};

export const when = (ts) => (ts ? ts.slice(5, 16).replace("T", " ") : "");

export const ago = (ts) => {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// Always-two-decimals money, matching the design prototype ($1,234.56 style kept
// simple as $1234.56 for tabular alignment).
export const money = (n) => "$" + Number(n ?? 0).toFixed(2);
export const pct = (n) => (Number(n ?? 0) * 100).toFixed(1) + "%";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

// HH:MM:SS wall clock from an epoch ms or ISO string.
export const clock = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// "Jul 14, 09:12" from an ISO timestamp.
export const dateShort = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// "Jul 14" from a YYYY-MM-DD day string (UTC to match the day bucketing).
export const dayLabel = (day) => {
  const d = new Date(day + "T00:00:00Z");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

// "12s ago" / "5m ago" / "2h ago" from a whole-second count.
export const agoStr = (sec) => {
  if (sec < 60) return sec + "s ago";
  const m = Math.floor(sec / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h ago";
};

// M:SS from a second count (clamped at zero).
export const mmss = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 60) + ":" + pad(sec % 60);
};

export const typeLabel = (t) =>
  ({
    cache_expiry: "Cache expiry",
    cache_invalidation: "Cache invalidation",
    session_bloat: "Session bloat",
    output_verbosity: "Output verbosity",
    model_mismatch: "Model mismatch",
  }[t] || t);

export const typeBadge = (t) =>
  ({
    cache_expiry: "b-serious",
    session_bloat: "b-crit",
    cache_invalidation: "b-warn",
    output_verbosity: "b-warn",
    model_mismatch: "b-accent",
  }[t] || "b-dim");

export const verdictLabel = (v) =>
  ({ "switch-1h": "Switch to 1h", "switch-5m": "Switch to 5m", keep: "Keep current" }[v] || v);

export const evColor = (k) =>
  ({
    ping_fired: "var(--good)",
    prevented_rebuild: "var(--good)",
    session_resumed: "var(--accent)",
    real_request: "var(--dim)",
  }[k] || "var(--dim)");

// Projects are path-encoded dirs ("C--Users-me-Desktop-work-my-app"). Strip the
// longest common prefix across all projects so only the distinguishing tail shows.
export function projectLabeler(projects) {
  const names = [...new Set(projects)];
  if (names.length < 2) return (p) => p;
  let lcp = names[0];
  for (const n of names) {
    while (!n.startsWith(lcp)) lcp = lcp.slice(0, -1);
  }
  const cut = lcp.lastIndexOf("-") + 1; // cut at a segment boundary
  return (p) => p.slice(cut) || p;
}
