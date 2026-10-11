# 0037. `castra test policies` runs the project's vitest

## Status
Accepted (2026-10-11). Implements ARCHITECTURE §6 `castra test policies`.

## Context
Policy tests need the Workers runtime, a local D1 with every migration applied and real Better Auth sessions.
Projects already have exactly that in their `vitest.config.ts` (`@cloudflare/vitest-plugin`). A separate runner
would duplicate it.

## Decision
- `castra test policies [-- <vitest args>]` runs `vitest run policies` in the current directory (the project's own
  vitest binary from `node_modules/.bin` and its own config). Policy tests are the files whose path contains
  `policies` (the template's `test/policies.test.ts`).
- vitest's output is streamed and its exit code is the command's exit code. No matching file is a failure
  (vitest exits 1): a project without policy tests does not pass.
- vitest missing (`ENOENT`) → exit 1 with an install hint.
- The monorepo's own `pnpm test:policies` (core, `vitest run --passWithNoTests policy`) is unrelated and unchanged.

## Consequences
- The filter is a path substring, so a file named e.g. `test/policies-helpers.test.ts` would also run. Accepted.
- No policy coverage check (every rule has an allow and a deny test) is enforced by the CLI; the template's tests
  model the convention.
