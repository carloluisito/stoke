// src/env-setup.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join, dirname } from "node:path";

export interface EnsureResult {
  action: "already-set" | "updated" | "set" | "skipped-unsupported-platform" | "error";
  detail?: string;
}

const VAR = "ANTHROPIC_BASE_URL";
const BLOCK_BEGIN = "# >>> stoke: env auto-set >>>";
const BLOCK_END = "# <<< stoke: env auto-set <<<";

interface Overrides {
  platform: NodeJS.Platform;
  home: string;
  shell: string;
}
let _overrides: Overrides | null = null;
export const _testHooks = {
  setOverrides(o: Overrides | null): void {
    _overrides = o;
  },
};
function plat(): NodeJS.Platform {
  return _overrides ? _overrides.platform : osPlatform();
}
function home(): string {
  return _overrides ? _overrides.home : homedir();
}
function shellPath(): string {
  return _overrides ? _overrides.shell : (process.env.SHELL ?? "");
}

function readUserEnv(): string {
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", VAR], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const m = out.match(new RegExp(VAR + "\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+?)\\s*$", "m"));
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

function rcPathForPlatform(): string | null {
  const p = plat();
  const sh = shellPath();
  const wantsZsh = sh.endsWith("zsh") || (sh === "" && p === "darwin");
  if (p === "darwin") return join(home(), wantsZsh ? ".zshrc" : ".bash_profile");
  if (p === "linux") return join(home(), wantsZsh ? ".zshrc" : ".bashrc");
  return null;
}

function ensureUnixBlock(targetUrl: string): EnsureResult {
  const rcPath = rcPathForPlatform();
  if (!rcPath) return { action: "skipped-unsupported-platform", detail: String(plat()) };
  mkdirSync(dirname(rcPath), { recursive: true });

  const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
  const newBlock = `${BLOCK_BEGIN}\nexport ${VAR}="${targetUrl}"\n${BLOCK_END}`;
  const blockRe = new RegExp(`${BLOCK_BEGIN}[\\s\\S]*?${BLOCK_END}`);
  const match = existing.match(blockRe);

  if (match) {
    if (match[0] === newBlock) return { action: "already-set", detail: targetUrl };
    const updated = existing.replace(blockRe, newBlock);
    writeFileSync(rcPath, updated);
    return { action: "updated", detail: rcPath };
  }
  const appended = existing.length > 0 && !existing.endsWith("\n")
    ? existing + "\n" + newBlock + "\n"
    : existing + newBlock + "\n";
  writeFileSync(rcPath, appended);
  return { action: "set", detail: rcPath };
}

function removeUnixBlock(): EnsureResult {
  const rcPath = rcPathForPlatform();
  if (!rcPath) return { action: "skipped-unsupported-platform", detail: String(plat()) };
  if (!existsSync(rcPath)) return { action: "already-set", detail: "no rc file" };
  const existing = readFileSync(rcPath, "utf8");
  const blockRe = new RegExp(`${BLOCK_BEGIN}[\\s\\S]*?${BLOCK_END}\\n?`);
  if (!blockRe.test(existing)) return { action: "already-set", detail: "block absent" };
  writeFileSync(rcPath, existing.replace(blockRe, ""));
  return { action: "set", detail: "removed" };
}

export function ensurePersistentBaseUrl(targetUrl: string): EnsureResult {
  if (plat() === "win32") {
    const current = readUserEnv();
    if (current === targetUrl) return { action: "already-set", detail: current };
    try {
      execFileSync("setx", [VAR, targetUrl], { stdio: "ignore" });
      return current
        ? { action: "updated", detail: `${current} → ${targetUrl}` }
        : { action: "set", detail: targetUrl };
    } catch (e) {
      return { action: "error", detail: (e as Error).message };
    }
  }
  return ensureUnixBlock(targetUrl);
}

export function removePersistentBaseUrl(): EnsureResult {
  if (plat() === "win32") {
    try {
      execFileSync("reg", ["delete", "HKCU\\Environment", "/v", VAR, "/f"], {
        stdio: "ignore",
      });
      return { action: "set", detail: "removed" };
    } catch (e) {
      return { action: "error", detail: (e as Error).message };
    }
  }
  return removeUnixBlock();
}
