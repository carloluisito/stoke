import React from "react";
import { useApi, Table } from "../components.jsx";

export default function OptimizerLog() {
  const { data } = useApi("/interventions");
  if (!data) return <p>Loading…</p>;
  if (data.length === 0) return <p style={{ opacity: 0.6 }}>No optimizer interventions logged yet.</p>;
  return (
    <Table
      cols={[
        { key: "ts", label: "When", render: r => r.ts?.slice(0, 19).replace("T", " ") },
        { key: "session_id", label: "Session", render: r => r.session_id?.slice(0, 8) },
        { key: "lever", label: "Lever" },
        { key: "mode", label: "Mode" },
        { key: "message", label: "Message" },
      ]}
      rows={data}
    />
  );
}
