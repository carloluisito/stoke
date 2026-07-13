import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb } from "../src/db.js";
import { loadPricing } from "../src/pricing.js";
import { ingestFile, backfill } from "../src/ingest.js";

const fixture = fs.readFileSync("tests/fixtures/session-basic.jsonl", "utf8");

function tmpProjects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokeff-"));
  const proj = path.join(root, "C--Users-me-myproj");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "s1.jsonl"), fixture);
  return { root, file: path.join(proj, "s1.jsonl") };
}

describe("ingest", () => {
  it("backfills, dedupes on re-run, prices turns", () => {
    const { root } = tmpProjects();
    const db = openDb(":memory:");
    const rules = loadPricing();
    backfill(db, rules, root);
    backfill(db, rules, root);
    const rows = db.prepare("SELECT * FROM turns ORDER BY ts").all();
    expect(rows.length).toBe(2);
    expect(rows[0].cost_usd).toBeGreaterThan(0);
    expect(rows[0].project).toBe("C--Users-me-myproj");
  });
  it("resumes from offset on append", () => {
    const { root, file } = tmpProjects();
    const db = openDb(":memory:");
    const rules = loadPricing();
    backfill(db, rules, root);
    fs.appendFileSync(file, '\n{"type":"assistant","sessionId":"s1","timestamp":"2026-07-11T10:02:00.000Z","message":{"id":"msg_3","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":6000,"cache_creation_input_tokens":0}}}\n');
    ingestFile(db, rules, file, "C--Users-me-myproj");
    expect(db.prepare("SELECT COUNT(*) c FROM turns").get().c).toBe(3);
  });
});
