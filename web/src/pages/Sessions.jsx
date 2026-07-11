import React, { useState, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useApi, Table, Section, Intro, AXIS, GRID, ChartTooltip } from "../components.jsx";
import { usd, tok, ago, projectLabeler } from "../api.js";

// Live session state, judged against the session's own cache TTL.
function sessionStatus(r) {
  const gap = Date.now() - new Date(r.ended).getTime();
  if (gap < 2 * 60e3) return { icon: "●", label: "active", color: "var(--good)", title: "A turn completed in the last 2 minutes" };
  if (gap < r.ttlMs) return { icon: "◐", label: "cache warm", color: "var(--ink)", title: `Within the ${r.ttlMs / 60000}m cache TTL — resuming now reuses the cache cheaply` };
  return { icon: "○", label: "cache cold", color: "var(--muted)", title: "Past the cache TTL — resuming re-bills the full context at input price" };
}

export default function Sessions() {
  const { data: list } = useApi("/sessions?limit=100");
  const [sel, setSel] = useState(null);
  const { data: detail } = useApi(sel ? `/sessions/${sel}` : "/sessions?limit=0");
  const label = useMemo(() => projectLabeler((list || []).map(r => r.project)), [list]);
  if (!list) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  return (
    <div>
      <Intro>💡 <b>What did each conversation cost — and is it cheap to resume?</b> A session is one Claude Code conversation. While its cache is <b>warm</b>, continuing it reuses your context at 10% price; once <b>cold</b>, the next message re-bills everything at full price.</Intro>
      {sel && Array.isArray(detail) && detail.length > 0 && (
        <Section title={`Per-turn cost — ${label(detail[0].project)}`}
          hint="Each bar is one exchange (your message + Claude's reply). Tall bars are the expensive moments — hover to see why: big output, or a cache rebuild.">
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
            { key: "status", label: "Status", render: r => {
                const s = sessionStatus(r);
                return <span title={s.title} style={{ color: s.color, fontWeight: 600 }}>{s.icon} {s.label}</span>;
              } },
            { key: "ended", label: "Last activity", render: r => ago(r.ended) },
            { key: "project", label: "Project", render: r => <span title={r.project}>{label(r.project)}</span> },
            { key: "model", label: "Model", render: r => r.model?.replace("claude-", "") },
            { key: "turns", label: "Turns", num: true },
            { key: "cost", label: "Cost", num: true, render: r => usd(r.cost) },
          ]}
          rows={list}
          onRowClick={r => setSel(r.session_id)}
        />
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "8px 0 0" }}>
          ● active = turn in the last 2 min · ◐ cache warm = resuming is cheap · ○ cache cold = resuming re-bills full context
        </p>
      </Section>
    </div>
  );
}
