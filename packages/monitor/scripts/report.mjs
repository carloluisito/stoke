import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { overview, sessions, cacheStats } from "../src/analytics/breakdowns.js";

const config = loadConfig();
const db = openDb(config.dbPath);
const o = overview(db);
const c = cacheStats(db);
const top = sessions(db, { limit: 5 });

console.log(`## 💰 Spend report

| Window | Cost |
|---|---|
| Today | $${o.today.toFixed(2)} |
| Last 7 days | $${o.week.toFixed(2)} |
| Last 30 days | $${o.month.toFixed(2)} |

**Effective rate:** $${o.effectiveDollarsPerMTok.toFixed(2)}/MTok blended · **Cache hit rate:** ${(c.hitRate * 100).toFixed(1)}%

### Top recent sessions
| Session | Project | Turns | Cost |
|---|---|---|---|
${top.map(s => `| ${s.session_id.slice(0, 8)} | ${s.project} | ${s.turns} | $${s.cost.toFixed(2)} |`).join("\n")}
`);
