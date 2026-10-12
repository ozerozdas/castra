# Castra security model

Castra is a policy engine and a REST/MCP surface in front of a Cloudflare D1 database. This document says what it
protects, what it relies on, and what it does not do. Status: v0.1.0, released, not externally audited. Design
background: [ARCHITECTURE.md](ARCHITECTURE.md). Decisions: [docs/adr](adr/).

## 1. Scope and trust boundaries

### Attackers considered

| Actor | What they hold | What they can reach |
| --- | --- | --- |
| Anonymous internet client | nothing | Only table operations whose rule is true for `user: null` (for example `isPublic()`). Anonymous callers never hold roles ([ADR 0005](adr/0005-policy-compilation-semantics.md)). |
| Authenticated user | Better Auth session | Operations whose rules accept that user id and their current roles. |
| User with a role | session + `_castra_roles` row | Same, plus `role(...)` rules and `visibleTo` fields for that role. Roles are read from D1 on every request. |
| API key holder | `castra_ak_...` | Acts as the key's user, with roles limited to a subset of that user's current roles ([ADR 0022](adr/0022-own-api-keys-table.md)). Never more than the user. |
| MCP token holder | `castra_mcp_...` | `/mcp` only. Per scope: `schema:read` (`describe_schema`), `access:check` (`check_access`, `explain_query`), `data:read` (`query_data` as the token's own user), `data:read:any_user` (`as` another user or `anonymous`). No scope grants admin or writes ([ADR 0061](adr/0061-mcp-tokens-and-scopes.md)). |
| Local stdio MCP user | shell access to the developer machine | Trusted operator. `castra mcp` has no tokens, runs against the local D1, and `as` may be any user id, `anonymous`, or a hypothetical role set. |

A MCP token is not a REST credential (it resolves to anonymous there), and an API key or session is not accepted on
`/mcp`.

### Trusted

- The deployer and whoever holds the Cloudflare API token, Wrangler login or Worker secrets. They can read the database directly.
- Worker secrets (`BETTER_AUTH_SECRET`, OAuth client secrets).
- Cloudflare itself: Workers runtime, D1, the network edge.
- The developer's configuration, including `custom()` and `where()` rules (see section 3).
- The Better Auth library, pinned at 1.7.7 for the auth flows. Castra does not re-audit it.

Out of the model: a compromised Cloudflare account, a malicious dependency, a compromised developer machine, and
denial of service (writes are rate limited per IP; see "Rate limiting" below).

## 2. Guarantees

Each item names where it is enforced and which tests cover it. Test paths are relative to the repository root.
"Allow and deny tests per rule type" is a project rule (CLAUDE.md rule 6); run them with `pnpm test:policies` in this repository, or `castra test policies` in a Castra project.

1. **Default closed.** A table without a policy has no routes, and an undefined operation is closed. Reserved tables
   cannot be configured at all. Enforced in `packages/core/src/config.ts` (`defineConfig`) and
   `packages/core/src/policy/engine.ts` (`isOpen`). Tests: `packages/core/test/policy/`, `packages/core/test/api/`.
2. **Policies compile to SQL.** Read, update and delete rules become a `WHERE` fragment from the caller context; rows
   are never filtered after the query, so pagination and counts are computed over visible rows only.
   `packages/core/src/policy/compile.ts`, `packages/core/src/api/plan.ts`. Tests: `packages/core/test/policy/property.d1.test.ts`
   (generated rules compared with a JS oracle), `rules.d1.test.ts`, `packages/core/test/api/router.d1.test.ts`.
3. **Write check on every create and update, on the stored row.** The authoritative check is a guard statement run in
   the same atomic D1 `batch()` as the write: if the stored row does not satisfy the rule, the guard raises, the batch
   rolls back, and the client gets 403 `write_check_failed`. A missing row also fails closed
   ([ADR 0050](adr/0050-checks-via-guarded-batch.md)). `checkRow` (also used by MCP `check_access`) is only a dry run
   and can be approximate. Enforced in `packages/core/src/db/guarded-write.ts`, `engine.writeGuard`. Tests:
   `packages/core/test/policy/guarded-write.d1.test.ts`, `review2-affinity.d1.test.ts`.
4. **Server-set and owner columns are never taken from input.** Any column named in an `owner()` rule is implicitly
   `setBy: "server"`: filled from the session user on create, a different client value is 403, never written on
   update. `readonly` and `hidden` columns, unknown columns and non-scalar values are rejected with 400, not stripped
   ([ADR 0007](adr/0007-write-check-and-server-columns.md)). `engine.prepareWrite`. Tests:
   `packages/core/test/policy/write.test.ts`, `fields.test.ts`, `adversarial.review.test.ts`.
5. **Includes obey their own table's `read` policy.** An included table without an open `read` cannot be included;
   included rows use that table's compiled filter and field projection. `packages/core/src/api/plan.ts`
   ([ADR 0042](adr/0042-includes.md)). Tests: `packages/core/test/api/`, `examples/blog/test/api.test.ts`.
6. **Column visibility on read and write.** `hidden` columns never leave the server. `visibleTo` columns are stripped
   for callers without the role (`self` is supported), and a `visibleTo` column can only be written by a caller who
   could read it. When a create or update cannot be re-read under the read policy, the response carries only the
   primary key, and only if the caller may read the key column (`engine.canReadColumn`); otherwise it is `{}`.
   `engine.projectRow`, `prepareWrite`, `rereadBody` in `packages/core/src/api/plan.ts`. Tests:
   `packages/core/test/policy/fields.test.ts`, `field-write.test.ts`, `packages/core/test/api/final-review.d1.test.ts`
   (FR-2), `final-review-fixes.d1.test.ts`.
7. **Filters and sorts only on readable columns.** Every filtered or sorted column goes through
   `engine.canFilter` (false for hidden columns, columns the caller cannot see, and tables without an open `read`);
   a rejected column answers like an unknown one. Item routes (`/:id`) are 404 for callers who cannot read the primary
   key. OpenAPI lists only the operations REST serves (no `POST` without a single-column primary key, no `/{id}`
   routes for a hidden key). `packages/core/src/api/plan.ts`, `openapi.ts`. Tests:
   `packages/core/test/policy/review-fixes.test.ts`, `packages/core/test/api/item-routes.test.ts`, `review3.d1.test.ts`,
   `final-review.d1.test.ts` (FR-3), `final-review-fixes.d1.test.ts`.
8. **No string-built SQL.** Queries are built with Kysely; values are bound; identifiers come from the schema
   snapshot (`sql.id`). Config columns and tables are checked against the snapshot at startup, and the `Rule` and the
   snapshot are deep-frozen copies. Schema introspection uses `pragma_*()` functions with bound parameters
   ([ADR 0009](adr/0009-pragma-identifier-quoting.md)). The only raw SQL in the write guard is a fixed error
   expression. Tests: `packages/core/test/policy/adversarial.review.d1.test.ts`, `rule-immutability.test.ts`.
9. **Reserved tables are never exposed.** `user`, `session`, `account`, `verification`, `_castra_*`, `sqlite_*`,
   `_cf_*` and `d1_migrations` are rejected in config (case-insensitively), skipped by introspection where they are
   Workers/D1 internals, and absent from OpenAPI. `isReservedTable` in `packages/core/src/config.ts`,
   `packages/core/src/schema/introspect.ts`. Tests: `packages/core/test/policy/config.test.ts`,
   `examples/blog/test/api.test.ts` (OpenAPI lists no internal names).
10. **Sessions are validated against D1 on every request.** No KV or cookie cache; a deleted, signed-out or expired
    session is anonymous on the next request, and roles are re-read from `_castra_roles`
    ([ADR 0021](adr/0021-sessions-in-d1-only.md)). `packages/auth/src/context.ts`, `create-auth.ts`. Tests:
    `examples/blog/test/auth.test.ts` (sign-out, role revoke, revoked key).
11. **API keys and MCP tokens are stored as SHA-256 hashes and compared in constant time.** Both carry 256 bits of
    secret. The comparison also runs against a dummy hash of the same length when the id is unknown. A presented but
    invalid API key resolves to anonymous and does not fall back to a cookie. `packages/auth/src/api-keys.ts`,
    `hash.ts`, `packages/mcp/src/tokens.ts`. Tests: `examples/blog/test/auth.test.ts` (API keys: valid, revoked,
    expired, role subset, no cookie fallback), `packages/auth/test/unit.test.ts`, `packages/mcp/test/remote.test.ts`.
    The dummy-hash path is covered by `packages/auth/test/api-key-timing.test.ts` and
    `packages/mcp/test/token-timing.test.ts`: an unknown id runs exactly one comparison, against the all-zero dummy hash.
12. **Weak secrets are rejected.** `BETTER_AUTH_SECRET` must be at least 32 characters, must not contain a known
    placeholder marker (for example `replace-me`, `changeme`, `example`) and needs at least 10 distinct characters; the
    Worker refuses to build auth otherwise. This happens on the first request that needs auth, which answers with a
    generic 500. `/health` still returns 200. `packages/auth/src/create-auth.ts`. Test: `packages/auth/test/unit.test.ts`.
    `castra deploy` generates a 32-byte random secret if none exists.
13. **MCP uses the same pipeline as REST.** `query_data` plans and executes through the REST request pipeline and
    the same engine; there is no MCP-only data path (ADR [0060](adr/0060-mcp-shared-tools.md)). Tests:
    `examples/blog/test/mcp.test.ts` compares `query_data` with REST for several identities and paths.
14. **Remote MCP `as` rules.** Without `data:read:any_user`, `as` may only be omitted or name the token's own user.
    With it, `as` may be `anonymous` or `{userId}`; explicit roles are rejected (400 `roles_not_allowed`), roles
    always come from `_castra_roles` at call time, and an unknown user id is 400 `unknown_user`. Local stdio keeps
    `{userId, roles}` because it is the trusted operator. `packages/mcp/src/identity.ts`, `scopes.ts`
    ([ADR 0061](adr/0061-mcp-tokens-and-scopes.md), amendment). Tests: `packages/mcp/test/review4.test.ts`, `remote.test.ts`.
15. **Audit log per remote MCP call.** One `_castra_audit` row per JSON-RPC message, with its own outcome, written in
    `finally`. If the audit write fails the client gets 500 `audit_failed` and no data. Duplicate-id batches and
    transport rejections are audited as `rejected`
    ([ADR 0063](adr/0063-mcp-audit-log.md)). `packages/mcp/src/audit.ts`, `remote.ts`. Tests:
    `packages/mcp/test/remote.test.ts`, `review4.test.ts`. Stdio writes no audit rows.
16. **Request size limits and LIKE caps.** REST bodies are limited to 1 MiB (413), page size is clamped to
    `api.maxLimit` (default 100), at most 100 bound parameters per query, and `like` filters are limited to 256
    characters and 10 wildcards (400, and D1 "pattern too complex" maps to 400). `/mcp` limits bodies to 1 MiB
    (also checked from `Content-Length` before reading) and batches to 10 messages.
    `packages/core/src/api/router.ts`, `parse.ts`, `plan.ts`, `packages/mcp/src/remote.ts`.
    Tests: `packages/core/test/api/parse.test.ts`, `review3.d1.test.ts`, `packages/mcp/test/remote.test.ts`.
17. **Errors are `application/problem+json`** for unmatched routes and uncaught exceptions; 500s are generic and do
    not include SQL or stack traces. Better Auth's `/api/auth/*` errors are rewritten as `auth_error` problems that keep
    its `code` and `message`; a 5xx body is never echoed ([ADR 0073](adr/0073-auth-errors-problem-json.md)).
    `packages/auth/src/hono.ts`. Tests: `packages/auth/test/unit.test.ts`, `examples/blog/test/auth.test.ts`.
18. **A create or update never deletes another row.** Castra's write path issues only plain `INSERT` and `UPDATE`
    statements: no `INSERT OR REPLACE`, `REPLACE` or upsert. A schema-level `ON CONFLICT REPLACE` on a `UNIQUE` or
    `PRIMARY KEY` constraint would make a colliding write delete the other row without the delete policy. Introspection
    detects that clause conservatively from `sqlite_master.sql` (`TableSnapshot.conflictReplace`), and the engine
    refuses every create and update on such a table with 403 `unsafe_schema`, for every caller. Read and delete keep
    their policies. OpenAPI does not advertise the refused writes and `castra generate` warns
    ([ADR 0066](adr/0066-on-conflict-replace-tables.md)). `packages/core/src/schema/introspect.ts`
    (`hasReplaceConflictClause`), `engine.ts`. Tests: `packages/core/test/api/final-review.d1.test.ts` (FR-1),
    `final-review-fixes.d1.test.ts`, `packages/mcp/test/final-review.test.ts`, `packages/cli/test/generate.test.ts`.
    Triggers are trusted schema code and can still change other rows.

## 3. What Castra does not guarantee

### Known issues (from [PROGRESS.md](PROGRESS.md), "Open issues")

- **`custom()` and `where()` rules are the developer's responsibility.** The engine validates the table and column
  names it can walk, but cannot see inside raw `sql` fragments. A predicate can contain a subquery that reads Better
  Auth tables or `_castra_*` tables, and nothing stops it. A predicate that throws for the probe context is a config
  error, but one that is simply wrong is not detected. Write allow and deny tests for every custom rule.
- **`check_access` and `explain_query` reveal hidden column names.** Tokens with `access:check` learn the names (not
  the values) of `hidden: true` columns through `hiddenFields` and the planned SELECT. This is by design
  (ARCHITECTURE section 3) and pinned in `packages/mcp/test/review4.test.ts`. Do not give that scope to parties who
  must not learn your schema details. Likewise, writing a `visibleTo` column without the role answers 403, which
  reveals that the column exists (ADR 0007, amendment 2).
- **`check_access` can differ from the real write.** The dry run cannot reproduce non-literal defaults, rowid
  assignment or non-numeric text in numeric columns, and says "approximate" when one applies. Column collations
  (NOCASE, RTRIM) are applied ([ADR 0075](adr/0075-column-collations.md)). Only the guarded write is exact.
- **Existence oracles.** Constraint errors (409) on unique constraints with client-chosen values, and foreign-key
  children blocking a delete, reveal that a row exists even if the caller cannot read it. The same goes for a foreign
  key into a table without an open `read` policy. Castra leaves that reference to the database, so a create or
  update answers differently (success or 409) depending on whether the unreadable parent row exists. A foreign key
  into a table with an open `read` policy is checked under that policy, and a missing or unreadable parent is the
  same 400 `invalid_reference`.
- **Audit table growth.** A request with a known MCP token id and a wrong secret writes one `_castra_audit` row per
  request. Anyone who learns a token id (it is part of the token and appears in `_castra_mcp_tokens`) can grow the
  table. There is no automatic retention; prune with `castra mcp audit prune --older-than <days>`
  ([ADR 0070](adr/0070-audit-prune-command.md)).
- **Audit rows may contain PII.** `_castra_audit.arguments` stores tool arguments verbatim up to 4 KB (filters,
  paths, `check_access` rows). Treat the table as sensitive and prune it regularly.
- **Rate limiting covers writes only.** Sign-in, sign-up, `/mcp` and table writes are limited per IP (60 per minute by
  default, per Cloudflare location, approximate). Reads are not; use a WAF rule on a custom domain
  ([rate limiting](rate-limiting.md), [ADR 0072](adr/0072-rate-limit-binding.md)).
- **Primary key changes on update** are not rejected by `prepareWrite`; the guard needs the new key and otherwise
  fails closed with 403.
- **Reserved table list is hard-coded.** `isReservedTable` knows the four Better Auth tables. A Better Auth plugin
  that adds tables must also add them to `AUTH_TABLES` or the engine could expose them. v0.1 uses only the `bearer`
  plugin, which adds none.
- **Very deep rule nesting** (thousands of levels) overflows the stack at startup. It fails when the config is
  built, never at request time.
- **The example config is intentionally permissive in places:** `comments` is public, including comments on draft posts.

### Platform limits

- **D1 has no row-level locks across requests and no interactive transactions.** Atomicity is limited to one
  `batch()`. Read-then-write sequences across requests can interleave; the write guard protects the policy, not
  application invariants.
- **Read replication, if you enable it, is eventually consistent.** A revoked session or role could be read from a
  replica that has not caught up. Castra does not configure replication. Not tested.
- **D1 size and throughput limits** apply. Castra is not designed for write-heavy workloads.
- **No field-level or at-rest encryption** beyond what Cloudflare provides. Columns are stored as written.
- **No tenant isolation.** One Worker and one D1 per deployment; multi-tenancy is not built
  ([ADR 0002](adr/0002-no-multitenancy-v0.1.md)).

### Not built (ARCHITECTURE section 8)

Out of scope until v1.0 and therefore not protected by anything here: PostgreSQL/MySQL/Hyperdrive, realtime
(Durable Objects), queues, Redis/S3/OIDC adapters, hosted offering. Not in v0.1: MCP write tools, bulk
operations, multi-level include, R2 storage, multi-tenancy, plugin SDK and custom hooks, admin UI. Remote MCP is
read-only and exposes no write tool.

Also not done: stdio MCP against the remote D1 via the API token, automatic audit retention, a `castra mcp token list`
command, HTTP endpoints for API key management, and `castra init` (the CLI prints "not implemented yet",
[ADR 0038](adr/0038-castra-init-deferred.md)).

## 4. Operator checklist

- [ ] Secrets only through `wrangler secret put` (or `castra deploy`, which sets `BETTER_AUTH_SECRET` from stdin).
      Never commit `.dev.vars`, tokens or keys. Generate secrets with `openssl rand -base64 32`.
- [ ] Create the Cloudflare API token with the minimum permissions in [cloudflare-token.md](cloudflare-token.md).
      Use a token scoped to one account; run `castra doctor` to check it.
- [ ] Give each MCP token only the scopes it needs, a user with minimal roles, and an expiry. Avoid `data:read:any_user`
      for anything except trusted verification tooling.
- [ ] Revoke a token with `castra mcp token revoke <id> [--remote]`. Revoking a user's role takes effect on the next call.
- [ ] Review `_castra_audit` regularly (`outcome` of `denied`, `unauthorized:*`, `rejected`), and prune old rows with `castra mcp audit prune --older-than <days> --remote`.
- [ ] Keep the `RATE_LIMITER` binding (`createCastraApp` applies `rateLimitWrites`; it warns once when the binding is missing); tune `limit` for your users. On a
      custom domain, add a WAF rule for reads ([rate limiting](rate-limiting.md)).
- [ ] Restrict `trustedOrigins` for Better Auth to your real front-end origins.
- [ ] Review every `custom()` and `where()` rule and give each allow and deny tests.
- [ ] Run the policy tests in CI with `castra test policies` ([ADR 0037](adr/0037-castra-test-policies.md)); it fails when no
      policy test file exists. It does not check that every rule has an allow and a deny test, so review that yourself.
- [ ] Do not expose tables you have not reviewed; leaving a table out of `tables` keeps it closed.

## 5. Reporting a vulnerability

Please do not open a public issue. Open a private security advisory on the GitHub repository (Security tab,
"Report a vulnerability"). Include the affected version or commit, a reproduction (config, request, expected and
actual result), and the impact. This is an early-stage project maintained without a service level; reports are
handled as time allows.
