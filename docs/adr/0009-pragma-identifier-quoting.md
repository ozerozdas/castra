# 0009. Schema introspection binds identifiers instead of quoting them into PRAGMA text

## Status
Accepted (2026-10-10). Supersedes the "identifiers double-quoted and escaped" sentence of ADR 0010.

## Context
`PRAGMA table_info(...)` and friends take an identifier, not a bound parameter, so the first version of
`introspect()` built `PRAGMA table_info("<name>")` strings and relied on `quoteIdentifier` (double quotes
doubled, NUL rejected). The names come from `sqlite_master`, so they are database-controlled rather than
user-controlled, but CLAUDE.md rule 5 forbids string-built SQL, and a table named `x") ; ...` is legal in SQLite.
The security review flagged it. The only other place SQL text meets a database is `packages/cli/src/local-d1.ts`;
it forwards the statement and its bound parameters unchanged and builds no SQL itself.

## Decision
`introspect()` uses the table-valued pragma functions with bound parameters:

- `SELECT * FROM pragma_table_info(?)`
- `SELECT * FROM pragma_foreign_key_list(?)`
- `SELECT * FROM pragma_index_list(?)`
- `SELECT * FROM pragma_index_info(?)`

They return the same columns as the statement forms. Verified on local D1 (miniflare): the whole introspection
suite, including composite keys, implicit FK parents, partial and expression indexes, passes unchanged. No SQL text
is concatenated anywhere in schema introspection. `quoteIdentifier` stays exported as a small public helper but
introspection no longer uses it.

## Consequences
- Table and index names, including ones containing quotes or semicolons, are data, never SQL.
- A test asserts the hostile name arrives as a bound parameter and that no `PRAGMA` text is issued.
- Query functions (`QueryFn`) must pass `params` through to the driver; both the CLI and the test harness do.
