# Castra — Architecture

> Cloudflare-native, self-hosted, agent-safe Backend-as-a-Service starter kit.
> One command provisions a Worker + D1 + KV in the developer's own Cloudflare account and
> exposes policy-protected REST endpoints for existing D1 tables — verifiable by AI agents over MCP.

**Positioning:** a backend AI agents can safely build on. The policy engine is the core;
auth, provisioning and auto-CRUD are conveniences around it.

---

## 1. Fixed decisions

| Topic | Decision | Rationale |
| --- | --- | --- |
| Runtime | Cloudflare Workers + Hono | Workers-native, fixed |
| Shape | Modular monolith: one Worker, one D1 | Small core, simple deploy |
| Query layer | Kysely + schema introspection | DB is the single source of truth; natural fit for dynamic queries |
| Database | D1 only until v1.0 | Sharp Cloudflare-native positioning; adapter interface exists, one implementation |
| Authentication | Better Auth (Kysely D1 dialect) | Never hand-roll auth |
| Policy definition | TypeScript, inside `defineConfig` | Typed, single file, IDE support; MCP reads the same model |
| MCP | Local (stdio) + remote (on the Worker) | Local: dev + write tools. Remote: verify a deployed backend |

## 2. Layers

```
 Clients:   App/frontend (REST+OpenAPI)   AI agent (MCP)        Developer (CLI)
                  │                          │                       │
 ┌──── Cloudflare Worker (Hono) ─────────────┴──────┐        ┌──────────────────┐
 │  REST router (auto CRUD + custom)   MCP server   │        │  castra CLI      │
 │                 │                       │        │        │  provision       │
 │            Auth · Better Auth ◄─────────┘        │        │  migrate/deploy  │
 │                 │                                │        │  test policies   │
 │      ★ Policy engine (rule → WHERE, check,       │        │  local MCP       │
 │                       field filter)              │        └────────┬─────────┘
 │                 │                                │                 │ provision
 │      Kysely query layer · schema snapshot ·      │                 │
 │      Zod validation · OpenAPI                    │                 │
 └─────────────────┬────────────────────────────────┘                 │
 ┌──── Adapter interface (single implementation until v1) ────────────┴─────┐
 │   D1 (data + auth tables)      KV (cache, rate limit)     R2 (optional)  │
 └──────────────────────────────────────────────────────────────────────────┘
```

No request — from an app or an agent — reaches data without passing auth and the policy engine.
`@castra-kit/app` (`createCastraApp`) wires these layers into one Hono app, so the order ships with the packages
([ADR 0077](adr/0077-create-castra-app.md)).

## 3. Policy engine (the core)

The policy engine is the Worker-side equivalent of the RLS that D1 lacks. REST, MCP and custom
endpoints all call the same engine, so what an agent verifies is exactly what production enforces.

### Rules
- **Default closed.** A table with no policy in config gets no routes at all. Better Auth tables and
  `_castra_*` internal tables are never exposed.
- **Unit:** table × operation (`read`, `create`, `update`, `delete`). Undefined operation = closed.
- **Rule types:** `isPublic()`, `authenticated()`, `role(...)`, `owner(column)`, and custom predicates
  that produce Kysely expressions. Combine with `.and()` / `.or()`.
- **Compile to SQL.** `read`/`update`/`delete` rules compile, with the user context, into a `WHERE`
  fragment. Never post-filter: pagination and `count` must stay correct.
- **Write check.** After `create`/`update` the resulting row must still satisfy the policy (Postgres
  `WITH CHECK` semantics). Owner columns are set by the server (`owner_id = ctx.user.id`); a
  client-supplied different value is rejected.
- **Field rules.** `hidden` columns never leave the server (e.g. `password_hash`); `readonly` columns
  cannot be written; `visibleTo` narrows fields by role (`self` is a pseudo-role).
- **Relations.** Every table pulled in through `include` gets its own `read` policy. A table without a
  policy cannot be included.
- **Context (`ctx`):** `user`, `roles`, `session`, `request`. Roles live in a table tied to the Better Auth user.

