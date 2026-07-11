import fs from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { extractTurn } from "./parser.js";
import { priceTurn } from "./pricing.js";

const UPSERT = `INSERT INTO turns (message_id, session_id, project, ts, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read, cost_usd)
VALUES (@message_id,@session_id,@project,@ts,@model,@input_tokens,@output_tokens,@cache_write_5m,@cache_write_1h,@cache_read,@cost_usd)
ON CONFLICT(message_id) DO NOTHING`;

export function ingestFile(db, rules, filePath, project) {
  const prev = db.prepare("SELECT offset FROM ingest_state WHERE file=?").get(filePath)?.offset || 0;
  const size = fs.statSync(filePath).size;
  if (size <= prev) return 0;
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(size - prev);
  fs.readSync(fd, buf, 0, buf.length, prev);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  const complete = lastNl === -1 ? "" : text.slice(0, lastNl + 1); // only whole lines
  const ins = db.prepare(UPSERT);
  let n = 0;
  const tx = db.transaction(() => {
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      const turn = extractTurn(line, { project });
      if (!turn) continue;
      const { costUsd } = priceTurn(turn, rules);
      ins.run({ ...turn, cost_usd: costUsd });
      n++;
    }
    db.prepare("INSERT INTO ingest_state (file, offset) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET offset=excluded.offset")
      .run(filePath, prev + Buffer.byteLength(complete, "utf8"));
  });
  tx();
  return n;
}

export function backfill(db, rules, transcriptGlobDir) {
  if (!fs.existsSync(transcriptGlobDir)) return;
  for (const proj of fs.readdirSync(transcriptGlobDir)) {
    const projDir = path.join(transcriptGlobDir, proj);
    let stat;
    try { stat = fs.statSync(projDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(projDir)) {
      if (!f.endsWith(".jsonl")) continue;
      try { ingestFile(db, rules, path.join(projDir, f), proj); }
      catch (e) { console.error("[backfill]", f, e.message); }
    }
  }
}

export function watch(db, rules, transcriptGlobDir) {
  const watcher = chokidar.watch(path.join(transcriptGlobDir, "*", "*.jsonl"), { ignoreInitial: false });
  const handle = (fp) => {
    try { ingestFile(db, rules, fp, path.basename(path.dirname(fp))); }
    catch (e) { console.error("[ingest]", fp, e.message); }
  };
  watcher.on("add", handle).on("change", handle);
  return watcher;
}
