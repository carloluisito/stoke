import React, { useState } from "react";
import { useApi, Empty, Badge } from "../components.jsx";
import { go } from "../router.js";
import { money, dateShort, typeLabel, typeBadge } from "../api.js";

export default function Waste({ route }) {
  const isLog = route.parts[1] === "log";
  return (
    <>
      <div className="hr">
        <div>
          <div className="pagetitle">Waste</div>
          <div className="pagesub">Where money leaked, and what the optimizer did about it.</div>
        </div>
        <div className="seg" role="group" aria-label="Waste view">
          <button className={isLog ? "" : "on"} onClick={() => go("waste")}>Findings</button>
          <button className={isLog ? "on" : ""} onClick={() => go("waste/log")}>Optimizer log</button>
        </div>
      </div>
      {isLog ? <Log /> : <Findings />}
    </>
  );
}

function Findings() {
  const { data: waste } = useApi("/waste");
  const [type, setType] = useState("all");
  const [openId, setOpenId] = useState(null);

  if (!waste) return <div className="card"><div className="skel" style={{ width: "100%", height: 180 }} /></div>;

  const findings = waste.findings || [];
  const attribution = waste.attribution || [];
  const total = findings.reduce((a, f) => a + f.wastedUsd, 0);
  const byType = {};
  findings.forEach((f) => (byType[f.type] = (byType[f.type] || 0) + f.wastedUsd));
  const topType = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
  const attrSaved = attribution.reduce((a, x) => a + x.estSavedUsd, 0);
  const chips = ["all", ...Object.keys(byType)];
  const rows = (type === "all" ? findings : findings.filter((f) => f.type === type)).slice().sort((a, b) => b.wastedUsd - a.wastedUsd);

  if (!findings.length) return <Empty title="No waste findings">Nothing has leaked recently — the optimizer has nothing to flag.</Empty>;

  return (
    <>
      <div className="grid cards3 mb14">
        <div className="card"><div className="klabel">Total identified waste</div><div className="kval num" style={{ color: "var(--serious)" }}>{money(total)}</div><div className="kdelta">{findings.length} findings</div></div>
        <div className="card"><div className="klabel">Est. saved by optimizer</div><div className="kval num" style={{ color: "var(--good)" }}>{money(attrSaved)}</div><div className="kdelta">across {attribution.length} active levers</div></div>
        <div className="card"><div className="klabel">Top waste type</div><div className="kval" style={{ fontSize: 20 }}>{topType ? typeLabel(topType[0]) : "—"}</div><div className="kdelta">{topType ? money(topType[1]) : ""}</div></div>
      </div>

      <div className="filterbar mb14">
        {chips.map((c) => (
          <button key={c} className={`chipbtn ${type === c ? "on" : ""}`} onClick={() => setType(c)}>
            {c === "all" ? "All types" : typeLabel(c)}
          </button>
        ))}
      </div>

      <div className="card pad0 mb18">
        <table className="tbl">
          <thead>
            <tr>
              <th><span className="th">Type</span></th>
              <th><span className="th">Project</span></th>
              <th><span className="th">When</span></th>
              <th><span className="th rt" style={{ justifyContent: "flex-end" }}>Wasted</span></th>
              <th><span className="th" /></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => {
              const id = (f.session_id || "") + f.ts + i;
              const open = openId === id;
              const proxyNote = f.type === "cache_expiry" && (f.detail?.proxyWasUp || f.proxyWasUp);
              const toggle = () => setOpenId(open ? null : id);
              return (
                <React.Fragment key={id}>
                  <tr className="tr" tabIndex={0} onClick={toggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}>
                    <td><Badge cls={typeBadge(f.type)}>{typeLabel(f.type)}</Badge></td>
                    <td className="mono" style={{ fontSize: 12 }}>{f.project}</td>
                    <td className="num faint">{dateShort(f.ts)}</td>
                    <td className="rt num" style={{ fontWeight: 600, color: "var(--serious)" }}>{money(f.wastedUsd)}</td>
                    <td className="rt faint">{open ? "▲" : "▼"}</td>
                  </tr>
                  {open && (
                    <tr className="expand">
                      <td colSpan={5}>
                        <div className="expandin">
                          <div className="rec">{f.recommendation}</div>
                          {proxyNote && <div className="badge b-warn" style={{ alignSelf: "flex-start" }}>proxy was up but couldn't prevent it — check ping budget</div>}
                          {f.session_id && (
                            <div className="fx" style={{ gap: 10, flexWrap: "wrap" }}>
                              <button className="chipbtn" onClick={() => go("sessions/" + f.session_id)}>Open session waterfall →</button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="klabel mb14">Optimizer attribution — impact per lever</div>
      <div className="card">
        <div className="attr" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 9 }}>
          <span className="klabel">Lever</span>
          <span className="klabel rt">Events/session</span>
          <span className="klabel rt">Est. saved</span>
        </div>
        {attribution.map((a, i) => (
          <div key={i} className="attr">
            <span className="mono" style={{ fontWeight: 600 }}>{a.lever}</span>
            <span className="rt num"><span className="faint">{a.eventsPerSessionBefore?.toFixed(2)}</span> → <span style={{ color: "var(--good)" }}>{a.eventsPerSessionAfter?.toFixed(2)}</span></span>
            <span className="rt num" style={{ fontWeight: 600, color: "var(--good)" }}>{money(a.estSavedUsd)}</span>
          </div>
        ))}
        {!attribution.length && <div style={{ padding: "12px 0", color: "var(--dim)", fontSize: 12.5 }}>No optimizer attribution yet.</div>}
      </div>
    </>
  );
}

function Log() {
  const { data: interventions } = useApi("/interventions");
  if (!interventions) return <div className="card"><div className="skel" style={{ width: "100%", height: 160 }} /></div>;
  const badge = (mode) => (mode === "enforce" ? "b-crit" : mode === "warn" ? "b-warn" : "b-accent");
  if (!interventions.length) return <Empty title="No interventions logged">The optimizer hasn't needed to warn, gate or downshift anything.</Empty>;
  return (
    <>
      <div className="pagesub mb14">Live interventions the optimizer applied — soft warnings, hard gates and downshifts.</div>
      <div className="card pad0">
        {interventions.map((i, idx) => (
          <div key={idx} className="attr" style={{ gridTemplateColumns: "auto 1fr auto", padding: "14px 16px" }}>
            <Badge cls={badge(i.mode)}>{i.mode}</Badge>
            <div>
              <div style={{ fontWeight: 600 }}>{i.message}</div>
              <div className="faint mono" style={{ fontSize: 11.5, marginTop: 3 }}>{i.lever} · {i.project}</div>
            </div>
            <span className="num faint" style={{ fontSize: 12 }}>{dateShort(i.ts)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
