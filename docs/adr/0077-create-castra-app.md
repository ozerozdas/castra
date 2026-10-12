# 0077. `createCastraApp`: the Worker wiring ships in a package

## Status
Accepted (2026-10-12). Issue #19 (part 1). Changes ARCHITECTURE §2 (a package above core, auth and mcp).

## Context
The template's `src/index.ts` was about 90 lines, almost all of it Castra wiring: problem handlers, the rate limiter,
`/health`, the `/mcp` route, Better Auth, the request context, `/me` and the REST router. The user owns that file, so
a package bump never updates it. Upgrading 0.1.0 → 0.1.2 meant hand-editing it (ADR 0072's middleware), and skipping
the edit failed silently: without the binding or the middleware, writes were simply not limited.

## Decision
- New package **`@castra-kit/app`** exports `createCastraApp({ config, snapshot, ... })`, which returns the Hono app
  with the wiring above, in this order:
  1. problem+json handlers;
  2. `before(app)` hook (CORS, logging);
  3. `rateLimitWrites` over `RATE_LIMITER` (`rateLimit: false` turns it off);
  4. `GET /health`;
  5. `/mcp` (`mcp: false` turns it off); mounted before the session middleware, as before;
  6. Better Auth under `/api/auth/*`, then `castraContext`;
  7. `GET /me`;
  8. `routes(app)` hook: custom routes, with `c.get("ctx")` set;
  9. the REST router (`/`, `/openapi.json`, `/api/<table>`).
- A separate package because the wiring depends on core, auth and mcp, and none of those should depend on the others
  above it. It re-exports the types an app's `Env` needs (`CastraBindings`, `CastraAppEnv`, `RateLimiterLike`).
- Binding names are fixed (`DB`, `RATE_LIMITER`), as the CLI and docs already assume.
- The template's and `examples/blog`'s `src/index.ts` shrink to `createCastraApp(...)` plus app-specific code. Future
  middleware ships with a package bump; the hooks are the opt-out and reorder points.
- `rateLimitWrites` logs one warning per isolate when a request from Cloudflare (`cf-connecting-ip` set) arrives and
  there is no binding, so a missing `ratelimits` entry is visible in `wrangler tail`.

## Consequences
- One more package to publish; projects depend on `@castra-kit/app` (plus `@castra-kit/cli`). The lower-level
  packages stay public for apps that want to wire things themselves.
- Upgrading an existing project to the release with this change is one last manual edit of `src/index.ts`, described
  in that release's upgrade note.
- `castra doctor` checks for bindings and versions (#19 part 2) are separate.
