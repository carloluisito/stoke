// Claude Code encodes a project's cwd as its directory name, replacing every
// path separator with "-" ("C--Users-me-Desktop-repositories-personal-omnidesk").
// Raw, that's unreadable in a table and identical across every project for the
// first five segments. Keep the group + name that actually distinguish it:
// "personal/omnidesk".
//
// This is the ONE name formatter. It replaced two partial implementations:
// projectLabeler() in api.js (longest-common-prefix, produced a bare tail) and
// shortPath() in Proxy.jsx (last two path segments, left "-" runs mangled).

// Container directories that projects live *inside*. Everything after the
// deepest one of these is the meaningful part of the path.
//
// Only container words belong here — NOT "home" or "users". An earlier version
// treated those as strippable anywhere in the path, which silently turned
// "...repositories-work-project-home" into "unknown", because the project was
// literally named "project-home".
const ANCHORS = new Set([
  "repositories", "repos", "code", "projects", "workspace", "git", "src", "dev",
]);

// Leading path scaffolding — only ever stripped from the *front*, and only when
// no anchor was found.
const LEADING_NOISE = new Set([
  "c", "d", "e", "f", "users", "home", "desktop", "documents", "mnt", "var",
]);

export function projectName(raw) {
  if (!raw) return "unknown";
  const parts = String(raw).split(/[\\/-]+/).filter(Boolean);
  if (parts.length === 0) return "unknown";

  // Prefer the deepest container dir as the cut point.
  let cut = -1;
  for (let i = 0; i < parts.length; i++) {
    if (ANCHORS.has(parts[i].toLowerCase())) cut = i;
  }

  let rest;
  if (cut >= 0) {
    rest = parts.slice(cut + 1);
  } else {
    // No recognisable container — drop the leading scaffolding run, then keep
    // at most the last two segments.
    let i = 0;
    while (i < parts.length && LEADING_NOISE.has(parts[i].toLowerCase())) i++;
    rest = parts.slice(i);
    if (rest.length > 2) rest = rest.slice(-2);
  }

  if (rest.length === 0) return "unknown";
  if (rest.length === 1) return rest[0];

  // First remaining segment is the grouping dir; everything after it is the
  // project name, which may itself contain dashes ("windlass-lms").
  return rest[0] + "/" + rest.slice(1).join("-");
}
