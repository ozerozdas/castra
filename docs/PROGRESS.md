# Progress

## Status (2026-10-11)
v0.1 is complete in this repository. Milestones M1-M6 are signed off:

| Milestone | Signed off by |
| --- | --- |
| M1 policy engine, M1 schema snapshot | review 3 (after reviews 1 and 2 and their fixes) |
| M2 REST API | review 3, findings fixed |
| M3 auth | review 1 (M1/M3 security review), findings fixed |
| M4 MCP | review 4, findings fixed |
| M5 CLI and create-castra | review 5, findings fixed |
| M6 README, SECURITY.md, final state | final v0.1 review, findings FR-1 to FR-3 and doc items fixed (below) |

Tests at sign-off (`pnpm -r test`, all passing, local D1 through the Workers pool where noted):

| Package | Files | Tests |
| --- | --- | --- |
| `castra` (core, Workers pool) | 28 | 779 |
| `@castra-kit/auth` (Node) | 2 | 20 |
| `@castra-kit/mcp` (Workers pool) | 5 | 83 |
| `@castra-kit/cli` | 10 | 102 |
| `create-castra` | 5 (1 skipped: opt-in e2e) | 48 (43 passed, 5 skipped) |
| `create-castra` template (`test:template`) | 2 | 28 |
| `examples/blog` (Workers pool) | 7 | 103 |

**Remaining human-only steps:**
- Real-account deploy: done 2026-10-11 by the human with a project scaffolded by `create-castra` (same template
  and migrations as `examples/blog`). `castra deploy` provisioned D1 + KV, applied the 3 migrations remotely, set
  `BETTER_AUTH_SECRET` and deployed to `workers.dev`. Live checks: `/health` 200, `/api/notes` 200 (empty),
  `/openapi.json` lists only `notes`, `/api/users` and `/api/_castra_audit` 404, anonymous `POST /api/notes` 401,
  `/mcp` without a token 401. Hit on the way: an account token (`cfat_`) without `CLOUDFLARE_ACCOUNT_ID` was
  reported as invalid, and an `All accounts` token stopped at `multiple-accounts`; the CLI now names the
  `cfat_` case before any call and refuses `cfk_` Global API Keys; docs/cloudflare-token.md shows the token form.
- Push, publish and package-name decisions. Nothing is pushed or published, and `npm create @castra-kit@latest` needs a
  published package (ADR 0004).

## Done
- **Final v0.1 review fixes** (2026-10-11). The review tests are in
  `packages/core/test/api/final-review.d1.test.ts` and all pass with their assertions unchanged.
  - FR-1 (Medium): a `UNIQUE`/`PRIMARY KEY ... ON CONFLICT REPLACE` constraint let a create or update silently delete
    another user's conflicting row. `introspect` now flags such tables conservatively from `sqlite_master.sql`
    (`TableSnapshot.conflictReplace`; `NOT NULL ON CONFLICT REPLACE` is not flagged). The engine refuses create and
    update on them for every caller with 403 `unsafe_schema`. OpenAPI and MCP do not advertise those writes, and
    `castra generate` warns. The REST/MCP write path issues no `INSERT OR REPLACE` or upsert (ADR 0066). The blog
    and template snapshots are unchanged; they have no such clause.
  - FR-2 (Low-Medium): a create/update that cannot be re-read returns the primary key only when the caller may read
    the key column, `{}` otherwise. MCP has no write path, so it has no such response.
  - FR-3 (Low): OpenAPI advertises `POST` only with a single-column primary key, and `/{id}` routes only for a key
    column that is not hidden. This now matches REST.
  - The dummy-hash constant-time path has tests (`packages/auth/test/api-key-timing.test.ts`,
    `packages/mcp/test/token-timing.test.ts`). `sha256Hex` and `timingSafeEqual` moved to `packages/auth/src/hash.ts`
    and are still exported.
  - New allow and deny tests: `packages/core/test/api/final-review-fixes.d1.test.ts`,
    `packages/mcp/test/final-review.test.ts`, and `packages/cli/test/generate.test.ts` (flag and warning).
  - The template's "OpenAPI lists only notes" test checks that notes is present and the closed tables are absent, so
    the README quickstart (adding `tags`) passes `pnpm test:policies` unchanged.
  - Docs: SECURITY.md (FR-1 as guarantee 18, FR-2/FR-3 under guarantees 6/7, test references for API keys and the
    dummy hash, FK existence oracle, weak secret fails on the first auth request); README (404 until
    `pnpm generate`, `BETTER_AUTH_URL`/origin behaviour, OpenAPI wording, `unsafe_schema`); `.dev.vars.example`
    wording.
