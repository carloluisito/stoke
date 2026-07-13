import fs from "node:fs";
import { readStdin, loadOptimizerConfig, openDbSafe, logIntervention, loadReads, saveReads, emit } from "./lib.mjs";

try {
  const input = await readStdin();
  if (input.tool_name === "Read" && input.tool_input?.file_path) {
    const cfg = loadOptimizerConfig();
    const mode = cfg.levers.wasteful_read_warning || "suggest";
    const sessionId = input.session_id || "unknown";
    const file = input.tool_input.file_path;
    const isPartialRead = input.tool_input.offset != null || input.tool_input.limit != null;
    const reads = loadReads(sessionId);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* file may not exist */ }
    const threshold = cfg.thresholds.largeFileRereadBytes || 100000;

    // Only full re-reads of large files are wasteful; targeted (offset/limit) reads are the fix, never blocked.
    if (reads[file] && size > threshold && !isPartialRead && mode !== "observe") {
      const db = await openDbSafe();
      if (mode === "enforce") {
        const reason = `[tokeff] Blocked: ${file} (${Math.round(size / 1024)}KB) was already read this session — a full re-read re-bills all of it. Read a targeted range (offset/limit) or grep for what you need; if you genuinely need the whole file again, that read is allowed.`;
        emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
        logIntervention(db, { session_id: sessionId, lever: "wasteful_read_warning", mode, message: `BLOCKED full re-read of ${file} (${Math.round(size / 1024)}KB); redirected to targeted read` });
      } else {
        const msg = `[tokeff] ${file} (${Math.round(size / 1024)}KB) was already read this session — a full re-read re-bills all of it. Prefer a targeted range or grep.`;
        emit({ systemMessage: msg });
        logIntervention(db, { session_id: sessionId, lever: "wasteful_read_warning", mode, message: msg });
      }
    }
    if (!isPartialRead) reads[file] = (reads[file] || 0) + 1;
    saveReads(sessionId, reads);
  }
} catch { /* fail open */ }
process.exit(0);
