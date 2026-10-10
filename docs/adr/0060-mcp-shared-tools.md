# 0060. MCP tools are one definition over the REST pipeline

## Status
Accepted (2026-10-10).

## Context
Rule 7: MCP calls the same engine as REST, with no MCP-only data path. ARCHITECTURE §5 lists four v0.1 tools,
all read-only, served both locally (stdio) and remotely (`/mcp`).

## Decision
- `castraTools(options)` in `@castra/mcp` returns the four tools, each defined once: a zod input schema and a
  `run(args, access)` function. `createCastraMcpServer` registers them unchanged for both transports. The only
  thing that differs between transports is the `ToolAccess` object, which turns `as` into a `CastraContext`
  (ADR 0061).
- `query_data({path, query?, as?})` is GET only. It runs exactly what the REST router runs:
  1. the `engine.isOpen(table, "read")` check (404 before parsing, same order as the router)
  2. `parseRequest`
  3. `planRequest`
  4. `executePlan(db, plan)`

  It returns `{status, body}`. Errors go through `toProblem`, so the body equals the REST problem+json body.
  `examples/blog/test/mcp.test.ts` asserts identical status and body for 5 identities × 10 requests, plus the
  next cursor page.
- `explain_query` stops after `planRequest` and returns the plan JSON (ADR 0064).
- `check_access` is a dry run. It calls:
  - `engine.explain(readFilter)`, or `writeGuard(...).explanation` for create;
  - with a row: `prepareWrite` and `checkRow`.

  It never writes.
- `describe_schema` lists only tables with at least one open op. Columns hidden for everyone are left out.
  Each op shows its policy as `String(rule)` (or `null`), along with field rules and relations whose target is
  readable. Reserved tables (Better Auth, `_castra_*`) are never listed, because they can never be open
  (`isReservedTable` in the engine).
- Tool handlers catch their own errors and return `isError: true` with a problem body. The SDK would otherwise
  turn exceptions into free text.
- Core change: one export line in `packages/core/src/api/index.ts` (`notFound`). No policy or REST behaviour
  changed.

## Consequences
- A policy bug shows up identically in REST and MCP, and is fixed once.
- `query_data` does not get the REST router's `beforeRequest` hook. It is a per-app Hono concern that MCP does not
  run. Apps that rely on it for authorization would see different results. Policies must carry authorization.
