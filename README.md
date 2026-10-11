# Castra

Cloudflare-native, self-hosted, agent-safe Backend-as-a-Service starter kit.

**Status: pre-release. Nothing is published to npm.** The repository currently contains the monorepo
foundation (M0) only: contract types, an example app skeleton and CI. There is no working policy engine,
REST API, auth, MCP server or CLI yet.

See `docs/ARCHITECTURE.md` for the design, `docs/GOAL.md` for the v0.1 plan and `docs/PROGRESS.md` for
current status.

## MCP (pending review)

- `castra mcp` serves read-only tools over stdio against the **local** D1. These are `describe_schema`,
  `check_access`, `explain_query` and `query_data`.
  - It is a developer tool: `as` may impersonate **any** user or role, with no token and no audit log.
  - Never expose it over a network.
- The deployed Worker serves the same tools at `POST /mcp`.
  - It needs `Authorization: Bearer castra_mcp_...` tokens, created with
    `castra mcp token create --user <id> --scopes "schema:read data:read"`.
  - Scopes: `schema:read`, `access:check`, `data:read`, `data:read:any_user`. There are no write or admin scopes.
  - Every call is written to `_castra_audit`.

## Create a project (pending review)

`create-castra` scaffolds a Workers + D1 project with a `notes` table, policies with allow/deny tests, Better Auth,
REST + OpenAPI and `/mcp`. Nothing is on npm yet, so `npx create-castra` does not work. From a built checkout,
scaffold outside the repository (a project inside it would be taken for part of the pnpm workspace):

```
cd ~/projects
node <castra>/packages/create-castra/dist/cli.js my-app --local-packages <castra>
cd my-app && pnpm run typecheck && pnpm test && pnpm run test:policies
```

`pnpm --filter create-castra test:e2e` does exactly that in a temp directory and also runs `wrangler dev`.

`castra init` (add Castra to an existing project) is not part of v0.1 (ADR 0038).

## Develop

```
pnpm install
pnpm -r build
pnpm -r test
pnpm lint && pnpm typecheck
pnpm --filter blog db:migrate:local && pnpm --filter blog dev
```

Requires Node >= 20 and pnpm 10.
