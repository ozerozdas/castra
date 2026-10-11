# Status and limits

## What works and what does not

Works (locally, covered by tests): policy engine, REST, OpenAPI, Better Auth, roles, API keys, read-only MCP (stdio and
`/mcp`), `generate`, `migrate`, `test policies`, and scaffolding with `npm create @castra-kit` (checked against the
published 0.1.0 packages).

Verified on a real account (2026-10-11): `castra deploy` of a scaffolded project (provision D1 + KV,
`migrate --remote`, secret, deploy to `workers.dev`); the live `/health`, `/api/notes`, `/openapi.json` and `/mcp`
answered as documented. Otherwise `provision`, `doctor`, `deploy` and `migrate --remote` are tested against a fake
Cloudflare API and fake wrangler; `doctor` and `--storage` (R2) have not run against a real account. GitHub sign-in is
only unit-tested (no network). The scaffolder's end-to-end test is opt-in and not in CI. Known issues are listed in [SECURITY.md](SECURITY.md) section 3.

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
- No rate limiting ([ADR 0003](adr/0003-rate-limiting-hook-only.md)); `hooks.beforeRequest` on the REST router is
  the hook point, and Cloudflare rate limiting rules in front of the Worker are recommended.

**Out of scope** ([ARCHITECTURE.md](ARCHITECTURE.md) section 8):
- Until v1.0: PostgreSQL/MySQL/Hyperdrive, realtime (Durable Objects), queues, Redis/S3/OIDC adapters, a hosted or
  managed offering.
- Not in v0.1 (later roadmap): MCP write tools, migrations via MCP, `propose_policy`, `deploy_status` (v0.2); R2
  storage routes, multi-level include, bulk operations, multi-tenancy (v0.3); plugin SDK, custom hooks, admin UI,
  stable config API (v1.0).
