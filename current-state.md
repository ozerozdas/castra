# Castra — Current state

Date: 2026-10-26. **v0.4.1 is prepared on `release/v0.4.1`** (dependency patch release on top of v0.4.0).
All six packages share version 0.4.1.
The consumer production API (`api.mehmetozer.dev`) remains on 0.2.1; the 0.3.0 upgrade ships before the 0.4.0
upgrade so the audit and rollback fixes are in place before the new MCP migration tools reach production.
Details: `CHANGELOG.md`, `docs/PROGRESS.md`, `docs/SECURITY.md`, ADRs 0001–0086.

## Released and verified

- Packages: core, auth, mcp, app, cli and create. Scaffold with `npm create @castra-kit@latest my-app`.
- GitHub release: https://github.com/ozerozdas/castra/releases/tag/v0.4.0
- v0.4 includes local MCP `generate_migration` and `apply_migration` tools through `castra mcp`, the v0.3.0
  audit hardening and Worker rollback, `createCastraApp`, separate auth rate limits, safe destroy and
  generated upgrade notes/tests. The production consumer API upgrade is pending.
- CI at `7103906`: lint, build, typecheck, tests, policy tests, upgrade-note check and upgrade test passed.
  Core 805 · auth 25 · MCP 139 · app 7 · CLI 143 · create 43 (7 skipped) · template 28 · blog 105.
  The separate policy run passes 529 tests; it overlaps the core suite. Upgrade tests: 2 passed.
- Real deployment: `api.mehmetozer.dev` runs a Castra backend. Read-only check on 2026-10-13:
  `/health` returned `{"ok":true}`. The owner's blog integration worked locally and is not yet published.
  The consumer was upgraded from 0.1.2 to 0.2.1, locally validated and deployed on 2026-10-13.
  Worker version: `c0179060-a304-4f9c-86dc-33e267ed56db`. No pending remote migrations; all 11 snapshot
  tables matched; `castra doctor --remote` passed on the real account. Live checks passed: health/posts/OpenAPI 200, blog CORS allowed, anonymous write and
  tokenless MCP 401, audit table route 404. Authenticated MCP writes and rollback are not live-verified.


## Releasing a new version

Bump all six package versions together, run the full CI pipeline, publish packages, tag and create a release.
Version 0.4.0 publication completed on 2026-10-19. Existing 0.1.x apps follow
`docs/upgrading/0.2.0.md`, using the desired patch version in package commands.

## v0.3.0 audit hardening

Issue #21 is implemented locally (ADR 0084): masked scalar audit arguments, configurable subtree redaction,
opt-in bounded retention, preserved attempt-before-write auditing. No migration or scaffold edits.
Validation passed: lint, build, typecheck, full tests, policy suite, upgrade-note check and upgrade tests.
MCP now has 132 passing tests; app has 7. These changes are published in 0.3.0; the consumer production API has not been upgraded.

## Next

1. Consumer upgrade deployed and smoke-tested; see `docs/NEXT-STEPS.md` for the next work.
2. Audit hardening (#21) released in 0.3.0; historical audit rows need explicit pruning.
3. Safe Worker rollback implemented locally (#17, ADR 0085); live example Worker rollback and config/schema rejection verified; released in 0.3.0.
4. Local MCP `generate_migration` / `apply_migration` (#20) released in 0.4.0 with ADR 0086; consumer production upgrade pending.

R2 routes, multi-level includes and bulk operations are v0.3 expansion candidates. Multi-tenancy remains open;
admin UI, plugin SDK and stable config API belong to v1.0 per ARCHITECTURE §8.

v0.3.0 CLI rollback: live D1/config fingerprint checks, immutable version metadata, dry-run, explicit target,
confirmation and post-confirmation rechecks. No automatic D1 restore or forced Cloudflare deployment.

Live rollback validation on isolated `castra-blog` example: operator performed a successful rollback and
config mismatch test. Agent verified live D1 schema mismatch rejection with an empty temporary table,
cleaned it up, compared original/final DDL and confirmed active deployment unchanged (see docs/PROGRESS.md).
This is separate from the production consumer API, where rollback has not been exercised.

## v0.3.0 release

Release branch merged through PR #22 (`ef894e7`); PR/master CI and CodeQL passed. All six npm packages
and MCP server version are 0.3.0. Scaffold/example rollback scripts, generated upgrade guide and release
notes are included. MCP migrations (#20) and the consumer production upgrade remain subsequent work.

Release gate passed: lint/build/typecheck, 1288 full-suite tests (7 opt-in skipped), 529 policy tests,
generated notes and 2 upgrade tests. Six packed package manifests/content verified.
Release notes and publication steps: `docs/releases/0.3.0.md`.

Publication: six npm packages at 0.3.0, tag `v0.3.0`, GitHub release
https://github.com/ozerozdas/castra/releases/tag/v0.3.0. Issues #17 and #21 closed via PR #22.

## v0.4.0 release

Release branch merged through PR #28 (`7ffd6ef`); PR/master CI and CodeQL passed. All six npm packages
and MCP server version are 0.4.0. Local MCP migration tools (`generate_migration`, `apply_migration`), generated
upgrade guide and release notes are included. The consumer production upgrade remains subsequent work.

Release gate passed: lint/build/typecheck, 1295 full-suite tests (7 opt-in skipped), 529 policy tests,
generated notes and 2 upgrade tests. Six package tarballs inspected in a publish dry run.
Release notes and publication steps: `docs/releases/0.4.0.md`.

Publication: six npm packages at 0.4.0, tag `v0.4.0`, GitHub release
https://github.com/ozerozdas/castra/releases/tag/v0.4.0. Issue #20 closed via PR #28.
