# Token Efficiency Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete token-efficiency monitor + optimizer: transcript ingestor → SQLite, TTL/date-aware cost model, waste detectors, local dashboard (port 5599), and Claude Code optimizer (hooks, subagents, skills, statusline).

**Architecture:** Single Node.js (ESM) project. An ingestor watches Claude Code transcript JSONL files and writes per-turn usage rows to SQLite via better-sqlite3. An analytics layer (pure SQL + JS functions) computes spend breakdowns and dollar-quantified waste findings. A Fastify server exposes `/api/*` and serves a built React/Vite frontend. The optimizer is a set of fail-open Node hook scripts + agent/skill markdown files registered into the user's Claude Code config dir by an installer script.

**Tech Stack:** Node.js ≥20 (ESM), better-sqlite3, chokidar, Fastify, React + Vite + recharts, Vitest.

## Global Constraints

- Dashboard port default **5599**; on conflict try 5600–5610. **Never 9876.**
- Claude Code config dir: `process.env.CLAUDE_CONFIG_DIR` else `~/.claude`; overridable via tool config. (This machine: `~/.claude-work`.)
- Hooks **fail open**: top-level try/catch, always `process.exit(0)`, never throw to Claude Code.
- Main-loop model is never downgraded automatically; model routing = subagents only.
- Pricing is data (config/pricing.json), effective-dated; cache write 1.25× (5m TTL) / 2× (1h TTL); cache read 0.1×.
- All data local. TDD with Vitest. Commit per task on branch `feat/token-efficiency-tool`.
- Windows-compatible paths (use `node:path`, no shell-isms in code).

## File Structure

```
package.json, vitest.config.js, .gitignore
config/pricing.json          # effective-dated model prices
src/config.js                # tool config: config-dir detection, ports, paths
src/db.js                    # SQLite open + schema migration
src/pricing.js               # loadPricing(), priceTurn(turn, date)
src/parser.js                # parseTranscriptLine(), extractTurn()
src/ingest.js                # backfill + chokidar watcher, offset tracking
src/analytics/breakdowns.js  # spend queries
src/analytics/detectors.js   # 6 detectors + ttlAdvisor
src/server.js                # Fastify app + /api routes + static
src/statusline-data.js       # session cost lookup for statusline
web/  (Vite app: index.html, src/main.jsx, src/App.jsx, src/pages/*.jsx)
plugin/hooks/session-start.mjs, user-prompt-submit.mjs, pre-tool-use.mjs, stop.mjs
plugin/agents/cheap-explore.md, cheap-search.md
plugin/skills/spend/SKILL.md, efficiency-audit/SKILL.md
plugin/statusline.mjs
plugin/optimizer-config.json # per-lever modes: observe|suggest|enforce
scripts/install.mjs          # registers hooks/statusline/agents/skills into config dir
scripts/start.mjs            # runs ingestor + server
tests/fixtures/*.jsonl       # transcript fixtures
tests/*.test.js
```

---

### Task 1: Scaffold + config module

**Files:**
- Create: `package.json`, `vitest.config.js`, `.gitignore`, `src/config.js`, `tests/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env, overrides = {}) -> { configDir, transcriptGlobDir, dbPath, port, portRange, optimizerConfigPath }`

- [ ] **Step 1: Init project + deps**

```bash
git checkout -b feat/token-efficiency-tool
npm init -y
npm i better-sqlite3 chokidar fastify @fastify/static
npm i -D vitest
```
Edit `package.json`: `"type": "module"`, scripts: `"test": "vitest run"`, `"start": "node scripts/start.mjs"`. `.gitignore`: `node_modules/`, `data/`, `web/dist/`.

- [ ] **Step 2: Failing test for config**

```js
// tests/config.test.js
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import path from "node:path";
import os from "node:os";

describe("loadConfig", () => {
  it("uses CLAUDE_CONFIG_DIR when set", () => {
    const c = loadConfig({ CLAUDE_CONFIG_DIR: "C:/x/.claude-work" });
    expect(c.configDir).toBe(path.resolve("C:/x/.claude-work"));
    expect(c.transcriptGlobDir).toBe(path.join(path.resolve("C:/x/.claude-work"), "projects"));
  });
  it("falls back to ~/.claude", () => {
    const c = loadConfig({});
    expect(c.configDir).toBe(path.join(os.homedir(), ".claude"));
  });
  it("defaults port 5599 and range excludes 9876", () => {
    const c = loadConfig({});
    expect(c.port).toBe(5599);
    expect(c.portRange).toEqual([5600, 5610]);
  });
  it("accepts overrides", () => {
    const c = loadConfig({}, { port: 6001 });
    expect(c.port).toBe(6001);
  });
});
```

