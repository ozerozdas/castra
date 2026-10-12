# 0079. `deploy_status` runs `castra doctor`; doctor checks upgrades and remote drift

## Status
Accepted (2026-10-12). Issues #13 and #19 (part 2).

## Context
ARCHITECTURE §5 plans `deploy_status` (provisioning, bindings, schema drift) as a local-only MCP tool, and §6 has
`castra doctor` for the same questions. Two implementations would drift apart. Upgrades also failed silently: a
project could miss a binding the installed version expects (`RATE_LIMITER`, `AUTH_RATE_LIMITER`), mix
`@castra-kit/*` versions, or run against a D1 whose schema no longer matches the committed snapshot.

## Decision
- **One implementation.** `deploy_status` is registered only by the stdio server (`castra mcp`). It calls the CLI's
  `doctor()` and returns its rows (`check`, `status`, `required`, `fix`), the drift lines and `ok`. The remote
  `/mcp` route never has it: it needs the Cloudflare token and the project files, which only the local side has.
- **New doctor checks:**
  - *Castra packages:* every `@castra-kit/*` dependency in the project's `package.json` is installed
    (`node_modules/@castra-kit/<name>/package.json`) at the same version. A mismatch fails (exit 1) and the fix
    lists the one command to align them. Not installed is a warning.
  - *Rate-limit bindings:* `RATE_LIMITER` and `AUTH_RATE_LIMITER` in `ratelimits`. Missing is a warning, not a
    failure, because `createCastraApp({ rateLimit: false })` is a valid choice.
  - *Remote drift:* `castra doctor --remote` (and `deploy_status` with `remote: true`) compares the snapshot with the
    deployed D1 through the D1 HTTP API (the opener `castra deploy` already uses), instead of the local D1.
- Drift lines are returned in the result (`drift`), so the tool shows what changed, not only that something did.

## Consequences
- `deploy_status` needs the same token as `castra doctor` for the permission rows; without one, those rows say so
  and the local checks still run.
- `--remote` reads `sqlite_master` and `PRAGMA`s only, as in `castra deploy`.
- The expected bindings are listed in the CLI; a release that adds one adds it there and to the upgrade note.
