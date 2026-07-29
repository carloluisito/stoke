import React from "react";
import { usd } from "../api.js";
import { projectName } from "../lib/projectName.js";
import { go } from "../router.js";

// Which projects leak. Names are normalised — the raw values are mangled cwd
// encodings like "C--Users-me-Desktop-repositories-personal-omnidesk".
export default function ByProject({ byProject, projectCount }) {
  if (!byProject?.length) return null;
  const max = byProject[0].usd || 1;
  const more = Math.max(0, (projectCount || 0) - byProject.length);
  return (
    <div className="card">
      {byProject.map((p) => (
        <div key={p.project} className="prow">
          <div className="pname" title={p.project}>{projectName(p.project)}</div>
          <div className="ptrack"><i style={{ width: `${Math.max(2, (p.usd / max) * 100)}%` }} /></div>
          <div className="pamt">{usd(p.usd)}</div>
        </div>
      ))}
      {more > 0 && (
        <div className="morelink">
          <button onClick={() => go("waste")}>
            {more} more project{more === 1 ? "" : "s"} →
          </button>
        </div>
      )}
    </div>
  );
}
