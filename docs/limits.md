# Status and limits

## What works and what does not

Current release: **v0.4.0**. Local MCP migration tools for `castra mcp` ship with ADR 0086, on top of the
v0.3.0 audit hardening (ADR 0084) and safe Worker rollback (ADR 0085). The consumer production API still runs 0.2.1. Locally tested: policy engine, REST, OpenAPI, Better Auth, roles, API keys,
MCP reads and writes (stdio and `/mcp`), schema generation, migration create/apply/status, scaffolding,
`createCastraApp`, doctor checks, destroy, local `propose_policy` and `deploy_status`, and upgrades.
The current CI runs lint, build, typecheck, tests, policy tests, generated upgrade-note checks and an upgrade test.
The full scaffolder end-to-end suite remains opt-in.

Verified on a real account (2026-10-11): scaffolded deployment, D1 + KV provisioning, remote migrations,
secret setup and live health/API/OpenAPI/MCP responses. On 2026-10-13, `api.mehmetozer.dev/health` returned
`{"ok":true}`; the owner reports a working local blog integration that is not yet published. The consumer
was subsequently upgraded to 0.2.1 and deployed on 2026-10-13. Remote migrations had no pending files and
schema drift checks passed. Live posts/OpenAPI reads, blog CORS, anonymous write denial, tokenless MCP denial
and reserved-table isolation passed. Authenticated MCP writes have not been smoke-tested in production.
`castra doctor --remote` passed on the real account after deployment, including both rate-limit bindings,
package consistency and remote schema drift. R2 storage provisioning and GitHub sign-in still lack
recorded real-account verification.
Cloudflare management tests otherwise use a fake API/wrangler. Known issues: [SECURITY.md](SECURITY.md) section 3.

## What Castra is not

**D1 limits.** Castra inherits them. Figures below are from the
[D1 limits page](https://developers.cloudflare.com/d1/platform/limits/) (checked 2026-10-11); check it for current values.

| Limit | Workers Paid | Free |
| --- | --- | --- |
| Database size | 10 GB | 500 MB |
| Bound parameters per query | 100 | 100 |
| SQL statement length | 100 KB | 100 KB |
| Queries per Worker invocation | 1000 | 50 |
| String, BLOB or row size | 2 MB | 2 MB |
| Simultaneous D1 connections per invocation | 6 | 6 |

- **Writes go to one primary.** Per the [read replication docs](https://developers.cloudflare.com/d1/best-practices/read-replication/),
  all write queries are forwarded to the primary database. Castra is not for write-heavy workloads.
- **No interactive transactions, no row locks across requests.** Atomicity is limited to one `batch()`, which Castra
  uses for every guarded write. Read-then-write sequences across requests can interleave.
- **Read replication is opt-in** and replicas update asynchronously (the Sessions API gives sequential consistency).
  Castra does not configure or test replication; a revoked session or role could be read from a lagging replica.
- Statements are limited by the 100 bound parameters, so very wide tables or huge rules can fail.
- No tenant isolation: one Worker and one D1 per deployment ([ADR 0002](adr/0002-no-multitenancy-v0.1.md)).
- Writes use the Workers Rate Limiting binding, with a separate auth bucket and an optional user/context key; reads are not. Counters are per location
  and approximate ([rate limiting](rate-limiting.md), [ADR 0072](adr/0072-rate-limit-binding.md)).

**Out of scope** ([ARCHITECTURE.md](ARCHITECTURE.md) section 8):
- Until v1.0: PostgreSQL/MySQL/Hyperdrive, realtime (Durable Objects), queues, Redis/S3/OIDC adapters, a hosted or
  managed offering.
- Migrations via MCP now work locally in 0.4.0 (ADR 0086) but the remote `/mcp` route still does not expose them. Safe Worker rollback is implemented locally (ADR 0085), live-verified and released in 0.3.0; expansion candidates include R2 storage routes,
  multi-level includes, bulk operations and multi-tenancy (open).
- v1.0: plugin SDK, custom hooks, admin UI and stable config API.
