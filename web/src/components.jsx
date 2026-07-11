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

export function Card({ label, value, sub, accent }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 18px", minWidth: 150, flex: 1 }}>
      <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, color: accent || "var(--ink)" }}>{value}</div>
      {sub && <div style={{ color: "var(--ink-2)", fontSize: 12, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function Section({ title, children }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 18, marginTop: 16 }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "var(--ink-2)", fontWeight: 600 }}>{title}</h3>
      {children}
    </div>
  );
}

export function Table({ cols, rows, onRowClick, selectedKey, rowKey }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} style={{ textAlign: c.num ? "right" : "left", padding: "6px 10px", borderBottom: "1px solid var(--baseline)", color: "var(--muted)", fontWeight: 500, whiteSpace: "nowrap" }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const selected = selectedKey && rowKey && rowKey(r) === selectedKey;
            return (
              <tr key={i} onClick={onRowClick ? () => onRowClick(r) : undefined}
                style={{ cursor: onRowClick ? "pointer" : "default", background: selected ? "rgba(57,135,229,0.12)" : "transparent" }}>
                {cols.map(c => (
                  <td key={c.key} style={{ textAlign: c.num ? "right" : "left", padding: "6px 10px", borderBottom: "1px solid var(--grid)", color: "var(--ink)", whiteSpace: c.wrap ? "normal" : "nowrap", maxWidth: c.wrap ? 480 : undefined }}>
                    {c.render ? c.render(r) : r[c.key]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const BADGES = {
  cache_expiry:       { color: "var(--critical)", icon: "⛔", label: "cache expiry" },
  cache_invalidation: { color: "var(--serious)",  icon: "⚠", label: "cache invalidation" },
  session_bloat:      { color: "var(--warning)",  icon: "⚠", label: "session bloat" },
  output_verbosity:   { color: "var(--warning)",  icon: "⚠", label: "verbose output" },
  model_mismatch:     { color: "var(--serious)",  icon: "⚠", label: "model mismatch" },
};

export function Badge({ type }) {
  const b = BADGES[type] || { color: "var(--muted)", icon: "•", label: type };
  return (
    <span style={{ color: b.color, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      {b.icon} {b.label}
    </span>
  );
}

// Shared recharts chrome — recessive solid hairlines, muted ink, no tick lines.
export const AXIS = { tick: { fill: "var(--muted)", fontSize: 11 }, axisLine: { stroke: "var(--baseline)" }, tickLine: false };
export const GRID = { stroke: "var(--grid)", vertical: false };

export function ChartTooltip({ active, payload, label, rows }) {
  if (!active || !payload?.length) return null;
  const items = rows ? rows(payload) : payload.map(p => ({ name: p.name, value: p.value, color: p.color }));
  return (
    <div style={{ background: "var(--page)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
      {label != null && <div style={{ color: "var(--muted)", marginBottom: 4 }}>{label}</div>}
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--ink)" }}>
          {it.color && <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color, display: "inline-block" }} />}
          <span style={{ color: "var(--ink-2)" }}>{it.name}</span>
          <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}
