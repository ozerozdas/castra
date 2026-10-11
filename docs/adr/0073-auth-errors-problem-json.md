# 0073. Better Auth errors as problem+json

## Status
Accepted (2026-10-11). Issue #7.

## Context
Every Castra error is `application/problem+json` except the responses of the Better Auth handler at `/api/auth/*`,
which answers `{ code, message }` as plain JSON. Clients had to handle two error formats.

## Decision
- `authRoutes` passes every handler response through `authProblem`. A status below 400 is returned untouched.
- An error becomes a problem with the original status, type `auth_error` (`rate_limited` for 429) and `detail` set to
  Better Auth's `message`.
- Better Auth's `code` and `message` stay as extension members, so `better-auth/client` still reads them.
- For a 5xx the body is not read: `detail` is a generic sentence and `code` is omitted, so a database error never
  reaches the client.
- Response headers are kept (Set-Cookie, Retry-After).

## Consequences
- Apps that use `authRoutes` get it by updating `@castra-kit/auth`. Apps that mount `auth.handler` themselves can wrap
  it with the exported `authProblem`.
- One problem type covers all auth failures; clients branch on `code`, which is Better Auth's and may change between its
  versions.
