import React, { useState } from "react";
import Overview from "./pages/Overview.jsx";
import Sessions from "./pages/Sessions.jsx";
import CacheHealth from "./pages/CacheHealth.jsx";
import WasteReport from "./pages/WasteReport.jsx";
import OptimizerLog from "./pages/OptimizerLog.jsx";

const TABS = {
  Overview: <Overview />,
  Sessions: <Sessions />,
  "Cache health": <CacheHealth />,
  "Waste report": <WasteReport />,
  "Optimizer log": <OptimizerLog />,
};

export default function App() {
  const [tab, setTab] = useState("Overview");
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 22 }}>💰 tokeff <span style={{ opacity: 0.5, fontSize: 14 }}>token efficiency</span></h1>
      <nav style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {Object.keys(TABS).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: "6px 14px", borderRadius: 8, border: "1px solid #333", cursor: "pointer",
              background: tab === t ? "#2f6feb" : "#1a1d24", color: "#e6e6e6",
            }}>
            {t}
          </button>
        ))}
      </nav>
      {TABS[tab]}
    </div>
  );
}
