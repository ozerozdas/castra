# Contributing

Thanks for helping. Castra is small and opinionated, so please open a
[discussion](https://github.com/ozerozdas/castra/discussions) or an issue before starting a large change.

## Setup

Requires Node 20+ and pnpm 10.

```sh
pnpm install
pnpm -r build
pnpm -r test             # unit + integration (Workers pool, local D1)
pnpm test:policies       # policy allow/deny suite of the core package
pnpm lint && pnpm typecheck
pnpm --filter blog db:migrate:local && pnpm --filter blog dev
pnpm --filter @castra-kit/create test:e2e   # scaffold + install + wrangler dev (opt-in)
```

| Path | What |
| --- | --- |
| `packages/core` (`@castra-kit/core`) | Policy engine, schema snapshot, REST router, OpenAPI |
| `packages/auth` (`@castra-kit/auth`) | Better Auth wiring, roles, API keys, context |
| `packages/mcp` (`@castra-kit/mcp`) | MCP tools, stdio entry, `/mcp` route |
| `packages/app` (`@castra-kit/app`) | `createCastraApp`: the Worker wiring (ADR 0077) |
| `packages/cli` (`@castra-kit/cli`) | The `castra` binary |
| `packages/create-castra` (`@castra-kit/create`) | Scaffolder and template |
| `examples/blog` | Reference app and e2e test target |
| `site` | Problem type pages at castra.mehmetozer.dev |

## Rules for changes

These come from [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), which wins on design questions.

1. **Default closed.** No policy means no route. Never add a fallback that opens a table.
2. **Policies compile to SQL.** Never filter rows after the query.
3. **Write check on every create and update.** Server-set columns are never taken from input.
4. **Includes obey their own table's `read` policy.**
5. **No string-built SQL.** Kysely only; identifiers only from the schema snapshot.
6. **Every policy rule type ships with allow and deny tests.** A change to `packages/core/src/policy` without new or
   updated tests is incomplete.
7. **MCP calls the same engine as REST.** No MCP-only data path.
8. **Scope.** Anything out of scope in ARCHITECTURE §8 is proposed in an ADR, not built.
9. **No secrets** in the repo or in tests.

A change that deviates from ARCHITECTURE.md starts with an ADR in `docs/adr/NNNN-title.md`.

## Pull requests

- Small, focused PRs with [conventional commit](https://www.conventionalcommits.org/) titles (`feat(core): ...`).
- CI (lint, build, typecheck, tests, policy tests) must pass.
- Public APIs get TSDoc. Errors use `application/problem+json`; a new error code needs a page in `site/problems.json`
  (a test enforces it).
- Keep the docs honest: if behaviour changes, update the page in `docs/` that describes it.

## Releasing (maintainer)

All five packages share one version. Bump them together, add a `CHANGELOG.md` entry, run the full pipeline,
`pnpm -r publish`, tag `vX.Y.Z` and create a GitHub release.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
