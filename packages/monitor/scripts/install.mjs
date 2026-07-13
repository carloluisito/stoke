import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

const HOOK_EVENTS = {
  SessionStart: "session-start.mjs",
  UserPromptSubmit: "user-prompt-submit.mjs",
  PreToolUse: "pre-tool-use.mjs",
  Stop: "stop.mjs",
};

export function install({ configDir, projectRoot, dryRun = false }) {
  const changes = [];
  const write = (fp, content) => {
    changes.push(`write ${fp}`);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
  };

  // 1. Agents
  const agentsSrc = path.join(projectRoot, "plugin", "agents");
  for (const f of fs.readdirSync(agentsSrc)) {
    write(path.join(configDir, "agents", f), fs.readFileSync(path.join(agentsSrc, f), "utf8"));
  }

  // 2. Skills (rewrite %TOKEFF_ROOT% to the absolute project root)
  const skillsSrc = path.join(projectRoot, "plugin", "skills");
  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const src = path.join(skillsSrc, skillDir, "SKILL.md");
    const content = fs.readFileSync(src, "utf8").replaceAll("%TOKEFF_ROOT%", projectRoot.replaceAll("\\", "/"));
    write(path.join(configDir, "skills", skillDir, "SKILL.md"), content);
  }

  // 3. settings.json merge (additive, never clobber)
  const settingsPath = path.join(configDir, "settings.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { /* fresh */ }

  settings.hooks = settings.hooks || {};
  for (const [event, script] of Object.entries(HOOK_EVENTS)) {
    const command = `node "${path.join(projectRoot, "plugin", "hooks", script)}"`;
    settings.hooks[event] = settings.hooks[event] || [];
    const already = settings.hooks[event].some(m => (m.hooks || []).some(h => h.command?.includes(script)));
    if (!already) {
      settings.hooks[event].push({ hooks: [{ type: "command", command, timeout: 10 }] });
      changes.push(`hook ${event} -> ${script}`);
    }
  }

  if (!settings.statusLine) {
    settings.statusLine = { type: "command", command: `node "${path.join(projectRoot, "plugin", "statusline.mjs")}"` };
    changes.push("statusLine -> tokeff statusline");
  } else {
    changes.push("statusLine already configured — left untouched");
  }

  changes.push(`merge ${settingsPath}`);
  if (!dryRun) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  return changes;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const config = loadConfig();
  const dryRun = process.argv.includes("--dry-run");
  for (const configDir of config.configDirs) {
    const changes = install({ configDir, projectRoot: config.projectRoot, dryRun });
    console.log(`[tokeff install] ${configDir}${dryRun ? " (dry run — nothing written)" : ""}`);
    for (const c of changes) console.log("  -", c);
  }
}
