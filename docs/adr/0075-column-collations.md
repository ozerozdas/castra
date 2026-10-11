# 0075. Column collations in the snapshot

## Status
Accepted (2026-10-11). Amends [ADR 0050](0050-checks-via-guarded-batch.md) for the dry run. Issue #9.

## Context
The dry run (`checkRow`, MCP `check_access`) evaluates a rule against a candidate row built from bound values. A bound
value has no collation, so it compared with BINARY while the real table compared a `COLLATE NOCASE` or `COLLATE RTRIM`
column without case or trailing spaces. The guarded write was always exact; the dry run could answer the opposite.
Read filters and guards run on real columns and were never affected.

## Decision
- `ColumnSnapshot.collation` is `"NOCASE"` or `"RTRIM"` when declared, and absent for BINARY. Existing snapshots stay
  valid and unchanged.
- No pragma reports a column's collation, and parsing `CREATE TABLE` text is fragile. Introspection asks SQLite: a
  compound SELECT takes each column's collation from its leftmost SELECT, so
  `SELECT x = 'A', x = 'a ' FROM (SELECT "col" AS x FROM "t" WHERE 0 UNION ALL SELECT 'a')` reveals NOCASE (first is
  1) or RTRIM (second is 1). One query per table, no table rows read. Identifiers come from `pragma_table_info` and
  are quoted.
- `checkRow` writes each candidate cell as `<value> COLLATE <name> AS "<column>"`. The collation keyword comes from a
  fixed map, never from snapshot text (rule 5).
- Schema drift reports a collation change. `describe_schema` includes `collation` when present.

## Consequences
- Apps get it after `castra generate` refreshes `castra/schema.json`. Until then the snapshot has no collations and
  the dry run behaves as before.
- Custom collations are not available on D1, so only the two built-in ones are modelled.
