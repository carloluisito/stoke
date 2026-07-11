import React, { useMemo } from "react";
import { useApi, Card, Section, Table, Badge } from "../components.jsx";
import { usd, tok, when, projectLabeler } from "../api.js";

export default function CacheHealth() {
  const { data: c } = useApi("/cache");
  const { data: o } = useApi("/overview");
  const { data: waste } = useApi("/waste");
  const events = useMemo(() => (waste?.findings || []).filter(f => f.type === "cache_expiry" || f.type === "cache_invalidation"), [waste]);
  const label = useMemo(() => projectLabeler(events.map(e => e.project)), [events]);
  if (!c || !waste || !o) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Card label="Cache hit rate" value={`${(c.hitRate * 100).toFixed(1)}%`} sub="reads ÷ (reads + fresh input)" />
        <Card label="Saved by caching" value={usd(o.cacheSavedUsd)} sub="vs full input price" accent="var(--good)" />
        <Card label="Tokens read from cache" value={tok(c.totalRead)} sub="billed at 10% of input price" />
        <Card label="Cache writes" value={`${tok(c.totalWrite5m)} · ${tok(c.totalWrite1h)}`} sub="5-minute TTL · 1-hour TTL" />
      </div>
      <Section title={`Cache loss events (${events.length}) — each one re-billed context at full price`}>
        {events.length === 0 ? <p style={{ color: "var(--muted)" }}>None detected 🎉</p> : (
          <Table
            cols={[
              { key: "type", label: "Event", render: r => <Badge type={r.type} /> },
              { key: "ts", label: "When", render: r => when(r.ts) },
              { key: "project", label: "Project", render: r => <span title={r.project}>{label(r.project)}</span> },
              { key: "wastedUsd", label: "Cost", num: true, render: r => usd(r.wastedUsd) },
              { key: "recommendation", label: "What to do", wrap: true, render: r => <span style={{ color: "var(--ink-2)" }}>{r.recommendation}</span> },
            ]}
            rows={events.sort((a, b) => b.wastedUsd - a.wastedUsd)}
          />
        )}
      </Section>
    </div>
  );
}
