import React from "react";
import { useApi, Card, Table } from "../components.jsx";
import { usd, tok } from "../api.js";

export default function CacheHealth() {
  const { data: c } = useApi("/cache");
  const { data: waste } = useApi("/waste");
  if (!c || !waste) return <p>Loading…</p>;
  const events = waste.findings.filter(f => f.type === "cache_expiry" || f.type === "cache_invalidation");
  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <Card label="Cache hit rate" value={`${(c.hitRate * 100).toFixed(1)}%`} sub="reads / (reads + fresh input)" />
        <Card label="Cache reads" value={tok(c.totalRead)} />
        <Card label="Writes (5m TTL)" value={tok(c.totalWrite5m)} />
        <Card label="Writes (1h TTL)" value={tok(c.totalWrite1h)} />
      </div>
      <h3>Cache loss events</h3>
      {events.length === 0 ? <p style={{ opacity: 0.6 }}>None detected 🎉</p> : (
        <Table
          cols={[
            { key: "type", label: "Type" },
            { key: "session_id", label: "Session", render: r => r.session_id?.slice(0, 8) },
            { key: "ts", label: "When", render: r => r.ts?.slice(0, 16).replace("T", " ") },
            { key: "wastedUsd", label: "Wasted", render: r => usd(r.wastedUsd) },
            { key: "recommendation", label: "Recommendation" },
          ]}
          rows={events}
        />
      )}
    </div>
  );
}
