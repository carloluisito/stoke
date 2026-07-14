import React from "react";
import { money, tok, dayLabel, clock } from "./api.js";

const SPEND_SERIES = [
  ["output", "var(--s-output)"],
  ["input", "var(--s-input)"],
  ["cacheWrite", "var(--s-cwrite)"],
  ["cacheRead", "var(--s-cread)"],
];

export const dayTotal = (d) => d.output + d.input + d.cacheWrite + d.cacheRead;

// SVG polyline geometry for a sparkline over `values`, in a 100 x h viewBox.
export function sparkGeometry(values, h) {
  const n = values.length;
  if (!n) return { line: "", area: `0,${h} 100,${h}` };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const nx = (i) => (n === 1 ? 0 : (i / (n - 1)) * 100);
  const ny = (v) => h - ((v - min) / (max - min || 1)) * (h - 4) - 2;
  const line = values.map((v, i) => `${nx(i).toFixed(1)},${ny(v).toFixed(1)}`).join(" ");
  return { line, area: `0,${h} ${line} 100,${h}` };
}

export function Sparkline({ values, height = 30 }) {
  const { line, area } = sparkGeometry(values, height);
  return (
    <svg
      className="spark"
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={area} fill="var(--accent-weak)" stroke="none" />
      <polyline
        points={line}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Stacked, clickable spend-by-day bars. `days` = [{day,output,input,cacheWrite,cacheRead}].
export function SpendChart({ days, selectedDay, onSelectDay }) {
  const totals = days.map(dayTotal);
  const max = Math.max(1, ...totals);
  return (
    <>
      <div className="chart">
        {days.map((d, i) => {
          const tot = totals[i] || 1;
          const label = dayLabel(d.day);
          const aria = `${label}: ${money(totals[i])}`;
          return (
            <button
              key={d.day}
              className={`barcol ${selectedDay === d.day ? "on" : ""}`}
              onClick={() => onSelectDay(d.day)}
              aria-label={aria}
              title={aria}
            >
              <div className="barstack" style={{ height: ((totals[i] / max) * 100).toFixed(2) + "%" }}>
                {SPEND_SERIES.map(([k, c]) => (
                  <span
                    key={k}
                    className="barseg"
                    style={{ height: ((d[k] / tot) * 100).toFixed(2) + "%", background: c }}
                  />
                ))}
              </div>
              <span className="barx num">{label.split(" ")[1]}</span>
            </button>
          );
        })}
      </div>
      <div className="legend">
        <div className="lg"><span className="lgs" style={{ background: "var(--s-output)" }} />output</div>
        <div className="lg"><span className="lgs" style={{ background: "var(--s-input)" }} />fresh input</div>
        <div className="lg"><span className="lgs" style={{ background: "var(--s-cwrite)" }} />cache write</div>
        <div className="lg"><span className="lgs" style={{ background: "var(--s-cread)" }} />cache read</div>
      </div>
    </>
  );
}

// Per-turn token-mix waterfall. `turns` are raw rows from GET /sessions/:id.
export function Waterfall({ turns, flagIndex, scrollRef }) {
  return (
    <div className="card pad0">
      <div className="wfrow" style={{ background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
        <div className="klabel">Turn / time</div>
        <div className="klabel">Token mix (in · out · cache write · cache read)</div>
        <div className="klabel rt">Pings</div>
        <div className="klabel rt">Cost</div>
      </div>
      <div className="wf" ref={scrollRef}>
        {turns.map((t, i) => {
          const cw = (t.cache_write_5m || 0) + (t.cache_write_1h || 0);
          const inTok = t.input_tokens || 0;
          const out = t.output_tokens || 0;
          const cr = t.cache_read || 0;
          const total = inTok + out + cw + cr || 1;
          const segs = [
            [inTok, "var(--s-input)"],
            [out, "var(--s-output)"],
            [cw, "var(--s-cwrite)"],
            [cr, "var(--s-cread)"],
          ];
          const flagged = i === flagIndex;
          return (
            <div key={t.message_id || i} className={`wfrow ${flagged ? "flag" : ""}`}>
              <div>
                <div className="num" style={{ fontWeight: 600 }}>#{i + 1}</div>
                <div className="faint num" style={{ fontSize: 11 }}>{clock(t.ts)}</div>
              </div>
              <div>
                <div className="tbar">
                  {segs.map(([v, c], j) => (
                    <span key={j} style={{ width: ((v / total) * 100).toFixed(2) + "%", background: c }} />
                  ))}
                </div>
                <div className="faint num" style={{ fontSize: 11, marginTop: 5 }}>
                  {tok(inTok)} in · {tok(out)} out · {tok(cw)} cw · {tok(cr)} cr
                </div>
              </div>
              <div className="rt num">{t.proxy_pings_since_prev || 0}</div>
              <div className="rt num" style={{ fontWeight: 600 }}>{money(t.cost_usd)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BudgetBar({ spent, cap }) {
  const w = Math.min(100, ((spent || 0) / (cap || 1)) * 100).toFixed(1);
  return (
    <div className="budget mt14">
      <div className="budbar">
        <div className="budfill" style={{ width: w + "%" }} />
      </div>
    </div>
  );
}
