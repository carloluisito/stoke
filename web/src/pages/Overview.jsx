import React from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from "recharts";
import { useApi, Card, Section, AXIS, GRID, ChartTooltip } from "../components.jsx";
import { usd } from "../api.js";

// Fixed categorical assignment — output first (it's the 5x-priced component).
const SERIES = [
  { key: "output", name: "Output", color: "var(--s1)" },
  { key: "input", name: "Fresh input", color: "var(--s2)" },
  { key: "cacheWrite", name: "Cache write", color: "var(--s3)" },
  { key: "cacheRead", name: "Cache read", color: "var(--s4)" },
];

export default function Overview() {
  const { data: o } = useApi("/overview");
  const { data: daily } = useApi("/spend/daily-cost?days=30");
  if (!o || !daily) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Card label="Today" value={usd(o.today)} />
        <Card label="Last 7 days" value={usd(o.week)} />
        <Card label="Last 30 days" value={usd(o.month)} />
        <Card label="Saved by caching" value={usd(o.cacheSavedUsd)} sub="vs paying full input price" accent="var(--good)" />
      </div>
      <Section title="Daily spend — where the dollars go">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={daily.map(d => ({ ...d, dayLabel: d.day.slice(5) }))} maxBarSize={26}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="dayLabel" {...AXIS} />
            <YAxis {...AXIS} tickFormatter={v => `$${v}`} width={44} />
            <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={
              <ChartTooltip rows={(payload) => [
                ...payload.map(p => ({ name: p.name, value: usd(p.value), color: p.color })).reverse(),
                { name: "Total", value: usd(payload.reduce((a, p) => a + p.value, 0)) },
              ]} />
            } />
            <Legend wrapperStyle={{ fontSize: 12, color: "var(--ink-2)" }} />
            {SERIES.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.name} stackId="usd" fill={s.color}
                stroke="var(--surface)" strokeWidth={1}
                radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "8px 0 0" }}>
          All segments are dollars, so sizes are directly comparable. Output tokens cost 5× input; cache reads are the cheap green slice doing most of the volume.
        </p>
      </Section>
    </div>
  );
}
