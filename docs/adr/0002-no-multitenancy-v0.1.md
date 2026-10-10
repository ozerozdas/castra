# 0002. No multi-tenancy in v0.1

## Status
Accepted (2026-10-10)

## Context
Multi-tenancy (organizations, per-tenant isolation) multiplies the policy engine's surface: every rule,
include and write check would need a tenant dimension. The policy engine is security code and the
highest risk in the project.

## Decision
v0.1 ships a single-tenant model: one Worker, one D1, users with roles. Tenant-style isolation can be
expressed manually with `owner(column)` and custom predicates. Multi-tenancy is listed as open for v0.3.

## Consequences
- Smaller policy core and a smaller test matrix.
- Apps needing org-level isolation must model it in their own policies until v0.3.
- A future tenant concept may change `CastraContext`; a new ADR is required before doing so.
