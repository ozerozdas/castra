# 0050. Write checks via a guarded D1 batch

## Status
Accepted (2026-10-10). Supersedes the "Row check (`checkRow`)" part of ADR 0007 as the enforcement
mechanism; `checkRow` stays as a dry run.

## Context
ADR 0007 enforced `WITH CHECK` by evaluating the rule against a *candidate* row built from bound
parameters (`SELECT 1 FROM (SELECT CAST(? AS ...) AS c1, ...) AS t WHERE <rule>`), before the write.
The second security review showed that a candidate can never be made identical to the stored row:

- **A** non-numeric text in a numeric-affinity column keeps the column affinity once stored, which then
  converts the *other* operand of a comparison; a bound value cannot carry an affinity without being
  converted itself.
- **B** D1 binds every JS number as REAL; an INTEGER/NUMERIC column stores `3.0` as INTEGER `3`
  (`typeof`, `CAST AS TEXT`, `length`, `LIKE` differ).
- **C** columns omitted on create get their `DEFAULT`, not NULL.
- **D** `COLLATE NOCASE` columns compare case-insensitively; the derived table uses BINARY. The snapshot
  does not (and cannot cheaply) record collations.
- **E** STRICT `ANY` columns store values verbatim.

Every mismatch is a potential WITH CHECK bypass. D1 has no interactive transactions, but
`D1Database.batch()` runs its statements as one SQL transaction: "If a statement in the sequence fails,
then an error is returned for that specific statement, and it aborts or rolls back the entire
sequence" (Cloudflare D1 Worker API docs, verified via Context7 on 2026-10-10, and by test on local D1).

## Decision
**The authoritative check runs on the stored row, after the write, in the same batch.**

- `PolicyEngine.writeGuard(table, op: "create" | "update", ctx, target): WriteGuard` builds, with
  Kysely, a `SELECT` that raises an SQL error unless the row identified by `target` exists and satisfies
  the op's rule (partially evaluated for `ctx`, exactly as `readFilter` does):

  ```sql
  select json_extract('{}', CASE WHEN exists(
           select 1 as "ok" from "t" where ("t"."pk" = ?) and <rule>)
         THEN '$' ELSE 'castra_write_check_failed' END) as "castra_write_guard"
  ```
  `target` is the full primary key *after* the write, or `"last_insert_rowid"` (rowid tables).
  Identifiers come only from the snapshot (`sql.id`); values are bound; the only raw SQL is the fixed
  error expression, which interpolates nothing.
- `runGuardedWrite(d1, write, guard)` compiles both queries, binds them to D1 prepared statements, runs
  `d1.batch([write, guard])` and maps the guard's error to `PolicyError(403, "write_check_failed")`
  with the guard's explanation. Any other error (constraint, STRICT type, ...) is rethrown unchanged;
  the batch is rolled back either way.
- **Missing row fails closed.** A wrong key, a primary key changed by the update, or an update that
  matched nothing (USING filter) all fire the guard. The API layer that wants 404 vs 403 must decide
  that before the write (it already reads the existing row for `prepareWrite(..., existing)`).

**Error expression.** Probed on local D1 (workerd, `D1_ERROR`), all raise and roll the batch back:

| Expression | D1 message |
| --- | --- |
| `json('x')` | `malformed JSON` |
| `abs(-9223372036854775808)` | `integer overflow` |
| `raise(ABORT, ...)` | rejected: only inside triggers |
| `load_extension(...)` | `not authorized` |
| `json_extract('{}', 'castra_write_check_failed')` | `bad JSON path: 'castra_write_check_failed'` |

`json_extract` with an invalid path is the only one whose message carries our own marker, so callers
can tell a policy violation from any other error without guessing. JSON1 is built into SQLite ≥ 3.38
and D1. `isWriteCheckError(err)` requires both `bad JSON path` and `'castra_write_check_failed'`
in the message (or a `cause`). A `custom()` predicate that deliberately raises the same error only
makes its own write fail closed.

**`checkRow` becomes a documented dry run** (MCP `check_access`, early pre-check), improved where cheap:
- C: on create, omitted columns take their literal snapshot default (NULL, quoted string, number,
  TRUE/FALSE, blob), typed as SQLite's parser types it and converted by the column affinity.
  Non-literal defaults (`CURRENT_TIMESTAMP`, `(expr)`) and omitted rowid columns stay NULL and the
  reason says `approximate dry run: ...`. Schema default text is never spliced into SQL (rule 5).
- B: integral JS numbers in (-2^63, 2^63) bind as `CAST(? AS INTEGER)` for INTEGER/NUMERIC columns.
- E: `TableSnapshot.strict?: true` (additive, from `pragma_table_list`); STRICT `ANY` values bind as-is.
- A, D: not modelled; A is flagged `approximate`, D (collation) is not visible to the engine at all.

**`prepareWrite` fails closed early on A**: a string that is not SQLite-numeric text for an
INTEGER/REAL/NUMERIC-affinity column is a 400, except declared types containing `DATE` or `TIME`
(SQLite date conventions store ISO-8601 text there; `DATETIME` has NUMERIC affinity). STRICT `ANY`
columns are exempt.

**STRICT (E).** Recorded in the snapshot because it was one extra `pragma_table_list(?)` query and an
optional field; omitted for ordinary tables so existing snapshots and drift checks do not change.

## Consequences
- The API layer's write path: create → `prepareWrite` → (optional `checkRow` pre-check) →
  `runGuardedWrite(env.DB, insert, writeGuard(t, "create", ctx, pk | "last_insert_rowid"))`.
  Update → `readFilter("update")` on the existing row → `prepareWrite(..., existing)` →
  `runGuardedWrite(env.DB, update.where(pk).where(filter), writeGuard(t, "update", ctx, newPk))`.
- Writes cost one extra statement in the same round trip.
- Triggers fire before the guard and are rolled back with it.
- `runGuardedWrite` takes the D1 binding directly (structural `D1DatabaseLike`), not a Kysely instance:
  kysely-d1 has no batch API.
- Tests: `guarded-write.d1.test.ts` (allow/deny for defaults, NOCASE, STRICT, affinity, update rollback,
  atomicity, non-guard errors, 300-run property against a JS oracle evaluated on the stored row) and the
  reviewer's `review2-affinity.d1.test.ts`, whose A/D blocks assert the guarded write.
