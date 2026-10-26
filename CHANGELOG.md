# Changelog

All `@castra-kit/*` packages share one version. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

## 0.4.1 (2026-10-26)

Dependency patch release. Upgrade from 0.4.0: bump the `@castra-kit/*` packages and run `pnpm install`.
No database migration, binding or API change.

### Changed

- `better-auth` 1.7.9 → 1.7.12 (`@castra-kit/auth`).
- `kysely` 0.29.6 → 0.29.7 (core, auth, mcp, app, create).
- Dev tooling: `wrangler` 4.151.3, `@cloudflare/workers-types` 5.20261022.1, `@cloudflare/vitest-plugin` 1.4.6,
  `eslint` 10.13.0, `typescript-eslint` 8.72.0, `@readme/openapi-parser` 10.0.0.
- `@types/node` stays on 22 to match the supported runtime (`engines: node >=20`); Dependabot now skips its
  major updates.

## 0.4.0 (2026-10-19)

Upgrade from 0.3.0: bump the `@castra-kit/*` packages, run `pnpm install`, and restart `castra mcp`. No database migration is required.

### Added

- Local MCP migration tools for `castra mcp` stdio only ([ADR 0086](docs/adr/0086-mcp-migrations.md), #20).
  - `generate_migration { name }` creates the next numbered file in `migrations_dir` and previews the template.
  - `apply_migration { approve }` lists pending migrations; with `approve: true` it runs the drift check,
    then `wrangler d1 migrations apply`, and reports the exit code. Without approval, returns a dry-run summary.
- CLI `castra mcp` wiring: builds the migrations callback from `migrateCreate`, `migrateStatus`, `generate`,
  and `migrate`, using a `silentExec` wrapper so wrangler stdout never enters the MCP JSON-RPC stream.

### Security

- These tools are local-only; the remote `/mcp` route never registers them. No new audit code is introduced.

## 0.3.0 (2026-10-13)

Upgrade from 0.2.1: [upgrade guide](docs/upgrading/0.3.0.md). No database migration is required.

### Changed
- MCP audit arguments now store structure with masked values, including write attempts and rejected calls.
  Historical rows are unchanged; prune them explicitly. Optional `audit.redactKeys` hides entire subtrees.

### Added
- `castra rollback` checks marked Worker versions against live D1 schema and Wrangler config, supports dry-run
  and explicit targets, and requires Worker-name confirmation. Deploy records compatibility metadata (ADR 0085, #17).
- Opt-in `audit.retentionDays` runs one bounded prune batch after remote MCP auditing. Packaged apps configure
  it with `mcp: { audit: { retentionDays: 30 } }`. Cleanup errors do not change tool results (ADR 0084, #21).

## 0.2.1 (2026-10-12)

Bump the `@castra-kit/*` packages; no template changes. Coming from 0.1.x, follow
[docs/upgrading/0.2.0.md](docs/upgrading/0.2.0.md) and use `0.2.1` in its `pnpm add` line.

### Fixed
- `checkRow` (dry run, `check_access`) now stores numeric text with a fraction or exponent in INTEGER/NUMERIC columns
  as SQLite does: REAL, then INTEGER when integral (`"1e3"`, `"123456789012345678.5"`). `typeof()` and
  `CAST(... AS TEXT)` rules could get a different answer than the real write. The guarded write was already exact.
  The npm 0.2.0 packages were published without this fix (the `v0.2.0` tag includes it).

## 0.2.0 (2026-10-12)

Upgrading an existing project: follow [docs/upgrading/0.2.0.md](docs/upgrading/0.2.0.md) (package commands, scripts
and template diffs; `src/index.ts` becomes one `createCastraApp` call).

### Added
- Upgrade notes have a generated "Template changes" section (`pnpm add` / `pnpm remove` commands, scripts, and a diff
  per template file) from `node scripts/upgrade-note.mjs <version> --write`. CI checks it is current and runs an
  upgrade test: scaffold the previous release, apply the note, run its tests
  ([ADR 0083](docs/adr/0083-upgrade-notes.md), #19). Upgrading to 0.2.0: [docs/upgrading/0.2.0.md](docs/upgrading/0.2.0.md).
- MCP tool `propose_policy` (local `castra mcp` only): `{ table, op, rule }` returns a unified diff of
  `castra.config.ts`, validated against the current roles and schema and never applied. Rules are parsed from a small
  grammar (`isPublic`, `authenticated`, `role`, `owner`, `.and`, `.or`), never evaluated
  ([ADR 0082](docs/adr/0082-propose-policy.md), #12).
- MCP write tools `create_data`, `update_data`, `delete_data` run `POST` / `PATCH` / `DELETE` through the REST write
  path (policies, field rules, write guard). Local stdio: any `as`. Remote `/mcp`: new scope `data:write`, only as
  the token's own user; an `attempt` audit row is stored before each write
  ([ADR 0081](docs/adr/0081-mcp-write-tools.md), #10).
- `castra migrate create <name>` writes the next numbered file in `migrations_dir`; `castra migrate status
  [--local|--remote]` lists files as applied / pending / unknown from wrangler's `d1_migrations` table. Wrangler stays
  the runner ([ADR 0080](docs/adr/0080-migration-workflow.md), #11).
- New package `@castra-kit/app`: `createCastraApp({ config, snapshot })` builds the Worker (problem+json, write rate
  limit, `/health`, `/mcp`, Better Auth, request context, `/me`, REST router) in a fixed order, with `before` and
  `routes` hooks and `rateLimit: false` / `mcp: false`. The template's and `examples/blog`'s `src/index.ts` are now a
  single call, so middleware added later ships with a package bump
  ([ADR 0077](docs/adr/0077-create-castra-app.md), #19). Existing projects: [docs/upgrading/0.2.0.md](docs/upgrading/0.2.0.md).
- `rateLimitWrites` logs one warning per isolate when a write from Cloudflare finds no binding.
- Sign-in, sign-up and other `/api/auth/*` writes have their own bucket, `AUTH_RATE_LIMITER` (10/min per IP in the
  template), on top of the general one. `rateLimit: { key }` keys table writes by user (or anything in the request
  context), falling back to the IP; `rateLimitWrites` takes `{ retryAfterSeconds, key, binding }`
  ([ADR 0078](docs/adr/0078-auth-bucket-and-rate-limit-key.md), #18).
- MCP tool `deploy_status` (local `castra mcp` only) runs the `castra doctor` checks and returns the rows and drift
  lines. `castra doctor` now also checks that `@castra-kit/*` packages share one version (fails otherwise), that
  `RATE_LIMITER` / `AUTH_RATE_LIMITER` are declared (warns), and with `--remote` compares the snapshot with the
  deployed D1 ([ADR 0079](docs/adr/0079-deploy-status-and-doctor-checks.md), #13, #19).
- `castra destroy` deletes what `castra deploy` created and `wrangler.jsonc` records (Worker, D1, `CACHE` KV, R2),
  after a plan and typing the Worker name (`--confirm` in scripts, `--dry-run` to only list). D1 is exported with
  `wrangler d1 export` first unless `--skip-backup`. Recorded ids are reset to placeholders, so a rerun deletes
  nothing and `castra deploy` starts fresh ([ADR 0076](docs/adr/0076-castra-destroy.md), #16).

## 0.1.2 (2026-10-11)

Upgrading an existing project: bump the `@castra-kit/*` packages, add the `RATE_LIMITER` binding and the
`rateLimitWrites` middleware ([docs/rate-limiting.md](docs/rate-limiting.md)), and run `castra generate` so the
snapshot picks up column collations.

### Added
- `castra generate` records `COLLATE NOCASE` and `COLLATE RTRIM` columns in the snapshot (`collation`), and
  `check_access` / `checkRow` compare those columns as the table does. `describe_schema` shows the collation;
  schema drift reports collation changes ([ADR 0075](docs/adr/0075-column-collations.md), #9).
- A one-to-many include cut at 25 rows marks its parent row with `"$truncated": ["<include>"]`. Only rows the caller
  may read are counted. Documented in OpenAPI ([ADR 0074](docs/adr/0074-include-truncation-marker.md), #8).
- Better Auth `/api/auth/*` errors are `application/problem+json` (type `auth_error`, or `rate_limited` for 429),
  keeping Better Auth's `code` and `message`. 5xx bodies are replaced by a generic detail
  ([ADR 0073](docs/adr/0073-auth-errors-problem-json.md), #7).
- Writes (sign-in, sign-up, `/mcp`, table writes) are rate limited per IP: `rateLimitWrites` in `@castra-kit/core`
  over the Workers Rate Limiting binding, wired into the template and `examples/blog`. New problem type
  `rate_limited` (429). Existing projects: see [docs/rate-limiting.md](docs/rate-limiting.md)
  ([ADR 0072](docs/adr/0072-rate-limit-binding.md), #6).
- `GET /` answers a welcome instead of a 404: name, version and links as JSON, or a small HTML page for browsers.
  Turn it off with `api.welcome: false` ([ADR 0071](docs/adr/0071-welcome-route.md), #14).

## 0.1.1 (2026-10-11)

### Added
- `castra mcp audit prune --older-than <days> [--local | --remote]` deletes old `_castra_audit` rows in batches
  ([ADR 0070](docs/adr/0070-audit-prune-command.md)).
- `pruneAuditQuery(before)` and `AUDIT_PRUNE_BATCH` in `@castra-kit/mcp`, for pruning from a Cron Trigger.

### Fixed
- Trailing-character trims no longer use backtracking regexes (CodeQL `js/polynomial-redos`). This affects the
  REST and OpenAPI `basePath`, MCP path parsing, and the CLI's deploy URL and R2 bucket names. None of these inputs
  come from API clients.
- `castra deploy` matches Cloudflare hostnames exactly when it picks the deployed URL from wrangler output, instead
  of looking for a substring.

### Changed
- Package metadata: author is Mehmet Özer Özdaş, and the package READMEs link to the new docs pages.

## 0.1.0 (2026-10-11)

First release: policy engine compiled to SQL, auto REST and OpenAPI, Better Auth with roles and API keys, read-only
MCP (stdio and `/mcp`), the `castra` CLI and the `@castra-kit/create` scaffolder.
See the [release notes](https://github.com/ozerozdas/castra/releases/tag/v0.1.0).
