import React, { useEffect, useState } from "react";
import { api } from "./api.js";

export function useApi(path, { refreshMs = 15000 } = {}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api(path).then(d => alive && setData(d)).catch(e => alive && setErr(e));
    load();
    const timer = refreshMs ? setInterval(load, refreshMs) : null;
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { alive = false; if (timer) clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [path, refreshMs]);
  return { data, err };
}

export function Card({ label, value, sub }) {
  return (
    <div style={{ background: "#1a1d24", borderRadius: 12, padding: 16, minWidth: 140 }}>
      <div style={{ opacity: 0.6, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ opacity: 0.6, fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

export function Table({ cols, rows, onRowClick }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr>{cols.map(c => <th key={c.key} style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #333", opacity: 0.6 }}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} onClick={onRowClick ? () => onRowClick(r) : undefined}
            style={{ cursor: onRowClick ? "pointer" : "default" }}>
            {cols.map(c => <td key={c.key} style={{ padding: "6px 8px", borderBottom: "1px solid #22252c" }}>{c.render ? c.render(r) : r[c.key]}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
