import React, { useMemo } from "react";
import { useApi, Card, Section, Intro, Table, Badge } from "../components.jsx";
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
      <Intro>💡 <b>Is the prompt cache doing its job?</b> Claude Code re-sends your whole conversation on every message; the cache re-serves that history at ~10% of the normal price. This page shows how much that saves — and every event where the cache broke and you paid full price again.</Intro>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Card label="Cache hit rate" value={`${(c.hitRate * 100).toFixed(1)}%`} sub="reads ÷ (reads + fresh input)" />
        <Card label="Saved by caching" value={usd(o.cacheSavedUsd)} sub="vs full input price" accent="var(--good)" />
        <Card label="Tokens read from cache" value={tok(c.totalRead)} sub="billed at 10% of input price" />
        <Card label="Cache writes" value={`${tok(c.totalWrite5m)} · ${tok(c.totalWrite1h)}`} sub="5-minute TTL · 1-hour TTL" />
      </div>
      <Section title={`Cache loss events (${events.length})`}
        hint="⛔ expiry = you paused longer than the cache lifetime (5 min or 1 h). ⚠ invalidation = something changed early context mid-session (e.g. editing CLAUDE.md). Either way, the next message rebuilt the cache at full price — that rebuild is the cost shown.">
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
