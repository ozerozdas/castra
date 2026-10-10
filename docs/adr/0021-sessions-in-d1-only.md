# 0021. Sessions are validated against D1 on every request

## Status
Accepted (2026-10-10).

## Context
ARCHITECTURE §9: KV is eventually consistent, so a revoked session could keep working if KV were the
session store. Better Auth can keep sessions in `secondaryStorage` (KV) and can cache them in a signed
cookie (`session.cookieCache`), both of which delay revocation.

## Decision
- No `secondaryStorage` is configured. Sessions live only in the D1 `session` table.
- `session.cookieCache.enabled` is explicitly `false`, and `resolveContext` calls
  `auth.api.getSession({ headers, query: { disableCookieCache: true } })` anyway.
- A session that is missing, deleted or past `expiresAt` resolves to the anonymous context. Roles are
  read from `_castra_roles` on every request.

## Consequences
- One D1 read for the session plus one for roles per authenticated request. Acceptable for v0.1; a
  KV cache can be added later only with invalidation on revoke and a short TTL (new ADR).
- Revocation (sign-out, `revoke-session`, deleting the row) takes effect on the next request. Tested.
