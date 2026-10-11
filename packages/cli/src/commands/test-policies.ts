import { resolve } from "node:path";
import type { ExecFn } from "../exec.js";

/** Options of `castra test policies`. */
export interface TestPoliciesOptions {
  /** Project directory; vitest runs here and uses the project's own vitest config. */
  cwd: string;
  /** Extra arguments passed to vitest after the filter (everything after `--`). */
  extraArgs?: string[];
}

/** Side effects of `castra test policies`. */
export interface TestPoliciesDeps {
  exec: ExecFn;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Vitest file filter: policy tests must have this in their path (e.g. `test/policies.test.ts`). */
export const POLICY_TEST_FILTER = "policies";

/**
 * `castra test policies`: run the project's policy allow/deny tests with `vitest run policies` in the project
 * directory (ADR 0037). The project's vitest config (normally `@cloudflare/vitest-plugin` with the migrations
 * applied to a local D1) is used unchanged. vitest's output is streamed; its exit code is returned.
 *
 * No matching test file is a failure (vitest exits 1): every policy rule must ship with tests.
 *
 * @returns the process exit code (vitest's).
 */
export async function testPolicies(options: TestPoliciesOptions, deps: TestPoliciesDeps): Promise<number> {
  const cwd = resolve(options.cwd);
  const args = ["run", POLICY_TEST_FILTER, ...(options.extraArgs ?? [])];
  let result;
  try {
    result = await deps.exec("vitest", args, { cwd });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      deps.error("Cannot run vitest. Install it in your project (`pnpm add -D vitest @cloudflare/vitest-plugin`).");
      return 1;
    }
    throw e;
  }
  if (result.code !== 0) deps.error(`Policy tests failed (vitest exited with code ${result.code}).`);
  return result.code;
}
