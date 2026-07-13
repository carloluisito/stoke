import React, { useState } from "react";
import Overview from "./pages/Overview.jsx";
import Sessions from "./pages/Sessions.jsx";
import CacheHealth from "./pages/CacheHealth.jsx";
import WasteReport from "./pages/WasteReport.jsx";
import OptimizerLog from "./pages/OptimizerLog.jsx";
import Proxy from "./pages/Proxy.jsx";

const TABS = {
  Overview: <Overview />,
  Sessions: <Sessions />,
  Proxy: <Proxy />,
  "Cache health": <CacheHealth />,
  "Waste report": <WasteReport />,
  "Optimizer log": <OptimizerLog />,
};

export default function App() {
  const [tab, setTab] = useState("Overview");
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>🔥 stoke</h1>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 16px" }}>cache keep-alive + token spend · live, refreshes every 15s</p>
      <nav style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        {Object.keys(TABS).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13,
              border: tab === t ? "1px solid var(--s1)" : "1px solid var(--border)",
              background: tab === t ? "rgba(57,135,229,0.15)" : "var(--surface)",
              color: tab === t ? "var(--ink)" : "var(--ink-2)",
            }}>
            {t}
          </button>
        ))}
      </nav>
      {TABS[tab]}
    </div>
  );
}
