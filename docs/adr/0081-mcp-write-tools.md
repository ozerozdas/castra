# 0081. MCP write tools on the REST write path

## Status
Accepted (2026-10-12). Issue #10. Changes ARCHITECTURE §5 ("write tools are local only") and ADR 0061 (scopes).

## Context
v0.2 lets agents write. The REST API already enforces create/update/delete policies, field rules (`setBy:
"server"`, readonly), the atomic write guard (ADR 0050) and `ON CONFLICT REPLACE` refusals. A separate MCP write path
would have to repeat all of it (CLAUDE.md rule 7).

## Decision
- **Three tools**, shared by stdio and `/mcp` like the read tools:
  - `create_data { path: "/api/<table>", body }` = `POST`;
  - `update_data { path: "/api/<table>/<id>", body }` = `PATCH`;
  - `delete_data { path: "/api/<table>/<id>" }` = `DELETE`.

  Each runs `parseRequest → planRequest → executePlan` with the D1 binding, exactly as the REST router, and returns
  `{ status, body }` as REST would. A path whose shape does not match the tool (e.g. an id on create) is a 404.
  Arguments mirror `explain_query`, so an agent can explain a write and then run it with the same arguments.
- **Local stdio:** any identity via `as`, as for reads (trusted operator, local D1 only).
- **Remote `/mcp`:** new scope **`data:write`** for all three. Writes run **only as the token's own user**: any
  other `as` (another user, `"anonymous"`, roles) is a 403 `write_as_other_user`, and no scope lifts that.
  `data:read:any_user` stays read-only.
- **Audit:** a remote write stores an `attempt` row (tool, arguments, status 0) **before** it touches data. If that
  insert fails, the write does not run. The usual row with the outcome and status follows in `finally`. Reads keep
  one row per call.
- MCP annotations: the write tools are not read-only; `update_data` and `delete_data` are destructive and idempotent.

## Consequences
- An agent cannot do anything over MCP that the token's user cannot do over REST with a session or API key.
- Arguments, including written values, are stored in `_castra_audit` (truncated at 4096 characters). Do not write
  secrets through MCP; prune the audit log as before.
- D1 has no interactive transactions, so a write that succeeded is not undone when the final audit row fails; the
  `attempt` row records it. The client gets 500 `audit_failed` in that case.
- No bulk writes (ARCHITECTURE §8). `generate_migration` / `apply_migration` remain separate.
