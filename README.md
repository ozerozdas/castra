# Castra

Castra is a Cloudflare-native, self-hosted, agent-safe Backend-as-a-Service starter kit. One Worker and one D1
database in your own Cloudflare account serve auto-generated REST endpoints for your tables, protected by a
TypeScript policy engine that compiles every rule to SQL. Auth is Better Auth, and an MCP server lets AI agents
inspect and verify the exact policies that production enforces. Tables without a policy do not exist as routes.

**Status: v0.1, pre-release, not published to npm.** Everything below runs from a checkout of this repository. Mocked
tests cover the Cloudflare API calls; nothing has been run against a real Cloudflare account yet (see
[What works and what does not](#what-works-and-what-does-not)). `npx create-castra my-app` will work only after the
packages are published (names must be re-checked first, [ADR 0004](docs/adr/0004-package-names.md)). Until then,
scaffold with `--local-packages` as shown below ([ADR 0036](docs/adr/0036-create-castra-local-packages.md)).

## Contents

[Quickstart](#quickstart-5-minutes) · [Concepts](#concepts) · [Config reference](#config-reference) ·
[REST API](#rest-api) · [Auth](#auth) · [MCP](#mcp) · [CLI](#cli-reference) ·
[What Castra is not](#what-castra-is-not) · [Links and development](#links-and-development)

## Quickstart (5 minutes)

Requirements: Node >= 20, pnpm 10. No Cloudflare account is needed until the deploy step.

### 1. Scaffold

Build a checkout, then scaffold **outside** it (a project inside the repo would be taken for part of the pnpm workspace):

```sh
git clone git@github.com:ozerozdas/castra.git && cd castra
pnpm install && pnpm -r build
cd ~/projects
node <path-to-castra>/packages/create-castra/dist/cli.js my-app --local-packages <path-to-castra>
cd my-app
```

`create-castra` options: `--template <name>` (only `default`), `--package-manager pnpm|npm`, `--no-install`,
`--local-packages <path>`. `--local-packages` is only supported with pnpm. After publishing this becomes
`npx create-castra my-app`.

### 2. Run locally

```sh
cp .dev.vars.example .dev.vars   # set BETTER_AUTH_SECRET: openssl rand -base64 32
pnpm db:migrate:local            # castra migrate --local: applies migrations/ to the local D1
pnpm dev                         # wrangler dev, http://localhost:8787
```

### 3. First request

```sh
curl localhost:8787/health
curl localhost:8787/openapi.json                    # only open operations are listed
curl localhost:8787/api/notes                       # anonymous: public notes only (empty list at first)

# sign up (Better Auth); the session token comes back in the set-auth-token header
curl -i -X POST localhost:8787/api/auth/sign-up/email \
  -H 'content-type: application/json' -H 'origin: http://localhost:8787' \
  -d '{"email":"me@example.com","password":"correct-horse-battery","name":"Me"}'

# TOKEN = the value of the set-auth-token response header above
curl -X POST localhost:8787/api/notes -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"hello","is_public":1}'
```

`owner_id` is filled in by the server; sending a different one is rejected with 403.

### 4. Define a policy

Tables are closed until `castra.config.ts` opens them. Add a table and open it:

```sh
echo 'CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL);' > migrations/0004_tags.sql
pnpm db:migrate:local
```

```ts
// castra.config.ts, inside tables: { ... }
tags: { read: isPublic(), create: role("admin") },
```

Until `pnpm generate` (step 5) refreshes `castra/schema.json`, the new table's routes answer 404. The Worker reads
the committed snapshot, not the live database, and a configured table that is missing from the snapshot stays closed.

Then add an allow and a deny test per rule to `test/policies.test.ts` (a rule without both is incomplete).

### 5. Regenerate the snapshot and run the policy tests

```sh
pnpm generate            # castra generate: writes castra/schema.json and castra/db.d.ts; commit both
pnpm test:policies       # castra test policies: runs `vitest run policies` on a local D1
```

### 6. Deploy

Create a Cloudflare API token with the minimum permissions in [docs/cloudflare-token.md](docs/cloudflare-token.md)
(Workers Scripts Edit, D1 Edit, Workers KV Storage Edit; R2 only with storage).

```sh
export CLOUDFLARE_API_TOKEN=...      # never commit this
export CLOUDFLARE_ACCOUNT_ID=...     # optional if the token sees exactly one account
pnpm doctor                          # castra doctor: read-only permission/binding/drift check
pnpm provision                       # castra provision: creates D1 + KV, writes ids into wrangler.jsonc
pnpm migrate                         # castra migrate --remote
pnpm run deploy                      # castra deploy: all of the above, drift check, secret, wrangler deploy
```

Use `pnpm run deploy`: `pnpm deploy` is a built-in pnpm command. `castra deploy` is idempotent, generates
`BETTER_AUTH_SECRET` as a Worker secret the first time, and prints the API, `/openapi.json` and `/mcp` URLs.

## Concepts

- **Default closed.** A table with no policy gets no routes; an operation without a rule (`read`, `create`,
  `update`, `delete`) is closed. Better Auth tables, `_castra_*`, `sqlite_*`, `_cf_*` and `d1_migrations` can never be
  configured.
- **Policies compile to SQL.** `read`, `update` and `delete` rules become a `WHERE` fragment from the caller's
  context. Rows are never filtered after the query, so pagination and counts stay correct.
- **Rule builders** (all from `castra`):

  | Builder | Allows |
  | --- | --- |
  | `isPublic()` | everyone, including anonymous |
  | `authenticated()` | any signed-in user |
  | `role(...names)` | users holding at least one of the roles (must be declared in `roles`) |
  | `owner(column)` | rows where `column` equals the caller's user id |
  | `custom(name, (eb, ctx) => expr)` | a named Kysely expression; the developer is responsible for it |
  | `.and(rule)` / `.or(rule)` | combine rules |
  | `.where((q) => q.eb(col, op, value))` | and-narrows a rule with a row predicate |

- **Write check.** Every create and update is verified on the *stored* row in the same atomic D1 `batch()` as the
  write; a row that no longer satisfies the rule rolls back with 403 `write_check_failed`
  ([ADR 0050](docs/adr/0050-checks-via-guarded-batch.md)).
- **`setBy: "server"`.** Such columns are never taken from input. Columns used in an `owner()` rule are implicitly
  server-set: filled from the session user on create, a different client value is 403.
- **Field rules.** `hidden` columns never leave the server; `readonly` columns cannot be written; `visibleTo` shows a
  column only to the listed roles.
- **The `self` role.** Inside `visibleTo`, `"self"` matches the caller's own row (`users.id`, or the table's single
  `owner()` read column, or `selfColumn`; [ADR 0006](docs/adr/0006-self-pseudo-role.md)). It cannot be declared in `roles`.
- **Includes obey their own table's `read` policy.** `?include=` on a table without an open `read` is a 400.
- **MCP uses the same engine and request pipeline as REST.** There is no MCP-only data path.

Example, from [examples/blog/castra.config.ts](examples/blog/castra.config.ts):

```ts
import { authenticated, defineConfig, isPublic, owner, role } from "castra";

export default defineConfig({
  database: "d1",
  auth: { provider: "better-auth", methods: ["email", "github"] },
  storage: false,
  api: { maxLimit: 100 },
  roles: ["admin", "editor", "member"],
  tables: {
    posts: {
      read: isPublic().where((q) => q.eb("status", "=", "published")).or(owner("author_id")).or(role("admin")),
      create: authenticated(),
      update: owner("author_id").or(role("editor", "admin")),
      delete: role("admin"),
      fields: { author_id: { setBy: "server" }, internal_notes: { visibleTo: ["admin"] } },
      filterable: ["status", "created_at"],
    },
    comments: { read: isPublic(), create: authenticated(), update: owner("user_id"),
      delete: owner("user_id").or(role("admin")), fields: { user_id: { setBy: "server" } } },
    users: { read: authenticated(), fields: { email: { visibleTo: ["self", "admin"] } } },
  },
});
// audit_logs has no policy, so it is never exposed.
```

## Config reference

`defineConfig(config)` validates and deep-freezes the config. Unknown keys anywhere are an error.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `database` | `"d1"` | required | Only value allowed. |
| `roles` | `string[]` | required | All role names used anywhere. No duplicates; `"self"` is reserved. |
| `tables` | `Record<string, TableConfig>` | required | Tables not listed are closed. |
| `auth` | `{ provider?: "better-auth"; methods?: string[] }` | none | Validated as an object only; **not read by v0.1 code**. Email+password is always on; GitHub turns on when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set. |
| `storage` | `boolean` | none | Must be a boolean; **not read by v0.1 code**. R2 is provisioned by `castra provision --storage` or existing `r2_buckets` ([ADR 0031](docs/adr/0031-storage-flag-for-r2.md)). R2 storage routes are not built. |
| `api.maxLimit` | positive integer | `100` | Cap for `?limit`. |

`TableConfig`:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `read` / `create` / `update` / `delete` | `Rule` | closed | Built with the rule builders only. |
| `fields` | `Record<column, FieldConfig>` | none | See below. |
| `filterable` | `string[]` | none | Columns clients may filter on; must exist in the snapshot and not be `hidden`. Sorting uses the same check. |
| `selfColumn` | `string` | `id` for a table named `users`, else the single `owner()` column of `read` | Column compared with the caller id for `"self"`. |

`FieldConfig`:

| Key | Type | Meaning |
| --- | --- | --- |
| `hidden` | `true` | Never returned, never writable, never filterable. |
| `readonly` | `true` | Not writable by clients. |
| `setBy` | `"server"` | Value comes from the server, never from input. |
| `visibleTo` | `string[]` | Roles (or `"self"`) that can read the column; only they can write it. |

The Worker also needs env: `BETTER_AUTH_SECRET` (Worker secret, >= 32 chars, placeholders rejected),
`BETTER_AUTH_URL` (optional), `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (optional). Locally these live in `.dev.vars`.
A weak or placeholder secret does not stop the Worker from starting: `/health` still returns 200, and the first
request that needs auth fails with a generic 500.

Auth options (`roles`, `trustedOrigins`, `basePath`, `mirrorUsers`) are passed to `authRoutes` in `src/index.ts`.
Neither the blog example nor the template sets `trustedOrigins`, so Better Auth trusts only the origin of
`BETTER_AUTH_URL`. Set it to the origin you call from: `http://localhost:8787` for `wrangler dev`, and your real URL
in production. A request to `/api/auth/*` with any other `Origin` header gets 403 `INVALID_ORIGIN`. A request without
an `Origin` header (curl, server-to-server) is accepted. Add your front-end origins to `trustedOrigins`.

## REST API

Only operations with a rule exist. Everything else, including closed and unknown tables, is 404.

| Operation | Route |
| --- | --- |
| List | `GET /api/:table` |
| Get | `GET /api/:table/:id` (single-column primary key) |
| Create | `POST /api/:table` (201; single-column primary key) |
| Update | `PATCH /api/:table/:id` |
| Delete | `DELETE /api/:table/:id` (204) |
| Docs | `GET /openapi.json` (OpenAPI 3.1, lists exactly the operations REST serves) |

Query parameters on lists ([ADR 0040](docs/adr/0040-rest-pagination-and-request-pipeline.md),
[0041](docs/adr/0041-filters-validation-and-types.md), [0042](docs/adr/0042-includes.md)):

| Feature | Syntax |
| --- | --- |
| Filter | `?status=eq.draft&created_at=gte.2026-01-01`; operators `eq neq gt gte lt lte in like is`. `in.(a,b,"c,d")`, `is.null\|true\|false`, `like` uses `*` as the wildcard. Only `filterable` columns. |
| Sort | `?sort=-created_at,title` (max 5 keys) |
| Page size | `?limit=` (default `min(25, maxLimit)`, clamped to `maxLimit`, `0` is 400) |
| Keyset cursor | response `{ data, nextCursor }`; pass `?cursor=<nextCursor>`. `null` when there is no next page. |
| Offset | `?offset=` (<= 100000), not combinable with `cursor` |
| Count | `?count=exact` adds `count` to the response |
| Includes | `?include=author,comments`: one level, derived from foreign keys (`author_id` -> `author`; a child table with one FK to the base table), each under its own `read` policy. One-to-many includes return at most 25 rows per parent, silently. |

Limits: bodies <= 1 MiB (413), JSON only (415), unknown body keys 400, <= 20 filters, <= 100 `in` values, <= 10 includes,
100 bound parameters per statement, `like` patterns <= 256 characters and 10 wildcards. Text primary keys are
generated by the server (a client value is 400).

OpenAPI leaves out what REST would always refuse:

- `POST` on a table without a single-column primary key.
- `/{id}` routes when the primary key column is `hidden`.
- `POST` and `PATCH` on a table whose schema has `ON CONFLICT REPLACE` on a `UNIQUE` or `PRIMARY KEY` constraint.
  Such a write would silently delete the conflicting row, so Castra answers it with 403 `unsafe_schema` for every
  caller ([ADR 0066](docs/adr/0066-on-conflict-replace-tables.md)). `castra generate` warns about these tables.

A create or update whose row the caller cannot read back returns only the primary key, or `{}` when the caller cannot
read the key column either.

Errors are `application/problem+json` `{type,title,status,detail}`: 400 validation, 401 anonymous / 403 authenticated
when a rule can never allow, 403 for spoofing, `write_check_failed` or `unsafe_schema`, 404 unknown/closed/not visible, 409 constraint
violation or concurrent change, 500 generic (no SQL or stack). Better Auth's own `/api/auth/*` errors are not problem+json.

## Auth

- **Better Auth** 1.7.7 on D1: email + password, and GitHub when both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are
  set. Endpoints are under `/api/auth/*` (for example `POST /api/auth/sign-up/email`, `/sign-in/email`). The `bearer`
  plugin returns the session token in the `set-auth-token` header. A `GET /me` route shows the resolved context.
- **Sessions are checked against D1 on every request.** There is no KV or cookie cache, so a signed-out, deleted or
  expired session is anonymous on the next request ([ADR 0021](docs/adr/0021-sessions-in-d1-only.md)).
- **Roles** live in `_castra_roles (user_id, role)` and are re-read on every request. There is no CLI or HTTP endpoint
  to grant them in v0.1: call `assignRole(env.DB, userId, role, config.roles)` from `@castra/auth`, or insert rows with
  `wrangler d1 execute`.
- **API keys** (`castra_ak_...`) act as a user with a subset of that user's roles, are stored as SHA-256 hashes, and are
  sent as `x-api-key` or `Authorization: Bearer`. Create and revoke them with `createApiKey` / `revokeApiKey` from
  `@castra/auth`; there is no CLI or HTTP endpoint yet ([ADR 0022](docs/adr/0022-own-api-keys-table.md)). A presented but
  invalid key is anonymous, never a fallback to a cookie.
- A `users` table mirrors `id`, `email`, `name` from Better Auth so app tables can reference it with foreign keys
  ([ADR 0023](docs/adr/0023-users-profile-mirror.md)).

## MCP

Four read-only tools: `describe_schema`, `check_access`, `explain_query`, `query_data`. They run on the same engine
and request pipeline as REST. There are no write or admin tools in v0.1.

- **Local, stdio:** `castra mcp` serves them against the **local** D1. It is a developer tool: `as` may impersonate any
  user (`{ userId, roles? }`), `"anonymous"`, or a hypothetical role set, with no token and no audit log. Never expose
  it over a network. Loading `castra.config.ts` needs Node >= 22.18 (or a `.js`/`.mjs` config, `--config`).
- **Remote, `POST /mcp` on the deployed Worker:** needs `Authorization: Bearer castra_mcp_...`.

  ```sh
  castra mcp token create --user <id> --scopes "schema:read data:read" [--name <n>] [--expires-in <days>] [--local|--remote]
  castra mcp token revoke <id> [--local|--remote]
  ```

  | Scope | Grants |
  | --- | --- |
  | `schema:read` | `describe_schema` |
  | `access:check` | `check_access`, `explain_query` |
  | `data:read` | `query_data` as the token's own user |
  | `data:read:any_user` | `as` another user or `"anonymous"` |

  `as` on `/mcp` is the token's user by default; `"anonymous"` or `{ userId }` of an existing user need
  `data:read:any_user`. Explicit roles are rejected: roles always come from `_castra_roles`. MCP tokens are accepted only
  on `/mcp`, and sessions or API keys are not. Every call writes a `_castra_audit` row. There is no rate limiting
  on `/mcp`: add a Cloudflare rate limiting rule in front of it.

Details: [ADR 0060](docs/adr/0060-mcp-shared-tools.md), [0061](docs/adr/0061-mcp-tokens-and-scopes.md),
[0062](docs/adr/0062-mcp-remote-transport.md), [0063](docs/adr/0063-mcp-audit-log.md),
[0065](docs/adr/0065-castra-mcp-cli.md).

## CLI reference

The `castra` binary comes from `@castra/cli`; a scaffolded project exposes most commands as package scripts.
Exit codes: 0 success, 1 check or runtime failure, 2 usage error or not implemented.

| Command | Does | Options |
| --- | --- | --- |
| `castra generate` | Write `castra/schema.json` and `castra/db.d.ts` from the local D1 | `--local`, `--config <wrangler>`, `--out <dir>`, `--binding <name>`, `--check` (no write, exit 1 on drift) |
| `castra provision` | Find or create D1, KV `CACHE` and (with storage) R2; write ids into `wrangler.jsonc`; idempotent | `--config`, `--account-id <id>`, `--storage` |
| `castra migrate` | `wrangler d1 migrations apply` | `--local` (default), `--remote`, `--config`, `--binding`, `--account-id` |
| `castra doctor` | Verify token, permissions, bindings and local drift; read-only | `--config`, `--account-id`, `--storage`, `--out` |
| `castra deploy` | provision -> migrate --remote -> drift check -> `BETTER_AUTH_SECRET` if missing -> `wrangler deploy` | `--config`, `--account-id`, `--storage`, `--binding`, `--out` |
| `castra test policies` | Run the project's `vitest run policies` (files whose path contains `policies`); no matching file fails ([ADR 0037](docs/adr/0037-castra-test-policies.md)) | extra vitest args after `--` |
| `castra mcp` | Local stdio MCP server | `--config <castra.config.ts>`, `--wrangler <path>`, `--binding`, `--out` |
| `castra mcp token create` / `revoke <id>` | Manage `/mcp` tokens | `--user`, `--scopes`, `--name`, `--expires-in`, `--local`, `--remote`, `--config`, `--binding`, `--account-id` |
| `castra init` | Add Castra to an existing project | Deferred, prints "not implemented yet" and exits 2 ([ADR 0038](docs/adr/0038-castra-init-deferred.md)). Copy the migrations, config and `src/index.ts` wiring from a scaffold by hand. |

Environment: `CLOUDFLARE_API_TOKEN` (provision, doctor, deploy, `migrate --remote`, `mcp token --remote`),
`CLOUDFLARE_ACCOUNT_ID` (optional when the token sees one account).

## What works and what does not

Works (locally, covered by tests): policy engine, REST, OpenAPI, Better Auth, roles, API keys, read-only MCP (stdio and
`/mcp`), `generate`, `migrate`, `test policies`, `create-castra` with `--local-packages`.

Not verified: `provision`, `doctor`, `deploy` and `migrate --remote` are tested against a fake Cloudflare API and fake
wrangler only; no real-account deploy has been done. GitHub sign-in is only unit-tested (no network). `create-castra` is
not in CI (its e2e needs the registry). Known issues are listed in [docs/SECURITY.md](docs/SECURITY.md) section 3.

## What Castra is not

**D1 limits.** Castra inherits them. Figures below are from the
[D1 limits page](https://developers.cloudflare.com/d1/platform/limits/) (checked 2026-10-11); check it for current values.

| Limit | Workers Paid | Free |
| --- | --- | --- |
| Database size | 10 GB | 500 MB |
| Bound parameters per query | 100 | 100 |
| SQL statement length | 100 KB | 100 KB |
| Queries per Worker invocation | 1000 | 50 |
| String, BLOB or row size | 2 MB | 2 MB |
| Simultaneous D1 connections per invocation | 6 | 6 |

- **Writes go to one primary.** Per the [read replication docs](https://developers.cloudflare.com/d1/best-practices/read-replication/),
  all write queries are forwarded to the primary database. Castra is not for write-heavy workloads.
- **No interactive transactions, no row locks across requests.** Atomicity is limited to one `batch()`, which Castra
  uses for every guarded write. Read-then-write sequences across requests can interleave.
- **Read replication is opt-in** and replicas update asynchronously (the Sessions API gives sequential consistency).
  Castra does not configure or test replication; a revoked session or role could be read from a lagging replica.
- Statements are limited by the 100 bound parameters, so very wide tables or huge rules can fail.
- No tenant isolation: one Worker and one D1 per deployment ([ADR 0002](docs/adr/0002-no-multitenancy-v0.1.md)).
- No rate limiting ([ADR 0003](docs/adr/0003-rate-limiting-hook-only.md)); `hooks.beforeRequest` on the REST router is
  the hook point, and Cloudflare rate limiting rules in front of the Worker are recommended.

**Out of scope** ([ARCHITECTURE.md](docs/ARCHITECTURE.md) section 8):
- Until v1.0: PostgreSQL/MySQL/Hyperdrive, realtime (Durable Objects), queues, Redis/S3/OIDC adapters, a hosted or
  managed offering.
- Not in v0.1 (later roadmap): MCP write tools, migrations via MCP, `propose_policy`, `deploy_status` (v0.2); R2
  storage routes, multi-level include, bulk operations, multi-tenancy (v0.3); plugin SDK, custom hooks, admin UI,
  stable config API (v1.0).

## Links and development

- [docs/SECURITY.md](docs/SECURITY.md): threat model, guarantees and known issues
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design; [docs/adr/](docs/adr/): one ADR per decision
- [docs/PROGRESS.md](docs/PROGRESS.md): status per milestone; [docs/GOAL.md](docs/GOAL.md): the v0.1 plan
- [docs/cloudflare-token.md](docs/cloudflare-token.md): minimum API token permissions

| Path | What |
| --- | --- |
| `packages/core` (`castra`) | Policy engine, schema snapshot, REST router, OpenAPI |
| `packages/auth` (`@castra/auth`) | Better Auth wiring, roles, API keys, context |
| `packages/mcp` (`@castra/mcp`) | MCP tools, stdio entry, `/mcp` route |
| `packages/cli` (`@castra/cli`) | The `castra` binary |
| `packages/create-castra` | `create-castra` scaffolder and template |
| `examples/blog` | Reference app and e2e test target |

```sh
pnpm install
pnpm -r build
pnpm -r test             # unit + integration (Workers pool, local D1)
pnpm test:policies       # policy allow/deny suite of the core package
pnpm lint && pnpm typecheck
pnpm --filter blog db:migrate:local && pnpm --filter blog dev
pnpm --filter create-castra test:e2e   # scaffold + install + wrangler dev (opt-in)
```

Requires Node >= 20 and pnpm 10.
