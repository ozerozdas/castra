# 0031. R2 is enabled by `--storage` or an existing `r2_buckets` entry

## Status
Accepted (2026-10-10).

## Context
ARCHITECTURE §6 says R2 is provisioned "only if storage is on", and the config draft (§7) has `storage: false` in
`castra.config.ts`. Reading that file from the CLI means loading user TypeScript (bundling or a TS loader) just
to read one boolean.

## Decision
Storage is on when either:
1. `--storage` is passed to `castra provision` / `castra deploy` / `castra doctor`, or
2. `wrangler.jsonc` already declares at least one `r2_buckets` entry.

The first `castra provision --storage` adds `{ "binding": "STORAGE", "bucket_name": "<worker>-storage" }` (shortened with a hash suffix when that exceeds R2's 63 characters, see the
ADR 0030 amendment of 2026-10-11); from
then on rule 2 keeps storage on without the flag. `castra.config.ts` is not read by the CLI.

## Consequences
- `wrangler.jsonc` stays the single source of provisioning state (consistent with ADR 0030).
- If `storage: true` in `castra.config.ts` but nobody ran `--storage`, the R2 binding is missing; the runtime
  should report a clear error. `create-castra` should pass `storage` straight to `provision`.
- Revisit if the CLI gets a config loader for other reasons.
