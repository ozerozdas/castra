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
- **M1 schema snapshot (pending review)**
  - `castra` core: `introspect(query)`, `generateKyselyTypes(snapshot)`, `diffSnapshots(a, b)` in
    `packages/core/src/schema`, tested against a real miniflare D1 (core now runs its tests in the Workers pool).
  - `@castra/cli`: `castra generate [--local] [--config] [--out] [--binding] [--check]`; other subcommands print
    "not implemented yet" and exit 2. Reads local D1 through wrangler `getPlatformProxy` (ADR 0011).
  - `examples/blog/castra/schema.json` + `db.d.ts` generated from the local blog D1.
  - Mapping decisions (INTEGER PRIMARY KEY `notNull`, index/FK rules) in ADR 0010; `SchemaSnapshot` unchanged.
  - D1 PRAGMAs verified: `table_list`, `table_info`, `table_xinfo`, `foreign_key_list`, `index_list`, `index_info`,
    `index_xinfo`, `foreign_keys` work; `user_version`, `schema_version`, `compile_options` are rejected;
    D1 refuses to create `_cf_*` tables (the filter is covered with a stubbed query).
- **M3 auth (pending review)**
  - `@castra/auth`: `createAuth` (Better Auth 1.7.7, native D1, email+password, GitHub when env set,
    bearer plugin), `resolveContext` (session / API key / anonymous), roles helpers, API keys
    (`_castra_api_keys`, SHA-256 hashed), Hono `authRoutes`, `castraContext`, `requireRole`.
  - `examples/blog`: `0002_auth.sql` (generated Better Auth tables + `_castra_roles` + `_castra_api_keys`),
    `/api/auth/*`, `/me`, `GET /admin/ping` (admin only), `.dev.vars.example`.
  - Sessions checked against D1 every request, no KV/cookie cache. ADRs 0020-0023.
  - Tests: 15 unit (auth), 24 integration against local D1 (blog).
  - Not done: GitHub OAuth flow only unit-tested (no network); no HTTP endpoints for API key management;
    no `users` mirror repair command.
- **M1 policy engine (pending review)**
  - `packages/core/src/policy/` (rules, compiler, engine, errors) + `src/config.ts` (`defineConfig`).
    Exports: `defineConfig`, `isPublic`, `authenticated`, `role`, `owner`, `custom`, `Rule`
    (`.and/.or/.where`), `createPolicyEngine` (`isOpen`, `readFilter`, `prepareWrite`, `checkRow`,
    `projectRow`, `explain`), `PolicyError`, `CastraConfigError`.
  - Tests in `packages/core/test/policy/`: Node unit tests + `*.d1.test.ts` on real local D1 (workerd),
    allow/deny per rule type × op, spoofing, field rules, explain, fast-check properties (300 runs each)
    against a JS oracle. ADRs 0005–0008.
  - Deps: `kysely` 0.29.6 (core dep); dev: `kysely-d1` 0.4.0, `fast-check` 4.10.2,
    `@cloudflare/vitest-plugin` 1.4.0, `@cloudflare/workers-types` 5.20261010.1.
  - Open: snapshot in policy tests is a hand-written fixture until the Schema agent's generator lands.
- **M5 CLI provision/doctor/migrate/deploy (pending review)**
  - `@castra/cli`: `castra provision [--config] [--account-id] [--storage]`, `castra doctor`,
    `castra migrate [--local|--remote]`, `castra deploy`. Cloudflare REST client behind injectable `fetch`,
    wrangler behind injectable `exec`; all exported from `packages/cli/src/index.ts` for `create-castra`.
  - Provision is find-by-name then create; ids written with `jsonc-parser` edits (comments preserved); second run
    makes 0 POSTs. KV `CACHE` added when missing; R2 only with `--storage` or existing `r2_buckets` (ADR 0031).
  - Deploy: provision → `migrate --remote` → drift check against remote D1 via D1 HTTP query → `BETTER_AUTH_SECRET`
    (32 random bytes, stdin only, only if missing) → `wrangler deploy` → prints API, `/openapi.json`, `/mcp`.
  - Doctor: read-only probes (+ token policies if "API Tokens Read"), binding and local drift checks (ADR 0033).
  - Minimum token permissions with sources: `docs/cloudflare-token.md`. ADRs 0030–0034.
  - Tests: fake Cloudflare API + fake wrangler; global `fetch` stubbed to fail. Nothing run against a real account.
  - Not done: real-account deploy (human), `env.*` overrides in wrangler.jsonc, `castra init`, `--persist-to`,
    custom domains/routes in the printed URL beyond what wrangler prints.

- **M1/M3 security review findings fixed** (2026-10-10)
  - `checkRow` numeric-text detection is ASCII-whitespace only, as SQLite (Unicode whitespace stayed TEXT while the
    check CAST it to a number: WITH CHECK bypass).
  - `owner()` columns are implicitly `setBy: "server"` (ADR 0007 amendment).
  - `hidden` columns in `filterable` are a config error; new `PolicyEngine.canFilter(table, column, ctx)` for the API
    layer (M2 must call it for every filtered/sorted column).
  - `buildAuthOptions` rejects the `.dev.vars.example` placeholder and weak secrets.
  - Schema introspection uses `pragma_*()` table-valued functions with bound parameters (ADR 0009).

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
- `isReservedTable` hard-codes the four Better Auth tables (`user`, `session`, `account`, `verification`). A Better Auth
  plugin that adds tables must also add them to `AUTH_TABLES`, or the policy engine could expose them. v0.1 uses only the
  `bearer` plugin, which adds no tables.
