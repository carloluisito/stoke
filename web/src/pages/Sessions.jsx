import React, { useState, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useApi, Table, Section, AXIS, GRID, ChartTooltip } from "../components.jsx";
import { usd, tok, when, projectLabeler } from "../api.js";

export default function Sessions() {
  const { data: list } = useApi("/sessions?limit=100");
  const [sel, setSel] = useState(null);
  const { data: detail } = useApi(sel ? `/sessions/${sel}` : "/sessions?limit=0");
  const label = useMemo(() => projectLabeler((list || []).map(r => r.project)), [list]);
  if (!list) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  return (
    <div>
      {sel && Array.isArray(detail) && detail.length > 0 && (
        <Section title={`Per-turn cost — ${label(detail[0].project)} · ${sel.slice(0, 8)} (click a bar for detail)`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={detail.map((t, i) => ({ ...t, n: i + 1 }))} maxBarSize={22}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="n" {...AXIS} label={{ value: "turn", fill: "var(--muted)", fontSize: 11, position: "insideBottomRight", dy: 8 }} />
              <YAxis {...AXIS} tickFormatter={v => `$${v}`} width={44} />
              <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={
                <ChartTooltip rows={(payload) => {
                  const t = payload[0].payload;
                  return [
                    { name: "Cost", value: usd(t.cost_usd), color: "var(--s1)" },
                    { name: "Output tokens", value: tok(t.output_tokens) },
                    { name: "Fresh input", value: tok(t.input_tokens) },
                    { name: "Cache read", value: tok(t.cache_read) },
                    { name: "Cache write", value: tok(t.cache_write_5m + t.cache_write_1h) },
                  ];
                }} />
              } />
              <Bar dataKey="cost_usd" fill="var(--s1)" radius={[4, 4, 0, 0]} stroke="var(--surface)" strokeWidth={1} />
            </BarChart>
          </ResponsiveContainer>
        </Section>
      )}
      <Section title="Recent sessions — click a row to see its cost per turn">
        <Table
          rowKey={r => r.session_id}
          selectedKey={sel}
          cols={[
            { key: "started", label: "Started", render: r => when(r.started) },
            { key: "project", label: "Project", render: r => <span title={r.project}>{label(r.project)}</span> },
            { key: "model", label: "Model", render: r => r.model?.replace("claude-", "") },
            { key: "turns", label: "Turns", num: true },
            { key: "cost", label: "Cost", num: true, render: r => usd(r.cost) },
          ]}
          rows={list}
          onRowClick={r => setSel(r.session_id)}
        />
      </Section>
    </div>
  );
}
