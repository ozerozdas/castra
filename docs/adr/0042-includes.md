# 0042. One-level includes derived from foreign keys

## Status
Accepted (2026-10-10).

## Context
ARCHITECTURE §4: `?include=author,comments`, derived from FKs, one level, batched with `IN`, each included table
under its own `read` policy (CLAUDE.md rule 4). Naming, ambiguity, caps and the leak surface were open.

## Decision
- **Names:** many-to-one from an FK column `<name>_id` on the base table → `<name>` (`posts.author_id` → `author`).
  One-to-many from a table `T` with exactly one FK column to the base table → `T` (`posts` ← `comments`). FK columns
  without the `_id` suffix, tables with several FKs to the base, and names that collide with a base column or with
  each other are not includable. Only configured tables are candidates.
- **Policy:** the included table must have an open `read` (else 400 — never silently empty); rows load in one
  query per include under `readFilter(target, "read", ctx)` and pass through `projectRow(target)`. A many-to-one
  target the caller cannot read appears as `null` (indistinguishable from a dangling key).
- **Join columns:** both join columns must be visible to the caller on every row (not hidden, not `visibleTo`-gated
  for them; `self` does not count); otherwise 400. Attaching rows by a column the caller cannot see would reveal it.
- **Unknown and refused includes** use the same 400 message (`include "x" is not available`).
- **Batching:** the parent keys are bound as one JSON array parameter (`col IN (SELECT value FROM json_each(?))`),
  so a page of 100 parents never exceeds D1's 100-parameter limit.
- **Cap:** one-to-many loads at most 25 children per parent (`row_number() OVER (PARTITION BY fk ORDER BY pk)`),
  so a page returns at most `limit × 25` children per include. Truncation is not signalled in v0.1; clients that
  need every child list the child table with a filter.

## Consequences
- `audit_logs` (no policy, no FK) can never be included; Better Auth tables are never configured, so never targets.
- Multi-level include stays v0.3 (ARCHITECTURE §8).
