import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { loadPricing } from "../src/pricing.js";
import { runDetectors } from "../src/analytics/detectors.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const rules = loadPricing();

let sessionId = process.argv[2];
if (!sessionId) {
  sessionId = db.prepare("SELECT session_id FROM turns ORDER BY ts DESC LIMIT 1").get()?.session_id;
}
if (!sessionId) {
  console.log("No sessions in the database yet.");
  process.exit(0);
}

const findings = runDetectors(db, rules).filter(f => f.session_id === sessionId);
const cost = db.prepare("SELECT SUM(cost_usd) c, COUNT(*) n FROM turns WHERE session_id = ?").get(sessionId);

console.log(`## 🔍 Efficiency audit — session ${sessionId.slice(0, 8)}

**Cost so far:** $${(cost.c || 0).toFixed(2)} across ${cost.n} turns
`);
if (findings.length === 0) {
  console.log("No waste detected in this session. 🎉");
} else {
  console.log(`| Finding | Wasted | Recommendation |\n|---|---|---|`);
  for (const f of findings) {
    console.log(`| ${f.type} | $${f.wastedUsd.toFixed(2)}${f.confidence === "estimate" ? " (est.)" : ""} | ${f.recommendation} |`);
  }
}
