import React from "react";
import { usd } from "../api.js";
import { causeFor } from "../lib/causes.js";
import { projectName } from "../lib/projectName.js";
import { go } from "../router.js";

// 1,087 individual findings are unreadable and unactionable. Users fix causes,
// so group by cause, sort by cost, and give each one a single next step.
export default function Causes({ causes, ttlSwitchCount }) {
  if (!causes?.length) return null;
  return (
    <>
      {causes.map((c) => {
        const meta = causeFor(c.type);
        // Cache expiry is the one cause stoke can name a concrete target for.
        const fixLabel =
          c.type === "cache_expiry" && ttlSwitchCount > 0
            ? `Use the longer cache on ${ttlSwitchCount} project${ttlSwitchCount === 1 ? "" : "s"} →`
            : `${meta.fix} →`;
        return (
          <button key={c.type} className="cause" onClick={() => go(meta.route)}>
            <div>
              <div className="camt">{usd(c.usd)}</div>
              <div className="ccount">{c.count}×</div>
            </div>
            <div>
              <div className="cname">{meta.title}</div>
              <div className="cwhy">{meta.why}</div>
              {c.topProject && (
                <div className="cworst">worst: {projectName(c.topProject)}</div>
              )}
            </div>
            <span className="cfix">{fixLabel}</span>
          </button>
        );
      })}
    </>
  );
}
