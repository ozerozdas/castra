import type { CompiledQuery } from "kysely";

/** Result of one statement in a batch. */
export interface BatchStatementResult {
  rows: Record<string, unknown>[];
  /** Rows changed by an INSERT/UPDATE/DELETE. */
  changes: number;
}

/**
 * Runs compiled statements as ONE atomic unit: if any statement fails, none of them takes effect.
 * Writes go through this so the write and its policy guard commit or roll back together (ADR 0043).
 * Kysely stays the only SQL builder; the runner only binds and sends what Kysely compiled.
 */
export type BatchRunner = (statements: readonly CompiledQuery[]) => Promise<BatchStatementResult[]>;

/** The part of a D1 binding {@link d1Batch} needs (structural, so core does not depend on workers-types). */
export interface D1BatchCapable {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<Array<{ results?: unknown[]; meta?: { changes?: number } }>>;
}

/**
 * A {@link BatchRunner} over a D1 binding. D1 runs a `batch()` as a single transaction: statements
 * execute sequentially and a failure rolls back the whole batch.
 */
export function d1Batch(d1: D1BatchCapable): BatchRunner {
  return async (statements) => {
    const prepared = statements.map((q) => d1.prepare(q.sql).bind(...q.parameters));
    const results = await d1.batch(prepared);
    return results.map((r) => ({
      rows: (r.results ?? []) as Record<string, unknown>[],
      changes: r.meta?.changes ?? 0,
    }));
  };
}
