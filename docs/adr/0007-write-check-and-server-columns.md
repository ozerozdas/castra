# 0007. Write check and server-set columns

## Status
Accepted (2026-10-10)

## Context
ARCHITECTURE §3 requires Postgres `WITH CHECK` semantics on create/update and server-set owner columns.
D1 has no interactive transactions, so "write then verify then roll back" is not available, and custom
predicates are SQL, so the check cannot be done in JavaScript.

## Decision
**Input (`prepareWrite`) rejects, never strips.** Unknown columns, `hidden` columns, `readonly` columns
(on create *and* update) and non-scalar values → 400. `setBy: "server"` columns:
- On create, owner columns (named in any `owner()` rule of the table) are filled from `ctx.user.id`; a
  client value that is not strictly equal is rejected with 403 (spoofing); an equal value is accepted.
- On update, server columns are never written. A client value is compared with the stored value when the
  caller passes the existing row (optional 5th argument `existing`, an addition to the agreed signature),
  otherwise with `ctx.user.id`; a mismatch is 403. This stops an admin from taking ownership by sending
  their own id.
- Non-owner server columns (e.g. `created_at`) have no server value in the engine; any client value → 400.

**Row check (`checkRow`) runs the op's rule in SQL against a candidate row:**
`SELECT 1 AS ok FROM (SELECT <v1> AS "c1", ...) AS "<table>" WHERE <rule> LIMIT 1`. The derived table is
aliased as the table name so qualified `owner()` references resolve. Every snapshot column is present
(missing ones are NULL); candidate keys not in the snapshot → 400.

Bound parameters have no column affinity, but stored values do. Each value is wrapped in
`CAST(? AS TEXT|NUMERIC|REAL)` wherever SQLite would convert on storage, so comparisons behave as they do
against the real table. Verified on local D1, including D1's habit of binding JS numbers as REAL
(`42` stored in a TEXT column becomes `'42.0'`; checkRow agrees). Non-numeric text in numeric columns and
blobs are bound as-is, as SQLite stores them.

## Consequences
- The API layer must, for update: apply `readFilter("update")` to the existing row (USING), call
  `prepareWrite(..., existing)`, merge, then `checkRow("update", merged)` (WITH CHECK), then write.
  For create: `prepareWrite` → `checkRow("create")` → insert.
- `readonly` columns that need an initial client value are not supported; use `setBy: "server"` or a DB default.
- User ids should be TEXT (Better Auth ids are), given the REAL binding behaviour above.
