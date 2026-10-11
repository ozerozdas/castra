# 0004. Package names

## Status
Accepted (2026-10-10). Re-check availability before publishing. Scoped names amended by ADR 0068; all names by ADR 0069 (`@castra-kit/*`).

## Context
Users import `defineConfig` and the rule helpers from one package, and scaffold with `npx create-<name>`.
Internal packages should not become public API by accident.

## Decision
- `castra`: the core package (`packages/core`), imported by user config. Verified free on npm on 2026-10-10.
- `create-castra`: the scaffolder (`packages/create-castra`). Verified free on npm on 2026-10-10.
- `@castra/auth`, `@castra/mcp`, `@castra/cli`: internal workspace packages, `"private": true`.
  The `castra` binary lives in `@castra/cli` for now and may merge into `castra` later.
- Nothing is published without explicit human approval.

## Consequences
- Availability is a point-in-time check; re-verify with `npm view` right before the first publish.
- Scoped names are not reserved on npm; if they are ever published, the `@castra` scope must be claimed first.
