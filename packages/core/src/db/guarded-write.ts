import type { Compilable } from "kysely";
import { WRITE_CHECK_MARKER, type WriteGuard } from "../policy/engine.js";
import { PolicyError } from "../policy/errors.js";

/** The subset of a D1 prepared statement {@link runGuardedWrite} uses. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
}

/** The subset of a D1 result {@link runGuardedWrite} returns. */
export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

/**
 * The subset of the `D1Database` binding {@link runGuardedWrite} uses. A real `env.DB` satisfies it;
 * declared structurally so `castra` does not depend on `@cloudflare/workers-types` at runtime.
 */
export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
  batch<T = Record<string, unknown>>(statements: D1StatementLike[]): Promise<D1ResultLike<T>[]>;
}

/**
 * True when `err` is the SQL error a failing {@link WriteGuard} raises
 * (`bad JSON path: 'castra_write_check_failed'`), as opposed to any other database error.
 */
export function isWriteCheckError(err: unknown): boolean {
  const needle = `'${WRITE_CHECK_MARKER}'`;
  for (let e: unknown = err, depth = 0; e !== null && e !== undefined && depth < 5; depth++) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message.includes("bad JSON path") && message.includes(needle)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs a write and its {@link WriteGuard} atomically: both Kysely queries are compiled, bound to D1
 * prepared statements and sent as one `batch()` (`[write, guard]`). D1 batches are SQL transactions,
 * so when the guard raises, the write is rolled back (ADR 0050).
 *
 * Returns the write statement's result (`RETURNING` rows in `results`).
 *
 * @throws {@link PolicyError} 403 `write_check_failed` (with the guard's explanation) when the stored
 *   row does not satisfy the rule or does not exist. Every other database error (constraint
 *   violation, type error, ...) is rethrown unchanged; the batch is rolled back in both cases.
 */
export async function runGuardedWrite<T = Record<string, unknown>>(
  d1: D1DatabaseLike,
  write: Compilable<unknown>,
  guard: WriteGuard,
): Promise<D1ResultLike<T>> {
  const statements = [write.compile(), guard.compile()].map((c) => d1.prepare(c.sql).bind(...c.parameters));
  let results: D1ResultLike<T>[];
  try {
    results = await d1.batch<T>(statements);
  } catch (err) {
    if (isWriteCheckError(err)) {
      const e = guard.explanation;
      const explanation = {
        ...e,
        allowed: false,
        where: e.where ? { sql: e.where.sql, parameters: [...e.where.parameters] } : null,
        hiddenFields: [...e.hiddenFields],
        ...(e.conditionalFields ? { conditionalFields: [...e.conditionalFields] } : {}),
        reason: `the stored row violates the ${e.op} rule ${e.matchedRule}; the write was rolled back`,
      };
      throw new PolicyError(403, "write_check_failed", `${e.op} on "${e.table}" violates its policy`, explanation);
    }
    throw err;
  }
  return results[0]!;
}
