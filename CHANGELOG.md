# Changelog

All `@castra-kit/*` packages share one version. The format follows [Keep a Changelog](https://keepachangelog.com/).

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
