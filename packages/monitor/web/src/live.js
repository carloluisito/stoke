import { useEffect, useRef, useState } from "react";

const firstProject = (proxy) => proxy?.live?.sessions?.[0]?.projectPath || "";
const resumeTotal = (r = {}) => (r.survived || 0) + (r.partial || 0) + (r.rebuilt || 0);

// Pure: derive ticker events + toasts from the change between two /proxy polls.
// Events are honest — they come from real counter increments, never fabricated.
// Emits nothing unless the proxy is up and a counter actually advanced.
export function diffProxyEvents(prev, next, nowTs) {
  const events = [];
  const toasts = [];
  if (!prev || !next || !next.up) return { events, toasts };
  const a = prev.today || {};
  const b = next.today || {};
  const project = firstProject(next);

  const dReb = (b.rebuildsAvoided || 0) - (a.rebuildsAvoided || 0);
  if (dReb > 0) {
    const dSaved = +((b.savedUsd || 0) - (a.savedUsd || 0)).toFixed(2);
    const amt = dSaved > 0 ? ` — saved $${dSaved.toFixed(2)}` : "";
    events.push({ kind: "prevented_rebuild", text: `prevented rebuild${amt}`, project, ts: nowTs });
    if (dSaved > 0) toasts.push({ text: `🔥 kept cache warm — saved $${dSaved.toFixed(2)}` });
  }

  const dPing = (b.pingsFired || 0) - (a.pingsFired || 0);
  if (dPing > 0) {
    events.push({
      kind: "ping_fired",
      text: `ping fired — cache kept warm${dPing > 1 ? ` (×${dPing})` : ""}`,
      project,
      ts: nowTs,
    });
  }

  const dRes = resumeTotal(b.resumes) - resumeTotal(a.resumes);
  if (dRes > 0) {
    events.push({ kind: "session_resumed", text: "session resumed — cache survived", project, ts: nowTs });
  }
  return { events, toasts };
}

// Drives all liveness: a 1s tick for countdowns, and poll-to-poll diffing of the
// `proxy` payload into a capped event list plus auto-expiring toasts.
export function useLiveness(proxy) {
  const [now, setNow] = useState(() => Date.now());
  const [lastPollAt, setLastPollAt] = useState(() => Date.now());
  const [events, setEvents] = useState([]);
  const [toasts, setToasts] = useState([]);
  const prevRef = useRef(null);
  const idRef = useRef(1);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!proxy) return;
    setLastPollAt(Date.now());
    const prev = prevRef.current;
    prevRef.current = proxy;
    if (!prev) return;
    const { events: ev, toasts: ts } = diffProxyEvents(prev, proxy, Date.now());
    if (ev.length) {
      setEvents((cur) => [...ev.map((e) => ({ ...e, id: idRef.current++ })), ...cur].slice(0, 40));
    }
    ts.forEach((toast) => {
      const id = idRef.current++;
      setToasts((cur) => [...cur, { ...toast, id }]);
      setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), 6000);
    });
  }, [proxy]);

  const dismissToast = (id) => setToasts((cur) => cur.filter((x) => x.id !== id));
  return { now, lastPollAt, events, toasts, dismissToast };
}

// Countdown to the next cache ping for one live session, given the current clock
// and when the proxy was last polled. Returns seconds left, progress fraction and
// whether it just crossed zero (a ping should have fired).
export function sessionCountdown(session, now, lastPollAt) {
  const active = session.cacheStatus !== "abandoned" && session.cacheStatus !== "paused";
  const window = (session.detectedTtlSeconds || 0) - 30;
  const elapsed = Math.max(0, (now - lastPollAt) / 1000);
  const idle = (session.idleSec || 0) + elapsed;
  const cd = Math.max(0, window - idle);
  return {
    active,
    seconds: cd,
    frac: window > 0 ? cd / window : 0,
    pinging: active && cd <= 0 && window > 0,
  };
}
