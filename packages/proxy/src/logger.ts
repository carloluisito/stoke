// src/logger.ts
import {
  appendFile,
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import type { EventRecord } from "./types.ts";

export interface SummaryStats {
  realRequests: number;
  pingsFired: number;
  pingsSkipped: number;
  sessionsPaused: number;
  totalPingSpendUsd: number;
  resumesSurvived: number;
  resumesPartial: number;
  resumesRebuilt: number;
  /** $ paid across both partial (small natural growth) and rebuilt (full cold-cache) cases. */
  resumeRebuildSpendUsd: number;
}

/** Subset of stats restricted to events at or after a given timestamp. */
export interface WindowedStats {
  pingsFired: number;
  totalPingSpendUsd: number;
}

/** Callback invoked on every logger.write — used by /api/stream to push live updates. */
export type LogSubscriber = (event: EventRecord) => void;

export interface RotationConfig {
  maxSizeBytes: number;
  maxFiles: number;
}

export class JsonlLogger {
  private subscribers = new Set<LogSubscriber>();
  private events: EventRecord[] = [];
  private pending: string[] = [];
  private flushScheduled = false;
  private rotation: RotationConfig | null;

  constructor(private readonly path: string, rotation?: RotationConfig | null) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.rotation = rotation ?? null;
    this.replayFromDisk();
  }

  private replayFromDisk(): void {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.events.push(JSON.parse(line) as EventRecord);
      } catch {
        // skip malformed line — same tolerance as the previous on-disk scanners
      }
    }
  }

  write(event: EventRecord): void {
    this.events.push(event);
    this.pending.push(JSON.stringify(event) + "\n");
    this.scheduleFlush();
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // A misbehaving subscriber must not break the log writer.
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flushAsync());
  }

  private flushAsync(): void {
    if (this.pending.length === 0) {
      this.flushScheduled = false;
      return;
    }
    const batch = this.pending.join("");
    this.pending = [];
    appendFile(this.path, batch, "utf8", (err) => {
      this.flushScheduled = false;
      if (err) {
        // ENOENT = the file was removed (e.g. test cleanup, or the user
        // manually deleted the log). Silently drop; we don't want to spam
        // stderr or re-create the file under the user's feet.
        // Other errors (EACCES, ENOSPC, etc.) are visible to the operator.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          try {
            process.stderr.write(`stoke logger: dropped ${batch.length} bytes (${err.message})\n`);
          } catch {
            // best-effort logging only
          }
        }
        return;
      }
      if (this.pending.length > 0) this.scheduleFlush();
      else this.maybeRotate();
    });
  }

  /** Drain the pending write queue synchronously. Call from SIGINT before exit. */
  flushSync(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.join("");
    this.pending = [];
    appendFileSync(this.path, batch, "utf8");
    this.maybeRotate();
  }

  private maybeRotate(): void {
    if (!this.rotation) return;
    try {
      const { size } = statSync(this.path);
      if (size <= this.rotation.maxSizeBytes) return;
      this.rotateOnce(this.rotation.maxFiles);
    } catch {
      // file missing or stat failed → skip
    }
  }

  private rotateOnce(maxFiles: number): void {
    try {
      const drop = `${this.path}.${maxFiles}`;
      if (existsSync(drop)) {
        try {
          unlinkSync(drop);
        } catch {
          /* ignore */
        }
      }
      for (let n = maxFiles - 1; n >= 1; n--) {
        const from = `${this.path}.${n}`;
        const to = `${this.path}.${n + 1}`;
        if (existsSync(from)) {
          try {
            renameSync(from, to);
          } catch {
            /* ignore individual failure */
          }
        }
      }
      try {
        renameSync(this.path, `${this.path}.1`);
      } catch {
        /* ignore */
      }
    } catch (err) {
      try {
        process.stderr.write(
          `stoke logger: rotation failed (${(err as Error).message})\n`,
        );
      } catch {
        /* best-effort */
      }
    }
  }

  /** Subscribe to every subsequent write. Returns an unsubscribe function. */
  subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Read-only view of the in-memory event log. Stable across calls; callers must not mutate. */
  snapshot(): readonly EventRecord[] {
    return this.events;
  }

  summary(): SummaryStats {
    const stats: SummaryStats = {
      realRequests: 0,
      pingsFired: 0,
      pingsSkipped: 0,
      sessionsPaused: 0,
      totalPingSpendUsd: 0,
      resumesSurvived: 0,
      resumesPartial: 0,
      resumesRebuilt: 0,
      resumeRebuildSpendUsd: 0,
    };
    for (const ev of this.events) {
      const cost = (ev as EventRecord & { costUsd?: number }).costUsd;
      switch (ev.kind) {
        case "real_request":
          stats.realRequests += 1;
          break;
        case "ping_fired":
          stats.pingsFired += 1;
          if (typeof cost === "number") stats.totalPingSpendUsd += cost;
          break;
        case "ping_skipped":
          stats.pingsSkipped += 1;
          break;
        case "session_paused":
          stats.sessionsPaused += 1;
          break;
        case "session_resumed":
          if (ev.cacheOutcome === "survived") {
            stats.resumesSurvived += 1;
          } else if (ev.cacheOutcome === "partial") {
            stats.resumesPartial += 1;
            stats.resumeRebuildSpendUsd += ev.rebuildCostUsd;
          } else {
            stats.resumesRebuilt += 1;
            stats.resumeRebuildSpendUsd += ev.rebuildCostUsd;
          }
          break;
      }
    }
    return stats;
  }

  /**
   * Sum ping_fired counts and costUsd for events at or after `sinceMs`.
   * Used by the scheduler to compute spendUsdToday / spendUsdMonth / spendUsdCycle.
   */
  statsSinceMs(sinceMs: number): WindowedStats {
    const out: WindowedStats = { pingsFired: 0, totalPingSpendUsd: 0 };
    for (const ev of this.events) {
      if (ev.kind !== "ping_fired" || !ev.ts) continue;
      const eventMs = new Date(ev.ts).getTime();
      if (!Number.isFinite(eventMs) || eventMs < sinceMs) continue;
      out.pingsFired += 1;
      const cost = (ev as EventRecord & { costUsd?: number }).costUsd;
      if (typeof cost === "number") out.totalPingSpendUsd += cost;
    }
    return out;
  }
}
