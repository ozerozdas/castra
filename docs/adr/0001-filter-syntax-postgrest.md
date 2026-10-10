# 0001. PostgREST-style filter syntax

## Status
Accepted (2026-10-10)

## Context
List endpoints need a query-string filter language. It must be easy for humans and AI agents to write,
map cleanly onto Kysely expressions, and be restrictable to an allow-list of columns.

## Decision
Use PostgREST style: `?status=eq.draft&created_at=gte.2026-01-01`. Operators in v0.1:
`eq neq gt gte lt lte in like is`. Filterable columns can be allow-listed per table in config.
Column names are validated against the schema snapshot; values are always bound parameters.

## Consequences
- Familiar to many developers; models already know the syntax.
- No nested boolean grouping (`or`/`and`) in v0.1; add by ADR if needed.
- The parser must reject unknown columns and operators with `application/problem+json`.
