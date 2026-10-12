# castra-app

A [Castra](https://github.com/ozerozdas/castra) backend on Cloudflare Workers + D1: REST API with
row-level policies, Better Auth, OpenAPI at `/openapi.json` and read-only MCP tools at `/mcp`.

## Run locally

```sh
cp .dev.vars.example .dev.vars   # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
pnpm db:migrate:local            # applies migrations/ to the local D1 under .wrangler/
pnpm dev                         # http://localhost:8787/health, /openapi.json, /api/notes
pnpm test                        # all tests on a local D1 (no Cloudflare account needed)
pnpm test:policies               # only the policy allow/deny tests
```

## Rate limiting

Writes (sign-in, sign-up, `/mcp`, table writes) are limited to 60 per minute per IP by the `RATE_LIMITER` binding in
`wrangler.jsonc`; sign-in and sign-up also to 10 per minute by `AUTH_RATE_LIMITER`. Reads are not. Tuning and a WAF rule for reads: Castra docs, `docs/rate-limiting.md`.

## Deploy (5 commands)

```sh
export CLOUDFLARE_API_TOKEN=...  # permissions: see the Castra docs (docs/cloudflare-token.md)
pnpm doctor                      # checks the token permissions and bindings, changes nothing
pnpm provision                   # creates the D1 database (+ KV) and writes the ids into wrangler.jsonc
pnpm run deploy                  # provision -> migrate --remote -> drift check -> secret -> wrangler deploy
curl https://castra-app.<your-subdomain>.workers.dev/health
```

`pnpm run deploy`, not `pnpm deploy`: `pnpm deploy` is a built-in pnpm command. `castra deploy` is idempotent
and sets `BETTER_AUTH_SECRET` as a Worker secret the first time. It prints the API, `/openapi.json` and `/mcp`
URLs. Commit `wrangler.jsonc` after the first provision.

## Remove the deployment

```sh
pnpm run destroy -- --dry-run    # lists what would be deleted
pnpm run destroy                 # asks for the Worker name, exports D1 to castra-backups/, then deletes
```

`castra destroy` deletes only what `wrangler.jsonc` records: the Worker, the D1 database, the `CACHE` KV namespace
and R2 buckets (empty them first). The ids go back to placeholders, so `pnpm run deploy` starts fresh. The exports
in `castra-backups/` are full copies of your data; the folder is gitignored, so keep them somewhere safe.

## Change the schema

1. Add `migrations/000N_name.sql`.
2. `pnpm db:migrate:local && pnpm generate`. This updates `castra/schema.json` and `castra/db.d.ts`. Commit both.
3. Add a policy for the table in `castra.config.ts`. Tables without a policy have no routes.
4. Add allow and deny tests for every rule in `test/policies.test.ts`.

`castra deploy` refuses to ship when the committed snapshot does not match the remote database.

## Layout

| Path | What |
| --- | --- |
| `castra.config.ts` | Roles and per-table policies (`read`, `create`, `update`, `delete`, fields) |
| `migrations/` | `0001` app tables, `0002` Better Auth + roles + API keys, `0003` MCP tokens + audit |
| `castra/` | Generated schema snapshot and Kysely types (`pnpm generate`) |
| `src/index.ts` | The Worker: `createCastraApp` (auth, `/mcp`, REST router) plus your own routes |
| `test/` | Workers-runtime tests on a local D1 |

Docs: https://github.com/ozerozdas/castra (`docs/ARCHITECTURE.md`, `docs/cloudflare-token.md`).
