# 0074. Marking truncated includes

## Status
Accepted (2026-10-11). Amends [ADR 0042](0042-includes.md). Issue #8.

## Context
A one-to-many include returns at most 25 rows per parent (`INCLUDE_MANY_PER_PARENT`). The response did not say when
rows were cut, so a client could not tell 25 children from 250.

## Decision
- The include query fetches 26 rows per parent under the child table's own `read` policy. Only 25 are returned.
- When a parent had 26, its row gets `"$truncated": ["<include name>", ...]`. The key is absent otherwise.
- The marker lives on the parent row, so it works the same for `GET /api/<table>/<id>` (the body is the row) and for
  each row of a list. The envelope does not change.
- `$truncated` cannot be an unquoted SQLite identifier, so it does not collide with real columns in practice.
- OpenAPI lists `$truncated` on the read schema of every table with a one-to-many include, with the include names as
  an `enum`.
- The cap stays fixed. A client that needs every child lists the child table with a filter and pagination
  (`GET /api/comments?post_id=eq.<id>`, with `post_id` in `filterable`).

## Consequences
- Counting rows the caller cannot read is impossible by construction: the extra row comes from the same filtered query.
- A client that does strict schema validation sees one new optional property.
