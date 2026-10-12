# 0082. `propose_policy`: a reviewable config diff, never applied

## Status
Accepted (2026-10-12). Issue #12. Implements the `propose_policy` row of ARCHITECTURE §5.

## Context
Agents can read the schema and policies (`describe_schema`) and test decisions (`check_access`). Changing a policy
must stay a human decision: the config is code, every rule needs allow and deny tests (CLAUDE.md rule 6), and a
running Worker must never pick up a policy an agent wrote.

## Decision
- **Local only.** `castra mcp` registers `propose_policy`; the remote `/mcp` route never does (no file access, and a
  token holder should not shape policies).
- **Input** `{ table, op, rule }`. `rule` is an expression over `isPublic()`, `authenticated()`, `role("...")`,
  `owner("column")`, `.and(...)` and `.or(...)`, with plain string literals; `null` removes the operation's policy
  (closes it). The text is **parsed by a small grammar, never evaluated**. `.where()` and `custom()` take code and are
  refused with a note to add them by hand.
- **Validation** against the running config and snapshot: the table must exist in `castra/schema.json`, and the
  config with the proposed rule must pass `defineConfig` and `createPolicyEngine` (known roles, existing owner
  columns). The running engine is not touched.
- **Output** `{ applied: false, path, table, op, before, after, diff, next }`. `diff` is a unified diff of
  `castra.config.ts` as it is on disk: the rule is printed canonically and only that property's value changes
  (comments around it stay); a missing table entry or property is inserted, and a missing builder is added to the
  `@castra-kit/core` import. A config the edit cannot follow (no `tables: {` literal, spread or computed keys) is a
  400 that says to edit by hand.
- **Never writes.** The file is read once per call; nothing writes it, and the loaded config is not modified.

## Consequences
- Applying is manual: review, apply, add allow and deny tests, `castra test`, deploy.
- The diff targets the usual config shape (`defineConfig({ ..., tables: { name: { op: rule } } })`); unusual layouts
  get the canonical rule text without a diff.
- Field rules, `filterable` and other table options are not proposed by this tool.
