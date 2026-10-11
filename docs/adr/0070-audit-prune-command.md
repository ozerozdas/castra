# 0070. Audit retention is a prune command

## Status
Accepted (2026-10-11). Amends ADR 0063 ("No retention policy yet").

## Context
`_castra_audit` gets one row per remote MCP message, and requests with a known token id and a wrong secret are
audited too. Nothing ever deletes rows, so the table grows without bound and keeps tool arguments (possible PII)
forever. D1 databases have a size limit.

## Decision
- `castra mcp audit prune --older-than <days> [--local | --remote]` deletes rows whose `at` is older than now minus
  `<days>`. `<days>` is a whole number, at least 1.
- Deletion runs in batches of 5000 rows (`DELETE ... WHERE id IN (SELECT id ... LIMIT 5000) RETURNING id`), repeated
  until a batch is short. Each statement stays short on D1, and the command prints the total.
- `@castra-kit/mcp` exports `pruneAuditQuery(before)` so an app can run the same statement from a Cron Trigger.
- There is no automatic default retention. How long to keep an audit log is the operator's decision. Deleting
  audit rows silently on an upgrade would be surprising.

## Consequences
- Operators schedule pruning themselves, by hand, from CI, or with a Worker Cron Trigger calling `pruneAuditQuery`.
- The audit log is still fail-closed (ADR 0063). Pruning never runs on the request path.
