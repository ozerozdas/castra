# 0010. Schema introspection: sources and mapping rules

## Status
Accepted (2026-10-10).

## Context
`SchemaSnapshot` (`packages/core/src/types.ts`) is built from SQLite metadata and drives the policy engine,
the REST generator and the generated Kysely types. The contract leaves a few mapping questions open
(PROGRESS.md "Open issues": `notNull` for `INTEGER PRIMARY KEY`). Verified against D1 (miniflare, 2026-10-10):
`PRAGMA table_list`, `table_info`, `table_xinfo`, `foreign_key_list`, `index_list`, `index_info`,
`index_xinfo`, `foreign_keys` and `SELECT ... FROM pragma_table_info(?)` work; `PRAGMA user_version`,
`schema_version` and `compile_options` are rejected with `SQLITE_AUTH`; creating `_cf_*` tables is rejected.

## Decision
`introspect(query)` uses only `sqlite_master`, `PRAGMA table_info`, `foreign_key_list`, `index_list` and
`index_info`, with identifiers double-quoted and escaped. The contract is unchanged. Rules:

- **Excluded tables:** `sqlite_*`, `_cf_*`, `d1_migrations`. Views are not tables and are skipped.
- **Kept tables:** Better Auth and `_castra_*` tables stay in the snapshot so it is complete. The policy engine
  refuses to expose them (default closed); the snapshot does not mark them.
- **`notNull`:** `PRAGMA table_info` value, except a single-column `INTEGER PRIMARY KEY` (rowid alias) is
  reported `true`: SQLite reports `notnull = 0` for it, but it can never read back as NULL. Other primary key
  columns follow `table_info`.
- **Foreign keys:** one entry per column pair. An omitted parent column (`REFERENCES parent`) is resolved to the
  parent's primary key column at the same position. Sorted by (column, table, referenced column).
- **Indexes:** `UNIQUE` constraint indexes (`origin = u`, named `sqlite_autoindex_*`) are included because they
  carry uniqueness. Primary-key indexes are omitted (covered by `primaryKey`). Partial and expression indexes
  are omitted: the contract cannot express their predicate, and listing a partial unique index would overstate
  uniqueness. Sorted by name.
- **Affinity:** SQLite section 3.1 rules, in order (INT, CHAR/CLOB/TEXT, BLOB or empty, REAL/FLOA/DOUB, else NUMERIC).
- **Determinism:** tables sorted by name, columns in `cid` order. `generatedAt` is the only volatile field;
  `diffSnapshots` ignores it and `castra generate` keeps the committed value when nothing else changed.
- **Kysely types:** INTEGER/REAL/NUMERIC -> `number`, TEXT -> `string`, BLOB -> `ArrayBuffer`, `| null` when not
  `NOT NULL`, `Generated<T>` when the column has a default or is a rowid alias.

## Consequences
- Generated types treat `NUMERIC` as `number`; values such as dates stored in NUMERIC columns need app-level care.
- Tables created by the Cloudflare runtime outside the filters above would appear in the snapshot; extend
  `isInternalTable` if D1 adds new internals.
- Partial/expression indexes are invisible to the snapshot; if the planner or OpenAPI needs them later, extend the
  contract in an ADR.
