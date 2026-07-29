import React from "react";
import { mmss } from "../api.js";
import { projectName } from "../lib/projectName.js";
import { sessionCountdown } from "../live.js";
import { go } from "../router.js";
import { Empty } from "../components.jsx";

const isActive = (s) => s.cacheStatus === "warm" || s.cacheStatus === "paused";

// Cap the card count. Concurrent sessions in one project render as identical
// labels ("agent/sandbox" x5), which tells the reader nothing and pushes the
// rest of the page down. Four soonest-to-ping answers "what is stoke about to
// do" without the wall.
const MAX_CARDS = 4;

// Only the sessions stoke is actually working on. The old Proxy page rendered
// every tracked session, and 16 of 22 were finished — $0.00, no countdown, pure
// noise pushing the live ones below the fold.
export default function LiveNow({ sessions, now, lastPollAt }) {
  const all = sessions || [];
  const active = all.filter(isActive);
  const inactive = all.length - active.length;

  if (!active.length) {
    return (
      <Empty title="No sessions to keep alive right now">
        Start a Claude Code conversation and stoke will hold its cache open between messages.
      </Empty>
    );
  }

  // Soonest ping first; sessions with no live countdown sink to the bottom.
  const ranked = active
    .map((s) => ({ s, cd: sessionCountdown(s, now, lastPollAt) }))
    .sort((a, b) => {
      if (a.cd.active !== b.cd.active) return a.cd.active ? -1 : 1;
      return (a.cd.seconds ?? Infinity) - (b.cd.seconds ?? Infinity);
    });
  const shown = ranked.slice(0, MAX_CARDS);
  const overflow = ranked.length - shown.length;

  return (
    <>
      <div className="grid cards2">
        {shown.map(({ s, cd }) => {
          const paused = s.cacheStatus === "paused";
          return (
            <div key={s.key} className={`livecard ${s.cacheStatus}`}>
              <div className="mono" style={{ fontWeight: 600 }}>{projectName(s.projectPath)}</div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                {s.model?.replace("claude-", "")}
              </div>
              <div className="countdown mt14">
                <div className="cdtop">
                  <span className="dim" style={{ fontSize: 12 }}>
                    {paused ? "paused — over the daily budget" : "keeping cache alive, next check in"}
                  </span>
                  <span className={`cdtime num ${cd.pinging ? "pinging" : ""}`}>
                    {!cd.active ? "—" : cd.pinging ? "just now" : mmss(cd.seconds)}
                  </span>
                </div>
                <div className="cdbar">
                  <div
                    className={`cdfill ${cd.seconds < 30 ? "warnc" : ""}`}
                    style={{ width: (cd.active ? cd.frac * 100 : 0).toFixed(1) + "%" }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {(overflow > 0 || inactive > 0) && (
        <div className="morelink">
          <button onClick={() => go("proxy")}>
            {[
              overflow > 0 && `${overflow} more being kept alive`,
              inactive > 0 && `${inactive} finished`,
            ].filter(Boolean).join(" · ")} →
          </button>
        </div>
      )}
    </>
  );
}
