# Auth

- **Better Auth** 1.7.7 on D1: email + password, and GitHub when both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are
  set. Endpoints are under `/api/auth/*` (for example `POST /api/auth/sign-up/email`, `/sign-in/email`). The `bearer`
  plugin returns the session token in the `set-auth-token` header. A `GET /me` route shows the resolved context.
- **Sessions are checked against D1 on every request.** There is no KV or cookie cache, so a signed-out, deleted or
  expired session is anonymous on the next request ([ADR 0021](adr/0021-sessions-in-d1-only.md)).
- **Roles** live in `_castra_roles (user_id, role)` and are re-read on every request. There is no CLI or HTTP endpoint
  to grant them in v0.1: call `assignRole(env.DB, userId, role, config.roles)` from `@castra-kit/auth`, or insert rows with
  `wrangler d1 execute`.
- **API keys** (`castra_ak_...`) act as a user with a subset of that user's roles, are stored as SHA-256 hashes, and are
  sent as `x-api-key` or `Authorization: Bearer`. Create and revoke them with `createApiKey` / `revokeApiKey` from
  `@castra-kit/auth`; there is no CLI or HTTP endpoint yet ([ADR 0022](adr/0022-own-api-keys-table.md)). A presented but
  invalid key is anonymous, never a fallback to a cookie.
- A `users` table mirrors `id`, `email`, `name` from Better Auth so app tables can reference it with foreign keys
  ([ADR 0023](adr/0023-users-profile-mirror.md)).
