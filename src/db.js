import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function openDb(dbPath) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      message_id TEXT PRIMARY KEY, session_id TEXT, project TEXT, ts TEXT, model TEXT,
      input_tokens INT, output_tokens INT, cache_write_5m INT, cache_write_1h INT,
      cache_read INT, cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
    CREATE TABLE IF NOT EXISTS ingest_state (file TEXT PRIMARY KEY, offset INT);
    CREATE TABLE IF NOT EXISTS interventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, session_id TEXT,
      lever TEXT, mode TEXT, message TEXT
    );
  `);
  return db;
}
