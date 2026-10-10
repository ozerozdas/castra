# Castra

Cloudflare-native, self-hosted, agent-safe Backend-as-a-Service starter kit.

**Status: pre-release. Nothing is published to npm.** The repository currently contains the monorepo
foundation (M0) only: contract types, an example app skeleton and CI. There is no working policy engine,
REST API, auth, MCP server or CLI yet.

See `docs/ARCHITECTURE.md` for the design, `docs/GOAL.md` for the v0.1 plan and `docs/PROGRESS.md` for
current status.

## Develop

```
pnpm install
pnpm -r build
pnpm -r test
pnpm lint && pnpm typecheck
pnpm --filter blog db:migrate:local && pnpm --filter blog dev
```

Requires Node >= 20 and pnpm 10.
