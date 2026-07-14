import { useEffect, useState } from "react";

// Hash routes: #overview | #sessions?project=&model=&day= | #sessions/<id>
//              | #proxy | #waste | #waste/log
export function parseHash(hash) {
  const h = (hash || "").replace(/^#\/?/, "");
  const [p, qs] = h.split("?");
  const parts = p.split("/").filter(Boolean);
  const query = {};
  new URLSearchParams(qs || "").forEach((v, k) => (query[k] = v));
  return { tab: parts[0] || "overview", parts, query };
}

export function go(hash) {
  location.hash = hash;
}

// Build "#sessions?project=…" from a partial query, dropping "all"/empty values.
export function sessionsHash(query) {
  const p = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (v && v !== "all") p[k] = v;
  }
  const s = new URLSearchParams(p).toString();
  return "sessions" + (s ? "?" + s : "");
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    if (!location.hash) location.hash = "overview";
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}