- [ ] **Step 3: Run test, expect FAIL** — `npx vitest run tests/config.test.js` → module not found.

- [ ] **Step 4: Implement `src/config.js`**

```js
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env, overrides = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR
    ? path.resolve(env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  return {
    configDir,
    transcriptGlobDir: path.join(configDir, "projects"),
    dbPath: path.join(projectRoot, "data", "tokeff.db"),
    port: 5599,
    portRange: [5600, 5610],
    optimizerConfigPath: path.join(projectRoot, "plugin", "optimizer-config.json"),
    projectRoot,
    ...overrides,
  };
}
```

- [ ] **Step 5: Test passes; commit** — `git add -A && git commit -m "feat: scaffold + config module"`

---

### Task 2: DB schema

**Files:**
- Create: `src/db.js`, `tests/db.test.js`

**Interfaces:**
- Produces: `openDb(dbPath) -> Database` with tables:
  - `turns(message_id TEXT PRIMARY KEY, session_id TEXT, project TEXT, ts TEXT, model TEXT, input_tokens INT, output_tokens INT, cache_write_5m INT, cache_write_1h INT, cache_read INT, cost_usd REAL)`
  - `ingest_state(file TEXT PRIMARY KEY, offset INT)`
  - `interventions(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, session_id TEXT, lever TEXT, mode TEXT, message TEXT)`

- [ ] **Step 1: Failing test**

```js
// tests/db.test.js
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";

describe("openDb", () => {
  it("creates schema in-memory and is idempotent", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(tables).toEqual(expect.arrayContaining(["turns", "ingest_state", "interventions"]));
    const db2 = openDb(":memory:"); // no throw on re-run of DDL
    expect(db2).toBeTruthy();
  });
  it("upserts a turn by message_id", () => {
    const db = openDb(":memory:");
    const ins = db.prepare(`INSERT INTO turns (message_id, session_id, project, ts, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read, cost_usd)
      VALUES (@message_id,@session_id,@project,@ts,@model,@input_tokens,@output_tokens,@cache_write_5m,@cache_write_1h,@cache_read,@cost_usd)
      ON CONFLICT(message_id) DO NOTHING`);
    const row = { message_id: "m1", session_id: "s1", project: "p", ts: "2026-07-11T00:00:00Z", model: "claude-opus-4-8", input_tokens: 10, output_tokens: 5, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, cost_usd: 0.001 };
    ins.run(row); ins.run(row);
    expect(db.prepare("SELECT COUNT(*) c FROM turns").get().c).toBe(1);
  });
});
```

- [ ] **Step 2: FAIL run.** — module not found.
- [ ] **Step 3: Implement `src/db.js`**

```js
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
```

- [ ] **Step 4: PASS; commit** — `git commit -am "feat: sqlite schema"`

---

### Task 3: Pricing / cost model

**Files:**
- Create: `config/pricing.json`, `src/pricing.js`, `tests/pricing.test.js`

**Interfaces:**
- Produces: `loadPricing(filePath?) -> rules[]`; `priceTurn(turn, rules) -> costUsd` where turn = `{ model, ts, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read }`. Rule match: `model.startsWith(rule.model_prefix)`, latest `effective_from <= ts` wins; unknown model uses rule with `model_prefix: ""` and sets `turn.unknown_model = true` via return `{ costUsd, unknownModel }`.

- [ ] **Step 1: Write `config/pricing.json`** (USD per MTok; cache_write_5m = 1.25×input, 1h = 2×, read = 0.1×)

```json
{
  "rules": [
    { "model_prefix": "claude-fable-5",  "effective_from": "2026-01-01", "input": 10, "output": 50, "cache_write_5m": 12.5, "cache_write_1h": 20, "cache_read": 1 },
    { "model_prefix": "claude-opus-4",   "effective_from": "2026-01-01", "input": 5,  "output": 25, "cache_write_5m": 6.25, "cache_write_1h": 10, "cache_read": 0.5 },
    { "model_prefix": "claude-sonnet-5", "effective_from": "2026-01-01", "input": 2,  "output": 10, "cache_write_5m": 2.5,  "cache_write_1h": 4,  "cache_read": 0.2 },
    { "model_prefix": "claude-sonnet-5", "effective_from": "2026-09-01", "input": 3,  "output": 15, "cache_write_5m": 3.75, "cache_write_1h": 6,  "cache_read": 0.3 },
    { "model_prefix": "claude-sonnet-4", "effective_from": "2026-01-01", "input": 3,  "output": 15, "cache_write_5m": 3.75, "cache_write_1h": 6,  "cache_read": 0.3 },
    { "model_prefix": "claude-haiku-4",  "effective_from": "2026-01-01", "input": 1,  "output": 5,  "cache_write_5m": 1.25, "cache_write_1h": 2,  "cache_read": 0.1 },
    { "model_prefix": "",                "effective_from": "2026-01-01", "input": 5,  "output": 25, "cache_write_5m": 6.25, "cache_write_1h": 10, "cache_read": 0.5 }
  ]
}
```

