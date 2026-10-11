# CLAUDE.md — Castra

Castra is a Cloudflare-native, self-hosted, agent-safe BaaS starter kit.
The full design lives in `docs/ARCHITECTURE.md`. Read it before any change; it wins over this file
on design questions. The v0.1 work plan lives in `GOAL.md`.

## Repo layout (pnpm workspaces, TypeScript, ESM)

```
packages/
  core/           # policy engine, schema snapshot, query builder, REST router (Hono), OpenAPI
  auth/           # Better Auth wiring, roles table, ctx resolution
  mcp/            # MCP tools (shared), stdio entry + Worker /mcp route
  cli/            # `castra` binary: provision, generate, migrate, deploy, test, mcp, doctor
  create-castra/  # `npm create @castra-kit@latest <name>` scaffolder
examples/
  blog/           # reference app: posts, comments, users — the e2e test target
docs/
  ARCHITECTURE.md
  adr/            # one ADR per decision that changes ARCHITECTURE.md
  SECURITY.md     # threat model for the policy engine
```

## Stack

Workers + Hono · D1 · Kysely (D1 dialect) · Better Auth · Zod · Vitest with
`@cloudflare/vitest-pool-workers` · Wrangler · pnpm · tsup.

Check current versions and APIs of Better Auth, Kysely D1 dialect, Wrangler and the MCP SDK against
their docs before use; do not rely on memory.

## Commands

```
pnpm install
pnpm -r build
pnpm -r test             # unit + integration (Workers pool, local D1)
pnpm test:policies       # policy allow/deny suite
pnpm lint && pnpm typecheck
pnpm --filter blog dev   # run the example locally
```

## Non-negotiable rules

1. **Default closed.** No policy → no route. Never add a fallback that opens a table.
2. **Policies compile to SQL.** Never filter rows after the query. Pagination and counts must stay correct.
3. **Write check on every create/update.** Server-set columns (`setBy: "server"`) are never taken from input.
4. **Includes obey their own table's `read` policy.**
5. **No string-built SQL.** Kysely only; identifiers only from the schema snapshot.
6. **Every policy rule type ships with allow AND deny tests.** A PR that touches `packages/core/policy`
   without new or updated tests is incomplete.
7. **MCP calls the same engine as REST.** No MCP-only data path.
8. **Scope:** anything listed as out of scope in `ARCHITECTURE.md` §8 is not built. Propose it in an ADR instead.
9. **Secrets** are Worker secrets or env vars, never committed. No real Cloudflare token in tests.

## Working conventions

- Small PR-sized commits; conventional commit messages (`feat(core): ...`).
- Public APIs get TSDoc. Errors use `application/problem+json`.
- When a design decision deviates from `ARCHITECTURE.md`, write `docs/adr/NNNN-title.md` first, then change code.
- Keep `README.md` and `docs/limits.md` honest: list what works, what doesn't, and D1's limits.
