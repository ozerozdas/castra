# 0038. `castra init` is deferred out of v0.1

## Status
Accepted (2026-10-11). Narrows ARCHITECTURE §6 for v0.1.

## Context
ARCHITECTURE §6 lists `castra init` ("add to an existing Workers project"). Doing that safely means merging into an
unknown `wrangler.jsonc`, an unknown migrations directory with its own numbering, an existing Hono (or non-Hono)
app and an existing test setup. The v0.1 goal (GOAL.md M5) only requires `npx create-castra my-app` → deploy.

## Decision
- `castra init` is not built in v0.1. The CLI lists it as planned and exits 2 ("not implemented yet").
- The supported path is `create-castra` for new projects. Existing projects can copy `migrations/0002_auth.sql`,
  `0003_mcp.sql`, `castra.config.ts` and the `src/index.ts` wiring from a scaffolded project by hand.

## Consequences
- Revisit for v0.2 with a design for migration renumbering and wrangler config merging (jsonc edits are already
  available from `castra provision`).