- **M0 Foundation** (2026-10-10)
  - pnpm workspace: `castra` (core), `@castra-kit/auth`, `@castra-kit/mcp`, `@castra-kit/cli` (bin `castra`),
    `create-castra` (bin). All private, nothing published. Each has tsup build, placeholder `src/index.ts`,
    a passing vitest test and a tsconfig extending `tsconfig.base.json`.
  - Root scripts: `build`, `test`, `test:policies` (`--passWithNoTests`), `lint` (ESLint flat), `typecheck`
  - Contract types in `packages/core/src/types.ts` (`SchemaSnapshot`, `CastraContext`, `Operation`, ...).
    `packages/core/src/policy/` and `schema/` reserved.
  - `examples/blog`: Hono `/health`, D1 migration (`users`, `posts`, `comments`, `audit_logs`), seed,
    vitest test with `@cloudflare/vitest-plugin` applying migrations. `wrangler dev` verified locally.
  - GitHub Actions CI, ADRs 0001-0004, README stub.

- **M6 README (signed off by the final review + fixes)**: v0.1 `README.md` (quickstart, concepts, config/REST/CLI reference, D1 limits cited from Cloudflare docs); `docs/SECURITY.md` now points to `castra test policies`.
- **M5 review fixes (2026-10-11), M5 signed off by review 5 + these fixes.** Review tests:
  `packages/cli/test/review5.test.ts`, `packages/create-castra/test/review5.test.ts` (no `it.todo` left).
  - R5-1 doctor: token policies count only when their `resources` cover the target account
    (`com.cloudflare.api.account.<id>` / `.*`), deny policies remove groups, the read-only probe always runs and a
    403 is `missing` whatever the policies say (ADR 0033 amendment).
  - R5-2 provision: default R2 bucket name stays within 3-63 chars (`<truncated>-<sha256 8>-storage`, deterministic);
    D1/KV names unchanged (no documented D1 limit, KV titles up to 512) (ADR 0030 amendment).
  - R5-3 CI runs on pushes to `master`.
  - R5-4 `spawnExec` swallows stdin EPIPE and returns the child's exit code.
  - R5-5 deploy/migrate pass `CLOUDFLARE_API_TOKEN` from the injected env to wrangler (ADR 0032 amendment).
  - R5-6 provision refuses (`d1-id-mismatch`, exit 1) a real `database_id` that is not the named database instead
    of repointing it to a new empty database (ADR 0030 amendment).
  - R5-7 `castra`: runtime `CliError`s (config not found, unprovisioned binding) exit 1; `UsageError` exits 2.
  - R5-8 `.gitignore` (template and repo root) ignores `.dev.vars*` / `.env*`, keeps `.dev.vars.example` / `.env.example`.
