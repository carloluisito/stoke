import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb } from "../src/db.js";

function runHook(name, input, env = {}) {
  const r = spawnSync("node", [path.join("plugin", "hooks", name)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function tmpDb(seedTurns = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokeff-hooks-"));
  const dbPath = path.join(dir, "t.db");
  const db = openDb(dbPath);
  const ins = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  seedTurns.forEach(r => ins.run(...r));
  db.close();
  return dbPath;
}

describe("hooks", () => {
  it("session-start injects conventions and logs intervention, exit 0", () => {
    const dbPath = tmpDb();
    const { code, out } = runHook("session-start.mjs", { session_id: "s1" }, { TOKEFF_DB: dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/token-efficiency/);
    const db = openDb(dbPath);
    expect(db.prepare("SELECT COUNT(*) c FROM interventions WHERE lever='efficiency_conventions'").get().c).toBe(1);
  });

  it("user-prompt-submit on TTL gap: notifies the user AND injects a self-correction directive to Claude", () => {
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10m ago > 5m TTL
    const dbPath = tmpDb([["m1","s1","p",past,"claude-opus-4-8",100,100,50000,0,100000,0.4]]);
    const { code, out } = runHook("user-prompt-submit.mjs", { session_id: "s1" }, { TOKEFF_DB: dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.systemMessage).toMatch(/cache expired/i);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/tokeff-directives/);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/do not re-read files/);
  });

  it("user-prompt-submit on bloat: injects delegation + compact directive to Claude", () => {
    const now = Date.now();
    const dbPath = tmpDb([0, 1, 2].map(i =>
      [`b${i}`,"sB","p",new Date(now - (3 - i) * 30_000).toISOString(),"claude-opus-4-8",1000,100,0,0,150000,0.1]));
    const { out } = runHook("user-prompt-submit.mjs", { session_id: "sB" }, { TOKEFF_DB: dbPath });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/cheap-explore/);
    expect(ctx).toMatch(/recommend \/compact/);
  });

  it("user-prompt-submit stays silent on a warm small session", () => {
    const recent = new Date(Date.now() - 30 * 1000).toISOString();
    const dbPath = tmpDb([["m1","s1","p",recent,"claude-opus-4-8",100,100,0,0,5000,0.01]]);
    const { code, out } = runHook("user-prompt-submit.mjs", { session_id: "s1" }, { TOKEFF_DB: dbPath });
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });

  function suggestConfig() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokeff-cfg-"));
    const p = path.join(dir, "optimizer-config.json");
    fs.writeFileSync(p, JSON.stringify({
      levers: { wasteful_read_warning: "suggest" },
      thresholds: { bloatContextTokens: 120000, largeFileRereadBytes: 100000 },
    }));
    return p;
  }

  it("pre-tool-use (suggest) warns on large re-read, silent on first read", () => {
    const dbPath = tmpDb();
    const bigFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tokeff-file-")), "big.txt");
    fs.writeFileSync(bigFile, "x".repeat(200000));
    const input = { session_id: `s-${Date.now()}`, tool_name: "Read", tool_input: { file_path: bigFile } };
    const env = { TOKEFF_DB: dbPath, TOKEFF_OPTIMIZER_CONFIG: suggestConfig() };
    const first = runHook("pre-tool-use.mjs", input, env);
    expect(first.code).toBe(0);
    expect(first.out.trim()).toBe("");
    const second = runHook("pre-tool-use.mjs", input, env);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out).systemMessage).toMatch(/already read/);
  });

  it("pre-tool-use (enforce, the default) DENIES a full re-read but allows targeted reads", () => {
    const dbPath = tmpDb();
    const bigFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tokeff-file-")), "big.txt");
    fs.writeFileSync(bigFile, "x".repeat(200000));
    const sessionId = `s-${Date.now()}-enforce`;
    const full = { session_id: sessionId, tool_name: "Read", tool_input: { file_path: bigFile } };
    const first = runHook("pre-tool-use.mjs", full, { TOKEFF_DB: dbPath });
    expect(first.out.trim()).toBe(""); // first read always allowed
    const second = runHook("pre-tool-use.mjs", full, { TOKEFF_DB: dbPath });
    const decision = JSON.parse(second.out).hookSpecificOutput;
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toMatch(/targeted range|grep/);
    // Targeted read of the same file is never blocked
    const targeted = { ...full, tool_input: { file_path: bigFile, offset: 100, limit: 50 } };
    const third = runHook("pre-tool-use.mjs", targeted, { TOKEFF_DB: dbPath });
    expect(third.code).toBe(0);
    expect(third.out.trim()).toBe("");
    const db = openDb(dbPath);
    expect(db.prepare("SELECT COUNT(*) c FROM interventions WHERE lever='wasteful_read_warning' AND message LIKE 'BLOCKED%'").get().c).toBe(1);
  });

  it("stop records session cost", () => {
    const dbPath = tmpDb([["m1","s1","p","2026-07-11T10:00:00Z","claude-opus-4-8",100,100,0,0,0,0.1234]]);
    const { code } = runHook("stop.mjs", { session_id: "s1" }, { TOKEFF_DB: dbPath });
    expect(code).toBe(0);
    const db = openDb(dbPath);
    const row = db.prepare("SELECT message FROM interventions WHERE lever='session_cost_record'").get();
    expect(row.message).toMatch(/\$0\.1234/);
  });

  it("fails open: bad DB path still exits 0 with no crash output", () => {
    const { code } = runHook("user-prompt-submit.mjs", { session_id: "s1" }, { TOKEFF_DB: "Z:/does/not/exist/x.db" });
    expect(code).toBe(0);
  });
});
