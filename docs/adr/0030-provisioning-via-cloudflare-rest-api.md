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
  A real-looking id that does not match the named resource is replaced with a warning (superseded for D1 by the
  2026-10-11 amendment below: refused).
- The config is edited with `jsonc-parser` `modify` + `applyEdits` (indent detected from the file), so comments,
  key order and untouched lines are preserved byte for byte. The file is only written when something changed.
- The account is `--account-id`, else `CLOUDFLARE_ACCOUNT_ID`, else the only account `GET /accounts` returns;
  several accounts is an error that lists them.

## Consequences
- Renaming a database in `wrangler.jsonc` provisions a new one; the old one is left alone (never deleted).
- Only top-level bindings are provisioned; `env.<name>` overrides are not handled yet.
- `create-castra` can import `provision`, `connect`, `CloudflareApi` from `@castra/cli` instead of re-implementing.

## Amendment (2026-10-11): refuse a mismatched D1 id; valid R2 bucket names

- **Mismatched D1 id is refused, not repointed.** The original decision replaced a real-looking `database_id` that
  did not match the database named `database_name` (with a warning). When no database had that name, this
  created a NEW empty database and silently switched the Worker to it (M5 review R5-6). Now `castra provision`
  (and so `castra deploy`) stops with a `d1-id-mismatch` problem (exit 1) before any create call or file write.
  The fix hint offers both resolutions: set `database_name` to the database the id belongs to, or reset
  `database_id` to the all-zeros placeholder to adopt/create the named database. An id that matches the named
  database, and placeholder ids, behave as before. The KV namespace still prefers a configured id that exists.
- **R2 bucket names stay valid** (R5-2). R2 allows 3-63 characters of `a-z`, `0-9` and `-`, not starting or
  ending with `-` (https://developers.cloudflare.com/r2/buckets/create-buckets/, checked 2026-10-11). A Worker
  name may be 63 characters, so `<worker>-storage` can exceed the limit. When it would (or when the Worker name
  has characters R2 refuses), the default is `<truncated worker>-<first 8 hex of sha256(worker)>-storage`:
  deterministic, so re-runs find the same bucket. An explicit `bucket_name` is never changed. D1 database names
  have no documented length limit and KV titles allow 512 characters, so their derivations are unchanged.
