# 0078. A separate rate-limit bucket for auth, and an optional per-user key

## Status
Accepted (2026-10-12). Amends [ADR 0072](0072-rate-limit-binding.md). Issue #18.

## Context
ADR 0072 limits every write per client IP with one bucket (60/min). Sign-in and sign-up share it with table writes,
which is loose for password guessing. Keying only by IP also makes users behind one NAT share a budget, and MCP write
tools (#10) will want a limit per token.

## Decision
- **Auth bucket.** `createCastraApp` limits writes under the auth base path (`/api/auth/*`) with a second binding,
  `AUTH_RATE_LIMITER`, keyed by IP. The template and `examples/blog` declare it at 10 writes per 60 s. Auth writes
  still count against `RATE_LIMITER` too. A missing `AUTH_RATE_LIMITER` logs one warning, like `RATE_LIMITER`.
- **Optional key.** `rateLimitWrites` takes `{ key }`. When it returns a string, the key is `<host>:id:<value>`,
  otherwise `<host>:<ip>` as before; the `id:` prefix keeps the two apart.
  `createCastraApp({ rateLimit: { key } })` moves the general write limit to after the request context, so `key` can
  read `c.get("ctx")` (for example the user id). `/mcp` and the auth routes stay keyed by IP: they answer before the
  context is resolved, and sign-in has no user yet.
- Without `key` the general limit stays the first middleware, as in ADR 0072, so unauthenticated floods are refused
  before a session lookup.
- `rateLimitWrites(getLimiter, 60)` still works; the second argument is now a number or an options object.

## Consequences
- New projects have a tighter limit on sign-in and sign-up with no extra setup. Existing projects add one
  `ratelimits` entry; until then the Worker logs a warning and auth writes only pass the general bucket.
- With `key`, every table write resolves the session before it is limited (one D1 read for session requests).
- Per-token limits for MCP write tools are left to #10, which can pass its own `key`.
