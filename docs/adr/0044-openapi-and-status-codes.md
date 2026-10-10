# 0044. OpenAPI document and status codes

## Status
Accepted (2026-10-10).

## Context
ARCHITECTURE §4: OpenAPI 3.1 from schema + policies listing only open operations, at `/openapi.json`.

## Decision
- `generateOpenApi({ config, snapshot })` is static per config: it lists exactly the table × operation pairs with a
  rule (item routes only for single-column PKs), identical for every caller. Validated in tests with
  `@readme/openapi-parser` (OpenAPI 3.1 schema + extra checks).
- Read schemas omit `hidden` columns; `visibleTo` columns are optional properties with a note. Includable relations
  are optional properties (`oneOf [ref, null]` / array). Create/Update schemas omit hidden, readonly, server-set
  (incl. owner) and generated key columns, `additionalProperties: false`.
- List documents filter parameters (filterable, non-hidden, non-BLOB columns), `sort`, `limit` (max = `maxLimit`),
  `cursor`, `offset`, `count`, and `include` as a comma-separated array whose enum lists only includable relations.
- Status codes: 200/201/204; 400 validation; 401 anonymous and 403 authenticated when the op's rule is constant
  false for the caller, and for spoofing / write-check failures; 404 unknown/closed/no row; 409 constraint or
  concurrent change; 413 body > 1 MiB; 415 non-JSON body; 500 generic.

## Consequences
- Role-dependent details (e.g. a column filterable only for admins) are described in prose, not in the schema.
