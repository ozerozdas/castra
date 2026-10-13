# Next steps after v0.3.0

Date: 2026-10-13. The consumer API at `api.mehmetozer.dev` is deployed on Castra 0.2.1;
local validation and production smoke checks are recorded in `../current-state.md`.
The consumer blog frontend has worked locally but has not been published.

## 1. Audit hardening

Issue: [#21](https://github.com/ozerozdas/castra/issues/21).
Status: released in 0.3.0 with ADR 0084; all required checks passed. Consumer production upgrade pending.

Original acceptance plan: first write an ADR defining which arguments are recorded, redaction defaults, compatibility and retention.
Then implement nested argument redaction for all tools and bounded automatic pruning using the existing prune
implementation. Preserve identity, tool, outcome/status and attempt-before-write guarantees.
Done when sensitive values are absent from stored audit arguments, retention is tested, and operator docs
explain defaults and configuration. Avoid requiring a migration unless the existing schema cannot support it.

## 2. Safe rollback

Issue: [#17](https://github.com/ozerozdas/castra/issues/17).
Status: released in 0.3.0 with ADR 0085; Worker-only, single-D1 compatibility markers, dry-run and confirmation.
Successful live rollback and config/schema mismatch rejection verified on the isolated example Worker/D1.
Schema probe cleaned up and unchanged deployment verified; see PROGRESS.md. Released in 0.3.0.

Original acceptance plan: first decide Worker-only rollback versus coordinated D1 restore in an ADR. Prefer the smallest safe initial
scope: record deploy/schema compatibility and refuse rollback when compatibility cannot be established.
Do not assume Worker rollback reverses migrations. Decide how to preserve compatibility metadata and how
D1 backups/bookmarks fit before implementing commands.
Done when dry-run output identifies the target and schema checks, incompatible rollbacks fail closed,
and tests exercise compatible, incompatible and interrupted deployment cases.

## 3. Local MCP migrations

Issue: [#20](https://github.com/ozerozdas/castra/issues/20).
Define generation output and explicit apply confirmation in an ADR. Reuse the existing CLI migration path;
start locally and keep remote mutation outside the initial tool scope.
Done when a proposal is reviewable, unapproved apply cannot execute, and applied migrations integrate with
snapshot generation/drift checks. Test rejection and error paths as well as successful apply.

## Release gate and scope

For each implementation: targeted tests, required CI checks, updated security/operator docs and upgrade notes
when scaffold/config behavior changes. Use a disposable D1/Worker for destructive rollback and migration tests.
The production API remains the consumer smoke-test target; avoid creating test data there by default.
Publish a hardening patch for backward-compatible fixes; additions or config changes require a version decision.

Defer R2 routes, bulk operations, deeper includes and multi-tenancy until these operational tasks are complete.
Blog frontend publication is a separate deployment task. Do not add it to this backend hardening release.

## v0.3.0 preparation

Audit hardening and safe rollback are prepared together on `codex/release-v0.3.0`. All required local CI gates,
0.2.1 upgrade tests and six-package tarball checks passed; release notes are in `releases/0.3.0.md`.
PR #22 merged, CI/CodeQL passed and six npm packages published at 0.3.0. MCP migrations and
the consumer production upgrade remain subsequent work.
