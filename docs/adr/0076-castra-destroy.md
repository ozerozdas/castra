# 0076. `castra destroy`

## Status
Accepted (2026-10-12). Issue #16. Not listed in ARCHITECTURE §6; this ADR adds it to the CLI.

## Context
`castra deploy` provisions a Worker, D1, the `CACHE` KV namespace and, with storage, R2. Removing them meant clicking
through the dashboard and keeping track of what belonged to the app. Deleting a database is irreversible, so the
command must make it hard to delete the wrong thing or to lose data by accident.

## Decision
- **Scope is exactly what `castra provision`/`deploy` manage, read from `wrangler.jsonc`, never found by name:**
  the Worker `name`, every `d1_databases` entry with a real `database_id`, the `kv_namespaces` entry with binding
  `CACHE` and a real `id`, and every `r2_buckets` entry. Other KV bindings are listed as kept. Placeholder ids
  (all zeros) mean "not provisioned" and are skipped.
- **Each resource is looked up by its recorded id first.** Missing ones are reported as already gone. A D1 database
  whose name differs from `database_name` is refused before anything is deleted (the config points somewhere
  unexpected).
- **Plan, then confirm.** The command prints the plan. `--dry-run` stops there. Otherwise the user types the Worker
  name at a prompt, or passes `--confirm <worker-name>` in scripts. Without a terminal and without `--confirm`, nothing
  is deleted.
- **D1 data loss is explicit.** Before deleting, every database is exported with
  `wrangler d1 export <name> --remote --output <dir>/<name>-<timestamp>.sql` (default dir `castra-backups`). A failed
  export stops the run before any delete. `--skip-backup` opts out and says so in the plan.
- **Order:** Worker (stops traffic and its secrets), then KV, then R2, then D1. R2 refuses to delete a non-empty
  bucket; Castra does not empty it. That failure is reported, and the run stops.
- **After each successful delete**, the recorded id in `wrangler.jsonc` is reset to the placeholder (D1 `database_id`,
  KV `id`), so `castra deploy` provisions fresh resources instead of failing on a stale id. Names are kept.
- **Idempotent:** a second run finds nothing recorded and prints "Nothing to delete." A partial failure leaves a
  config that describes what is still there; rerunning continues.
- The Worker is deleted without `force`, so Cloudflare refuses when another Worker still references it.

## Consequences
- The token needs the Edit permissions `deploy` already needs (Workers Scripts, D1, KV, and R2 with storage).
- Routes, custom domains and DNS records outside `wrangler.jsonc` resources are not managed by `destroy`; the plan
  says to check them in the dashboard.
- Rollback (#17) is a separate command.
