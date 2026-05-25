# Security policy

## Supported versions

Only the latest released version of stoke receives security updates. Pre-1.0
versions are best-effort.

## Threat model — what stoke is and isn't

stoke is a **local-only HTTP proxy**, intended to run on `127.0.0.1` between
Claude Code (or another Anthropic API client) and `api.anthropic.com`. It is
not designed to be exposed beyond loopback.

The proxy gates its dashboard / API surface behind a per-process random
32-character hex auth token. The token is printed at startup, persisted only
in memory, and regenerates on every restart.

### What's gated by the token
- `/dashboard/*` (HTML, JS, CSS, fonts)
- `/api/state`, `/api/stream`, `/api/reload`

### What's NOT gated (by design)
- `/api/health` — minimal liveness JSON, no session metadata
- `/v1/messages` — the Anthropic forwarder; gated by the client's own auth

## Operational guidance

- **Do not bind to `0.0.0.0` or any non-loopback address.** stoke has no audit
  log of token usage, no rate limiting on auth attempts, and was not designed
  to be public-internet-reachable.
- **Treat `~/.stoke/events.jsonl` as sensitive.** It records prefix token
  counts, model names, project paths, and per-session $ spend. It does NOT
  store auth headers or message content, but the metadata is still useful to
  an attacker enumerating your workload.
- **Wipe `~/.stoke/` if you suspect compromise.** Wiping forces a fresh
  registry and a fresh dashboard token on next start.

## Reporting a vulnerability

Open a private GitHub security advisory on the repository, or email the
maintainer listed in `package.json`'s `author` field. We aim to respond within
7 days.

Please include:

- A clear description of the issue
- A minimal reproduction (proxy version, OS, exact request / state)
- Your assessment of impact
- Any preferred timeline / coordinated disclosure window

We will work with you on a fix and credit you in the changelog unless you
prefer otherwise.

## Out of scope

- Issues that require physical or local-user access to the machine running
  stoke (e.g., reading the events log from another local user account).
- Denial-of-service via excessive request volume to `/v1/messages` — stoke
  forwards to Anthropic, which has its own rate limits.
- Anthropic API issues — please report those to Anthropic directly.
