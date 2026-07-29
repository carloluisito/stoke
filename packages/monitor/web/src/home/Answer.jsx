import React from "react";
import { usd, pct } from "../api.js";

const GREY = "color-mix(in srgb, var(--text) 22%, transparent)";

// The whole point of the screen: the user's own spend, then how much of it was
// avoidable. A sentence, not a bare metric — and a bar so the share is visible
// rather than something the reader has to compute.
export default function Answer({ spendUsd, avoidableUsd, avoidablePct, windowDays }) {
  const spend = spendUsd || 0;
  const avoid = avoidableUsd || 0;

  // Install day: no spend yet. Never render "$0 avoidable (NaN%)".
  if (spend <= 0) {
    return (
      <div className="answer">
        <div className="sentence">
          stoke is watching. Nothing billed yet.
          <small>
            As soon as you use Claude Code, this shows what you spent and how much of it was
            avoidable.
          </small>
        </div>
      </div>
    );
  }

  const necessary = Math.max(0, spend - avoid);
  const share = Math.min(1, avoid / spend);

  return (
    <div className="answer">
      <div className="sentence">
        You spent <b>{usd(spend)}</b> on Claude&nbsp;Code in the last {windowDays} days.<br />
        <span className="leak"><b className="leak">{usd(avoid)}</b> of it was avoidable.</span>
        <small>
          That&apos;s {pct(avoidablePct ?? share)} — billed for work Claude had already done, or
          output you didn&apos;t need.
        </small>
      </div>
      <div className="propbar">
        <i style={{ width: `${(1 - share) * 100}%`, background: GREY }} />
        <i style={{ width: `${share * 100}%`, background: "var(--serious)" }} />
      </div>
      <div className="proplegend">
        <span><span className="sw" style={{ background: GREY }} />necessary spend <b>{usd(necessary)}</b></span>
        <span><span className="sw" style={{ background: "var(--serious)" }} />avoidable <b>{usd(avoid)}</b></span>
      </div>
    </div>
  );
}
