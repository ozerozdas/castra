# CLI reference

The `castra` binary comes from `@castra-kit/cli`; a scaffolded project exposes most commands as package scripts.
Exit codes: 0 success, 1 check or runtime failure, 2 usage error or not implemented.

| Command | Does | Options |
| --- | --- | --- |
| `castra generate` | Write `castra/schema.json` and `castra/db.d.ts` from the local D1 | `--local`, `--config <wrangler>`, `--out <dir>`, `--binding <name>`, `--check` (no write, exit 1 on drift) |
| `castra provision` | Find or create D1, KV `CACHE` and (with storage) R2; write ids into `wrangler.jsonc`; idempotent | `--config`, `--account-id <id>`, `--storage` |
| `castra migrate` | `wrangler d1 migrations apply` | `--local` (default), `--remote`, `--config`, `--binding`, `--account-id` |
| `castra doctor` | Verify token, permissions, bindings (D1, KV, rate limits), `@castra-kit/*` versions and schema drift (local D1, or the deployed one with `--remote`); read-only. Same checks as the MCP tool `deploy_status` | `--config`, `--account-id`, `--storage`, `--remote`, `--out` |
| `castra deploy` | provision -> migrate --remote -> drift check -> `BETTER_AUTH_SECRET` if missing -> `wrangler deploy` | `--config`, `--account-id`, `--storage`, `--binding`, `--out` |
| `castra destroy` | Delete the Worker, D1 (exported first), KV `CACHE` and R2 recorded in `wrangler.jsonc`, after typing the Worker name; resets the ids to placeholders; idempotent ([ADR 0076](adr/0076-castra-destroy.md)) | `--config`, `--account-id`, `--dry-run`, `--confirm <worker>`, `--backup-dir <dir>`, `--skip-backup` |
| `castra test policies` | Run the project's `vitest run policies` (files whose path contains `policies`); no matching file fails ([ADR 0037](adr/0037-castra-test-policies.md)) | extra vitest args after `--` |
| `castra mcp` | Local stdio MCP server | `--config <castra.config.ts>`, `--wrangler <path>`, `--binding`, `--out` |
| `castra mcp token create` / `revoke <id>` | Manage `/mcp` tokens | `--user`, `--scopes`, `--name`, `--expires-in`, `--local`, `--remote`, `--config`, `--binding`, `--account-id` |
| `castra mcp audit prune` | Delete `_castra_audit` rows older than N days ([ADR 0070](adr/0070-audit-prune-command.md)) | `--older-than <days>` (required), `--local`, `--remote`, `--config`, `--binding`, `--account-id` |
| `castra init` | Add Castra to an existing project | Deferred, prints "not implemented yet" and exits 2 ([ADR 0038](adr/0038-castra-init-deferred.md)). Copy the migrations, config and `src/index.ts` wiring from a scaffold by hand. |

Environment: `CLOUDFLARE_API_TOKEN` (provision, doctor, deploy, destroy, `migrate --remote`, `mcp token --remote`),
`CLOUDFLARE_ACCOUNT_ID` (optional when the token sees one account).
