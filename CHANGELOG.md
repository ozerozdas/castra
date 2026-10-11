# Changelog

All `@castra-kit/*` packages share one version. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added
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
