// Ingests the stoke proxy's event log (~/.stoke/events.jsonl) into the
// proxy_events table, so ping spend and prevented cache rebuilds join the
// transcript spend in one database. Mirrors the transcript ingester's design:
// offset-resumed via ingest_state, transactional batches, partial-line
// tolerant. Additionally rotation-aware — the proxy renames events.jsonl to
// .1/.2/... when it exceeds its size cap, so a stored offset larger than the
// current file means "rotated: start over".

import fs from "node:fs";
import chokidar from "chokidar";

function extractColumns(ev) {
  const base = { ts: ev.ts || null, kind: ev.kind || "unknown", session_key: ev.sessionKey || null, tokens: null, cost_usd: null };
  if (ev.kind === "real_request") {
    base.tokens = ev.usage?.cache_read_input_tokens ?? null;
  } else if (ev.kind === "ping_fired") {
    base.tokens = ev.usage?.cache_read_input_tokens ?? null;
    base.cost_usd = typeof ev.costUsd === "number" ? ev.costUsd : null;
  } else if (ev.kind === "session_resumed") {
    base.cost_usd = typeof ev.rebuildCostUsd === "number" ? ev.rebuildCostUsd : null;
  }
  return base;
}

export function ingestProxyEvents(db, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { rows: 0 }; // proxy never ran on this machine — nothing to ingest
  }

  const state = db.prepare("SELECT offset FROM ingest_state WHERE file = ?").get(filePath);
  let offset = state?.offset ?? 0;
  if (offset > stat.size) offset = 0; // rotated — the file restarted

  if (offset === stat.size) return { rows: 0 };

  const fd = fs.openSync(filePath, "r");
  let chunk;
  try {
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    chunk = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }

  // Only consume complete lines; a partial trailing line stays for next time.
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline === -1) return { rows: 0 };
  const consumed = chunk.slice(0, lastNewline + 1);
  const newOffset = offset + Buffer.byteLength(consumed, "utf8");

  const insert = db.prepare(
    "INSERT INTO proxy_events (ts, kind, session_key, tokens, cost_usd, raw) VALUES (?,?,?,?,?,?)",
  );
  const saveState = db.prepare(
    "INSERT INTO ingest_state (file, offset) VALUES (?,?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset",
  );

  let rows = 0;
  const tx = db.transaction(() => {
    for (const line of consumed.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        continue; // torn or corrupt line — skip, never abort the batch
      }
      const c = extractColumns(ev);
      insert.run(c.ts, c.kind, c.session_key, c.tokens, c.cost_usd, trimmed);
      rows += 1;
    }
    saveState.run(filePath, newOffset);
  });
  tx();
  return { rows };
}

export function watchProxyEvents(db, filePath) {
  const watcher = chokidar.watch(filePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });
  const onChange = () => {
    try {
      ingestProxyEvents(db, filePath);
    } catch {
      // fail open — a bad read never kills the monitor
    }
  };
  watcher.on("add", onChange);
  watcher.on("change", onChange);
  return watcher;
}

/** Reconstruct EventRecord objects (ts ascending) for the shared savings math. */
export function proxyEventsBetween(db, fromTs, toTs) {
  const rows = db
    .prepare("SELECT raw FROM proxy_events WHERE ts >= ? AND ts <= ? ORDER BY ts")
    .all(fromTs, toTs);
  const out = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.raw));
    } catch {
      /* skip */
    }
  }
  return out;
}
