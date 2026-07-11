import React, { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useApi, Table } from "../components.jsx";
import { usd, tok } from "../api.js";

export default function Sessions() {
  const { data: list } = useApi("/sessions?limit=100");
  const [sel, setSel] = useState(null);
  const { data: detail } = useApi(sel ? `/sessions/${sel}` : "/sessions?limit=0");
  if (!list) return <p>Loading…</p>;
  return (
    <div>
      <Table
        cols={[
          { key: "session_id", label: "Session", render: r => r.session_id.slice(0, 8) },
          { key: "project", label: "Project" },
          { key: "model", label: "Model" },
          { key: "started", label: "Started", render: r => r.started?.slice(0, 16).replace("T", " ") },
          { key: "turns", label: "Turns" },
          { key: "cost", label: "Cost", render: r => usd(r.cost) },
        ]}
        rows={list}
        onRowClick={r => setSel(r.session_id)}
      />
      {sel && Array.isArray(detail) && detail.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3>Per-turn cost — {sel.slice(0, 8)}</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={detail.map((t, i) => ({ ...t, n: i + 1 }))}>
              <XAxis dataKey="n" fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip
                contentStyle={{ background: "#1a1d24", border: "1px solid #333" }}
                formatter={(v, n, { payload }) => [
                  `${usd(payload.cost_usd)} · in ${tok(payload.input_tokens)} out ${tok(payload.output_tokens)} · cache r ${tok(payload.cache_read)} w ${tok(payload.cache_write_5m + payload.cache_write_1h)}`,
                  "turn",
                ]}
              />
              <Bar dataKey="cost_usd" fill="#2f6feb" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
