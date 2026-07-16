import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextSidecarPayload } from "../src/context-sidecar.js";
import { saveContext } from "./hooks/lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  const input = JSON.parse(data);

  // Bridge CC's live context_window (only delivered here) to the UPS hook.
  const ctx = contextSidecarPayload(input, new Date().toISOString());
  if (ctx) saveContext(input.session_id, ctx);

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