- [ ] **Step 2: Failing tests**

```js
// tests/pricing.test.js
import { describe, it, expect } from "vitest";
import { loadPricing, priceTurn } from "../src/pricing.js";

const rules = loadPricing();
const base = { input_tokens: 0, output_tokens: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 };

describe("priceTurn", () => {
  it("prices opus 4.8 input+output", () => {
    const { costUsd } = priceTurn({ ...base, model: "claude-opus-4-8", ts: "2026-07-11T10:00:00Z", input_tokens: 1_000_000, output_tokens: 1_000_000 }, rules);
    expect(costUsd).toBeCloseTo(30, 6); // 5 + 25
  });
  it("applies TTL-specific cache write pricing", () => {
    const { costUsd } = priceTurn({ ...base, model: "claude-opus-4-8", ts: "2026-07-11T10:00:00Z", cache_write_5m: 1_000_000, cache_write_1h: 1_000_000 }, rules);
    expect(costUsd).toBeCloseTo(6.25 + 10, 6);
  });
  it("sonnet 5 intro pricing rolls over after 2026-08-31", () => {
    const before = priceTurn({ ...base, model: "claude-sonnet-5", ts: "2026-08-30T00:00:00Z", input_tokens: 1_000_000 }, rules).costUsd;
    const after  = priceTurn({ ...base, model: "claude-sonnet-5", ts: "2026-09-02T00:00:00Z", input_tokens: 1_000_000 }, rules).costUsd;
    expect(before).toBeCloseTo(2, 6);
    expect(after).toBeCloseTo(3, 6);
  });
  it("flags unknown models and uses fallback pricing", () => {
    const r = priceTurn({ ...base, model: "mystery-model", ts: "2026-07-11T00:00:00Z", input_tokens: 1_000_000 }, rules);
    expect(r.unknownModel).toBe(true);
    expect(r.costUsd).toBeCloseTo(5, 6);
  });
});
```

- [ ] **Step 3: FAIL run.**
- [ ] **Step 4: Implement `src/pricing.js`**

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "pricing.json");

export function loadPricing(filePath = defaultPath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")).rules;
}

