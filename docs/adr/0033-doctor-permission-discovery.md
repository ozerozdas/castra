# 0033. `castra doctor` discovers token permissions by read-only probing

## Status
Accepted (2026-10-10).

## Context
`castra doctor` must list missing token permissions. Cloudflare has no "what can this token do" endpoint that
every token can call:
- `GET /user/tokens/verify` (or `/accounts/{id}/tokens/verify` for account-owned tokens) returns only `id` and
  `status`.
- `GET /user/tokens/{id}` returns the policies, but requires "API Tokens Read", which a least-privilege deploy
  token does not have (and should not need).
Write probes (create then delete a resource) would detect Edit precisely but mutate the account, which a
diagnostic command must not do.

## Decision
For each required permission, in order:
1. If the token can read its own policies (`GET /user/tokens/{id}` or `/accounts/{a}/tokens/{id}`), use them:
   an allow policy containing the Edit group (or its "Write" alias) means `ok`; only the Read group means `missing`.
2. Otherwise run a read-only probe (`GET` list endpoint) for the product:
   Workers Scripts → `/accounts/{a}/workers/scripts`, D1 → `/d1/database`, KV → `/storage/kv/namespaces`,
   R2 → `/r2/buckets`. 401/403 (or Cloudflare codes 1000/10000) → `missing`; success → `readable`, meaning
   "at least Read; Edit not verifiable without writing".
3. Exit 1 when any required check is `missing`. `readable` does not fail the run but is explained in the output.

Doctor never issues anything but `GET`. Unprovisioned bindings are warnings, not failures (expected before the
first deploy). The schema drift check runs only when a local D1 exists (`.wrangler/state/v3/d1`).

## Consequences
- A token with only Read permissions passes doctor as `readable` and fails later at create time; provision and
  deploy then raise a `missing-permission` problem naming the exact group, so the fix is still obvious.
- Users who want a precise report can temporarily add "API Tokens Read" to the token.

## Amendment (2026-10-11): account scope, deny policies, probe always runs

The M5 review (R5-1) found that step 1 trusted every allow policy, whatever account it was scoped to, and ignored
deny policies, so a token whose Edit rows were granted on another account (or explicitly denied) was reported `ok`.

- A policy counts only if its `resources` contain `com.cloudflare.api.account.<accountId>` or
  `com.cloudflare.api.account.*` with the value `"*"` (format from
  https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/, checked 2026-10-11). A nested object
  value selects zones inside the account and does not count; zone and user keys never count. Cloudflare documents
  no organization-level resource key for token policies, so none is recognised.
- Deny policies covering the account remove their groups (Cloudflare evaluates explicit deny before allow).
- The read-only probe now always runs. A 401/403 is `missing` even when the policies say Edit. When the probe
  succeeds, the policies decide: Edit → `ok`, Read only → `missing`, neither (a format doctor does not parse) →
  `readable`. Without readable policies the behaviour is unchanged (`readable`).
