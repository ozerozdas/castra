# 0041. Filters, validation and JSON types

## Status
Accepted (2026-10-10). Refines ADR 0001.

## Context
ADR 0001 fixed the PostgREST operators. Value syntax, coercion and how to avoid column-existence oracles were open.
SQLite affinity is loose, so the type guarantee must come from the API layer (ARCHITECTURE §4).

## Decision
- **Operators:** `eq neq gt gte lt lte` (scalar), `in.(a,b,"c,d")` (double quotes for commas, `\"`/`\\` escapes),
  `is.null|true|false` (compiled to `IS NULL` / `IS TRUE` / `IS FALSE`), `like` with `*` as the wildcard: literal
  `%`, `_` and `\` are escaped and the predicate carries `ESCAPE '\'`. A literal `*` cannot be matched.
- **Columns:** every filtered and every sorted column must pass `engine.canFilter(table, column, ctx)`. Unknown,
  hidden, non-filterable and not-visible-to-caller columns get the *same* 400 message, so no existence oracle.
- **Types (Zod 4, per column affinity):** TEXT → string, INTEGER → safe integer, REAL/NUMERIC → finite number,
  undeclared type → string or number, declared BLOB → rejected on write and in filters (JSON has no bytes; BLOBs are
  returned base64-encoded). Nullable when the column is not `NOT NULL`. Filter values are coerced the same way
  (`?views=eq.abc` on an INTEGER column is 400).
- **Bodies:** must be a JSON object (`application/json`, else 415), ≤ 1 MiB (413). Unknown keys are 400; hidden
  columns are reported exactly like unknown ones (`unknown column "x"`), also when the engine rejects them.
- **Errors:** `application/problem+json` `{type,title,status,detail}`. `PolicyError` keeps its status and message;
  its `explanation` is never sent. Unexpected errors are a generic 500 (logged server-side only). Constraint
  violations (UNIQUE, NOT NULL, FK) are a generic 409 without the database message.

## Consequences
- NUMERIC columns that hold text dates must be filtered with numbers or declared TEXT.
- Booleans in JSON are not accepted for INTEGER columns; clients send 0/1.
