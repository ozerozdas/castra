# 0063. MCP audit log is fail-closed

## Status
Accepted (2026-10-10).

## Context
ARCHITECTURE §5: every remote call is written to `_castra_audit`. An audit log that can be skipped by an error
path is not an audit log.

## Decision
- **Table `_castra_audit`:**

  | Column | Notes |
  | --- | --- |
  | `id` | |
  | `at` | |
  | `token_id` | no FKs, so rows outlive tokens and users |
  | `user_id` | |
  | `tool` | |
  | `arguments` | JSON |
  | `outcome` | |
  | `status` | |

  Indexes on `at` and `token_id`.
- **One row per JSON-RPC message:**
  - `tool` is `params.name` for `tools/call`, otherwise the method.
  - `outcome` is one of `ok`, `error`, `denied` (missing scope), `invalid` (arguments rejected), `rejected`
    (405/413/bad JSON/too many messages), or `unauthorized:<reason>`.
  - `status` is the HTTP-like status of the tool result.
- **Auth failures** are audited when the token id is known, meaning a row with that id exists (revoked, expired,
  wrong secret). Unknown or malformed tokens have no id and are not written. This keeps unauthenticated callers
  from filling the table.
- **Write timing and failure:**
  - The audit insert runs in `finally` after the MCP response is computed: one multi-row INSERT of up to
    12 rows per statement.
  - If it throws, the client gets a 500 `audit_failed` problem instead of the computed response. A call that
    cannot be audited returns no data.
- **Truncation:** `arguments` is capped at 4096 characters. Larger values are replaced by
  `{"truncated":true,"length":n,"prefix":"..."}`, which is still valid JSON.

## Consequences
- An audit outage makes `/mcp` unavailable rather than unaudited.
- The local stdio server writes no audit rows. It is a developer tool on the developer's own local database.
- No retention policy yet; operators prune `_castra_audit` by `at`.

## Amendment (2026-10-11): per-message outcome and real status
Review 4 found three ways the audited outcome could differ from what happened. Each row now gets its own outcome:

| Case | `outcome` | `status` |
| --- | --- | --- |
| The tool ran | the tool's outcome (`ok`, `error`, `denied`) | the tool's status |
| Batch with duplicate ids (ADR 0062) | `rejected` for every message | 400 |
| The transport refused the request, such as 406 `Accept` or 415 `Content-Type` | `rejected`, or `invalid` for a 400 | the real HTTP status |
| `tools/call` whose tool never ran (unknown tool, invalid arguments, notification) | `invalid` | 400 |
| Other method whose JSON-RPC response has an `error` member | `error` | 404 for `-32601`, 400 for `-32700`/`-32600`/`-32602`, else 500 |
| Other method that succeeded | `ok` | 200 |

A 413 from the `Content-Length` check is one `rejected` row, like any other request refused before parsing.
