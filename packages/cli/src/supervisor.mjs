// Child-process supervisor for `stoke start`. Spawns the proxy and the
// monitor as independent children: each restarts on crash with exponential
// backoff (base doubling to a cap), and a crash of one NEVER touches the
// other — the proxy on port 9876 must survive anything the monitor does.

import { spawn } from "node:child_process";

const HEALTHY_MS = 60_000; // alive this long → backoff resets

export function startSupervisor(children, opts = {}) {
  const backoffBaseMs = opts.backoffBaseMs ?? 1000;
  const backoffCapMs = opts.backoffCapMs ?? 30_000;
  const unstableWindowMs = opts.unstableWindowMs ?? 5 * 60_000;
  const unstableThreshold = opts.unstableThreshold ?? 5;
  const healthyMs = opts.healthyMs ?? HEALTHY_MS;
  const log = opts.log ?? (() => {});

  const state = new Map();
  let stopping = false;

  function launch(spec) {
    const st = state.get(spec.name);
    st.startedAt = Date.now();
    const proc = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(spec.env ?? {}) },
    });
    st.proc = proc;
    proc.stdout?.on("data", (d) => log(`[${spec.name}] ${d.toString().trimEnd()}`));
    proc.stderr?.on("data", (d) => log(`[${spec.name}] ${d.toString().trimEnd()}`));
    opts.onChange?.();
    proc.on("exit", (code, signal) => {
      if (stopping) return;
      const now = Date.now();
      if (now - st.startedAt >= healthyMs) st.backoffMs = backoffBaseMs; // ran healthy — start fresh
      st.crashes = st.crashes.filter((t) => now - t < unstableWindowMs);
      st.crashes.push(now);
      st.restarts += 1;
      st.unstable = st.crashes.length > unstableThreshold;
      log(
        `[supervisor] ${spec.name} exited (code=${code ?? "?"} signal=${signal ?? "-"}) — restarting in ${st.backoffMs}ms${st.unstable ? " [UNSTABLE: keeps crashing, still retrying]" : ""}`,
      );
      st.timer = setTimeout(() => {
        st.timer = null;
        if (!stopping) launch(spec);
      }, st.backoffMs);
      st.backoffMs = Math.min(backoffCapMs, st.backoffMs * 2);
    });
    log(`[supervisor] ${spec.name} started (pid ${proc.pid})`);
  }

  for (const spec of children) {
    state.set(spec.name, {
      proc: null,
      timer: null,
      backoffMs: backoffBaseMs,
      crashes: [],
      restarts: 0,
      unstable: false,
      startedAt: 0,
    });
    launch(spec);
  }

  return {
    statuses() {
      const out = {};
      for (const [name, st] of state) {
        out[name] = {
          pid: st.proc?.pid ?? null,
          running: st.proc !== null && st.proc.exitCode === null && !st.timer,
          restarts: st.restarts,
          unstable: st.unstable,
        };
      }
      return out;
    },
    stop() {
      stopping = true;
      for (const [, st] of state) {
        if (st.timer) clearTimeout(st.timer);
        // Kill ONLY our own children by their exact PIDs — never a name- or
        // port-wide sweep.
        try {
          st.proc?.kill();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
