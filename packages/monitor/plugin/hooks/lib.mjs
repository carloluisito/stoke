import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try { return JSON.parse(data); } catch { return {}; }
}

export function loadOptimizerConfig() {
  try {
    const p = process.env.TOKEFF_OPTIMIZER_CONFIG || path.join(projectRoot, "plugin", "optimizer-config.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { levers: {}, thresholds: { bloatContextTokens: 120000, largeFileRereadBytes: 100000 } };
  }
}

export async function openDbSafe() {
  try {
    const { openDb } = await import("../../src/db.js");
    const dbPath = process.env.TOKEFF_DB || path.join(projectRoot, "data", "tokeff.db");
    return openDb(dbPath);
  } catch {
    return null;
  }
}

export function logIntervention(db, { session_id, lever, mode, message }) {
  try {
    db?.prepare("INSERT INTO interventions (ts, session_id, lever, mode, message) VALUES (?,?,?,?,?)")
      .run(new Date().toISOString(), session_id || "unknown", lever, mode, message);
  } catch { /* fail open */ }
}

export function sessionTurns(db, sessionId) {
  try {
    return db?.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY ts").all(sessionId) || [];
  } catch { return []; }
}

export function sessionTtlMs(turns) {
  return turns.some(t => t.cache_write_1h > 0) ? 3600_000 : 300_000;
}

export function readsSidecarPath(sessionId) {
  return path.join(projectRoot, "data", "session-reads", `${sessionId}.json`);
}

export function loadReads(sessionId) {
  try { return JSON.parse(fs.readFileSync(readsSidecarPath(sessionId), "utf8")); } catch { return {}; }
}

export function saveReads(sessionId, reads) {
  try {
    const p = readsSidecarPath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(reads));
  } catch { /* fail open */ }
}

export function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
}
