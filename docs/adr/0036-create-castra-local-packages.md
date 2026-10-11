# 0036. `create-castra --local-packages <repo>`

## Status
Accepted (2026-10-11).

## Context
Nothing is published to npm yet (ADR 0004), so a scaffolded project cannot install `castra` / `@castra/*` from the
registry. The end-to-end check (scaffold → install → typecheck → test → `wrangler dev`) still has to run against
the code in this repository.

## Decision
- `--local-packages <path>` points the four Castra dependencies (`castra`, `@castra/auth`, `@castra/mcp`,
  `@castra/cli`) at `<path>/packages/{core,auth,mcp,cli}`: `link:<abs>` for pnpm, `file:<abs>` for npm. The path is
  resolved against the current directory; each `package.json` must exist and carry the expected name, otherwise
  exit 1 before anything is written. A missing `dist/` is a warning (run `pnpm -r build`), not an error.
- Third-party dependencies keep their registry versions.
- `link:` keeps one physical copy of each Castra package (the repo's), so the `instanceof` checks on rules
  (ADR 0065) see the same `castra` module from the config, the CLI and the Worker.
- The e2e test (`pnpm --filter create-castra test:e2e`, opt-in via `CASTRA_E2E=1`) uses pnpm with this flag. It
  needs the registry or a warm pnpm store and is not part of `pnpm -r test`.

## Consequences
- The npm (`file:`) path is only unit-tested: npm would also try to resolve the linked packages' `workspace:*`
  dependencies, which it does not understand. pnpm is the supported way to use `--local-packages`.
- The flag is a development aid; it is documented in `--help` but not in the generated README.
