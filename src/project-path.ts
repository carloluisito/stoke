// src/project-path.ts
// Extract a human-readable project path from Claude Code's request payload.
// Claude Code embeds the CWD in the `system` field in a few formats; we try
// each in order and return a short, display-friendly form.

const CWD_PATTERNS: RegExp[] = [
  /<env>[\s\S]*?cwd:\s*([^\n<]+)/i,
  /<cwd>\s*([^<\n]+?)\s*<\/cwd>/i,
  /Working directory:\s*([^\n]+)/i,
  /Current working directory:\s*([^\n]+)/i,
  /cwd:\s*([^\n]+)/i,
];

/** Pull the CWD out of a payload's `system` field, or return null. */
export function extractProjectPath(payload: Record<string, unknown>): string | null {
  const sys = payload["system"];
  const text =
    typeof sys === "string"
      ? sys
      : Array.isArray(sys)
        ? sys.map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? "")).join("\n")
        : "";
  if (!text) return null;

  for (const re of CWD_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) return shortenPath(m[1].trim());
  }
  return null;
}

/**
 * Compress a long absolute path to the trailing 2-3 segments most
 * meaningful to a human ("work/resto-backend" rather than the full
 * "C:\Users\carlo\Desktop\repositories\work\resto-backend").
 */
function shortenPath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return raw;

  // Find a meaningful anchor — look for "repositories", "projects", "work", etc.
  const anchors = ["work", "personal", "ispade", "projects", "repositories", "src"];
  for (let i = segments.length - 1; i >= 0; i--) {
    if (anchors.includes(segments[i].toLowerCase())) {
      // Take the anchor and everything after it.
      return segments.slice(i).join("/");
    }
  }
  // No anchor found — return the last 2-3 segments.
  return segments.slice(-2).join("/");
}
