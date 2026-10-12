# 0080. Migration workflow: `castra migrate create`, `status`, `apply`

## Status
Accepted (2026-10-12). Issue #11. Extends ARCHITECTURE §6 (`castra migrate`).

## Context
`castra migrate` only wrapped `wrangler d1 migrations apply`. Adding a migration meant picking the next number by
hand, and seeing what was applied meant `wrangler d1 migrations list`, which needs the database name and, for remote,
its own login. Castra already owns the config, the token and the D1 HTTP opener (`castra deploy`, `doctor --remote`).

## Decision
- **Wrangler stays the runner.** `castra migrate [apply] [--local|--remote]` is unchanged: it runs
  `wrangler d1 migrations apply`. Castra never executes migration SQL itself, so there is one runner and one record.
- **Wrangler's table is the source of truth.** Files live in the binding's `migrations_dir` (default `migrations`)
  and applied names in `migrations_table` (default `d1_migrations`), both read from `wrangler.jsonc`. Castra adds no
  table of its own.
- **`castra migrate create <name>`** writes `<migrations_dir>/NNNN_<slug>.sql` (four digits, after the highest
  existing number, as `wrangler d1 migrations create` does), creating the directory if needed and never overwriting.
  The file starts with a comment: D1 migrations are forward-only, so the undo statements go there, commented out.
- **`castra migrate status [--local|--remote]`** compares the files with the recorded names and prints each as
  `applied`, `pending` or `unknown` (recorded, but the file is gone or renamed). Read-only. `--remote` reads the
  table through the D1 HTTP API with the same token as `castra doctor`; local reads the miniflare state.
- **`migrations_pattern`** (wrangler's nested layouts) is refused by `create` and `status` with a pointer to the
  wrangler commands; `apply` still works since wrangler handles it.
- After a local apply, the CLI reminds to run `castra generate`. Applying does not regenerate by itself: generate
  writes committed files and should be an explicit step.

## Consequences
- No down migrations. A rollback is a new forward migration; the comment block keeps the undo SQL next to the change.
- `status --remote` makes two read queries (`sqlite_master`, then the table).
- MCP `generate_migration` / `apply_migration` (ARCHITECTURE §5) can build on `create` and `apply`; they are not part
  of this change.