- **M5 create-castra + `castra test policies` (signed off by review 5 + fixes)**
  - `create-castra <name> [--template default] [--package-manager pnpm|npm] [--no-install] [--local-packages <repo>]`:
    copies `template/`, renames `_gitignore` / `_dev.vars.example`, substitutes the name in `package.json`,
    `wrangler.jsonc` (`<name>`, `<name>-db`) and `README.md`, refuses a non-empty target, installs, prints next steps
    (ADR 0035). `--local-packages` links the four Castra packages from a checkout (`link:` pnpm, `file:` npm; ADR 0036).
  - Template: `notes` table with public/owner/admin policies, auth + MCP migrations identical to the blog's,
    committed snapshot and types, Workers-pool tests (`health`, `policies` with allow AND deny per rule), scripts
    `dev`, `test`, `test:policies`, `db:migrate:local`, `generate`, `provision`, `doctor`, `migrate`, `deploy`.
  - The template is linted, typechecked (`tsconfig.template.json`) and tested inside the monorepo;
    `test/template-drift.test.ts` runs real `castra migrate --local` + `castra generate --check` on a scaffolded copy.
  - `castra test policies` runs the project's `vitest run policies` (ADR 0037). `castra init` deferred (ADR 0038).
  - `examples/blog`: `provision`, `doctor`, `migrate` (`--remote`), `deploy` scripts via `@castra-kit/cli`.
  - E2E (opt-in, `pnpm --filter @castra-kit/create test:e2e`): scaffold with `--local-packages` → `pnpm install` →
    typecheck → tests + `test:policies` → `db:migrate:local` + `castra generate --check` → `wrangler dev` on a free
    port, `/health` and `/api/notes` answer, the dev server's process group is stopped. Passed locally 2026-10-11;
    not in CI (needs the registry or a warm pnpm store).
  - Not done: publishing (nothing is on npm, so plain `npm create @castra-kit@latest` does not work yet), npm-flavoured e2e,
    `castra init`.
- **M2 REST API (signed off by review 3, findings fixed)**
- **M4 MCP (signed off by review 4 + fixes)**
  - `@castra-kit/mcp`: four read-only tools (`describe_schema`, `check_access`, `explain_query`, `query_data`) defined
    once and served by both transports. They run on the same engine and REST pipeline (ADR 0060).
    `query_data` ≡ REST, asserted for 5 identities × 10 requests.
  - Remote: `createMcpRoute` / `handleMcpRequest`, stateless Streamable HTTP with JSON responses (SDK 1.32.1,
    ADR 0062). It accepts `castra_mcp_` tokens only (`_castra_mcp_tokens`, SHA-256 hashed, constant-time).
    Scopes are `schema:read`, `access:check`, `data:read` and `data:read:any_user` (ADR 0061).
  - Audit: a fail-closed `_castra_audit` row per message (ADR 0063).
  - `explain_query` explains writes without executing them (ADR 0064).
  - CLI:
    - `castra mcp`: stdio against the local D1, `as` impersonates anyone (ADR 0065).
    - `castra mcp token create|revoke [--local|--remote]`.
  - `examples/blog`: `0003_mcp.sql`, `/mcp` mounted before the session/API-key middleware, snapshot regenerated
    (new tables present, unexposed).
  - Not done:
    - Stdio MCP against the remote D1 via the API token (ARCHITECTURE §5 "Local").
    - Audit retention.
    - A `castra mcp token list` command.
- **M4 review fixes** (review 4, 2026-10-11)
  - Audit (ADR 0063 amendment):
    - Every message of a batch is audited with its own outcome.
    - A batch with duplicate request ids is refused before any tool runs, and each message is audited as
      `rejected`.
    - Transport rejections (406, 415, ...) are audited with the real HTTP status.
    - JSON-RPC error responses are audited as `error`, not `ok`.
  - `/mcp` refuses a `Content-Length` over 1 MiB with 413 before reading the body. The read body is still checked
    (ADR 0062 amendment).
  - `check_access` validates `row` as a plain object and passes it to the engine unchanged. An own `__proto__`
    key now gets the same 400 as REST.
  - Remote `as` (ADR 0061 amendment): explicit roles are rejected, and roles always come from `_castra_roles`.
    An unknown `userId` is a 400 `unknown_user`. Local stdio is unchanged.
  - Tests: 4 reviewer BUG tests in `packages/mcp/test/review4.test.ts` now pass. The design pin for explicit roles
    asserts the new behaviour. 5 regression tests were added in `packages/mcp/test/remote.test.ts`.
