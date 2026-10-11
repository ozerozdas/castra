# 0071. A welcome response at `/`

## Status
Accepted (2026-10-11). Issue #14.

## Context
A deployed app answers `GET /` with a `not_found` problem. The URL `castra deploy` prints is the first thing people open,
and a 404 there looks like a broken deploy.

## Decision
- The REST router (which already serves `/openapi.json` at the root) also serves `GET /`.
- JSON by default: `{ name, version, openapi, api, docs }`. `name` and `version` are the OpenAPI `info` values; `api`
  is the base path; `docs` links to the Castra repository.
- A request whose `Accept` header contains `text/html` (a browser) gets a minimal static HTML page with the same links.
  No scripts, no external assets. The response sets `Vary: Accept`.
- It shows nothing beyond `/openapi.json`: no table names, no counts, no user data, no auth state.
- `api.welcome: false` in `castra.config.ts` turns it off, and `/` is a 404 again.

## Consequences
- New and existing apps get it by updating `@castra-kit/core`; the template does not change.
- An app that wants its own `/` sets `api.welcome: false`, or registers `/` before mounting the router.
