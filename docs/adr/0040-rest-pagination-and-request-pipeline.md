# 0040. REST request pipeline and pagination

## Status
Accepted (2026-10-10).

## Context
ARCHITECTURE §4 fixes the routes and says "cursor (keyset) by default, offset optional; maxLimit from config,
default 100" but leaves the default page size, the cursor format, offset rules and the request structure open.
MCP `explain_query` / `query_data` must reuse the REST path (CLAUDE.md rule 7).

## Decision
- **Three stages**, exported from `castra`: `parseRequest` (syntax only, pure), `planRequest(engine, snapshot,
  config, parsed, ctx)` (policy + schema checks; builds and **compiles** every Kysely statement without executing,
  returns `statements` with SQL + params and the policy `explanations`), `executePlan(db, plan, { batch })`.
  `JSON.stringify(plan)` is the `explain_query` payload; the executable part sits under a symbol.
  `createRestRouter` only wires these. Values known only at execution appear as `"$parentKeys"` in plans.
- **Closed = unknown.** The router checks `engine.isOpen(table, op)` before reading the body or query; unknown
  tables, closed tables/ops, auth and `_castra_*` tables all get the same 404 problem. Unsupported method/path
  combinations (PUT, PATCH on the collection, ...) also answer 404.
- **Page size:** `?limit` default `min(25, maxLimit)`; values above `maxLimit` are clamped, `0` is 400.
- **Cursor:** opaque base64url JSON `{ k: ["-created_at","id"], v: [<values>] }` — the sort keys (always
  including the primary key as tie-breaker) and the last row's values for them. A cursor whose keys differ from the
  current sort is 400; values are coerced to the column type and only ever bound as parameters in a keyset `WHERE`
  that is ANDed with the policy filter and the user filters. Sort columns must pass `engine.canFilter`, so a cursor
  can only compare columns the caller may already filter on; the primary key is used only when it is visible to the
  caller on every row (not hidden, not `visibleTo`-gated for them). Otherwise cursor pagination is refused (400) and
  `nextCursor` is `null`; offset still works. The keyset predicate is NULL-aware (SQLite sorts NULLs first ascending).
- **Offset:** `?offset=` (≤ 100000), not combinable with `cursor`. `nextCursor` is still returned.
- **Count:** `?count=exact` runs `count(*)` with the same policy + filter `WHERE` (no cursor).
- **Shape limits:** ≤ 20 filters, ≤ 100 `in` values (bound as one JSON parameter via `json_each`), ≤ 5 sort keys,
  ≤ 10 includes; a statement over D1's 100 bound parameters is rejected with 400.
- **Constant-false rules** (e.g. `role(admin)` for a member): 401 for anonymous, 403 for authenticated callers, for
  every operation (ADR 0044). This reveals only the policy shape, which `/openapi.json` already documents.

## Consequences
- A table without a primary key has list (offset) and create only; `/:id` routes need a single-column primary key.
- Query parameters named `sort`, `limit`, `cursor`, `offset`, `count`, `include` cannot be filters.
