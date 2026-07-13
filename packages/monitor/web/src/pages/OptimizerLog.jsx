import React, { useMemo } from "react";
import { useApi, Table, Section, Intro } from "../components.jsx";
import { ago, projectLabeler } from "../api.js";

export default function OptimizerLog() {
  const { data } = useApi("/interventions");
  const label = useMemo(() => projectLabeler((data || []).map(r => r.project).filter(Boolean)), [data]);
  if (!data) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  return (
    <div>
    <Intro>💡 <b>What has the optimizer done in my sessions?</b> The optimizer never acts silently — every warning it showed you and every instruction it gave Claude is recorded here, so you can audit it.</Intro>
    <Section title="Intervention history">
      {data.length === 0 ? <p style={{ color: "var(--muted)" }}>No optimizer interventions logged yet. They appear as you use Claude Code with the hooks installed.</p> : (
        <Table
          cols={[
            { key: "ts", label: "When", render: r => ago(r.ts) },
            { key: "project", label: "Project", render: r => r.project
                ? <span title={r.project}>{label(r.project)}</span>
                : <span style={{ color: "var(--muted)" }}>session had no billed turns yet</span> },
            { key: "lever", label: "Lever", render: r => r.lever.replaceAll("_", " ") },
            { key: "mode", label: "Mode" },
            { key: "message", label: "What it did", wrap: true, render: r => <span style={{ color: "var(--ink-2)" }}>{r.message}</span> },
          ]}
          rows={data}
        />
      )}
    </Section>
    </div>
  );
}
