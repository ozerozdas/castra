# 0003. Rate limiting: hook point only

## Status
Accepted (2026-10-10)

## Context
Abuse protection matters, but Cloudflare already offers rate limiting at the edge (WAF rules, the Workers
rate limiting binding), and a built-in limiter would grow scope before the policy engine is proven.

## Decision
v0.1 does not implement rate limiting. The REST router and MCP route expose a single middleware hook
point where a limiter can be installed. KV is reserved for caching and rate-limit counters later.

## Consequences
- Deployments should configure Cloudflare-side rate limiting; the README must say so.
- No behaviour to test or secure in v0.1 beyond the hook existing.
