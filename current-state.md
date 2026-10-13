# Castra — Current state

Date: 2026-10-13. **v0.2.1 is released.** The released packages share version 0.2.1; this branch prepares all six packages at 0.3.0.
Details: `CHANGELOG.md`, `docs/PROGRESS.md`, `docs/SECURITY.md`, ADRs 0001–0085.

## Released and verified

- Packages: core, auth, mcp, app, cli and create. Scaffold with `npm create @castra-kit@latest my-app`.
- GitHub release: https://github.com/ozerozdas/castra/releases/tag/v0.2.1
- v0.2 includes MCP writes through REST, migration create/status, local `propose_policy` and `deploy_status`,
  `createCastraApp`, separate auth rate limits, safe destroy and generated upgrade notes/tests.
- CI at `a80f280`: lint, build, typecheck, tests, policy tests, upgrade-note check and upgrade test passed.
  Core 805 · auth 25 · MCP 123 · app 6 · CLI 123 (1 skipped) · create 43 (7 skipped) · template 28 · blog 105.
  The separate policy run passes 529 tests; it overlaps the core suite. Upgrade tests: 2 passed.
- Real deployment: `api.mehmetozer.dev` runs a Castra backend. Read-only check on 2026-10-13:
  `/health` returned `{"ok":true}`. The owner's blog integration worked locally and is not yet published.
  The consumer was upgraded from 0.1.2 to 0.2.1, locally validated and deployed on 2026-10-13.
  Worker version: `c0179060-a304-4f9c-86dc-33e267ed56db`. No pending remote migrations; all 11 snapshot
  tables matched; `castra doctor --remote` passed on the real account. Live checks passed: health/posts/OpenAPI 200, blog CORS allowed, anonymous write and
  tokenless MCP 401, audit table route 404. Authenticated MCP writes and rollback are not live-verified.


## Releasing a new version

Bump all six package versions together, run the full CI pipeline, publish packages, tag and create a release.
Publication has not been performed in this release-preparation branch. Existing 0.1.x apps follow
`docs/upgrading/0.2.0.md`, using the desired patch version in package commands.

## Unreleased hardening

Issue #21 is implemented locally (ADR 0084): masked scalar audit arguments, configurable subtree redaction,
opt-in bounded retention, preserved attempt-before-write auditing. No migration or scaffold edits.
Validation passed: lint, build, typecheck, full tests, policy suite, upgrade-note check and upgrade tests.
MCP now has 132 passing tests; app has 7. These changes are not published or deployed.

## Next

1. Consumer upgrade deployed and smoke-tested; see `docs/NEXT-STEPS.md` for the next work.
2. Review/release the locally validated audit hardening (#21); historical audit rows need explicit pruning.
3. Safe Worker rollback implemented locally (#17, ADR 0085); live example Worker rollback and config/schema rejection verified; review/release pending.
4. Local MCP `generate_migration` / `apply_migration` (#20, v0.3; approval workflow needs a decision).

R2 routes, multi-level includes and bulk operations are v0.3 expansion candidates. Multi-tenancy remains open;
admin UI, plugin SDK and stable config API belong to v1.0 per ARCHITECTURE §8.

Unreleased CLI rollback: live D1/config fingerprint checks, immutable version metadata, dry-run, explicit target,
confirmation and post-confirmation rechecks. No automatic D1 restore or forced Cloudflare deployment.

Live rollback validation on isolated `castra-blog` example: operator performed a successful rollback and
config mismatch test. Agent verified live D1 schema mismatch rejection with an empty temporary table,
cleaned it up, compared original/final DDL and confirmed active deployment unchanged (see docs/PROGRESS.md).
This is separate from the production consumer API, where rollback has not been exercised.

## v0.3.0 release preparation

Branch `codex/release-v0.3.0`: six package versions and MCP server version bumped together; scaffold/example
rollback scripts, generated upgrade guide and release notes prepared. npm publication, tag, GitHub release and
consumer production upgrade have not been performed. MCP migrations (#20) remain outside this release.

Release gate passed: lint/build/typecheck, 1288 full-suite tests (7 opt-in skipped), 529 policy tests,
generated notes and 2 upgrade tests. Six packed package manifests/content verified.
Release notes and publication steps: `docs/releases/0.3.0.md`.
