import { readStdin, saveSessionState } from "./lib.mjs";

// SessionEnd is the only zero-ambiguity signal the proxy can get: the session is
// gone, so the probability that a keepalive ping ever pays off is exactly 0.
// Without it the scheduler keeps pinging a dead session until the consecutive
// cap binds — 2-5 wasted pings per close, on every concurrent session.
try {
  const input = await readStdin();
  saveSessionState(input.session_id, "ended", input.cwd);
} catch { /* fail open */ }
process.exit(0);
