# 0008. Policy test harness: real D1 plus property tests

## Status
Accepted (2026-10-10)

## Context
Policy SQL must be tested against the SQLite that runs in production, and allow/deny examples alone do
not catch compiler bugs in rule combinations.

## Decision
- `packages/core/vitest.config.ts` defines two Vitest projects: `unit` (Node; everything except
  `*.d1.test.ts`) and `d1` (`@cloudflare/vitest-plugin`, workerd with a local D1 binding `DB`; only
  `*.d1.test.ts`). Policy tests live in `packages/core/test/policy/` so `pnpm test:policies` picks them up.
- The `d1` project gets its D1 binding from inline `miniflare` options (no wrangler file in core);
  tests create their own tables. `cloudflare:workers` is typed by a local `.d.ts` so the Node-typed core
  package does not pull in `@cloudflare/workers-types` globals.
- `test/policy/oracle.ts` is a reference evaluator (SQL three-valued logic) used only by tests.
  fast-check generates random rule trees (public, authenticated, role, owner, where with comparisons,
  and, or), contexts (including anonymous callers carrying roles) and rows with NULLs. Properties,
  300 runs each: read filter rows and `count` match the oracle; UPDATE/DELETE under the filter touch
  exactly the oracle's rows; `checkRow` agrees with the oracle.

## Consequences
- Other core tests may stay in Node; anything that must execute SQL should be a `*.d1.test.ts` file.
- The schema snapshot used by policy tests is a hand-written fixture until the Schema agent's
  generator lands; it mirrors `examples/blog`.
