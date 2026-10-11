# 0072. Rate-limit writes with the Workers Rate Limiting binding

## Status
Accepted (2026-10-11). Amends [ADR 0003](0003-rate-limiting-hook-only.md). Issue #6.

## Context
ADR 0003 left rate limiting to Cloudflare-side rules. WAF rate limiting rules only apply to traffic through a zone (a
custom domain), so the default `<name>.<subdomain>.workers.dev` deploy had no protection at all: sign-in, sign-up,
`/mcp` and every write could be called without limit.

## Decision
- `@castra-kit/core` exports `rateLimitWrites(getLimiter)`, a Hono middleware over the Workers Rate Limiting binding.
- It limits every request that is not `GET`, `HEAD` or `OPTIONS`: sign-in and sign-up, `/mcp`, and table writes.
  Reads are not limited; they are cheap to cache and the WAF covers them on a custom domain.
- The key is `<host>:<cf-connecting-ip>`, so several Castra apps can share one `namespace_id` without sharing counters.
- A request without `cf-connecting-ip` (only outside Cloudflare: unit tests, `app.request()`) or without the binding
  is not limited. Cloudflare always sets the header on real traffic and clients cannot override it.
- Over the limit: `429` problem `rate_limited` with `Retry-After`.
- The template and `examples/blog` declare `RATE_LIMITER` with 60 writes per 60 s per IP. The binding's counters are
  per Cloudflare location and approximate; this is abuse protection, not accounting.

## Consequences
- New projects are protected on `workers.dev` with no extra setup. Existing projects add the binding and one line.
- Read-heavy abuse is still the WAF's job; `docs/rate-limiting.md` has a rule for custom domains.
