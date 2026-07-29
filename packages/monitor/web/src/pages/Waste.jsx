import React, { useState } from "react";
import { useApi, Empty, Badge } from "../components.jsx";
import { go } from "../router.js";
import { money, dateShort, typeLabel, typeBadge } from "../api.js";
import { projectName } from "../lib/projectName.js";
import { causeFor, fixLabel, interventionCopy, KIND_BADGE } from "../lib/causes.js";

// Success criterion: no unpaginated list longer than this.
const PAGE = 25;

export default function Waste({ route }) {
  const isLog = route.parts[1] === "log";
  return (
    <>
      <div className="hr">
        <div>
          <div className="pagetitle">Leaks</div>
          <div className="pagesub">Every avoidable charge stoke found, and what it did about them.</div>
        </div>
        <div className="seg" role="group" aria-label="Leaks view">
          <button className={isLog ? "" : "on"} onClick={() => go("waste")}>Charges</button>
          <button className={isLog ? "on" : ""} onClick={() => go("waste/log")}>What stoke did</button>
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
  // Default to 30 days. Unscoped, the totals were silently lifetime figures on a
  // list that grows without bound (1,087 rows / 66,000px at the time of writing).
  const [days, setDays] = useState(30);
  const [showAll, setShowAll] = useState(false);

  if (!waste) return <div className="card"><div className="skel" style={{ width: "100%", height: 180 }} /></div>;

  const all = waste.findings || [];
  const cutoff = Date.now() - days * 86400e3;
  const findings = days === 0 ? all : all.filter((f) => Date.parse(f.ts) >= cutoff);
  const attribution = waste.attribution || [];
  const total = findings.reduce((a, f) => a + f.wastedUsd, 0);
  const byType = {};
  findings.forEach((f) => (byType[f.type] = (byType[f.type] || 0) + f.wastedUsd));
  const topType = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
  const attrSaved = attribution.reduce((a, x) => a + x.estSavedUsd, 0);
  const chips = ["all", ...Object.keys(byType)];
  const matching = (type === "all" ? findings : findings.filter((f) => f.type === type))
    .slice()
    .sort((a, b) => b.wastedUsd - a.wastedUsd);
  // Never render an unbounded list. This table used to be 1,087 rows / 66,000px.
  const rows = showAll ? matching : matching.slice(0, PAGE);
  const hidden = matching.length - rows.length;

  const ranges = [[30, "30 days"], [7, "7 days"], [0, "All time"]];
  const RangePicker = (
    <div className="filterbar mb14">
      {ranges.map(([v, l]) => (
        <button key={v} className={`chipbtn ${days === v ? "on" : ""}`} onClick={() => setDays(v)}>{l}</button>
      ))}
      {chips.length > 1 && <span className="filtersep" />}
      {chips.map((c) => (
        <button key={c} className={`chipbtn ${type === c ? "on" : ""}`} onClick={() => setType(c)}>
          {c === "all" ? "All causes" : causeFor(c).title}
        </button>
      ))}
    </div>
  );

  if (!findings.length) {
    return (
      <>
        {RangePicker}
        <Empty title={days === 0 ? "No leaks found" : `No leaks in the last ${days} days`}>
          {days === 0
            ? "Nothing avoidable has been detected yet."
            : "Nothing avoidable in this window — widen the range to see older findings."}
        </Empty>
      </>
    );
  }

  return (
    <>
      <div className="grid cards3 mb14">
        <div className="card">
          <div className="klabel">Avoidable · {days === 0 ? "all time" : `last ${days} days`}</div>
          <div className="kval num" style={{ color: "var(--serious)" }}>{money(total)}</div>
          <div className="kdelta">{findings.length} charges</div>
        </div>
        <div className="card">
          <div className="klabel">Already prevented by stoke</div>
          <div className="kval num" style={{ color: "var(--good)" }}>{money(attrSaved)}</div>
          <div className="kdelta">across {attribution.length} automatic fixes</div>
        </div>
        <div className="card">
          <div className="klabel">Biggest cause</div>
          <div className="kval" style={{ fontSize: 17, lineHeight: 1.3 }}>{topType ? causeFor(topType[0]).title : "—"}</div>
          <div className="kdelta">{topType ? money(topType[1]) : ""}</div>
        </div>
      </div>

      {RangePicker}

      <div className="card pad0 mb18">
        <table className="tbl">
          <thead>
            <tr>
              <th><span className="th">Cause</span></th>
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
                    {/* typeLabel keeps the short engineering name in the table,
                        where the column is narrow; the plain-language title is in
                        the filter chips and the expanded row. */}
                    <td className="mono" style={{ fontSize: 12 }} title={f.project}>{projectName(f.project)}</td>
                    <td className="num faint">{dateShort(f.ts)}</td>
                    <td className="rt num" style={{ fontWeight: 600, color: "var(--serious)" }}>{money(f.wastedUsd)}</td>
                    <td className="rt faint">{open ? "▲" : "▼"}</td>
                  </tr>
                  {open && (
                    <tr className="expand">
                      <td colSpan={5}>
                        <div className="expandin">
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{causeFor(f.type).title}</div>
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
        {hidden > 0 && (
          <div className="morelink" style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", margin: 0 }}>
            Showing the {rows.length} costliest of {matching.length}.{" "}
            <button onClick={() => setShowAll(true)}>Show all {matching.length} →</button>
          </div>
        )}
        {showAll && matching.length > PAGE && (
          <div className="morelink" style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", margin: 0 }}>
            <button onClick={() => setShowAll(false)}>Show only the {PAGE} costliest</button>
          </div>
        )}
      </div>

      <div className="klabel mb14">What stoke fixed automatically</div>
      <div className="card">
        <div className="attr" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 9 }}>
          <span className="klabel">Fix</span>
          <span className="klabel rt">Before → after</span>
          <span className="klabel rt">Saved</span>
        </div>
        {/* Zero-impact levers are noise — a row of 0.00 → 0.00 / $0.00 tells the
            reader nothing. Collapse them to a count below. */}
        {attribution.filter((a) => a.estSavedUsd > 0).map((a, i) => (
          <div key={i} className="attr">
            <span style={{ fontWeight: 600 }}>{fixLabel(a.lever)}</span>
            <span className="rt num"><span className="faint">{a.eventsPerSessionBefore?.toFixed(2)}</span> → <span style={{ color: "var(--good)" }}>{a.eventsPerSessionAfter?.toFixed(2)}</span></span>
            <span className="rt num" style={{ fontWeight: 600, color: "var(--good)" }}>{money(a.estSavedUsd)}</span>
          </div>
        ))}
        {(() => {
          const idle = attribution.filter((a) => !(a.estSavedUsd > 0)).length;
          if (!idle) return null;
          return (
            <div className="morelink" style={{ marginTop: 12 }}>
              {idle} more fix{idle === 1 ? " is" : "es are"} active but {idle === 1 ? "hasn't" : "haven't"} had to save anything yet
            </div>
          );
        })()}
        {!attribution.length && <div style={{ padding: "12px 0", color: "var(--dim)", fontSize: 12.5 }}>stoke hasn&apos;t applied any automatic fixes yet.</div>}
      </div>
    </>
  );
}

// Where the levers and size limits actually live, so the obvious next question
// ("how do I change this?") is answered on the screen that raises it.
const CONFIG_PATH = "~/.stoke/config.json";

function Log() {
  const { data: interventions } = useApi("/interventions");
  const [showAll, setShowAll] = useState(false);
  const [showRoutine, setShowRoutine] = useState(false);

  if (!interventions) return <div className="card"><div className="skel" style={{ width: "100%", height: 160 }} /></div>;

  // Translate first, then filter: whether a row is routine depends on what the
  // message says, not which lever wrote it (see interventionCopy).
  const all = interventions.map((i) => ({ ...i, copy: interventionCopy(i.lever, i.message, i.mode) }));
  const steps = all.filter((i) => !i.copy.routine);
  const routineCount = all.length - steps.length;
  const list = showRoutine ? all : steps;
  const rows = showAll ? list : list.slice(0, PAGE);
  const hidden = list.length - rows.length;

  if (!list.length) {
    return (
      <Empty title="stoke hasn&apos;t had to step in">
        No warnings, blocks or nudges have been needed yet.
      </Empty>
    );
  }

  return (
    <>
      <div className="pagesub mb14">
        Every time stoke stepped in — a warning, a block, or a nudge to work more cheaply.
        {" "}All of it is automatic. To switch any of it off, or change the size limits, edit{" "}
        <span className="mono">{CONFIG_PATH}</span>.
      </div>

      {routineCount > 0 && (
        <div className="filterbar mb14">
          <button className={`chipbtn ${showRoutine ? "on" : ""}`} onClick={() => setShowRoutine(!showRoutine)}>
            {showRoutine ? "Hide" : "Show"} {routineCount} routine record{routineCount === 1 ? "" : "s"}
          </button>
          <span className="faint" style={{ fontSize: 11.5 }}>
            every session start and session cost note — same thing every time
          </span>
        </div>
      )}

      <div className="card pad0">
        {rows.map((i, idx) => {
          const c = i.copy;
          return (
            <div key={idx} className="attr" style={{ gridTemplateColumns: "auto 1fr auto", padding: "14px 16px", alignItems: "start" }}>
              <Badge cls={KIND_BADGE[c.kind] || "b-dim"}>{c.kind}</Badge>
              <div>
                <div style={{ fontWeight: 600 }}>{c.title}</div>
                {c.detail && <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 3, maxWidth: 620 }}>{c.detail}</div>}
                <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }} title={i.message}>
                  {fixLabel(i.lever)} · <span className="mono">{projectName(i.project)}</span>
                </div>
              </div>
              <span className="num faint" style={{ fontSize: 12 }}>{dateShort(i.ts)}</span>
            </div>
          );
        })}
        {hidden > 0 && (
          <div className="morelink" style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", margin: 0 }}>
            Showing the {rows.length} most recent of {list.length}.{" "}
            <button onClick={() => setShowAll(true)}>Show all {list.length} →</button>
          </div>
        )}
        {showAll && list.length > PAGE && (
          <div className="morelink" style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", margin: 0 }}>
            <button onClick={() => setShowAll(false)}>Show only the {PAGE} most recent</button>
          </div>
        )}
      </div>
    </>
  );
}
