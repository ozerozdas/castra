# Castra — Current state

Date: 2026-10-11. **v0.1.0 is released; 0.1.1 is prepared** (see `CHANGELOG.md`). `master` and tag `v0.1.0` are on `origin`; CI green. No open worktrees.
Details: `docs/PROGRESS.md`, `docs/SECURITY.md`, `README.md`, ADRs 0001–0069.

## Released

- npm: `@castra-kit/core`, `@castra-kit/auth`, `@castra-kit/mcp`, `@castra-kit/cli`, `@castra-kit/create` at `0.1.0`
  (ADR 0069). Scaffold with `npm create @castra-kit@latest my-app`.
- GitHub release: https://github.com/ozerozdas/castra/releases/tag/v0.1.0
- Problem type pages: https://castra.mehmetozer.dev/problems/ (`pnpm site:deploy`, ADR 0067).
- Real account: `mehmetozer-blog` runs on the npm packages at `mehmetozer-blog.nuvocode.workers.dev`.

Last full run on master: core 782 · auth 20 · mcp 83 · cli 102 · create 43 (+5 opt-in e2e skipped) + 28 template ·
blog 103 · test:policies 517.

## Releasing a new version

Bump the five package versions together (the scaffolder writes its own version into new apps), run the full
pipeline, then `pnpm -r publish --no-git-checks` (npm web login), tag `vX.Y.Z`, and create the GitHub release.
Publishing, tagging and releases need explicit human approval.

## Next (v0.1.x hardening)

- Rate limiting for `/mcp` (at least a documented WAF rule).
- PII in audit arguments.
- Better Auth `/api/auth/*` errors as problem+json.
- Signal truncated one-to-many includes (25 rows per parent).
- Collations in the snapshot so `check_access` matches the guarded write.

Then v0.2 (MCP writes, migrations, `propose_policy`) per ARCHITECTURE §8. A read-only admin UI in v0.3 is an open
proposal (needs an ADR).
