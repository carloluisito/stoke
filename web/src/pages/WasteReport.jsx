import React from "react";
import { useApi, Table } from "../components.jsx";
import { usd } from "../api.js";

const BADGE = {
  cache_expiry: "#e4573d", cache_invalidation: "#f2a33c", session_bloat: "#8e6fd8",
  output_verbosity: "#3fa46a", model_mismatch: "#2f6feb",
};

export default function WasteReport() {
  const { data: waste } = useApi("/waste");
  const { data: ttl } = useApi("/ttl-advice");
  if (!waste || !ttl) return <p>Loading…</p>;
  return (
    <div>
      <h3>Findings (ranked by wasted $)</h3>
      {waste.findings.length === 0 ? <p style={{ opacity: 0.6 }}>No waste detected 🎉</p> : (
        <Table
          cols={[
            { key: "type", label: "Type", render: r => <span style={{ background: BADGE[r.type] || "#555", borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>{r.type}</span> },
            { key: "session_id", label: "Session", render: r => r.session_id?.slice(0, 8) },
            { key: "wastedUsd", label: "Wasted", render: r => `${usd(r.wastedUsd)}${r.confidence === "estimate" ? " (est.)" : ""}` },
            { key: "recommendation", label: "Recommendation" },
          ]}
          rows={waste.findings}
        />
      )}
      <h3 style={{ marginTop: 28 }}>TTL advisor</h3>
      <Table
        cols={[
          { key: "project", label: "Project" },
          { key: "verdict", label: "Verdict" },
          { key: "monthlyDeltaUsd", label: "Δ if switched", render: r => usd(r.monthlyDeltaUsd) },
          { key: "reasoning", label: "Reasoning" },
        ]}
        rows={ttl}
      />
      {waste.attribution.length > 0 && (
        <>
          <h3 style={{ marginTop: 28 }}>Optimizer savings attribution</h3>
          <Table
            cols={[
              { key: "lever", label: "Lever" },
              { key: "eventsPerSessionBefore", label: "Waste events/session before", render: r => r.eventsPerSessionBefore.toFixed(2) },
              { key: "eventsPerSessionAfter", label: "After", render: r => r.eventsPerSessionAfter.toFixed(2) },
              { key: "estSavedUsd", label: "Est. saved", render: r => usd(r.estSavedUsd) },
            ]}
            rows={waste.attribution}
          />
        </>
      )}
    </div>
  );
}
