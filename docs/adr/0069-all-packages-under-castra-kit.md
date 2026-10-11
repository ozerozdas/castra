# 0069. All packages publish under `@castra-kit`

## Status
Accepted (2026-10-11). Amends ADRs 0004 and 0068.

## Context
The first `pnpm -r publish` failed on the first package: npm refused `castra` with 403 "Package name too similar
to existing package astro". Nothing was published. `create-castra` would likely hit the same check against
`create-astro`. Names inside a scope are not subject to this check, and the maintainer owns the `castra-kit` org.

## Decision
- `packages/core` publishes as `@castra-kit/core`; user code imports `defineConfig` and the rule helpers from it.
- `packages/create-castra` publishes as `@castra-kit/create`. Users scaffold with `npm create @castra-kit@latest
  <name>` (or `pnpm create @castra-kit <name>`); npm maps a bare scope to `<scope>/create`.
- The CLI binary stays `castra`, and the scaffolder's binary stays `create-castra`. Directory names stay.

## Consequences
- All five packages share one org, so future packages cannot be squatted by name.
- Imports are longer: `from "@castra-kit/core"` instead of `from "castra"`.
