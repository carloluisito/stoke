import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  const input = JSON.parse(data);
  const { openDb } = await import("../src/db.js");
  const { statuslineData } = await import("../src/statusline-data.js");
  const db = openDb(process.env.TOKEFF_DB || path.join(projectRoot, "data", "tokeff.db"));
  const { sessionCost, todayCost, cacheWarm } = statuslineData(db, input.session_id);
  process.stdout.write(
    `\u{1F4B0} $${sessionCost.toFixed(2)} session · cache ${cacheWarm ? "HIT" : "COLD"} · $${todayCost.toFixed(2)} today`
  );
} catch {
  process.stdout.write("\u{1F4B0} tokeff");
}
process.exit(0);
