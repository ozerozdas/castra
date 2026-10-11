import type { Operation } from "../types.js";

/**
 * Why a policy decision came out the way it did. Returned by `explain()`, attached to every
 * {@link PolicyError}, and surfaced by MCP `check_access` / `explain_query`.
 */
export interface Explanation {
  /** Table the decision is about. */
  table: string;
  /** Operation the decision is about. */
  op: Operation;
  /**
   * `true`/`false` when the decision does not depend on row data (or a concrete row was checked);
   * `"conditional"` when it compiles to a row filter.
   */
  allowed: boolean | "conditional";
  /** Human-readable rule tree of the governing rule, e.g. `or(and(public, where), owner(author_id), role(admin))`. */
  matchedRule: string;
  /** Compiled `WHERE` fragment (SQLite dialect, `?` placeholders) and its parameters, or `null` when none applies. */
  where: { sql: string; parameters: unknown[] } | null;
  /** Fields that are never returned to this caller (hidden, or `visibleTo` without a matching role). */
  hiddenFields: string[];
  /** Fields whose visibility depends on the row (`visibleTo` containing `"self"`, caller lacks the roles). */
  conditionalFields?: string[];
  /** Extra detail: residual rule after partial evaluation, or why a request was rejected. */
  reason?: string;
}

/** HTTP status a {@link PolicyError} maps to. */
export type PolicyErrorStatus = 400 | 401 | 403 | 404;

/** Machine-readable error code of a {@link PolicyError}. */
export type PolicyErrorCode =
  | "not_found"
  | "unauthenticated"
  | "forbidden"
  | "invalid_input"
  | "unknown_column"
  | "readonly_column"
  | "hidden_column"
  | "server_column"
  /** The guarded write's check failed against the stored row; the batch was rolled back (ADR 0050). */
  | "write_check_failed"
  /**
   * Create/update refused for every caller: the table has an `ON CONFLICT REPLACE` constraint that
   * would delete conflicting rows without the delete policy (`TableSnapshot.conflictReplace`, ADR 0066).
   */
  | "unsafe_schema";

/**
 * A request rejected by the policy engine. `status` maps to the HTTP response; `explanation`
 * says which rule or field caused it. Render as `application/problem+json`.
 */
export class PolicyError extends Error {
  readonly status: PolicyErrorStatus;
  readonly code: PolicyErrorCode;
  readonly explanation: Explanation;

  constructor(status: PolicyErrorStatus, code: PolicyErrorCode, message: string, explanation: Explanation) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
    this.code = code;
    this.explanation = explanation;
  }
}

/** Thrown by `defineConfig` and `createPolicyEngine` when the configuration is invalid. */
export class CastraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastraConfigError";
  }
}
