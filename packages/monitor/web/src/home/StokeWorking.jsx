import React from "react";
import { money } from "../api.js";

// stoke's own contribution, stated at its real size. The cumulative line is the
// honest replacement for the old "cache saved all-time $32,080" figure, which
// credited stoke with Anthropic's prompt cache doing its normal job.
export default function StokeWorking({ window30, allTime, warmCount, proxyUp }) {
  if (!proxyUp) {
    return (
      <div className="working off">
        <div className="wtitle">Keep-alive is off</div>
        <div className="wsub">
          No pings are firing, so cache rebuilds aren&apos;t being prevented right now.
          <strong style={{ color: "var(--text)" }}> Spend tracking still works</strong> — everything
          else on this page is accurate. Start it with <code>stoke start</code>.
        </div>
      </div>
    );
  }

  const net = window30?.netSavedUsd ?? 0;
  const rebuilds = window30?.rebuildsAvoided ?? 0;

  // Before the first prevented rebuild there is nothing to claim. Say so rather
  // than showing "clawed back $0.00".
  if (rebuilds <= 0) {
    return (
      <div className="working">
        <div className="wtitle"><span className="livedot" />stoke is holding your cache open</div>
        <div className="wsub">
          {warmCount > 0
            ? `Keeping ${warmCount} session${warmCount === 1 ? "" : "s"} alive. `
            : "No active sessions to hold right now. "}
          It hasn&apos;t needed to prevent a rebuild yet — that shows up here as soon as it does.
        </div>
      </div>
    );
  }

  return (
    <div className="working">
      <div className="wtitle"><span className="livedot" />stoke clawed back {money(net)} of that</div>
      <div className="wsub">
        It caught <strong style={{ color: "var(--text)" }}>{rebuilds} cache rebuilds</strong> before
        Claude could re-bill you
        {warmCount > 0 && <> — and is keeping {warmCount} session{warmCount === 1 ? "" : "s"} alive right now</>}.
      </div>
      {allTime && allTime.rebuildsAvoided > 0 && (
        <div className="wsince">
          Since stoke started running:{" "}
          <strong style={{ color: "var(--text)" }}>{allTime.rebuildsAvoided}</strong> rebuilds
          avoided · <strong style={{ color: "var(--good)" }}>{money(allTime.netSavedUsd)}</strong> net
          saved
        </div>
      )}
    </div>
  );
}