- **M2 REST API (details; signed off by review 3)**
  - `castra` core `src/api`: `parseRequest` → `planRequest` (compiled SQL + explanations, no execution) →
    `executePlan`; `createRestRouter` (Hono, problem+json, `beforeRequest` hook), `generateOpenApi` (3.1),
    ADRs 0040–0044.
  - Creates/updates use `engine.writeGuard` + `runGuardedWrite` (ADR 0050): one atomic [write, guard] D1 batch,
    then a re-read under the read policy. No D1 binding → 500, nothing written.
  - `examples/blog`: `castra.config.ts` (§7), REST routes mounted, snapshot regenerated with auth tables.
- **M1 schema snapshot (signed off by review 3)**
  - `castra` core: `introspect(query)`, `generateKyselyTypes(snapshot)`, `diffSnapshots(a, b)` in
    `packages/core/src/schema`, tested against a real miniflare D1 (core now runs its tests in the Workers pool).
  - `@castra-kit/cli`: `castra generate [--local] [--config] [--out] [--binding] [--check]`; other subcommands print
    "not implemented yet" and exit 2. Reads local D1 through wrangler `getPlatformProxy` (ADR 0011).
  - `examples/blog/castra/schema.json` + `db.d.ts` generated from the local blog D1.
  - Mapping decisions (INTEGER PRIMARY KEY `notNull`, index/FK rules) in ADR 0010; `SchemaSnapshot` unchanged.
  - D1 PRAGMAs verified: `table_list`, `table_info`, `table_xinfo`, `foreign_key_list`, `index_list`, `index_info`,
    `index_xinfo`, `foreign_keys` work; `user_version`, `schema_version`, `compile_options` are rejected;
    D1 refuses to create `_cf_*` tables (the filter is covered with a stubbed query).
- **M3 auth (signed off by review 1 + fixes)**
  - `@castra-kit/auth`: `createAuth` (Better Auth 1.7.7, native D1, email+password, GitHub when env set,
    bearer plugin), `resolveContext` (session / API key / anonymous), roles helpers, API keys
    (`_castra_api_keys`, SHA-256 hashed), Hono `authRoutes`, `castraContext`, `requireRole`.
  - `examples/blog`: `0002_auth.sql` (generated Better Auth tables + `_castra_roles` + `_castra_api_keys`),
    `/api/auth/*`, `/me`, `GET /admin/ping` (admin only), `.dev.vars.example`.
  - Sessions checked against D1 every request, no KV/cookie cache. ADRs 0020-0023.
  - Tests at M3: 15 unit (auth), 24 integration against local D1 (blog). Now 20 unit tests in 2 files (auth), and
    103 tests in 7 files (blog), see Status.
  - Not done: GitHub OAuth flow only unit-tested (no network); no HTTP endpoints for API key management;
    no `users` mirror repair command.
- **M1 policy engine (signed off by review 3)**
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
- **M5 CLI provision/doctor/migrate/deploy (signed off by review 5 + fixes)**
  - `@castra-kit/cli`: `castra provision [--config] [--account-id] [--storage]`, `castra doctor`,
    `castra migrate [--local|--remote]`, `castra deploy`. Cloudflare REST client behind injectable `fetch`,
    wrangler behind injectable `exec`; all exported from `packages/cli/src/index.ts` for `create-castra`.
  - Provision is find-by-name then create; ids written with `jsonc-parser` edits (comments preserved); second run
    makes 0 POSTs. KV `CACHE` added when missing; R2 only with `--storage` or existing `r2_buckets` (ADR 0031).
  - Deploy: provision → `migrate --remote` → drift check against remote D1 via D1 HTTP query → `BETTER_AUTH_SECRET`
    (32 random bytes, stdin only, only if missing) → `wrangler deploy` → prints API, `/openapi.json`, `/mcp`.
  - Doctor: read-only probes (+ token policies if "API Tokens Read"), binding and local drift checks (ADR 0033).
  - Minimum token permissions with sources: `docs/cloudflare-token.md`. ADRs 0030–0034.
  - Tests: fake Cloudflare API + fake wrangler; global `fetch` stubbed to fail. Nothing run against a real account.
  - Not done: `env.*` overrides in wrangler.jsonc, `castra init` (deferred, ADR 0038), `--persist-to`,
    custom domains/routes in the printed URL beyond what wrangler prints.

