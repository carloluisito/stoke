# Contributing to stoke

Thanks for considering a contribution. stoke is a small, focused tool — the
contribution model matches: keep changes scoped, write tests, no churn.

## Dev setup

```bash
git clone <your fork>
cd stoke
npm install
npm test          # 219+ tests, ~10s
npm run typecheck # tsc --noEmit
```

Node ≥ 20 required.

## Running the proxy from source

```bash
npm start                          # listens on 127.0.0.1:9876
ANTHROPIC_BASE_URL=http://127.0.0.1:9876 claude
```

The proxy reads / writes `~/.stoke/` (config, events log, persisted sessions,
digest). Wipe the directory to start fresh.

## Pull requests

- One concern per PR. Tests included or the PR will be sent back.
- Run `npm run typecheck && npm test` before pushing.
- New features need a test. Bug fixes need a regression test.
- Keep commits coherent — squash WIP commits before requesting review.
- README updates if your change affects user-visible behavior.

## Areas where help is welcome

- Additional plan / billing modes beyond `api-key` / `subscription` / `enterprise`
- Observation-based TTL corroboration (the "Anthropic silently changes TTL" gap)
- macOS / Linux env-var auto-setup polish
- Translated documentation

## Code style

- TypeScript strict mode (already enforced by `tsconfig.json`).
- No external runtime deps — only optional `@opentelemetry/*` is allowed.
- Pure functions where possible. Side effects isolated and testable.
- Comments only when the WHY isn't obvious from the code.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating, you agree to abide by its terms.

## Reporting bugs

Open an issue with reproduction steps and the relevant snippet from
`~/.stoke/events.jsonl`. Strip any auth headers before pasting.

## Security

See [SECURITY.md](./SECURITY.md) for the disclosure policy.
