// Claude Code encodes a project's cwd as its directory name, replacing every
// path separator with "-" ("C--Users-me-Desktop-repositories-personal-omnidesk").
// Raw, that's unreadable in a table and identical across every project for the
// first five segments. Keep the group + name that actually distinguish it:
// "personal/omnidesk".
//
// This is the ONE name formatter. It replaced two partial implementations:
// projectLabeler() in api.js (longest-common-prefix, produced a bare tail) and
// shortPath() in Proxy.jsx (last two path segments, left "-" runs mangled).
//
// MUST BE IDEMPOTENT. The proxy's live-session feed already sends shortened
// labels like "personal/agent-sandbox", and an earlier version re-truncated
// those to "agent/sandbox" — five concurrent sessions all rendered as the same
// meaningless label. Anything with no scaffolding left in it is returned as-is.

// Path scaffolding: drive letters, user dirs and the container dirs projects
// live inside. Everything after the LAST of these is the meaningful part.
//
// "home" is deliberately absent — it only counts as scaffolding in a leading
// position (see LEADING_ONLY). Treating it as scaffolding anywhere turned the
// real project "work-project-home" into "unknown".
const SCAFFOLD = new Set([
  "c", "d", "e", "f", "users", "desktop", "documents", "mnt", "var",
  "repositories", "repos", "code", "projects", "workspace", "git", "src", "dev",
]);

// Scaffolding only when it appears at the very start of the path (/home/me/...).
const LEADING_ONLY = new Set(["home", "user"]);

const isScaffold = (seg, i) => {
  const s = seg.toLowerCase();
  return SCAFFOLD.has(s) || (i <= 1 && LEADING_ONLY.has(s));
};

export function projectName(raw) {
  if (!raw) return "unknown";
  const parts = String(raw).split(/[\\/-]+/).filter(Boolean);
  if (parts.length === 0) return "unknown";

  // Cut after the deepest scaffolding segment. If there is none, the input is
  // already a clean label — return it untouched rather than truncating.
  let cut = -1;
  for (let i = 0; i < parts.length; i++) {
    if (isScaffold(parts[i], i)) cut = i;
  }
  const rest = parts.slice(cut + 1);

  if (rest.length === 0) return "unknown";
  if (rest.length === 1) return rest[0];

  // First remaining segment is the grouping dir; everything after it is the
  // project name, which may itself contain dashes ("windlass-lms").
  return rest[0] + "/" + rest.slice(1).join("-");
}
