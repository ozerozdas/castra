# 0043. Writes: guarded batch, server keys, references, response body

## Status
Accepted (2026-10-10). Builds on ADR 0007 and uses ADR 0050.

## Context
ADR 0007 made `checkRow` the WITH CHECK. The M1 re-review found that simulating storage in a derived table misses
column DEFAULTs, `COLLATE NOCASE`, `STRICT`/`ANY` and other affinity edge cases. D1 has no interactive
transactions, but `batch()` runs its statements in one transaction and rolls all of them back if one fails.

## Decision
- **Atomic batch.** Creates and updates run through `runGuardedWrite(env.DB, write, guard)` (ADR 0050): one
  `batch()` of [write, `engine.writeGuard(table, op, ctx, target)`]. The guard checks the *stored* row under the
  op's rule and raises, rolling the write back; that is 403 `write_check_failed` (its explanation is never sent).
  `target` is the full key after the write, or `"last_insert_rowid"` for rowid tables (the INSERT `RETURNING`s the
  key). The row is then re-read under the read policy, outside the batch.
- **404 vs 403 before the write.** Update loads the row under the update filter first; no row is 404. A guard miss
  is always 403.
- **Fail closed.** Without a D1 binding (`getD1` / `executePlan(…, { d1 })`) creates and updates return 500
  `write_unavailable` and nothing is written. Policy rejections that happen earlier (prepareWrite spoofing,
  `checkRow` pre-check) still answer 401/403/400.
- **Pre-checks for clean errors** (no write yet): `prepareWrite` (rejects, never strips; owner spoofing 403),
  Zod types, then `checkRow` on the input merged with evaluable defaults (literals, `CURRENT_*`,
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; other expressions are NULL in the candidate). Only the guard is authoritative.
- **Update** loads the row under the update filter (404 if none), runs `prepareWrite(..., existing)`, pre-checks the
  merged row, and the UPDATE repeats the update filter (USING). 0 changed rows → 409 (row changed concurrently).
- **Primary keys:** single-column TEXT PK → `crypto.randomUUID()` on the server; a client-supplied value is 400.
  `INTEGER PRIMARY KEY` (rowid) → assigned by SQLite, guard and re-read use `last_insert_rowid()` inside the batch.
  Other single-column PKs are client-supplied. Create on a table without a single-column PK is 404 (the guard needs it).
- **References:** for each FK in the written values whose target table has an open `read`, the referenced row must be
  readable by the caller (else 400 `references a row that does not exist`, same as a missing row). This stops writes
  from attaching data to, or probing the existence of, rows the caller cannot see. Targets without a read policy
  are left to the database FK (then a generic 409).
- **Response:** 201/200 with the row re-read under the *read* policy and projected; if the caller cannot read it
  (or the table has no read policy), only `{ <pk>: value }`. Delete: `DELETE … WHERE pk AND <delete filter>`,
  204 if a row was deleted, else 404.

## Consequences
- The re-read is a separate statement: a concurrent change between batch and re-read is visible in the response.
- The reference check and the pre-check run outside the batch (TOCTOU for rules that read other tables). The guard
  closes this for the row itself; reference readability is best effort.
- D1 statements are limited to 100 bound parameters; wide tables with large rules can hit it.
