# 0067. Problem `type` URIs use `castra.mehmetozer.dev`

## Status
Accepted (2026-10-11). Changes the base of every `application/problem+json` `type`. This is safe now because
nothing is published.

## Context
REST and MCP errors carry `type: https://castra.dev/problems/<code>`. The project does not own `castra.dev`.
Whoever does could serve anything at those URLs. Clients that follow `type` (RFC 9457 suggests it should
resolve to human-readable docs) would land on content we do not control.

`type` is part of the API contract. Clients branch on it, so it must not change after release.

## Decision
The base is `https://castra.mehmetozer.dev/problems/<code>`, a subdomain the maintainer owns. It is a single
constant in `packages/core/src/api/problem.ts`; it is not configurable. Codeless problems stay `about:blank`.

## Consequences
- Every `type` value changes once, before v0.1 is published. Tests assert the new base.
- The URLs do not resolve yet. Before publish, serve one page per code under `/problems/` (static pages, or a
  redirect to the README error section).
- If the project moves, keep the old URLs working with a redirect rather than changing `type` again.
