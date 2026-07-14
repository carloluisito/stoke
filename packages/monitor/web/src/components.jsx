import React, { useEffect, useState } from "react";
import { api } from "./api.js";

// Polls `path` every refreshMs (default 15s) and on window focus. Returns
// { data, err }. Pass refreshMs:0 to fetch once.
export function useApi(path, { refreshMs = 15000 } = {}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api(path)
        .then((d) => alive && (setData(d), setErr(null)))
        .catch((e) => alive && setErr(e));
    load();
    const timer = refreshMs ? setInterval(load, refreshMs) : null;
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [path, refreshMs]);
  return { data, err };
}

// Shimmer block sized by inline style.
export function Skeleton({ w, h, mt }) {
  return <div className="skel" style={{ width: w, height: h, marginTop: mt }} />;
}

// Honest empty state — says what is actually happening.
export function Empty({ title, children }) {
  return (
    <div className="empty">
      <div style={{ fontWeight: 600, color: "var(--text)" }}>{title}</div>
      {children && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

// One key/value stat tile.
export function Stat({ label, value, sub, accent, size }) {
  return (
    <div className="card">
      <div className="klabel">{label}</div>
      <div className="kval num" style={{ color: accent, fontSize: size }}>
        {value}
      </div>
      {sub != null && <div className="kdelta">{sub}</div>}
    </div>
  );
}

export function Badge({ cls = "b-dim", children }) {
  return <span className={`badge ${cls}`}>{children}</span>;
}
