# 0068. Scoped packages publish as `@castra-kit/*`

## Status
Accepted (2026-10-11). Amends ADR 0004.

## Context
ADR 0004 named the scoped packages `@castra/auth`, `@castra/mcp` and `@castra/cli`. Publishing them needs the npm
org `castra`, which is already taken by someone else. A user app depends on all three (create-castra writes them
into `package.json`), so they must be public.

## Decision
- The scoped packages are `@castra-kit/auth`, `@castra-kit/mcp` and `@castra-kit/cli`, under the npm org
  `castra-kit`.
- `castra` and `create-castra` are unchanged; they are unscoped and were free on 2026-10-11.
- Code, tests, the template and current docs use the new names. Older ADRs keep the names they were written with.

## Consequences
- Imports change from `@castra/...` to `@castra-kit/...` before anything is published, so no published user code
  breaks.
- The `castra-kit` org must exist and be owned by the maintainer before `pnpm -r publish`.
