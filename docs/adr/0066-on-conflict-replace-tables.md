# 0066. Tables with `ON CONFLICT REPLACE` are not writable through Castra

## Status
Accepted (2026-10-11). Final v0.1 review, finding FR-1. Adds `TableSnapshot.conflictReplace` (additive) and the
`PolicyError` code `unsafe_schema`.

## Context
SQLite lets a `UNIQUE` or `PRIMARY KEY` constraint carry a conflict clause. With `ON CONFLICT REPLACE`, an
`INSERT` or `UPDATE` that collides with an existing row **deletes that row** and then writes. No `DELETE`
statement is issued, so neither Castra's delete policy nor the write guard (ADR 0050) sees it. The guard only
checks the row that was written, and that row is fine.

The review reproduced it with a common "upsert by slug" schema, `slug TEXT UNIQUE ON CONFLICT REPLACE`. Bob
could only create his own rows, yet `POST {slug: "home"}` deleted Alice's `home` page. `PATCH` of his own row
to `slug: "home"` did the same.

None of the `pragma_*` functions Castra introspects with reports the conflict clause. SQLite keeps it in the
stored `CREATE TABLE` text in `sqlite_master.sql`.

`NOT NULL ON CONFLICT REPLACE` is different. It replaces a NULL with the column default and never deletes a
row. `CREATE UNIQUE INDEX` has no conflict clause. Statement-level `INSERT OR REPLACE` / `REPLACE` / upserts
are never issued by Castra's REST or MCP data path: REST writes are a plain Kysely `insertInto().values()` or
`updateTable().set().where()` (packages/core/src/api/plan.ts), and MCP never writes. The `onConflict` calls in
`@castra/auth` (`users` mirror sync, `_castra_roles` grant) are auth-internal tables outside the data path.

## Decision
**Detect conservatively, then refuse every create and update on a flagged table, for every caller.**

- `introspect` reads `sqlite_master.sql` per table. `hasReplaceConflictClause(sql)` tokenizes it, skipping
  string literals, quoted identifiers (`"x"`, `` `x` ``, `[x]`) and comments. It flags every
  `ON CONFLICT REPLACE` except one directly preceded by `NOT NULL`. When unsure, it flags. That covers a
  table-level `CHECK (...) ON CONFLICT REPLACE`, which SQLite accepts and ignores, and an unterminated
  literal or comment. We parse `NOT NULL` apart because the token test is exact, and flagging it would
  refuse writes on a harmless schema.
- A flagged table gets `conflictReplace: true` in the snapshot. The flag is omitted otherwise, so existing
  snapshots stay byte-identical. `diffSnapshots` reports a change of the flag as drift. `castra generate`
  prints a warning for each flagged table.
- The engine refuses `create` and `update` on a flagged table with **403 `unsafe_schema`** for everyone,
  admins included, and before any SQL. That covers `prepareWrite`, `writeGuard` and `readFilter(..., "update")`.
  `checkRow` answers `allowed: false` with the reason. `read` and `delete` keep following their policies.
- OpenAPI does not advertise `POST` or `PATCH` for such a table. MCP `describe_schema` adds `writesDisabled`.
  `check_access` answers `allowed: false` and `explain_query` returns the same 403 as REST.

**Why not refuse at engine construction.** Throwing a `CastraConfigError` when the config opens create or
update on a flagged table would be louder. It would also take the whole Worker down, reads and `/health`
included, for an app that upgrades with such a table, and it would only move the failure from the request to
the deploy. The write paths are the only unsafe part, and they stay closed in every case. No configuration
can open them, so this is still default closed. `castra generate` and `describe_schema` surface the condition
early. Closing the operation outright, so that `isOpen` is false and the route answers 404, was rejected too.
The table is configured, so a 404 would hide the reason, and a 403 with a stable code tells the developer
what to change.

**Remedy for the app:** recreate the table without the clause (default `ABORT`, so a collision is a 409
`constraint`), then run `castra generate`.

## Consequences
- An app with such a table can read and delete through Castra but cannot create or update. That is
  intentional, and the README and SECURITY.md say so.
- Triggers can still delete or change other rows on a write. They are trusted schema code, out of scope
  as before (SECURITY.md).
- If the detection misses a clause, the app falls back to the pre-fix behaviour. The tokenizer flags
  whenever it is unsure, and the review's DDL forms are covered by tests (column and table level,
  `PRIMARY KEY`, named constraints, comments and newlines between tokens, lower case).
