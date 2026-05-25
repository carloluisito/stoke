// src/digest.ts
import { appendFile } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./types.ts";
import { Registry } from "./registry.ts";
import { JsonlLogger } from "./logger.ts";
import { computeSavingsMulti, computeCacheHitRate } from "./savings.ts";
import { computeResumesInWindow } from "./dashboard-handler.ts";
import { startOfDayMs, startOfMonthMs } from "./time-windows.ts";

export interface DigestDeps {
  registry: Registry;
  logger: JsonlLogger;
  config: Config;
  nowMs: number;
}

export function buildDigest(deps: DigestDeps): string {
  const events = deps.logger.snapshot();
  const today = startOfDayMs(new Date(deps.nowMs));
  const month = startOfMonthMs(new Date(deps.nowMs));
  const [t, m, all] = computeSavingsMulti(events, deps.config, [
    { fromMs: today, toMs: deps.nowMs },
    { fromMs: month, toMs: deps.nowMs },
    { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER },
  ]);
  const hit = computeCacheHitRate(events, today, deps.nowMs);
  const dayStats = deps.logger.statsSinceMs(today);
  const resumes = computeResumesInWindow(events, today, deps.nowMs);

  const usd = (n: number): string => `$${n.toFixed(2)}`;
  const roi = dayStats.totalPingSpendUsd > 0
    ? (t.savedUsd / dayStats.totalPingSpendUsd).toFixed(1) + "×"
    : "—";
  const totalResumes = resumes.survived + resumes.partial + resumes.rebuilt;
  const resumesLine =
    totalResumes === 0
      ? "no resumes today"
      : `${resumes.survived} survived · ${resumes.partial} partial · ${resumes.rebuilt} rebuilt (${usd(resumes.rebuildSpentUsd)} paid on partial+rebuilt)`;

  const lines = [
    `stoke digest · ${new Date(deps.nowMs).toISOString()}`,
    `  Today        saved ${usd(t.savedUsd)}  ·  ${t.rebuildsAvoided} rebuilds avoided  ·  ${roi} ROI`,
    `  This month   saved ${usd(m.savedUsd)} ·  ${m.rebuildsAvoided} rebuilds avoided`,
    `  All time     saved ${usd(all.savedUsd)} · ${all.rebuildsAvoided} rebuilds avoided`,
    `  Pings fired today: ${dayStats.pingsFired}   Pings spent: ${usd(dayStats.totalPingSpendUsd)}`,
    `  Resumes today: ${resumesLine}`,
    `  Cache hit rate today: ${hit.hitRate === null ? "—" : (hit.hitRate * 100).toFixed(0) + "%"}`,
  ];
  return lines.join("\n") + "\n";
}

export function emitDigest(deps: DigestDeps): void {
  const text = buildDigest(deps);
  try {
    process.stdout.write(text + "\n");
  } catch {
    /* best-effort */
  }
  const digestPath = join(dirname(deps.config.logPath), "digest.log");
  appendFile(digestPath, text + "\n", "utf8", () => {
    /* best-effort, no retry */
  });
}
