# Concepts and configuration

- **Default closed.** A table with no policy gets no routes; an operation without a rule (`read`, `create`,
  `update`, `delete`) is closed. Better Auth tables, `_castra_*`, `sqlite_*`, `_cf_*` and `d1_migrations` can never be
  configured.
- **Policies compile to SQL.** `read`, `update` and `delete` rules become a `WHERE` fragment from the caller's
  context. Rows are never filtered after the query, so pagination and counts stay correct.
- **Rule builders** (all from `@castra-kit/core`):

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
  ([ADR 0050](adr/0050-checks-via-guarded-batch.md)).
- **`setBy: "server"`.** Such columns are never taken from input. Columns used in an `owner()` rule are implicitly
  server-set: filled from the session user on create, a different client value is 403.
- **Field rules.** `hidden` columns never leave the server; `readonly` columns cannot be written; `visibleTo` shows a
  column only to the listed roles.
- **The `self` role.** Inside `visibleTo`, `"self"` matches the caller's own row (`users.id`, or the table's single
  `owner()` read column, or `selfColumn`; [ADR 0006](adr/0006-self-pseudo-role.md)). It cannot be declared in `roles`.
- **Includes obey their own table's `read` policy.** `?include=` on a table without an open `read` is a 400.
- **MCP uses the same engine and request pipeline as REST.** There is no MCP-only data path.

Example, from [examples/blog/castra.config.ts](../examples/blog/castra.config.ts):

```ts
import { authenticated, defineConfig, isPublic, owner, role } from "@castra-kit/core";

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
| `storage` | `boolean` | none | Must be a boolean; **not read by v0.1 code**. R2 is provisioned by `castra provision --storage` or existing `r2_buckets` ([ADR 0031](adr/0031-storage-flag-for-r2.md)). R2 storage routes are not built. |
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
