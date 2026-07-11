import React from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { useApi, Card } from "../components.jsx";
import { usd } from "../api.js";

export default function Overview() {
  const { data: o } = useApi("/overview");
  const { data: daily } = useApi("/spend/daily?days=30");
  if (!o || !daily) return <p>Loading…</p>;
  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <Card label="Today" value={usd(o.today)} />
        <Card label="Last 7 days" value={usd(o.week)} />
        <Card label="Last 30 days" value={usd(o.month)} />
        <Card label="Effective $/MTok" value={usd(o.effectiveDollarsPerMTok)} sub="blended, all token types" />
      </div>
      <h3>Daily spend (tokens by type)</h3>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={daily}>
          <XAxis dataKey="day" fontSize={11} />
          <YAxis fontSize={11} />
          <Tooltip contentStyle={{ background: "#1a1d24", border: "1px solid #333" }} />
          <Legend />
          <Area stackId="1" dataKey="input_tokens" name="fresh input" fill="#e4573d" stroke="#e4573d" />
          <Area stackId="1" dataKey="output_tokens" name="output" fill="#f2a33c" stroke="#f2a33c" />
          <Area stackId="1" dataKey="cache_write" name="cache write" fill="#8e6fd8" stroke="#8e6fd8" />
          <Area stackId="1" dataKey="cache_read" name="cache read (cheap)" fill="#3fa46a" stroke="#3fa46a" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
