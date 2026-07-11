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
