# 0030. Provisioning through the Cloudflare REST API, state in `wrangler.jsonc`

## Status
Accepted (2026-10-10).

## Context
`castra provision` must create D1, KV and (optionally) R2 resources idempotently and record them in the
project's `wrangler.jsonc` (ARCHITECTURE §6). Two transports exist: `wrangler d1 create` / `wrangler kv namespace
create` / `wrangler r2 bucket create`, or the REST API directly. Tests must never touch a real account.

## Decision
- Resources are created through the Cloudflare REST API v4 (`https://api.cloudflare.com/client/v4`) with a small
  typed client (`packages/cli/src/cloudflare/api.ts`) that takes an injectable `fetch`. Endpoints used, verified
  on developers.cloudflare.com/api on 2026-10-10:
  - `GET /user/tokens/verify`, fallback `GET /accounts/{id}/tokens/verify` (account-owned tokens)
  - `GET /accounts`
  - `GET|POST /accounts/{id}/d1/database` (`?name=` filter), `POST /accounts/{id}/d1/database/{uuid}/query`
  - `GET|POST /accounts/{id}/storage/kv/namespaces` (paged, `per_page` ≤ 1000; body `{ title }`)
  - `GET|POST /accounts/{id}/r2/buckets` (`name_contains`, cursor paging; body `{ name }`)
  - `GET /accounts/{id}/workers/scripts/{name}/secrets`, `GET /accounts/{id}/workers/subdomain`
- Wrangler is still used for what it owns (migrations, `secret put`, `deploy`), behind an injectable `exec`.
- **Identity is the name.** D1 is looked up by `database_name` (defaults to `<worker>-db` and is written back if
  absent); the KV namespace bound as `CACHE` is titled `<worker>-cache`; the R2 bucket defaults to
  `<worker>-storage`. Lookup by exact name happens first; create only on a miss. A second run issues zero POSTs.
- Ids of all zeros/dashes (the scaffold's `00000000-0000-0000-0000-000000000000`) or empty mean "not provisioned".
  A real-looking id that does not match the named resource is replaced with a warning.
- The config is edited with `jsonc-parser` `modify` + `applyEdits` (indent detected from the file), so comments,
  key order and untouched lines are preserved byte for byte. The file is only written when something changed.
- The account is `--account-id`, else `CLOUDFLARE_ACCOUNT_ID`, else the only account `GET /accounts` returns;
  several accounts is an error that lists them.

## Consequences
- Renaming a database in `wrangler.jsonc` provisions a new one; the old one is left alone (never deleted).
- Only top-level bindings are provisioned; `env.<name>` overrides are not handled yet.
- `create-castra` can import `provision`, `connect`, `CloudflareApi` from `@castra/cli` instead of re-implementing.
