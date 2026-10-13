# 0085. Schema-compatible Worker rollback

## Status
Accepted (2026-10-13). Issue #17.

## Decision
Rollback changes only Worker traffic to a previous version. It never restores D1 data, runs migrations, or
forces Cloudflare to accept a version with changed secrets. `castra deploy` records SHA-256 fingerprints of
its parsed Wrangler config and live D1 schema in the immutable version message. Schema includes introspected
columns/relations and SQLite DDL (including indexes, triggers and internal/auth tables); row data is excluded.

`castra rollback` requires exactly one provisioned D1 binding, a single active version receiving 100% traffic,
and matching config fingerprints on the current version, target version and local config. The target schema
fingerprint must match live D1. Unmarked versions fail closed. The default target is the immediately preceding
deployment, which must also have a single version at 100%; explicit `--version` selects another version.

A read-only `--dry-run` prints the checked plan. Execution requires the Worker name via `--confirm` or prompt.
After confirmation it rechecks deployment identity, local config and live schema before calling the deployment
API without force. It verifies the resulting active version and reports failures without automatic retries.

## Consequences
Old deployments become eligible only after new marked deployments exist. Config matching is deliberately
conservative; even a harmless config change can prevent rollback. Multiple D1 deployments remain supported
but receive no rollback marker. Secrets/resource constraints remain enforced by Cloudflare. Matching schemas
cannot prove business-level compatibility with old code or undo migration side effects on data. Operators must
serialize deploys, migrations and rollback: there is no atomic lock across Worker deployment and D1 schema.