export function priceTurn(turn, rules) {
  const ts = turn.ts.slice(0, 10);
  const candidates = rules
    .filter(r => turn.model.startsWith(r.model_prefix) && r.effective_from <= ts)
    .sort((a, b) => (b.model_prefix.length - a.model_prefix.length) || (b.effective_from < a.effective_from ? -1 : 1));
  // longest prefix wins; among same prefix, latest effective_from wins
  const samePrefix = candidates.filter(r => r.model_prefix === candidates[0]?.model_prefix)
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  const rule = samePrefix[0];
  const unknownModel = !rule || rule.model_prefix === "";
  const M = 1_000_000;
  const costUsd = !rule ? 0 :
    (turn.input_tokens || 0) / M * rule.input +
    (turn.output_tokens || 0) / M * rule.output +
    (turn.cache_write_5m || 0) / M * rule.cache_write_5m +
    (turn.cache_write_1h || 0) / M * rule.cache_write_1h +
    (turn.cache_read || 0) / M * rule.cache_read;
  return { costUsd, unknownModel };
}
```

- [ ] **Step 5: PASS; commit** — `git commit -am "feat: TTL- and date-aware pricing model"`

---

### Task 4: Transcript parser

**Files:**
- Create: `src/parser.js`, `tests/parser.test.js`, `tests/fixtures/session-basic.jsonl`

**Interfaces:**
- Produces: `extractTurn(line, { project }) -> turnRow | null`. Returns null for non-assistant lines, lines without usage, malformed JSON. Maps `usage.cache_creation.ephemeral_5m_input_tokens/ephemeral_1h_input_tokens` (falling back: if no breakdown object, all of `cache_creation_input_tokens` counts as 5m).

- [ ] **Step 1: Fixture `tests/fixtures/session-basic.jsonl`** (4 lines: a user line, an assistant line with 5m-only cache breakdown, an assistant line with mixed 5m/1h + legacy fallback line, one malformed line)

```jsonl
{"type":"user","sessionId":"s1","timestamp":"2026-07-11T10:00:00.000Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","sessionId":"s1","timestamp":"2026-07-11T10:00:05.000Z","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":200,"cache_creation_input_tokens":5000,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":5000,"ephemeral_1h_input_tokens":0}}}}
{"type":"assistant","sessionId":"s1","timestamp":"2026-07-11T10:01:00.000Z","message":{"id":"msg_2","model":"claude-opus-4-8","usage":{"input_tokens":50,"output_tokens":80,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000}}}
{this is not json}
```

- [ ] **Step 2: Failing tests**

```js
// tests/parser.test.js
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { extractTurn } from "../src/parser.js";

const lines = fs.readFileSync("tests/fixtures/session-basic.jsonl", "utf8").split("\n").filter(Boolean);

describe("extractTurn", () => {
  it("ignores user lines and malformed lines", () => {
    expect(extractTurn(lines[0], { project: "p" })).toBeNull();
    expect(extractTurn(lines[3], { project: "p" })).toBeNull();
  });
  it("extracts usage with TTL breakdown", () => {
    const t = extractTurn(lines[1], { project: "p" });
    expect(t).toMatchObject({ message_id: "msg_1", session_id: "s1", model: "claude-opus-4-8",
      input_tokens: 100, output_tokens: 200, cache_write_5m: 5000, cache_write_1h: 0, cache_read: 0 });
  });
  it("falls back: no breakdown object → all cache_creation counts as 5m", () => {
    const t = extractTurn(lines[2], { project: "p" });
    expect(t.cache_write_5m).toBe(1000);
    expect(t.cache_write_1h).toBe(0);
    expect(t.cache_read).toBe(5000);
  });
});
```

- [ ] **Step 3: FAIL run.**
- [ ] **Step 4: Implement `src/parser.js`**

```js
export function extractTurn(line, { project }) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj?.type !== "assistant") return null;
  const msg = obj.message;
  const u = msg?.usage;
  if (!msg?.id || !u) return null;
  const bd = u.cache_creation;
  const cw5 = bd ? (bd.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
  const cw1 = bd ? (bd.ephemeral_1h_input_tokens || 0) : 0;
  return {
    message_id: msg.id,
    session_id: obj.sessionId || "unknown",
    project,
    ts: obj.timestamp || new Date(0).toISOString(),
    model: msg.model || "unknown",
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_write_5m: cw5,
    cache_write_1h: cw1,
    cache_read: u.cache_read_input_tokens || 0,
  };
}
```

- [ ] **Step 5: PASS; commit** — `git commit -am "feat: transcript parser"`

---

### Task 5: Ingestor (backfill + watch)

**Files:**
- Create: `src/ingest.js`, `tests/ingest.test.js`

**Interfaces:**
- Consumes: `openDb`, `extractTurn`, `loadPricing`, `priceTurn`.
- Produces: `ingestFile(db, rules, filePath, project)` (offset-tracked incremental read, upserts priced turns); `backfill(db, rules, transcriptGlobDir)` (walks `projects/*/ *.jsonl`, project = decoded dir name); `watch(db, rules, transcriptGlobDir)` (chokidar add/change → ingestFile; returns watcher).

- [ ] **Step 1: Failing tests** — use a temp dir mimicking `projects/<proj>/<session>.jsonl`; ingest twice, assert no duplicates and cost computed; append a line, ingest again, assert only new row added (offset works).

```js
// tests/ingest.test.js
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
```

- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement `src/ingest.js`**

```js
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
    if (!fs.statSync(projDir).isDirectory()) continue;
    for (const f of fs.readdirSync(projDir)) {
      if (f.endsWith(".jsonl")) ingestFile(db, rules, path.join(projDir, f), proj);
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
```

- [ ] **Step 4: PASS; commit** — `git commit -am "feat: ingestor with backfill, offsets, watch"`

---

### Task 6: Analytics breakdowns

**Files:**
- Create: `src/analytics/breakdowns.js`, `tests/breakdowns.test.js`

**Interfaces:**
- Produces (all take `db`, return plain objects/arrays):
  - `spendByDay(db, {days=30})` → `[{day, cost, input_tokens, output_tokens, cache_read, cache_write}]`
  - `spendByProject(db)` / `spendByModel(db)` / `sessions(db, {limit=50})` → `[{session_id, project, model, started, turns, cost}]`
  - `sessionDetail(db, sessionId)` → ordered turns with per-turn cost
  - `cacheStats(db)` → `{ hitRate, totalRead, totalWrite5m, totalWrite1h, freshInput }` where hitRate = read / (read + freshInput)
  - `overview(db)` → `{ today, week, month, effectiveDollarsPerMTok }`

- [ ] **Step 1: Failing tests** — seed in-memory DB with 4 hand-written turns across 2 sessions/2 models/2 days; assert each function's numbers exactly.

```js
// tests/breakdowns.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import { spendByDay, spendByProject, spendByModel, sessions, sessionDetail, cacheStats, overview } from "../src/analytics/breakdowns.js";

let db;
const seed = [
  ["m1","s1","projA","2026-07-10T09:00:00Z","claude-opus-4-8",1000,500,4000,0,0,0.05],
  ["m2","s1","projA","2026-07-10T09:05:00Z","claude-opus-4-8",100,300,0,0,4000,0.02],
  ["m3","s2","projB","2026-07-11T09:00:00Z","claude-haiku-4-5",2000,100,0,1000,0,0.01],
  ["m4","s2","projB","2026-07-11T09:10:00Z","claude-haiku-4-5",50,80,0,0,1000,0.005],
];
beforeEach(() => {
  db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  seed.forEach(r => ins.run(...r));
});

describe("breakdowns", () => {
  it("spendByDay groups and sums", () => {
    const days = spendByDay(db, { days: 365 });
    expect(days.length).toBe(2);
    expect(days.find(d => d.day === "2026-07-10").cost).toBeCloseTo(0.07, 6);
  });
  it("spendByProject / spendByModel", () => {
    expect(spendByProject(db).find(p => p.project === "projB").cost).toBeCloseTo(0.015, 6);
    expect(spendByModel(db).find(m => m.model === "claude-opus-4-8").cost).toBeCloseTo(0.07, 6);
  });
  it("sessions list + detail ordered", () => {
    const s = sessions(db, {});
    expect(s.length).toBe(2);
    expect(sessionDetail(db, "s1").length).toBe(2);
  });
  it("cacheStats hitRate = read/(read+fresh)", () => {
    const c = cacheStats(db);
    expect(c.totalRead).toBe(5000);
    expect(c.hitRate).toBeCloseTo(5000 / (5000 + 3150), 4);
  });
  it("overview returns totals", () => {
    const o = overview(db);
    expect(o.month).toBeCloseTo(0.085, 6);
  });
});
```

- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement with plain SQL** (GROUP BY substr(ts,1,10) for day; hitRate from SUM columns; overview uses `date('now')` boundaries via JS-computed ISO date strings passed as params).

```js
// src/analytics/breakdowns.js
export function spendByDay(db, { days = 30 } = {}) {
  return db.prepare(`SELECT substr(ts,1,10) day, SUM(cost_usd) cost,
    SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
    SUM(cache_read) cache_read, SUM(cache_write_5m + cache_write_1h) cache_write
    FROM turns WHERE ts >= ? GROUP BY day ORDER BY day`)
    .all(new Date(Date.now() - days * 86400e3).toISOString());
}
export function spendByProject(db) {
  return db.prepare(`SELECT project, SUM(cost_usd) cost, COUNT(*) turns FROM turns GROUP BY project ORDER BY cost DESC`).all();
}
export function spendByModel(db) {
  return db.prepare(`SELECT model, SUM(cost_usd) cost, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens FROM turns GROUP BY model ORDER BY cost DESC`).all();
}
export function sessions(db, { limit = 50 } = {}) {
  return db.prepare(`SELECT session_id, project, MIN(ts) started, MAX(model) model, COUNT(*) turns, SUM(cost_usd) cost
    FROM turns GROUP BY session_id ORDER BY started DESC LIMIT ?`).all(limit);
}
export function sessionDetail(db, sessionId) {
  return db.prepare(`SELECT * FROM turns WHERE session_id = ? ORDER BY ts`).all(sessionId);
}
export function cacheStats(db) {
  const r = db.prepare(`SELECT SUM(cache_read) totalRead, SUM(cache_write_5m) totalWrite5m,
    SUM(cache_write_1h) totalWrite1h, SUM(input_tokens) freshInput FROM turns`).get();
  const totalRead = r.totalRead || 0, freshInput = (r.freshInput || 0) + (r.totalWrite5m || 0) + (r.totalWrite1h || 0) - (r.totalWrite5m || 0) - (r.totalWrite1h || 0);
  // freshInput = uncached input only (input_tokens field is already the uncached remainder)
  const fresh = r.freshInput || 0;
  return { totalRead, totalWrite5m: r.totalWrite5m || 0, totalWrite1h: r.totalWrite1h || 0,
    freshInput: fresh, hitRate: totalRead + fresh > 0 ? totalRead / (totalRead + fresh) : 0 };
}
export function overview(db) {
  const now = new Date();
  const dayStart = now.toISOString().slice(0, 10);
  const weekStart = new Date(now - 7 * 86400e3).toISOString();
  const monthStart = new Date(now - 30 * 86400e3).toISOString();
  const q = db.prepare("SELECT SUM(cost_usd) c FROM turns WHERE ts >= ?");
  const tot = db.prepare(`SELECT SUM(cost_usd) c, SUM(input_tokens + output_tokens + cache_read + cache_write_5m + cache_write_1h) t FROM turns`).get();
  return {
    today: q.get(dayStart).c || 0,
    week: q.get(weekStart).c || 0,
    month: q.get(monthStart).c || 0,
    effectiveDollarsPerMTok: tot.t ? (tot.c / tot.t) * 1_000_000 : 0,
  };
}
```
(Clean up the `cacheStats` dead arithmetic when implementing — keep only `fresh`.)

- [ ] **Step 4: PASS; commit** — `git commit -am "feat: analytics breakdowns"`

---

### Task 7: Waste detectors + TTL advisor

**Files:**
- Create: `src/analytics/detectors.js`, `tests/detectors.test.js`

**Interfaces:**
- Produces: `runDetectors(db, rules) -> findings[]` with shape `{ type, session_id?, project?, ts?, wastedUsd, recommendation, detail }`. Types: `cache_expiry`, `cache_invalidation`, `session_bloat`, `output_verbosity`, `model_mismatch`. Also `ttlAdvisor(db, rules) -> [{project, verdict: "keep-5m"|"switch-1h", monthlyDeltaUsd, reasoning}]`.
- Detection rules (deterministic, testable):
  - **cache_expiry**: within a session, turn N has `cache_read > 0`-history (any prior cache activity) and turn N+1 has `cache_read = 0` **and** `cache_write_5m + cache_write_1h > 0` **and** gap > TTL (TTL = 1h if session ever wrote 1h tokens, else 5 min). `wastedUsd` = cache-write cost of turn N+1 minus what a cache-read of the same tokens would have cost.
  - **cache_invalidation**: same signature but gap ≤ TTL.
  - **session_bloat**: session where the mean of (cache_read + input) over the last 3 turns > 120k tokens. `wastedUsd` = (meanContext − 60k) / MTok × cache_read price × remaining-turn estimate (3). Recommendation: `/compact` or `/clear`.
  - **output_verbosity**: turns with `output_tokens > 3000` where the session's median output is < 800. `wastedUsd` = (output − median) × output price.
  - **model_mismatch**: session on an Opus/Fable model whose total cost > $0.50 and > 60% of turns are tool-heavy (approximation: output_tokens < 300 per turn — mechanical loops produce short outputs). `wastedUsd` = 0.5 × session cost (what Haiku delegation could plausibly save). Marked `confidence: "estimate"`.
  - **savingsAttribution** (also export `savingsAttribution(db) -> [{lever, eventsPerSessionBefore, eventsPerSessionAfter, estSavedUsd}]`): for each lever with rows in `interventions`, compare the rate of related detector findings in sessions started before vs after the lever's first intervention; `estSavedUsd` = (rateBefore − rateAfter) × mean wastedUsd × session count after. Exposed via `/api/waste` payload under `attribution`.
  - **ttlAdvisor**: per project, compute for each session the count of reuse gaps ≤ 5m (r5) and ≤ 1h (r1). If switching to 1h would have turned expiry re-writes into reads: monthlyDelta = Σ over expiry events with gap ≤ 1h of (rewrite cost − read cost) − extra write premium (2× vs 1.25× on all writes). Verdict `switch-1h` if delta > 0.

- [ ] **Step 1: Failing tests** — seed sessions purpose-built per detector (one fixture builder `seedTurns(db, rows)`), assert each detector fires exactly on its scenario and not on clean sessions, and that `wastedUsd > 0`.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement `runDetectors` + `ttlAdvisor`** per the rules above (iterate `sessionDetail`-style query grouped in JS; reuse `priceTurn` rules for prices via a helper `ruleFor(model, ts, rules)` exported from `src/pricing.js`).
- [ ] **Step 4: PASS; commit** — `git commit -am "feat: waste detectors + TTL advisor"`

---

### Task 8: Dashboard API server

**Files:**
- Create: `src/server.js`, `scripts/start.mjs`, `tests/server.test.js`

**Interfaces:**
- Produces: `buildServer({ db, rules, config }) -> fastify` with routes: `GET /api/overview`, `/api/spend/daily`, `/api/spend/projects`, `/api/spend/models`, `/api/sessions`, `/api/sessions/:id`, `/api/cache`, `/api/waste`, `/api/ttl-advice`, `/api/interventions`. `startServer(app, config)` tries `config.port` then `portRange` (never 9876). `scripts/start.mjs` = openDb → backfill → watch → server listen, logs URL.

- [ ] **Step 1: Failing tests** — `app.inject()` each route against seeded in-memory DB; assert 200 + JSON shape; assert port fallback picks 5600 when 5599 occupied (spin a net server on 5599 in the test).
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement.** Each route is a thin wrapper over Task 6/7 functions; `/api/interventions` reads the `interventions` table. Register `@fastify/static` for `web/dist` when it exists.
- [ ] **Step 4: PASS; commit** — `git commit -am "feat: dashboard API server + start script"`

---

### Task 9: Dashboard frontend

**Files:**
- Create: `web/` Vite React app — `web/index.html`, `web/vite.config.js` (build outDir `dist`, dev proxy `/api` → `http://localhost:5599`), `web/src/main.jsx`, `web/src/App.jsx` (tab nav), `web/src/api.js` (fetch helpers), pages: `Overview.jsx`, `Sessions.jsx`, `CacheHealth.jsx`, `WasteReport.jsx`, `OptimizerLog.jsx`.

**Interfaces:**
- Consumes: the `/api/*` routes from Task 8, verbatim shapes.

- [ ] **Step 1: Scaffold** — `npm create vite@latest web -- --template react`, `cd web && npm i && npm i recharts`.
- [ ] **Step 2: Implement pages** (no TDD for JSX; verified by build + manual smoke):
  - Overview: 3 stat cards (today/week/month), daily spend `AreaChart` stacked by input/output/cache_read/cache_write, effective $/MTok.
  - Sessions: table (session, project, model, turns, cost) → click loads `/api/sessions/:id`, renders per-turn `BarChart` waterfall of cost with token tooltips.
  - CacheHealth: hit-rate stat, write-5m/write-1h/read totals, expiry+invalidation events table from `/api/waste` filtered.
  - WasteReport: findings ranked by `wastedUsd`, each row shows type badge, recommendation, dollar amount; TTL advisor verdicts section from `/api/ttl-advice`.
  - OptimizerLog: interventions table (ts, session, lever, mode, message).
- [ ] **Step 3: Build passes** — `cd web && npm run build` → exits 0, `web/dist/index.html` exists.
- [ ] **Step 4: Commit** — `git commit -am "feat: dashboard frontend"`

---

### Task 10: Optimizer hooks

**Files:**
- Create: `plugin/optimizer-config.json`, `plugin/hooks/lib.mjs`, `plugin/hooks/session-start.mjs`, `plugin/hooks/user-prompt-submit.mjs`, `plugin/hooks/pre-tool-use.mjs`, `plugin/hooks/stop.mjs`, `tests/hooks.test.js`

**Interfaces:**
- Hook contract (Claude Code): JSON on stdin; stdout JSON like `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` for context injection, or `{"systemMessage": "..."}` for user-visible warnings. Exit 0 always.
- `plugin/optimizer-config.json`:

```json
{
  "levers": {
    "efficiency_conventions": "suggest",
    "cache_expiry_warning": "suggest",
    "context_bloat_warning": "suggest",
    "wasteful_read_warning": "suggest",
    "session_cost_record": "enforce"
  },
  "thresholds": { "bloatContextTokens": 120000, "largeFileRereadBytes": 100000 }
}
```

- `plugin/hooks/lib.mjs`: `readStdin()`, `loadOptimizerConfig()`, `logIntervention(db, {...})`, `lastTurnGapMs(db, sessionId)`, `sessionTtlMs(db, sessionId)` (1h if any 1h writes else 5m), all wrapped so failures return safe defaults.
- Behaviors:
  - **session-start**: if lever ≠ observe, emit `additionalContext` with the efficiency convention text (terse outputs; delegate mechanical searches to `cheap-explore`/`cheap-search` subagents; targeted reads over whole-file reads). Log intervention.
  - **user-prompt-submit**: read session_id + transcript_path from input; if gap since last assistant turn > session TTL → `systemMessage` "prompt cache expired (gap Xm > TTL Ym): this turn re-bills full context (~$Z). Consider /clear if starting a new topic." If last-3-turn mean context > threshold → suggest `/compact`. Log.
  - **pre-tool-use**: if tool is Read with a file already read this session (query transcript via DB? simpler: track in a per-session sidecar JSON `data/session-reads/<id>.json`) and file size > threshold → `systemMessage` warning. Suggest mode only. Log.
  - **stop**: upsert final session cost snapshot into interventions log (`lever: session_cost_record`) so statusline/dashboard have a closing record. Exit 0.

- [ ] **Step 1: Failing tests** — invoke each hook via `node plugin/hooks/x.mjs` (child_process) with sample stdin payloads + env `TOKEFF_DB` pointing at a temp DB seeded with turns; assert stdout JSON contract, exit code 0, and intervention rows written. Include a fail-open test: corrupt DB path → still exit 0, empty stdout.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement** per behaviors above. Hooks open the DB read-only where possible; every hook body inside `try { ... } catch { } finally { process.exit(0) }`.
- [ ] **Step 4: PASS; commit** — `git commit -am "feat: fail-open optimizer hooks"`

---

### Task 11: Subagents, skills, statusline

**Files:**
- Create: `plugin/agents/cheap-explore.md`, `plugin/agents/cheap-search.md`, `plugin/skills/spend/SKILL.md`, `plugin/skills/efficiency-audit/SKILL.md`, `plugin/statusline.mjs`, `src/statusline-data.js`, `tests/statusline.test.js`

**Interfaces:**
- Agents: markdown with frontmatter `name`, `description`, `model: haiku`, restricted `tools: Read, Glob, Grep` — read-only exploration/search personas that return concise findings.
- Skills: `spend` SKILL.md instructs Claude to run `node <projectRoot>/scripts/report.mjs` (add this tiny script: prints today/week/month + top sessions from DB as markdown). `efficiency-audit` SKILL.md instructs Claude to run `node <projectRoot>/scripts/audit-session.mjs <transcript-path>` which runs detectors against the current session only and prints recommendations.
- Statusline: Claude Code invokes `plugin/statusline.mjs` with JSON on stdin (has `session_id`, `transcript_path`, `model`); prints one line: `💰 $X.XX session · cache HIT|COLD · $Y.YY today`. `src/statusline-data.js` exports `statuslineData(db, sessionId)` → `{ sessionCost, todayCost, cacheWarm }` (cacheWarm = last turn < TTL ago and had cache_read > 0).

- [ ] **Step 1: Failing test for `statuslineData`** (seeded DB: correct sums; cacheWarm flips with gap).
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement all files.** Statusline script fail-open: on any error print `💰 tokeff` and exit 0.
- [ ] **Step 4: PASS; run `node plugin/statusline.mjs` manually with sample stdin; commit** — `git commit -am "feat: subagents, skills, statusline"`

---

### Task 12: Installer

**Files:**
- Create: `scripts/install.mjs`, `tests/install.test.js`

**Interfaces:**
- Produces: `install({ configDir, projectRoot, dryRun })` which:
  1. Copies `plugin/agents/*.md` → `<configDir>/agents/`, `plugin/skills/*` → `<configDir>/skills/`.
  2. Merges into `<configDir>/settings.json` (deep-merge, preserving existing entries): `hooks.SessionStart/UserPromptSubmit/PreToolUse/Stop` entries running `node <abs path to hook>.mjs`, and `statusLine: { type: "command", command: "node <abs>/plugin/statusline.mjs" }` **only if no statusLine already configured** (never clobber).
  3. Writes nothing outside `configDir` and the project; prints a summary of every change; `--dry-run` prints without writing.
- CLI: `node scripts/install.mjs [--dry-run]`.

- [ ] **Step 1: Failing tests** — temp configDir with a pre-existing settings.json containing an unrelated hook and an existing statusLine; run `install`; assert: agents/skills copied, our hooks appended not replacing existing, existing statusLine untouched, dry-run writes nothing.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS; commit** — `git commit -am "feat: installer with non-clobbering settings merge"`

---

### Task 13: End-to-end integration + README

**Files:**
- Create: `tests/e2e.test.js`, `README.md`

- [ ] **Step 1: E2E test** — temp `projects/` tree with the basic fixture → `openDb(tempfile)` → `backfill` → `buildServer` → inject `/api/overview`, `/api/sessions`, `/api/waste`; assert consistent totals across endpoints (overview.month === Σ session costs).
- [ ] **Step 2: FAIL → implement any glue gaps → PASS.**
- [ ] **Step 3: README.md** — what it is, quick start (`npm i`, `node scripts/install.mjs`, `npm start`, open http://localhost:5599), how each lever/mode works, how to edit pricing config, uninstall notes.
- [ ] **Step 4: Full suite green** — `npx vitest run` all pass; `cd web && npm run build` passes.
- [ ] **Step 5: Commit** — `git commit -am "feat: e2e test + README"`

---

### Task 14: Live verification

- [ ] **Step 1:** `node scripts/start.mjs` against the real config dir (`~/.claude-work`) — backfill runs over real transcripts, server starts on 5599.
- [ ] **Step 2:** `curl http://localhost:5599/api/overview` returns real spend numbers; open dashboard, spot-check a real session waterfall.
- [ ] **Step 3:** `node scripts/install.mjs --dry-run` output reviewed; then real install; verify `~/.claude-work/settings.json` merge is additive.
- [ ] **Step 4:** Final commit; stop the server (its own PID only).
