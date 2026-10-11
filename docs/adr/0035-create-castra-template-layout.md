# 0035. `create-castra`: one template, copied from the package

## Status
Accepted (2026-10-11). Implements ARCHITECTURE §6 `npx create-castra <name>`.

## Context
`npx create-castra my-app` must produce a project that installs, typechecks, passes its own tests and deploys with
`castra deploy`. The template has to stay in step with the Castra packages it uses (migrations for Better Auth and
`_castra_*` tables, the committed schema snapshot, the CLI scripts) without a second copy of the blog example.

## Decision
- **One template, `template/` inside the `create-castra` package**, copied file by file. `--template` exists
  (only `default`) so more templates do not change the CLI. No remote template download, no prompts.
- **Contents mirror `examples/blog` conventions:** `castra.config.ts` (one `notes` table: public/owner/admin read,
  authenticated create, owner-or-admin update/delete), `migrations/0001_init.sql` (app tables + `users` mirror),
  `0002_auth.sql` and `0003_mcp.sql` (identical to the blog's), committed `castra/schema.json` + `castra/db.d.ts`,
  `wrangler.jsonc` with a placeholder `database_id` (`castra provision` replaces it), a Workers-pool
  `vitest.config.ts`, `test/policies.test.ts` (allow AND deny per rule) and `test/health.test.ts`.
- **Dotfiles are stored as `_gitignore` and `_dev.vars.example`** and renamed on copy: npm drops `.gitignore` from
  published tarballs. `.dev.vars.example` holds a placeholder that `@castra/auth` rejects at startup; no secret is
  ever generated into the project by the scaffolder (`castra deploy` sets the Worker secret).
- **Name substitution** is a literal replace of `castra-app` in `package.json` (via JSON rewrite), `wrangler.jsonc`
  (`name`, `database_name` = `<name>-db`) and `README.md`. Every other file is copied byte for byte. The name must
  be a valid Worker name (lowercase, digits, dashes, ≤ 63), which also makes it a safe directory name.
- **Non-empty targets are refused** (exit 1, nothing written); an existing empty directory is accepted.
- **Castra packages get the scaffolder's own version** (all packages release together); third-party versions are
  pinned to what the monorepo tests with.
- **The template is checked inside the monorepo**, not excluded: root `eslint .` lints it,
  `tsconfig.template.json` typechecks it against the package sources, `vitest run --root template` runs its
  Workers tests (part of `pnpm --filter create-castra test`), and `test/template-drift.test.ts` runs the real
  `castra migrate --local` + `castra generate --check` on a scaffolded copy so the committed snapshot and types
  cannot drift from the migrations. The template is not a workspace package (`packages/*` does not match it), so
  its `package.json` is never installed in the monorepo; its imports resolve through `create-castra`'s
  devDependencies.
- The template declares `@types/node` itself: `vitest.config.ts` uses `node:` imports and a scaffolded project has
  no hoisted monorepo types (found by the e2e test).

## Consequences
- Changing auth/MCP migrations in the blog means changing the template's copy too; the drift test catches a stale
  snapshot but not a forgotten migration. Kept as duplication rather than generating migrations at scaffold time.
- `pnpm deploy` is a pnpm built-in, so the docs say `pnpm run deploy`.
