# 0006. The `self` pseudo-role

## Status
Accepted (2026-10-10)

## Context
`visibleTo: ["self", "admin"]` (ARCHITECTURE §7) needs a rule for which column identifies "the caller's
own row". Guessing wrong leaks fields, so the default must be conservative.

## Decision
`self` matches a row when `row[selfColumn]` is non-null and strictly equals `ctx.user.id`. `selfColumn` is:
1. `tables.<t>.selfColumn` when set (must exist in the snapshot);
2. otherwise `"id"` for a table named `users` (if it has an `id` column);
3. otherwise the single `owner()` column used in the table's `read` rule, if there is exactly one;
4. otherwise undefined, and `self` never matches (closed).

`"self"` cannot be declared as a role. `projectRow` fails closed when the self column is absent from the row.
Explanations list self-dependent fields in `conditionalFields` rather than `hiddenFields`.

## Consequences
- Tables whose identity column is not obvious must set `selfColumn` explicitly to use `self`.
- The API layer must select the self column whenever it selects a `visibleTo: ["self"]` field.
