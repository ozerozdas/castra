# 0005. Policy compilation: partial evaluation, qualified owner columns, anonymous roles

## Status
Accepted (2026-10-10)

## Context
ARCHITECTURE §3 requires rules to compile to SQL with the user context and never post-filter rows.
Several details were left open: how context-only rules appear in SQL, how columns are referenced so
filters survive joins, what an anonymous context carrying roles means, and how to spell "deny all".

## Decision
- Rules are partially evaluated against `ctx`. `isPublic()` → true; `authenticated()` → true iff
  `ctx.user` has a non-empty string id; `role(...)` → true iff authenticated AND `ctx.roles` intersects.
  `owner(col)`, `where(...)` and `custom(...)` stay as SQL. `and`/`or` are constant-folded.
- **Anonymous callers never hold roles.** A context with `user: null` and `roles: ["admin"]` is treated as
  having no roles, in `role()` and in `visibleTo`. Malformed contexts fail closed.
- `owner(col)` compiles to `"<table>"."<col>" = ?` (qualified with the base table name, user id bound as a
  parameter). The API layer must address the base table by its own name, never an alias, when it applies
  a filter. `where`/`custom` predicates are developer code and reference columns however they choose.
- A constant result compiles to `1 = 1` / `1 = 0`. A fully-false rule keeps the operation open
  (`isOpen` is about routes, not identities) but `explanation.allowed` is `false`.
- `readFilter` on a closed operation throws `PolicyError` 404. `prepareWrite` throws 401 (anonymous) or
  403 (authenticated) when the op's rule is constant-false for the caller.
- Identifiers: every column named in `owner()`, `fields`, `filterable` and `selfColumn` must exist in the
  snapshot or `createPolicyEngine` throws. `where`/`custom` predicates are built once with a probe
  context and their operation tree is walked; unknown tables/columns throw. This is best effort: raw
  `sql` fragments cannot be inspected.
- Configured tables missing from the snapshot are closed (not an error), matching `isOpen`.
- Reserved tables (Better Auth `user`/`session`/`account`/`verification`, `_castra_*`, `sqlite_*`, `_cf_*`)
  are compared case-insensitively because SQLite identifiers are case-insensitive.

## Consequences
- Explanations show a readable residual rule per context, e.g. anonymous → `where`, user → `or(where, owner(author_id))`.
- `where`/`custom` predicates run once at engine creation; one that throws for the probe context is a config error.
- Property tests compare the compiled SQL against a JS oracle with the same semantics (ADR 0008).