- **M1/M3 security review findings fixed** (2026-10-10)
  - `checkRow` numeric-text detection is ASCII-whitespace only, as SQLite (Unicode whitespace stayed TEXT while the
    check CAST it to a number: WITH CHECK bypass).
  - `owner()` columns are implicitly `setBy: "server"` (ADR 0007 amendment).
  - `hidden` columns in `filterable` are a config error; new `PolicyEngine.canFilter(table, column, ctx)` for the API
    layer (M2 must call it for every filtered/sorted column).
  - `buildAuthOptions` rejects the `.dev.vars.example` placeholder and weak secrets.
  - Schema introspection uses `pragma_*()` table-valued functions with bound parameters (ADR 0009).
- **Second security review findings A-F fixed** (2026-10-10, ADR 0050)
  - Authoritative WITH CHECK is now `PolicyEngine.writeGuard(table, op, ctx, pk | "last_insert_rowid")` +
    `runGuardedWrite(env.DB, write, guard)`: the guard runs on the stored row after the write in one atomic
    D1 `batch()`; a violation raises `bad JSON path: 'castra_write_check_failed'` → 403 `write_check_failed`, the
    write is rolled back. Other DB errors are rethrown unchanged. A missing row fails closed.
  - `checkRow` is a documented dry run: literal column defaults on create (C), integral numbers as INTEGER (B),
    STRICT `ANY` verbatim (E); flags `approximate` otherwise. Collations (D) are only enforced by the guard.
  - `prepareWrite` rejects non-numeric text for numeric-affinity columns with 400 (A), except DATE/TIME types.
  - `TableSnapshot.strict?: true` (additive) from `pragma_table_list`; `diffSnapshots` reports STRICT changes.
  - `Rule` deep-copies and deep-freezes its node; `createPolicyEngine` keeps a frozen `structuredClone` of the
    snapshot (F). `canFilter` is false for tables without an open `read`.
  - M2 API layer must use `runGuardedWrite` for every create/update (see ADR 0050 Consequences).

- **Third security review findings fixed** (2026-10-10; M1 + M2 signed off)
  - Unmatched paths/methods and uncaught exceptions are `application/problem+json` (404 / generic 500):
    `withProblemHandlers(app)` (core, exported) is used by `createRestRouter` and the blog root app.
  - `like` filters capped at 256 chars / 10 wildcards (400); D1 "LIKE or GLOB pattern too complex" maps to 400.
  - Field write permission (ADR 0007 amendment 2): a `visibleTo` field is writable only by a ctx that could read it.
  - Item routes (`GET/PATCH/DELETE /:id`) are 404 for ctxs that cannot read the primary key
    (`PolicyEngine.canReadColumn`).
  - `d1_migrations` is a reserved table.

- **M6: SECURITY.md** (2026-10-11, signed off by the final review + fixes): `docs/SECURITY.md` threat model,
  guarantees, known issues and operator checklist.

