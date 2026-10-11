# Castra — Current state

Date: 2026-10-11. **v0.1.1 is released; 0.1.2 is prepared** (see `CHANGELOG.md`). `master` and tags `v0.1.0`, `v0.1.1` are on `origin`. No open worktrees.
Details: `docs/PROGRESS.md`, `docs/SECURITY.md`, `README.md`, ADRs 0001–0075.

## Released

- npm: `@castra-kit/core`, `@castra-kit/auth`, `@castra-kit/mcp`, `@castra-kit/cli`, `@castra-kit/create` at `0.1.0`
  (ADR 0069). Scaffold with `npm create @castra-kit@latest my-app`.
- GitHub release: https://github.com/ozerozdas/castra/releases/tag/v0.1.0
- Problem type pages: https://castra.mehmetozer.dev/problems/ (`pnpm site:deploy`, ADR 0067).
- Real account: `mehmetozer-blog` runs on the npm packages at `mehmetozer-blog.nuvocode.workers.dev`.

Last full run on master: core 796 · auth 25 · mcp 84 · cli 105 · create 43 (+5 opt-in e2e skipped) + 28 template ·
blog 105 · test:policies 521.

## Releasing a new version

Bump the five package versions together (the scaffolder writes its own version into new apps), run the full
pipeline, then `pnpm -r publish --no-git-checks` (npm web login), tag `vX.Y.Z`, and create the GitHub release.
Publishing, tagging and releases need explicit human approval.

## Next (v0.1.x hardening)

- PII in audit arguments.
- Done in 0.1.2: welcome at `/` (#14), write rate limiting (#6), auth errors as problem+json (#7), `$truncated`
  includes (#8), collations in the snapshot (#9). Planned work lives in GitHub issues and milestones.

Then v0.2 (MCP writes, migrations, `propose_policy`) per ARCHITECTURE §8. A read-only admin UI in v0.3 is an open
proposal (needs an ADR).
