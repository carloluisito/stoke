import React from "react";
import { usd, dayLabel } from "../api.js";
import { go } from "../router.js";

const GREY = "color-mix(in srgb, var(--text) 22%, transparent)";
const H = 96;

// Daily cost with the avoidable share shaded and stoke's savings stacked on top,
// so the leak and the value both accrue visibly over time. No token-type stack —
// output / fresh input / cache write / cache read is expert detail and lives on
// the Sessions tab now.
export default function Trend({ days, avoidableByDay = {}, preventedByDay = {} }) {
  const rows = days || [];
  if (!rows.length) return null;

  // Scale to the tallest stacked column, not just the tallest cost, or a big
  // savings day would overflow the plot area.
  const max = Math.max(
    ...rows.map((d) => (d.total || 0) + (preventedByDay[d.day] || 0)),
    0.01,
  );
  const px = (v) => Math.round((v / max) * H);

  return (
    <div className="card">
      <div className="tbars">
        {rows.map((d) => {
          const total = d.total || 0;
          const avoid = Math.min(total, avoidableByDay[d.day] || 0);
          const prev = preventedByDay[d.day] || 0;
          const parts = [
            prev > 0 && `${usd(prev)} saved by stoke`,
            avoid > 0 && `${usd(avoid)} avoidable`,
          ].filter(Boolean);
          return (
            <button
              key={d.day}
              className="tcol"
              title={`${dayLabel(d.day)} · ${usd(total)} spent${parts.length ? " · " + parts.join(" · ") : ""}`}
              onClick={() => go(`sessions?day=${d.day}`)}
            >
              {prev > 0 && <i className="prev" style={{ height: Math.max(1, px(prev)) }} />}
              {avoid > 0 && <i className="avoid" style={{ height: Math.max(1, px(avoid)) }} />}
              <i className="rest" style={{ height: Math.max(1, px(total - avoid)) }} />
            </button>
          );
        })}
      </div>
      <div className="tx">
        <span>{dayLabel(rows[0].day)}</span>
        <span>{dayLabel(rows[rows.length - 1].day)}</span>
      </div>
      <div className="proplegend" style={{ marginTop: 10 }}>
        <span><span className="sw" style={{ background: GREY }} />necessary</span>
        <span><span className="sw" style={{ background: "var(--serious)" }} />avoidable</span>
        <span><span className="sw" style={{ background: "var(--good)" }} />saved by stoke</span>
      </div>
    </div>
  );
}
