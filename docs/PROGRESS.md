# Progress

## Done
- **M0 Foundation** (2026-10-10)
  - pnpm workspace: `castra` (core), `@castra/auth`, `@castra/mcp`, `@castra/cli` (bin `castra`),
    `create-castra` (bin). All private, nothing published. Each has tsup build, placeholder `src/index.ts`,
    a passing vitest test and a tsconfig extending `tsconfig.base.json`.
  - Root scripts: `build`, `test`, `test:policies` (`--passWithNoTests`), `lint` (ESLint flat), `typecheck`
  - Contract types in `packages/core/src/types.ts` (`SchemaSnapshot`, `CastraContext`, `Operation`, ...).
    `packages/core/src/policy/` and `schema/` reserved.
  - `examples/blog`: Hono `/health`, D1 migration (`users`, `posts`, `comments`, `audit_logs`), seed,
    vitest test with `@cloudflare/vitest-plugin` applying migrations. `wrangler dev` verified locally.
  - GitHub Actions CI, ADRs 0001-0004, README stub.

## In progress
- Nothing.

## Decisions
Versions chosen (verified with `npm view` on 2026-10-10):

| Package | Version | Note |
| --- | --- | --- |
| pnpm | 10.30.3 | Node 26.3 locally; CI uses Node 22; engines `>=20` |
| typescript | 6.0.3 | 7.0.2 is latest but typescript-eslint 8.71.1 requires `<6.1.0` |
| vitest | 5.0.3 | plugin peer is `^4.1.0 \|\| ^5.0.0` |
| @cloudflare/vitest-plugin | 1.4.0 | replaces deprecated `@cloudflare/vitest-pool-workers` (0.23.0, README says renamed) |
| wrangler | 4.149.0 | |
| @cloudflare/workers-types | 5.20261010.1 | |
| hono | 4.13.13 | used in blog |
| tsup | 8.5.1 | |
| eslint / @eslint/js | 10.12.0 / 10.0.1 | flat config |
| typescript-eslint | 8.71.1 | |
| @types/node | 22.20.5 | `Headers` global for core types |
| kysely, kysely-d1, better-auth, zod, @modelcontextprotocol/sdk | 0.29.6, 0.4.0, 1.7.7, 4.6.5, 1.32.1 | latest as checked; NOT installed yet, owning agents must re-verify docs |

Other decisions:
- Pool package: used `@cloudflare/vitest-plugin` (`cloudflareTest` plugin, `readD1Migrations`, `applyD1Migrations`
  from `cloudflare:test`, `exports.default.fetch` from `cloudflare:workers`; `SELF` is deprecated).
- All blog primary keys are TEXT uuid, generated in the application, for consistency with Better Auth user ids.
- Blog `compatibility_date` is `2026-10-01` (workerd 1.20261006 bundled with wrangler 4.149.0).
- `tsconfig.base.json` sets `ignoreDeprecations: "6.0"` because tsup's dts build injects `baseUrl`.
- `test:policies` runs `vitest run --passWithNoTests policy` in `castra`: policy tests must have "policy" in their file path.
- Blog `build` is `wrangler deploy --dry-run --outdir dist` (no network, no token).
- pnpm `onlyBuiltDependencies` allows `esbuild` and `workerd` postinstall scripts.

## Open issues
- Contract types: `ColumnSnapshot.notNull` for INTEGER PRIMARY KEY columns follows `PRAGMA table_info`; Schema agent should confirm.
- Re-verify npm availability of `castra` / `create-castra` before any publish (ADR 0004).
- `pnpm install` emits no peer warnings, but two workerd versions are installed (wrangler vs the plugin's miniflare).
