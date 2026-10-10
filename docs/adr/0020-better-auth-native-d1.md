# 0020. Better Auth on D1 through its native D1 support

## Status
Accepted (2026-10-10).

## Context
ARCHITECTURE §1 says "Better Auth (Kysely D1 dialect)". Better Auth 1.7.7 (latest on npm, checked
2026-10-10) accepts a D1 binding directly as `database`. Its `@better-auth/kysely-adapter` detects the
binding (`batch`/`exec`/`prepare`) and runs an internal `D1SqliteDialect`, which is a Kysely dialect.
Passing an external `kysely-d1` instance is also possible but is not the path the Better Auth docs use.

## Decision
- `createAuth(env, options)` passes `env.DB` as `database`. Better Auth still runs on Kysely with a
  D1 dialect, just its own bundled one, so the intent of ARCHITECTURE §1 holds.
- Castra's own queries (`_castra_roles`, `_castra_api_keys`, the `users` mirror) use `kysely` 0.29.6
  with `kysely-d1` 0.4.0. No string-built SQL.
- Auth tables are a committed SQL migration (`examples/blog/migrations/0002_auth.sql`). The Better Auth
  part is generated, not hand-written: `pnpm --filter @castra/auth auth:schema` runs `getMigrations()`
  with the exact runtime options (`buildAuthOptions`) against in-memory `node:sqlite`. Re-run and
  diff on every Better Auth upgrade.
- Ids are UUIDs (`advanced.database.generateId: "uuid"`), matching the blog's TEXT uuid keys.
- The `bearer` plugin is on so a session token can be sent as `Authorization: Bearer`.

## Consequences
- Two Kysely D1 dialects exist in the bundle (Better Auth's and `kysely-d1`). Both are small.
- A Better Auth upgrade that changes its schema needs a new migration; the generator makes the diff visible.
- No runtime `getMigrations()`/`/migrate` endpoint is exposed.