### Evaluation order
1. Route match (is table × operation open in config?)
2. Identity resolution (session, API key, or MCP token)
3. Table policy compiled to a `WHERE` fragment
4. Input validation + write check
5. Query runs; includes load with their own policies
6. Hidden / non-visible fields stripped from the response

### Verifiability
- Every decision yields an explanation: which rule matched, the `WHERE` produced, which fields were
  hidden. MCP `check_access` and `explain_query` return it.
- `castra test policies` runs fixture-based policy tests. Allow **and** deny tests per rule are mandatory in CI.

## 4. API generator

### Schema discovery
- Sources: `sqlite_master`, `PRAGMA table_info`, `PRAGMA foreign_key_list`, `PRAGMA index_list`.
- `castra generate` emits a committed JSON schema snapshot and Kysely TS types.
- Runtime uses the snapshot (no per-request introspection). Deploy runs a drift check and stops on mismatch.

### Endpoints (only for operations with a policy)
| Operation | Route |
| --- | --- |
| List | `GET /api/:table` |
| Get | `GET /api/:table/:id` |
| Create | `POST /api/:table` |
| Update | `PATCH /api/:table/:id` |
| Delete | `DELETE /api/:table/:id` |

No bulk operations in v0.1.

### Query features
- **Filter:** PostgREST style — `?status=eq.draft&created_at=gte.2026-01-01`. Operators: `eq neq gt gte lt lte in like is`.
  Filterable columns can be allow-listed in config.
- **Sort:** `?sort=-created_at,title`
- **Pagination:** cursor (keyset) by default, offset optional; `maxLimit` from config, default 100.
- **Relations:** `?include=author,comments`, derived from foreign keys. One level in v0.1; batched with `IN` (no N+1).

### Validation & docs
- SQLite type affinity is loose, so Zod schemas are generated from column types — type guarantees come from this layer.
- OpenAPI 3.1 is generated from schema + policies and lists only open operations; served at `/openapi.json`.
- Errors use `application/problem+json`.
- D1 has no interactive transactions; multi-statement writes use `db.batch()`.

### Custom endpoints
Hono routes under `src/routes` get the same `ctx` and policy helpers.

## 5. MCP layer

MCP never bypasses the policy engine. Local and remote share the tool set. Remote writes need `data:write` and run
only as the token's own user (ADR 0081).

| Tool | Purpose | Local | Remote | Version |
| --- | --- | --- | --- | --- |
| `describe_schema` | Tables, columns, relations, policies | yes | yes | v0.1 |
| `check_access` | Dry-run user/role × op × row → decision + explanation | yes | yes | v0.1 |
| `explain_query` | REST request → generated SQL + applied policies | yes | yes | v0.1 |
| `query_data` | Policy-bound read as a given identity | yes | scoped token | v0.1 |
| `create_data` / `update_data` / `delete_data` | Write through the REST write path | yes | `data:write`, own user | v0.2 |
| `propose_policy` | Config diff proposal, never applied (ADR 0082) | yes | no | v0.2 |
| `generate_migration` / `apply_migration` | Migration; apply requires approval (ADR 0086) | yes (local) | no | v0.4 |
| `deploy_status` | Provisioning, bindings, schema drift | yes | no | v0.2 |

- `generate_migration { name }` creates an empty `<migrations_dir>/NNNN_<slug>.sql` file with a header comment for the SQL body and the rollback; returns the path and a preview. Local only. Never applied.
- `apply_migration { approve }` lists pending migrations; with `approve: false` (or absent) it returns the dry-run summary without applying. With `approve: true`, after a successful drift check, runs `wrangler d1 migrations apply` and reports the exit code. Local only.

- **Local:** `npx castra mcp` (stdio), uses `wrangler dev` bindings or the Cloudflare API token.
- **Remote:** `/mcp` on the Worker. Separate MCP tokens with scopes `schema:read`, `access:check`,
  `data:read`, `data:write`; no scope grants admin. Reading as another user needs its own scope. Every call is
  written to `_castra_audit`. Argument values are masked before storage; configurable subtree redaction and
  opt-in bounded age retention are defined in ADR 0084. Attempt-before-write auditing remains mandatory.

