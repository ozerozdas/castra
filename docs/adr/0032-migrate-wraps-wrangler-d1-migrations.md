# 0032. `castra migrate` wraps `wrangler d1 migrations apply`

## Status
Accepted (2026-10-10).

## Context
ARCHITECTURE §6: `castra migrate` runs "auth, internal and user migrations". The blog example already keeps all of
them as ordered SQL files in one directory (`0001_init.sql`, `0002_auth.sql` with the Better Auth tables plus
`_castra_roles` / `_castra_api_keys`).

## Decision
- All migrations (auth, Castra-internal, user) are ordered `NNNN_name.sql` files in the binding's
  `migrations_dir`. There is no second migration runner and no separate tracking table.
- `castra migrate [--local|--remote] [--binding]` runs
  `wrangler d1 migrations apply <database_name> --local|--remote --config <path>` (cwd = config dir), default
  `--local`. Wrangler's `d1_migrations` table is the source of truth for what has been applied.
- Auth: wrangler reads `CLOUDFLARE_API_TOKEN` from the inherited environment; Castra adds `CLOUDFLARE_ACCOUNT_ID`
  for remote runs so wrangler never has to list accounts. The token is never put on the command line.
- stdin is a pipe, so wrangler runs non-interactively and skips its confirmation prompt (wrangler 4.149.0 help
  text: "When running the apply command in a CI/CD environment or another non-interactive command line, the
  confirmation step will be skipped, but the backup will still be captured.").

## Consequences
- Generating new auth/internal migrations into that directory is the job of `create-castra` / future
  `castra init`, not of `migrate`.
- A failed migration is rolled back by wrangler; `castra migrate` returns wrangler's exit code.
