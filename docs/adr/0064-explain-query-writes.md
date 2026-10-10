# 0064. `explain_query` explains writes but never executes

## Status
Accepted (2026-10-10).

## Context
`explain_query({method, path, query?, body?, as?})` maps a REST request to its SQL and the policies applied.
Agents most need this for writes (what would this PATCH check?). But the MCP layer in v0.1 is read-only.

## Decision
- **All REST methods are accepted:** GET, POST, PATCH and DELETE.
- **The pipeline stops at `planRequest`:**
  - The method must map to an op that is open for the table (`isOpen`), otherwise 404, same as REST.
  - Then `parseRequest` and `planRequest`, which only compiles.
  - The result is `{as, executed: false, plan}`. For writes, the plan holds the compiled statements and the
    guard SQL (ADR 0050) with their explanations.
  - `executePlan` is never called and no D1 batch is built.
- **Scopes:** it needs `access:check`, never `data:read`. Explaining a write as another identity follows
  ADR 0061.

## Consequences
- Tests assert that row counts and the targeted row are unchanged after explaining POST, PATCH and DELETE. This
  holds both in the package (in-memory server) and on the blog Worker (`/mcp`).
- Write explanations reveal compiled SQL and bound values from the caller's own body. They reveal no other
  rows' data, because nothing runs.