## 6. CLI & provisioning

v0.3.0 `castra rollback` (ADR 0085) changes Worker traffic only. Immutable deploy messages record full D1
schema and config hashes. Compatible single-D1 versions require explicit confirmation; unmarked versions,
schema/config mismatch and split traffic fail closed. Provider refusals are never forced.

Idempotent: re-running never duplicates resources. State lives in `wrangler.jsonc` bindings. Deploy uses Wrangler.

| Command | Does |
| --- | --- |
| `npm create @castra-kit@latest <name>` | Scaffold + config |
| `castra init` | Add to an existing Workers project |
| `castra provision` | Create D1, KV and (if enabled) R2 |
| `castra generate` | Schema snapshot + TS types |
| `castra migrate` | Auth, internal and user migrations; `create`, `status` (ADR 0080) |
| `castra deploy` | provision → migrate → wrangler deploy |
| `castra test policies` | Policy tests |
| `castra mcp` | Local MCP server |
| `castra doctor` | Token permissions, bindings, package versions, drift (local or `--remote`); `deploy_status` runs it |

First run: scaffold → read/verify `CLOUDFLARE_API_TOKEN` and list missing permissions → create
resources and write bindings → generate `BETTER_AUTH_SECRET` as a Worker secret → migrate → deploy and
print API, `/openapi.json` and `/mcp` URLs. Minimum token permissions are documented in the README
(Workers scripts, D1, KV, R2 only if storage is on) — names verified against Cloudflare docs.

## 7. Config example (API surface is a draft)

```ts
import { defineConfig, owner, role, authenticated, isPublic } from "@castra-kit/core";

export default defineConfig({
  database: "d1",
  auth: { provider: "better-auth", methods: ["email", "github"] },
  storage: false,
  api: { maxLimit: 100 },
  roles: ["admin", "editor", "member"],
  tables: {
    posts: {
      read: isPublic().where((q) => q.eb("status", "=", "published"))
        .or(owner("author_id"))
        .or(role("admin")),
      create: authenticated(),
      update: owner("author_id").or(role("editor", "admin")),
      delete: role("admin"),
      fields: {
        author_id: { setBy: "server" },
        internal_notes: { visibleTo: ["admin"] },
      },
      filterable: ["status", "created_at"],
    },
    comments: {
      read: isPublic(),
      create: authenticated(),
      update: owner("user_id"),
      delete: owner("user_id").or(role("admin")),
      fields: { user_id: { setBy: "server" } },
    },
    users: {
      read: authenticated(),
      fields: { email: { visibleTo: ["self", "admin"] } },
    },
  },
});
```

`audit_logs` has no policy, so it is never exposed.

## 8. Roadmap

- **v0.1 — MVP:** CLI provision + deploy · Better Auth + roles · policy engine · auto CRUD + OpenAPI · read-only MCP
- **v0.2 — Agents write:** MCP write tools · migrations · `propose_policy` · `deploy_status` / `doctor`
- **v0.3 — Expansion:** R2 storage · multi-level include · bulk operations · multi-tenancy (open)
- **v1.0 — Stable:** plugin SDK · custom hooks · admin UI · stable config API

**Out of scope until v1:** PostgreSQL/MySQL/Hyperdrive · realtime (Durable Objects) · queues ·
Redis/S3/OIDC adapters · hosted/managed offering.

## 9. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Policy engine bug | Data leak; project credibility gone | Default closed, mandatory allow/deny tests, property-based tests, security model doc |
| KV eventual consistency | Session revocation lags | Validate sessions against D1; KV is cache only |
| D1 limits (size, single writer) | Unfit for write-heavy apps | State unsuitable use cases in the README |
| Scope creep | Never ships | Hold the out-of-scope list |
| Cloudflare ships something similar | Commercial value drops | OSS/CV focus; MCP + verification layer stays the differentiator |
