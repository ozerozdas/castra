# MCP

Four read-only tools: `describe_schema`, `check_access`, `explain_query`, `query_data`. They run on the same engine
and request pipeline as REST. There are no write or admin tools in v0.1.

- **Local, stdio:** `castra mcp` serves them against the **local** D1. It is a developer tool: `as` may impersonate any
  user (`{ userId, roles? }`), `"anonymous"`, or a hypothetical role set, with no token and no audit log. Never expose
  it over a network. Loading `castra.config.ts` needs Node >= 22.18 (or a `.js`/`.mjs` config, `--config`).
- **Remote, `POST /mcp` on the deployed Worker:** needs `Authorization: Bearer castra_mcp_...`.

  ```sh
  castra mcp token create --user <id> --scopes "schema:read data:read" [--name <n>] [--expires-in <days>] [--local|--remote]
  castra mcp token revoke <id> [--local|--remote]
  ```

  | Scope | Grants |
  | --- | --- |
  | `schema:read` | `describe_schema` |
  | `access:check` | `check_access`, `explain_query` |
  | `data:read` | `query_data` as the token's own user |
  | `data:read:any_user` | `as` another user or `"anonymous"` |

  `as` on `/mcp` is the token's user by default; `"anonymous"` or `{ userId }` of an existing user need
  `data:read:any_user`. Explicit roles are rejected: roles always come from `_castra_roles`. MCP tokens are accepted only
  on `/mcp`, and sessions or API keys are not. Every call writes a `_castra_audit` row. There is no rate limiting
  on `/mcp`: add a Cloudflare rate limiting rule in front of it.

Details: [ADR 0060](adr/0060-mcp-shared-tools.md), [0061](adr/0061-mcp-tokens-and-scopes.md),
[0062](adr/0062-mcp-remote-transport.md), [0063](adr/0063-mcp-audit-log.md),
[0065](adr/0065-castra-mcp-cli.md).
