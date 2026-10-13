# 0084. Audit argument redaction and bounded retention

## Status
Accepted (2026-10-13). Issue #21. Amends ARCHITECTURE §5 and ADRs 0063/0070/0081.

## Decision
- Audit arguments retain object keys/array structure but replace every scalar value (including null, numbers and
  booleans) with `[REDACTED]`. No heuristic can reliably identify PII in paths, filter strings or arbitrary row
  values. This applies before truncation to all messages, denied/invalid calls and write attempt/outcome rows.
- Optional `audit.redactKeys` replaces whole matching subtrees, case-insensitively. There is no raw-value opt-out.
  Keys themselves remain visible unless the matching subtree is removed; never put sensitive values in keys.
  Traversal is bounded at 32 levels and 1000 nodes; oversized structure becomes `[REDACTED]`.
- `audit.retentionDays` is opt-in (positive integer, at most 36500). After durable audit insertion, remote MCP
  requests with a known token run one existing `pruneAuditQuery` batch (at most 5000 old rows). No timers, migration,
  global throttle or new binding. Idle applications do not prune; Cron/manual prune remains available.
- Retention errors are logged and do not undo an audit insert or change a served result. Audit insertion still fails
  closed, and the attempt row must succeed before any data write. Never prune inside that pre-write hook.
- `createCastraApp({ mcp: { audit: ... } })` forwards these settings. Omitted MCP options preserve the default route.

## Consequences
New audit rows stop storing payload values. Existing rows are unchanged; operators must prune them explicitly.
Identity, tool name, outcome/status and timing stay available. Retention costs at most one extra D1 query per
known-token request when enabled and may need Cron/manual catch-up for a backlog. This is age retention, not a
maximum table size. No automatic deletion is enabled merely by upgrading. Local stdio still has no audit log.
