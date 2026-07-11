import React, { useMemo } from "react";
import { useApi, Table, Section, Badge, Card } from "../components.jsx";
import { usd, when, projectLabeler } from "../api.js";

export default function WasteReport() {
  const { data: waste } = useApi("/waste");
  const { data: ttl } = useApi("/ttl-advice");
  const label = useMemo(() => projectLabeler((waste?.findings || []).map(f => f.project)), [waste]);
  if (!waste || !ttl) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  const total = waste.findings.reduce((a, f) => a + f.wastedUsd, 0);
  const switchable = ttl.filter(t => t.verdict === "switch-1h");
  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Card label="Identified waste" value={usd(total)} sub={`${waste.findings.length} findings`} accent="var(--serious)" />
        <Card label="Projects that should switch to 1h cache TTL" value={`${switchable.length}`} sub={switchable.map(s => label(s.project)).join(", ") || "none"} />
      </div>
      <Section title="Findings, biggest waste first">
        {waste.findings.length === 0 ? <p style={{ color: "var(--muted)" }}>No waste detected 🎉</p> : (
          <Table
            cols={[
              { key: "type", label: "Finding", render: r => <Badge type={r.type} /> },
              { key: "ts", label: "When", render: r => when(r.ts) },
              { key: "project", label: "Project", render: r => <span title={r.project}>{label(r.project)}</span> },
              { key: "wastedUsd", label: "Wasted", num: true, render: r => `${usd(r.wastedUsd)}${r.confidence === "estimate" ? " (est.)" : ""}` },
              { key: "recommendation", label: "What to do", wrap: true, render: r => <span style={{ color: "var(--ink-2)" }}>{r.recommendation}</span> },
            ]}
            rows={waste.findings}
          />
        )}
      </Section>
      <Section title="TTL advisor — would 1-hour caching pay off per project?">
        <Table
          cols={[
            { key: "project", label: "Project", render: r => <span title={r.project}>{label(r.project)}</span> },
            { key: "verdict", label: "Verdict", render: r => r.verdict === "switch-1h"
                ? <span style={{ color: "var(--good)", fontWeight: 600 }}>switch to 1h</span>
                : <span style={{ color: "var(--muted)" }}>keep 5m</span> },
            { key: "monthlyDeltaUsd", label: "Δ if switched", num: true, render: r => usd(r.monthlyDeltaUsd) },
            { key: "reasoning", label: "Why", wrap: true, render: r => <span style={{ color: "var(--ink-2)" }}>{r.reasoning}</span> },
          ]}
          rows={[...ttl].sort((a, b) => b.monthlyDeltaUsd - a.monthlyDeltaUsd)}
        />
      </Section>
      {waste.attribution.length > 0 && (
        <Section title="Optimizer savings attribution — waste rate before vs after each lever went live">
          <Table
            cols={[
              { key: "lever", label: "Lever" },
              { key: "eventsPerSessionBefore", label: "Events/session before", num: true, render: r => r.eventsPerSessionBefore.toFixed(2) },
              { key: "eventsPerSessionAfter", label: "After", num: true, render: r => r.eventsPerSessionAfter.toFixed(2) },
              { key: "estSavedUsd", label: "Est. saved", num: true, render: r => usd(r.estSavedUsd) },
            ]}
            rows={waste.attribution}
          />
        </Section>
      )}
    </div>
  );
}
