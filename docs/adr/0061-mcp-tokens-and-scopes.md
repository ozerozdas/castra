# 0061. Remote MCP tokens, scopes and `as`

## Status
Accepted (2026-10-10). Refines ARCHITECTURE §5 "Remote".

## Context
`/mcp` must authenticate machine clients with credentials that are separate from sessions and API keys, can be
narrowed, and can never grant admin or writes.

## Decision
- **Table `_castra_mcp_tokens`** (`examples/blog/migrations/0003_mcp.sql`):

  | Column | Notes |
  | --- | --- |
  | `id` | |
  | `user_id` | FK `user`, ON DELETE CASCADE |
  | `name` | |
  | `token_hash` | SHA-256 hex, UNIQUE |
  | `scopes` | space-separated |
  | `created_at` | |
  | `expires_at` | |
  | `revoked_at` | |

- **Token format:** `castra_mcp_<16 hex id>_<43 base64url secret>` (32 random bytes). Only the hash is stored.
- **Verification** (`verifyMcpToken`):
  - Parse the token, look up the row by id, hash the token, and compare with `timingSafeEqual`.
  - The comparison also runs when no row matches, against a dummy hash.
  - Revoked, expired, unknown, malformed, or stored-scope-invalid tokens fail.
  - Every failure is a 401 problem with `WWW-Authenticate: Bearer`.
- **Credentials are separated by prefix:**
  - `/mcp` accepts only MCP tokens. `castra_ak_` API keys and session bearers get 401, because `/mcp` is
    mounted before the session/API-key middleware.
  - On REST, an MCP token is not a credential: it resolves to anonymous.
- **Scopes:**

  | Scope | Grants |
  | --- | --- |
  | `schema:read` | `describe_schema` |
  | `access:check` | `check_access`, `explain_query` |
  | `data:read` | `query_data` as the token's own user |
  | `data:read:any_user` | `as` another identity, in addition to the tool's own scope |

  No scope grants admin or writes. A tool outside the token's scopes returns a 403 problem with
  `detail: "missing scope: <scope>"` and a `scope` field.
- **`as` on remote:**
  - Omitted, or `{userId: <token user>}`, means the token's user with roles read from `_castra_roles` at call
    time. Revoking a role takes effect on the next call.
  - Anything else needs `data:read:any_user`. This includes `"anonymous"`, another user id, and explicit roles.
  - The rule also applies to `check_access` and `explain_query`. Evaluating as another user id reveals that
    user's roles through the decision.
  - `describe_schema` ignores identity.
- **Local stdio has no tokens.** `as` may be any user id, `"anonymous"`, or `{roles: [...]}`; roles are checked
  against `config.roles`. This is documented in `castra mcp --help` and the `serveStdio` TSDoc.
- **Management:**
  - Library: `createMcpToken`, `revokeMcpToken`, and the compiled `insertMcpTokenQuery` / `revokeMcpTokenQuery`.
  - CLI: `castra mcp token create|revoke [--local|--remote]`.

## Consequences
- Tokens are bound to a user, so deleting the user deletes their tokens.
- Scope strings are validated both on create and on every read. A hand-edited row with an unknown scope fails
  closed.
