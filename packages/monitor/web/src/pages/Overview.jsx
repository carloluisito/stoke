import React from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from "recharts";
import { useApi, Card, Section, Intro, AXIS, GRID, ChartTooltip } from "../components.jsx";
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
      <Intro>💡 <b>What am I spending on Claude Code?</b> Totals cover all your profiles and projects, priced from the official per-token rates. Green = money caching saved you. Net cost folds in the keep-alive proxy: spend + its pings − the rebuilds it prevented.</Intro>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Card label="Net cost today" value={usd(o.netCost?.netCostUsd)} sub={`spend ${usd(o.netCost?.spendUsd)} + pings ${usd(o.netCost?.pingSpendUsd)} − prevented ${usd(o.netCost?.preventedUsd)}`} />
        <Card label="Proxy" value={o.proxyUp ? "UP" : "DOWN"} sub={o.proxyUp ? "cache keep-alive active" : "keep-alive inactive — see Proxy tab"} accent={o.proxyUp ? "var(--good)" : "var(--critical)"} />
        <Card label="Last 7 days" value={usd(o.week)} sub="rolling week" />
        <Card label="Last 30 days" value={usd(o.month)} sub="rolling month" />
        <Card label="Saved by caching" value={usd(o.cacheSavedUsd)} sub="what the same work would have cost extra without the prompt cache" accent="var(--good)" />
      </div>
      <Section title="Daily spend — where the dollars go"
        hint="Each bar is one day's bill, split into the four things you pay for: Claude's responses (output), new text sent in (fresh input), saving context to cache, and re-reading cached context.">
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
          Reading it: a big <span style={{ color: "var(--s1)" }}>blue</span> share means long responses (the most expensive token type — 5× input price). Lots of <span style={{ color: "var(--s3)" }}>yellow</span> cache-write means context being rebuilt — often after cache expiries, which the Waste report prices out.
        </p>
      </Section>
    </div>
  );
}
