import React from "react";
import { useApi, Card, Section, Intro, Table } from "../components.jsx";
import { usd } from "../api.js";

const mins = (sec) => `${Math.round((sec ?? 0) / 60)}m`;

export default function Proxy() {
  const { data: p } = useApi("/proxy");
  if (!p) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  const t = p.today || {};
  const live = p.live;
  return (
    <div>
      <Intro>💡 <b>Is the cache keep-alive working?</b> The proxy pings your prompt cache just before it expires so resuming a session stays at 10% price. This page shows what those pings cost and what they saved — the same dollars the Overview nets together.</Intro>

      {!p.up && (
        <div style={{ background: "rgba(229,57,57,0.12)", border: "1px solid rgba(229,57,57,0.4)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 13 }}>
          ⚠ <b>Proxy is DOWN.</b> Cache keep-alive is inactive — idle sessions will go cold at the normal TTL. Start it with <code>stoke start</code>. Spend tracking on the other tabs keeps working.
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Card label="Proxy" value={p.up ? "UP" : "DOWN"} sub={p.up ? "keep-alive pings active" : "not running"} accent={p.up ? "var(--good)" : "var(--critical)"} />
        <Card label="Net saved today" value={usd(t.netSavedUsd)} sub="prevented rebuilds − ping spend" accent="var(--good)" />
        <Card label="Rebuilds prevented" value={`${t.rebuildsAvoided ?? 0}`} sub={`${usd(t.savedUsd)} that would have been re-billed`} />
        <Card label="Ping spend today" value={usd(t.pingSpendUsd)} sub={`${t.pingsFired ?? 0} pings fired · ${t.pingsSkipped ?? 0} skipped`} />
      </div>

      <Section title="Session resumes today" hint="What happened when a paused/idle session came back: survived = cache was still warm (the win), partial = some context re-billed, rebuilt = full re-bill (the ping missed).">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Card label="Survived" value={`${t.resumes?.survived ?? 0}`} accent="var(--good)" sub="cache outlasted the pause" />
          <Card label="Partial" value={`${t.resumes?.partial ?? 0}`} sub="some context re-billed" />
          <Card label="Rebuilt" value={`${t.resumes?.rebuilt ?? 0}`} accent="var(--critical)" sub="full re-bill on resume" />
        </div>
      </Section>

      {live && (
        <>
          <Section title="Ping budget" hint="The proxy caps what it may spend on pings; when a cap is hit it pauses pinging (and caches can then expire — the Waste report flags those with 'proxy could not prevent').">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Card label="Today" value={`${usd(live.budget?.spentToday)} / ${usd(live.budget?.dailyCapUsd)}`} sub="ping spend vs daily cap" />
              <Card label="This month" value={`${usd(live.budget?.spentMonth)} / ${usd(live.budget?.monthlyCapUsd)}`} sub="ping spend vs monthly cap" />
              <Card label="Uptime" value={mins(live.uptimeSeconds)} sub={`plan: ${live.plan ?? "?"}`} />
            </div>
          </Section>

          <Section title="Live sessions the proxy is keeping warm">
            <Table
              rowKey={r => r.key}
              cols={[
                { key: "projectPath", label: "Project", render: r => <span title={r.projectPath}>{r.projectPath?.split(/[\\/]/).slice(-2).join("/") || "unknown"}</span> },
                { key: "model", label: "Model", render: r => r.model?.replace("claude-", "") },
                { key: "cacheStatus", label: "Cache", render: r => (
                    <span style={{ color: r.cacheStatus === "warm" ? "var(--good)" : r.cacheStatus === "cold" ? "var(--critical)" : "var(--muted)", fontWeight: 600 }}>
                      {r.cacheStatus}
                    </span>
                  ) },
                { key: "detectedTtlSeconds", label: "TTL", render: r => mins(r.detectedTtlSeconds) },
                { key: "idleSec", label: "Idle", render: r => mins(r.idleSec) },
                { key: "pingCount5h", label: "Pings 5h", num: true },
                { key: "pingCostUsd5h", label: "Ping cost 5h", num: true, render: r => usd(r.pingCostUsd5h) },
                { key: "savedUsdAllTime", label: "Saved (all time)", num: true, render: r => usd(r.savedUsdAllTime) },
              ]}
              rows={live.sessions || []}
            />
            {(live.sessions || []).length === 0 && (
              <p style={{ color: "var(--muted)", fontSize: 12, margin: "8px 0 0" }}>No sessions tracked yet — start a Claude Code conversation through the proxy.</p>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
