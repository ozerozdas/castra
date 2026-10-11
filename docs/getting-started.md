# Getting started

Requirements: Node >= 20, pnpm 10. No Cloudflare account is needed until the deploy step.

## 1. Scaffold

```sh
npm create @castra-kit@latest my-app    # or: pnpm create @castra-kit my-app
cd my-app
```

Scaffolder options: `--template <name>` (only `default`), `--package-manager pnpm|npm`, `--no-install`,
`--local-packages <path>`.

To try unreleased changes, build a checkout and scaffold **outside** it (a project inside the repo would be taken for
part of the pnpm workspace). `--local-packages` is only supported with pnpm
([ADR 0036](adr/0036-create-castra-local-packages.md)):

```sh
git clone git@github.com:ozerozdas/castra.git && cd castra
pnpm install && pnpm -r build
cd ~/projects
node <path-to-castra>/packages/create-castra/dist/cli.js my-app --local-packages <path-to-castra>
```

## 2. Run locally

```sh
cp .dev.vars.example .dev.vars   # set BETTER_AUTH_SECRET: openssl rand -base64 32
pnpm db:migrate:local            # castra migrate --local: applies migrations/ to the local D1
pnpm dev                         # wrangler dev, http://localhost:8787
```

## 3. First request

```sh
curl localhost:8787/health
curl localhost:8787/openapi.json                    # only open operations are listed
curl localhost:8787/api/notes                       # anonymous: public notes only (empty list at first)

# sign up (Better Auth); the session token comes back in the set-auth-token header
curl -i -X POST localhost:8787/api/auth/sign-up/email \
  -H 'content-type: application/json' -H 'origin: http://localhost:8787' \
  -d '{"email":"me@example.com","password":"correct-horse-battery","name":"Me"}'

# TOKEN = the value of the set-auth-token response header above
curl -X POST localhost:8787/api/notes -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"hello","is_public":1}'
```

`owner_id` is filled in by the server; sending a different one is rejected with 403.

## 4. Define a policy

Tables are closed until `castra.config.ts` opens them. Add a table and open it:

```sh
echo 'CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL);' > migrations/0004_tags.sql
pnpm db:migrate:local
```

```ts
// castra.config.ts, inside tables: { ... }
tags: { read: isPublic(), create: role("admin") },
```

Until `pnpm generate` (step 5) refreshes `castra/schema.json`, the new table's routes answer 404. The Worker reads
the committed snapshot, not the live database, and a configured table that is missing from the snapshot stays closed.

Then add an allow and a deny test per rule to `test/policies.test.ts` (a rule without both is incomplete).

## 5. Regenerate the snapshot and run the policy tests

```sh
pnpm generate            # castra generate: writes castra/schema.json and castra/db.d.ts; commit both
pnpm test:policies       # castra test policies: runs `vitest run policies` on a local D1
```

## 6. Deploy

Create a Cloudflare API token with the minimum permissions in [cloudflare-token.md](cloudflare-token.md)
(Workers Scripts Edit, D1 Edit, Workers KV Storage Edit; R2 only with storage).

```sh
export CLOUDFLARE_API_TOKEN=...      # never commit this
export CLOUDFLARE_ACCOUNT_ID=...     # optional if the token sees exactly one account
pnpm doctor                          # castra doctor: read-only permission/binding/drift check
pnpm provision                       # castra provision: creates D1 + KV, writes ids into wrangler.jsonc
pnpm migrate                         # castra migrate --remote
pnpm run deploy                      # castra deploy: all of the above, drift check, secret, wrangler deploy
```

Use `pnpm run deploy`: `pnpm deploy` is a built-in pnpm command. `castra deploy` is idempotent, generates
`BETTER_AUTH_SECRET` as a Worker secret the first time, and prints the API, `/openapi.json` and `/mcp` URLs.
