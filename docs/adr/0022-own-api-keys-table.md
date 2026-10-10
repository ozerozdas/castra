# 0022. API keys in a small `_castra_api_keys` table instead of the Better Auth plugin

## Status
Accepted (2026-10-10).

## Context
Castra needs API keys that act as a user, carry an optional role subset, are revocable, can expire and
are stored hashed. Better Auth offers `@better-auth/api-key` 1.7.7. It brings its own `apikey` table
(about 20 columns: refill, rate limit, request counters, metadata, permissions), its own HTTP endpoints
under `/api/auth/api-key/*`, optional secondary-storage mode, and per-request counter writes. Its
permission model is not Castra's role list.

## Decision
Roll a minimal table and ~100 lines of code in `@castra/auth`:
- Key format `castra_ak_<16 hex id>_<43 char base64url secret>` (8 + 32 random bytes).
- Stored: `id` (public part), `key_hash` = SHA-256 hex of the full key, `user_id` (FK, cascade),
  `roles` (JSON array or `NULL` = all of the user's roles), `expires_at`, `revoked_at`.
- Verification: strict regex parse, lookup by id, constant-time comparison of hashes (performed even
  when the id is unknown), then revoked/expiry checks.
- Effective roles = key subset ∩ user's current grants ∩ configured roles. A key never adds roles.
- Keys are accepted from `x-api-key` or `Authorization: Bearer castra_ak_...`.
- A presented key that is malformed, unknown, revoked or expired yields the **anonymous** context
  and does not fall back to a session cookie on the same request. Protected routes therefore answer 401.
- Key management is a library API (`createApiKey`, `revokeApiKey`); no HTTP endpoints in v0.1.

## Consequences
- Smaller attack surface: no extra public endpoints, no counters written per request.
- No rate limiting or usage counters on keys (consistent with ADR 0003).
- SHA-256 without a salt is adequate because keys carry 256 bits of randomness.
