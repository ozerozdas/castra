# MCP

Read tools: `describe_schema`, `check_access`, `explain_query`, `query_data`. Write tools: `create_data`,
`update_data`, `delete_data` (`{ path, body }`, the same arguments as `explain_query` for `POST` / `PATCH` /
`DELETE`; [ADR 0081](adr/0081-mcp-write-tools.md)). All run on the same engine and request pipeline as REST, so
policies, field rules and the write guard apply unchanged. There are no admin tools.

- **Local, stdio:** `castra mcp` serves them against the **local** D1. It is a developer tool: `as` may impersonate any
  user (`{ userId, roles? }`), `"anonymous"`, or a hypothetical role set, with no token and no audit log. Never expose
  it over a network. Loading `castra.config.ts` needs Node >= 22.18 (or a `.js`/`.mjs` config, `--config`).
  It also serves **`deploy_status`**, which runs the `castra doctor` checks (token permissions, bindings, package
  versions, schema drift; `remote: true` compares with the deployed D1) and returns one row per check with a fix
  ([ADR 0079](adr/0079-deploy-status-and-doctor-checks.md)). It uses `CLOUDFLARE_API_TOKEN` if set.
  And **`propose_policy`** `{ table, op, rule }`: returns a unified diff of `castra.config.ts` that sets the rule
  (`isPublic()`, `authenticated()`, `role(...)`, `owner(...)`, `.and()`, `.or()`) or removes it (`rule: null`). The rule
  is parsed, never evaluated, and checked against the current roles and schema. Nothing is applied: the file and the
  running policy stay as they are until you apply the diff and add tests ([ADR 0082](adr/0082-propose-policy.md)).
- **Remote, `POST /mcp` on the deployed Worker:** needs `Authorization: Bearer castra_mcp_...`.

  ```sh
  castra mcp token create --user <id> --scopes "schema:read data:read" [--name <n>] [--expires-in <days>] [--local|--remote]
  castra mcp token revoke <id> [--local|--remote]
  castra mcp audit prune --older-than <days> [--local|--remote]
  ```

  | Scope | Grants |
  | --- | --- |
  | `schema:read` | `describe_schema` |
  | `access:check` | `check_access`, `explain_query` |
  | `data:read` | `query_data` as the token's own user |
  | `data:read:any_user` | `as` another user or `"anonymous"` (reads only) |
  | `data:write` | `create_data`, `update_data`, `delete_data`, only as the token's own user |

  `as` on `/mcp` is the token's user by default; `"anonymous"` or `{ userId }` of an existing user need
  `data:read:any_user`. Explicit roles are rejected: roles always come from `_castra_roles`. MCP tokens are accepted only
  on `/mcp`, and sessions or API keys are not. Writes never take another `as` (403 `write_as_other_user`). Every call
  writes a `_castra_audit` row; a write also writes an `attempt` row first and does not run if that fails. Written
  values are part of the stored arguments. Nothing deletes them
  automatically; prune old rows with `castra mcp audit prune --older-than <days> [--local|--remote]`
  ([ADR 0070](adr/0070-audit-prune-command.md)), or call `pruneAuditQuery` from a Cron Trigger. `/mcp` calls count
  against the per-IP write limit ([rate limiting](rate-limiting.md)).

Details: [ADR 0060](adr/0060-mcp-shared-tools.md), [0061](adr/0061-mcp-tokens-and-scopes.md),
[0062](adr/0062-mcp-remote-transport.md), [0063](adr/0063-mcp-audit-log.md),
[0065](adr/0065-castra-mcp-cli.md).
