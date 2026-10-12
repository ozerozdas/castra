# Changelog

All `@castra-kit/*` packages share one version. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added
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