## Problem type pages
Live since 2026-10-11 at https://castra.mehmetozer.dev/problems/ (static-assets Worker `castra-site`, account Nuvo
Code, custom domain). Built from `site/problems.json` by `pnpm site:build`, deployed by `pnpm site:deploy`
(wrangler login or a token with Workers Scripts Edit + Zone Workers Routes Edit). A core test fails when an emitted
code has no page.

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
- `custom()` / `where()` predicates may contain subqueries that read reserved tables (Better Auth, `_castra_*`).
  The engine cannot see inside raw `sql` and only validates table names it can walk; reading such tables in a
  predicate is the config author's responsibility. Documented in `docs/SECURITY.md` section 3.
- Very deep rule nesting (~5000 alternating `and`/`or` levels) overflows the stack while the config is built
  (rule copy, validation, compilation). Fails at startup, never at request time; accepted.
- Column collations are not in the snapshot, so `checkRow` (dry run) compares with BINARY; only the guarded
  write (ADR 0050) is exact. MCP `check_access` answers may differ from the real write for NOCASE/RTRIM columns.
- `prepareWrite` does not reject primary-key changes on update; with `runGuardedWrite` the guard must be given the
  new key, otherwise the write fails closed (403).
- Contract types: `ColumnSnapshot.notNull` for INTEGER PRIMARY KEY columns follows `PRAGMA table_info`; Schema agent should confirm.
- npm package names (ADRs 0004, 0068, 0069): everything is under the `castra-kit` org (created 2026-10-11):
  `@castra-kit/core`, `@castra-kit/auth`, `@castra-kit/mcp`, `@castra-kit/cli`, `@castra-kit/create`. npm refused
  `castra` as too similar to `astro`. The binary stays `castra`, the import is `@castra-kit/core`.
- `pnpm install` emits no peer warnings, but two workerd versions are installed (wrangler vs the plugin's miniflare).
- `isReservedTable` hard-codes the four Better Auth tables (`user`, `session`, `account`, `verification`). A Better Auth
  plugin that adds tables must also add them to `AUTH_TABLES`, or the policy engine could expose them. v0.1 uses only the
  `bearer` plugin, which adds no tables.
- Constraint 409s act as existence oracles: unique constraints on client-chosen values, FK children blocking a
  delete, and FKs into a table without an open `read` policy (left to the database: success vs 409) reveal that a row
  exists even if the caller cannot read it. Documented in `docs/SECURITY.md` section 3.
- A table with `ON CONFLICT REPLACE` on a `UNIQUE`/`PRIMARY KEY` constraint can be read and deleted through Castra
  but not created into or updated (403 `unsafe_schema`, ADR 0066). That is intended. Triggers are trusted schema code
  and can still change other rows.
- The keyset cursor always compares on the primary key even when the PK is not in `filterable`. The PK is visible
  to anyone who can open item routes (they are 404 otherwise), so nothing leaks.
- The example config makes `comments` public, including comments on draft posts (intended, ARCHITECTURE §7).
- Better Auth `/api/auth/*` errors are not `application/problem+json`.
- One-to-many includes are truncated at 25 rows per parent and the response does not signal it.
- Writing a `visibleTo` column without the role answers 403, which reveals the column exists (ADR 0007 amendment 2).
- MCP `access:check` tokens can learn the names of `hidden: true` columns. `check_access` explanations list them in
  `hiddenFields`, and `explain_query` shows them in the planned SELECT. Their values are never shown. This is by
  design (ARCHITECTURE §3, "which fields were hidden"), and pinned in `packages/mcp/test/review4.test.ts`.
- `_castra_audit` growth: a request with a known MCP token id and a wrong secret writes one audit row per request
  (ADR 0063), and `/mcp` has no rate limit. Anyone who knows a token id can grow the table. There is no retention
  policy yet.
- `_castra_audit.arguments` stores tool arguments verbatim, up to 4 KB. Filters, paths and `check_access` rows can
  contain PII, so operators should treat the table as sensitive and prune it.
- No rate limiting on `/mcp` (or REST, ADR 0003). Put a Cloudflare rate-limiting rule (WAF) in front of `/mcp`,
  for example keyed on the `Authorization` header or the IP address.
