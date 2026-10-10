# 0034. Deploy order, `BETTER_AUTH_SECRET` handling and remote drift check

## Status
Accepted (2026-10-10). Amends the "remote introspection is not implemented" consequence of ADR 0011.

## Context
`castra deploy` = provision → migrate → deploy (ARCHITECTURE §6), plus generating `BETTER_AUTH_SECRET` as a
Worker secret and refusing to deploy when the schema snapshot drifted. Facts checked against wrangler 4.149.0
(installed, `--help` and `wrangler-dist/cli.js`) on 2026-10-10:
- `wrangler deploy --secrets-file <path>` exists (JSON or .env, additive) but needs the secret in a file.
- `wrangler secret put <KEY>` reads the value from stdin when not interactive (stdin not a TTY).
- `wrangler secret put` on a Worker that does not exist asks to create it; with `fallbackValue: true` it creates
  an empty draft Worker (`export default { fetch() {} }`) in non-interactive runs, then stores the secret.
- The secret list endpoint `GET /accounts/{a}/workers/scripts/{name}/secrets` returns names only, 404 /
  code 10007 when the Worker does not exist.

## Decision
Order: **provision → `migrate --remote` → drift check → secret (if missing) → `wrangler deploy` → print URLs.**
Each step stops the run on failure.

- **Secret**: if the API shows no `BETTER_AUTH_SECRET`, generate 32 bytes with `node:crypto.randomBytes`
  (base64url) and pass it to `wrangler secret put BETTER_AUTH_SECRET` **on stdin**. It is never in argv, the
  environment of child processes, logs or any file. An existing secret is never rotated by deploy.
  It is set before the first `wrangler deploy` (wrangler creates the draft Worker), so the real code never runs
  without its secret. `--secrets-file` was rejected because it requires writing the secret to disk.
- **Drift**: after the remote migrations, the remote D1 is introspected through the D1 HTTP query endpoint
  (`POST /accounts/{a}/d1/database/{uuid}/query`, only `SELECT`/`PRAGMA`) and compared with the committed
  `castra/schema.json` + `db.d.ts` using the same code as `castra generate --check`. Mismatch → stop before the
  secret and deploy steps.
- **URL**: parsed from `wrangler deploy` output (first `*.workers.dev` URL, else the first non-Cloudflare URL);
  fallback `https://<name>.<subdomain>.workers.dev` from `GET /accounts/{a}/workers/subdomain`. Printed: API base,
  `<url>/openapi.json`, `<url>/mcp`.

## Consequences
- The drift check runs after the remote migrations, so a drifted snapshot can leave the remote database migrated
  but the old Worker running. This is the intended safety trade-off: the new code is not shipped against a schema
  it was not generated for. Fix: run `castra migrate --local && castra generate`, commit, deploy again.
- On a brand-new Worker there is a short window where wrangler's empty draft Worker exists before the real deploy replaces it.
- The secret can only be read back by the Worker; losing it means rotating it (invalidates sessions).
