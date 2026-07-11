import React from "react";
import { useApi, Table, Section } from "../components.jsx";
import { when } from "../api.js";

export default function OptimizerLog() {
  const { data } = useApi("/interventions");
  if (!data) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  return (
    <Section title="Every intervention the optimizer made — full audit trail">
      {data.length === 0 ? <p style={{ color: "var(--muted)" }}>No optimizer interventions logged yet. They appear as you use Claude Code with the hooks installed.</p> : (
        <Table
          cols={[
            { key: "ts", label: "When", render: r => when(r.ts) },
            { key: "session_id", label: "Session", render: r => r.session_id?.slice(0, 8) },
            { key: "lever", label: "Lever" },
            { key: "mode", label: "Mode" },
            { key: "message", label: "Message", wrap: true, render: r => <span style={{ color: "var(--ink-2)" }}>{r.message}</span> },
          ]}
          rows={data}
        />
      )}
    </Section>
  );
}
