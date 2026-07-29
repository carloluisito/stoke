import React, { useState } from "react";

const KEY = "stoke.explainer.dismissed";

// One line for someone who has never seen stoke. Dismissed permanently — a
// returning user shouldn't be re-taught on every visit.
export default function Explainer() {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  });
  if (hidden) return null;
  const dismiss = () => {
    try { localStorage.setItem(KEY, "1"); } catch { /* private mode — hide for this session only */ }
    setHidden(true);
  };
  return (
    <div className="explainer">
      <div>
        Claude Code re-bills you for context it already cached. stoke stops that, and shows you
        what else is leaking.
      </div>
      <button onClick={dismiss} aria-label="Dismiss explanation">✕</button>
    </div>
  );
}
