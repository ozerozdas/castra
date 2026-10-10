# GOAL — Castra v0.1

## Objective

Ship Castra v0.1 as described in `docs/ARCHITECTURE.md`: a developer runs
`npx create-castra my-app`, then `castra deploy` with a Cloudflare API token, and gets a Worker on their
own account with Better Auth, roles, policy-protected auto-CRUD over their D1 tables, OpenAPI, and a
read-only MCP server (local + remote). The policy engine is the product; treat it as security code.

## How to run this goal (subagent-driven)

You are the **orchestrator**. You plan, delegate, integrate and verify. You do not write large amounts
of feature code yourself.

1. Read `CLAUDE.md` and `docs/ARCHITECTURE.md` fully.
2. Turn the milestones below into a task list with dependencies.
3. For each task, spawn a subagent with a self-contained brief: goal, files it owns, interfaces it must
   honour, acceptance criteria, and the commands that prove it. Subagents start cold — give them the
   context; do not assume they saw this conversation.
4. Run independent tasks in parallel only when they touch disjoint files (use worktree isolation when
   available). Serialize anything touching `packages/core/policy`.
5. After each milestone, spawn a **separate reviewer subagent** that did not write the code. It runs the
   tests, reads the diff against the non-negotiable rules in `CLAUDE.md`, and tries to break it. Fix what
   it finds before moving on.
6. Keep `docs/PROGRESS.md` updated after every milestone: done, in progress, decisions, open issues.
7. When a design question is not answered by the docs, pick the option most consistent with
   "default closed, small core", record it in `docs/adr/`, and continue. Stop and ask only for
   irreversible choices (public package names, publishing to npm, deploying to a real account).

### Suggested subagent roles

| Role | Owns |
| --- | --- |
| Scaffolder | Monorepo, tooling, CI, example app skeleton |
| Schema | Introspection, snapshot format, type generation, drift check |
| Policy | Rule DSL, compiler to Kysely `WHERE`, write check, field rules, explanations |
| API | Hono router, filters/sort/cursor pagination, includes, Zod, OpenAPI, errors |
| Auth | Better Auth on D1 via Kysely, roles table, `ctx` resolution, API keys |
| MCP | Shared tools, stdio entry, remote `/mcp` route, scoped tokens, audit log |
| CLI | `create-castra`, provision (idempotent), migrate, deploy, doctor |
| Security reviewer | Adversarial tests and review after every milestone (never writes features) |
| Docs | README, SECURITY.md, quickstart, token permission list |

## Milestones and acceptance criteria

### M0 — Foundation
- pnpm monorepo per `CLAUDE.md` layout; build, lint, typecheck, test run green in CI (GitHub Actions).
- `examples/blog` runs locally with `wrangler dev` and a local D1 holding `posts`, `comments`, `users`, `audit_logs`.

### M1 — Schema + policy engine (core, highest bar)
- `castra generate` writes a JSON schema snapshot and Kysely types from a D1 database.
- Policy DSL from ARCHITECTURE §7 type-checks and compiles to Kysely expressions.
- `explain(decision)` returns matched rule, compiled `WHERE` (SQL + params) and hidden fields.
- Tests: allow + deny per rule type; owner spoofing on create/update rejected; hidden fields never
  serialized; table without policy unreachable; property-based tests that a compiled read policy never
  returns a row the same policy evaluated in JS would deny.

### M2 — REST API
- Routes per ARCHITECTURE §4, only for operations with a policy.
- Filters (PostgREST style, allow-listed columns), sort, cursor pagination with `maxLimit`, one-level `include`
  batched with `IN`, each included table under its own `read` policy.
- `/openapi.json` (OpenAPI 3.1) lists exactly the open operations; validates with a standard validator.
- Integration tests against local D1 for every route, including "include leaks" and pagination-under-policy.

### M3 — Auth
- Better Auth (email + GitHub) on D1; roles table; `ctx` from session or API key.
- Session validity checked against D1 (KV is cache only).
- Tests for login, role assignment, role-gated routes, revoked session.

### M4 — MCP (read-only)
- Tools: `describe_schema`, `check_access`, `explain_query`, `query_data`.
- Same engine as REST (verified by a test that runs identical cases through both paths).
- Local stdio via `castra mcp`; remote `/mcp` with scoped tokens; every remote call in `_castra_audit`.

### M5 — CLI + provisioning
- `npx create-castra my-app` scaffolds a working project.
- `castra provision` creates D1/KV (R2 only if enabled), is idempotent, writes `wrangler.jsonc` bindings.
- `castra doctor` verifies token permissions and lists missing ones.
- `castra deploy` = provision → migrate → deploy, prints API, OpenAPI and MCP URLs.
- Cloudflare API calls are mocked in tests. A real-account deploy happens only when the human runs it.

### M6 — Docs + release readiness
- README: 5-minute quickstart, config reference, what Castra is not (D1 limits, out-of-scope list).
- `docs/SECURITY.md`: threat model and the guarantees the policy engine does and does not make.
- Minimum Cloudflare token permissions, verified against Cloudflare docs.
- Final adversarial review by a fresh reviewer subagent; findings fixed or recorded as known issues.

## Defaults for open questions (record each as an ADR)

- Filter syntax: PostgREST style.
- Multi-tenancy: not in v0.1.
- Rate limiting: not in v0.1; leave a hook point.
- Package names: `castra` and `create-castra` (verified free on npm on 2026-10-10; re-check before publishing).

## Definition of done

All milestones green in CI, reviewer sign-off on M1, M2 and M6, `examples/blog` deploys with one command
(verified by the human), `docs/PROGRESS.md` reflects final state. Do **not** publish to npm or create
public releases without explicit human approval.
