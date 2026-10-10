import {
  expressionBuilder,
  sql,
  type Compilable,
  type CompiledQuery,
  type Expression,
  type ExpressionBuilder,
  type Kysely,
  type RawBuilder,
  type SqlBool,
} from "kysely";
import { defineConfig, isReservedTable, OPERATIONS, type CastraConfig, type TableConfig } from "../config.js";
import type { CastraContext, ColumnSnapshot, Operation, SchemaSnapshot, TableSnapshot } from "../types.js";
import {
  compileExpression,
  compileOnlyDb,
  describeResidual,
  effectiveRoles,
  hasUser,
  partialEvaluate,
  residualToExpression,
  type Residual,
} from "./compile.js";
import { CastraConfigError, PolicyError, type Explanation, type PolicyErrorCode, type PolicyErrorStatus } from "./errors.js";
import { describeRule, walkRule, type RuleNode } from "./rules.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEB = ExpressionBuilder<any, any>;

/** Inputs of {@link createPolicyEngine}. */
export interface PolicyEngineOptions {
  /** Validated config (it is re-validated). */
  config: CastraConfig;
  /** Committed schema snapshot; the only source of SQL identifiers. */
  snapshot: SchemaSnapshot;
}

/** A compiled row filter for one table × operation × context. */
export interface Filter {
  /**
   * Returns the boolean `WHERE` expression. Pass the expression builder of a query whose base table
   * is the policy's table, addressable by its own name (do not alias it).
   */
  apply(eb: AnyEB): Expression<SqlBool>;
  /** Why this filter looks the way it does. */
  explanation: Explanation;
}

/** Input accepted by {@link PolicyEngine.prepareWrite}: the values to write. */
export interface PreparedWrite {
  /** Column → value, with server-set owner columns filled in. Only snapshot columns. */
  values: Record<string, unknown>;
}

/** Outcome of {@link PolicyEngine.checkRow}. */
export interface Decision {
  table: string;
  op: Operation;
  allowed: boolean;
  explanation: Explanation;
}

/**
 * Identifies the row a {@link PolicyEngine.writeGuard} checks: the full primary key of the row as it
 * is AFTER the write, or `"last_insert_rowid"` for an insert whose key the database assigns
 * (rowid tables only).
 */
export type WriteTarget = Record<string, unknown> | "last_insert_rowid";

/**
 * The authoritative WITH CHECK for one write (ADR 0050). A Kysely-compiled `SELECT` that, run right
 * after the write in the same D1 `batch()`, raises an SQL error unless the stored row identified by
 * the target exists and satisfies the operation's rule. D1 batches are atomic, so the error rolls the
 * write back. Run it with {@link runGuardedWrite}, which maps the error to a 403 {@link PolicyError}.
 */
export interface WriteGuard extends Compilable<unknown> {
  /** The guard query (same as `compile()` on this object). */
  readonly query: Compilable<unknown>;
  /** Why the guard looks the way it does; attached to the 403 when it fires. */
  readonly explanation: Explanation;
}

/** The policy engine. REST, MCP and custom routes all call this same object. */
export interface PolicyEngine {
  /**
   * Is `table × op` reachable at all? False for unknown tables, tables missing from the snapshot,
   * operations without a rule, and auth/internal tables.
   */
  isOpen(table: string, op: Operation): boolean;
  /**
   * The row filter for `read`, `update` or `delete`, partially evaluated for `ctx`.
   * Throws {@link PolicyError} 404 when the operation is closed.
   */
  readFilter(table: string, op: "read" | "update" | "delete", ctx: CastraContext): Filter;
  /**
   * Validates client input for `create`/`update`. Rejects (never strips) unknown, hidden and readonly
   * columns and `setBy: "server"` columns whose client value differs from the server value. On create,
   * fills `setBy: "server"` owner columns from `ctx.user.id`. On update, server columns are never
   * written; pass `existing` (the current row) to compare a client value with the stored one.
   */
  prepareWrite(
    table: string,
    op: "create" | "update",
    ctx: CastraContext,
    input: Record<string, unknown>,
    existing?: Record<string, unknown>,
  ): PreparedWrite;
  /**
   * Builds the AUTHORITATIVE write check (ADR 0050): a guard query to run after the write, in the
   * same D1 batch, via {@link runGuardedWrite}. It evaluates the `op` rule (partially evaluated for
   * `ctx`) against the row actually stored, so column defaults, affinity conversions, collations and
   * STRICT typing are exactly what D1 applied. The row must exist after the write: a missing row
   * (wrong key, primary key changed by the update, nothing written) fails closed.
   *
   * `target` is the complete primary key (every `primaryKey` column of the snapshot, non-null scalar
   * values; for an update, the key AFTER the update) or `"last_insert_rowid"` for an insert into a
   * rowid table without a client-supplied key.
   *
   * Throws {@link PolicyError} 404 when the operation is closed, 400 on a bad target.
   */
  writeGuard(table: string, op: "create" | "update", ctx: CastraContext, target: WriteTarget): WriteGuard;
  /**
   * Best-effort DRY RUN of the write check: evaluates the operation's rule in SQL against a candidate
   * row that is never stored. **Not authoritative**: the candidate cannot reproduce every storage
   * effect (column collations, non-numeric text in numeric columns, non-literal defaults, rowid
   * assignment). The explanation's `reason` says "approximate" when one of those applies. Use it for
   * MCP `check_access` and as an early pre-check; enforce writes with {@link writeGuard}.
   *
   * On create, omitted columns take their literal snapshot default (else NULL, marked approximate).
   * Use it for create, and for update on the existing row merged with the patch.
   */
  checkRow(
    db: Kysely<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    table: string,
    op: Operation,
    ctx: CastraContext,
    candidateRow: Record<string, unknown>,
  ): Promise<Decision>;
  /**
   * Returns a copy of `row` safe to send to this caller: removes hidden fields always, `visibleTo`
   * fields unless the caller holds a listed role or `"self"` matches, and columns not in the snapshot.
   */
  projectRow(table: string, ctx: CastraContext, row: Record<string, unknown>): Record<string, unknown>;
  /**
   * May `ctx` filter (or sort) on `column` of `table`? True only when the table has an open `read`, the column
   * exists, is not `hidden`, is listed in `filterable` (when `filterable` is set; otherwise any visible
   * column qualifies) and is visible to the caller under `visibleTo`. A `visibleTo` column that is
   * visible only through `"self"` is never filterable: self is decided per row, so a filter on it
   * would be a membership oracle over other users' values. Only a listed real role grants it.
   * The API layer must call this for every column named in a filter expression.
   */
  canFilter(table: string, column: string, ctx: CastraContext): boolean;
  /**
   * May `ctx` read `column` of `table` regardless of the row? Unlike {@link canFilter} it ignores the
   * table's `read` rule and `filterable`: it is false for unknown and `hidden` columns and for `visibleTo`
   * columns unless a listed real role is held (`"self"` is per row, so it does not count). The API layer
   * uses it for the primary key of item routes.
   */
  canReadColumn(table: string, column: string, ctx: CastraContext): boolean;
  /** The explanation of a decision or filter. */
  explain(decision: Decision | Filter): Explanation;
}

interface TableInfo {
  name: string;
  snapshot: TableSnapshot;
  columns: Map<string, ColumnSnapshot>;
  config: TableConfig;
  rules: Partial<Record<Operation, RuleNode>>;
  ownerColumns: Set<string>;
  serverColumns: Set<string>;
  readonlyColumns: Set<string>;
  hiddenColumns: Set<string>;
  visibleTo: Map<string, readonly string[]>;
  selfColumn: string | undefined;
}

const PROBE_USER_ID = "__castra_probe_user__";

/**
 * Builds the policy engine for a config and schema snapshot. Throws {@link CastraConfigError} when
 * the config is invalid or names a column that is not in the snapshot (owner columns, fields,
 * filterable, selfColumn, and — best effort — columns referenced by `where`/`custom` predicates).
 * Configured tables absent from the snapshot stay closed.
 */
export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  const config = defineConfig(options.config);
  const given = options.snapshot;
  if (!given || given.version !== 1 || typeof given.tables !== "object" || given.tables === null) {
    throw new CastraConfigError("snapshot must be a version 1 schema snapshot");
  }
  // Private, deep-frozen copy: mutating the caller's snapshot later cannot change identifiers or affinities.
  let snapshot: SchemaSnapshot;
  try {
    snapshot = deepFreeze(structuredClone(given));
  } catch (err) {
    throw new CastraConfigError(`snapshot must be plain JSON data: ${(err as Error).message}`);
  }

  const tables = new Map<string, TableInfo>();
  for (const [name, tc] of Object.entries(config.tables)) {
    const ts = Object.hasOwn(snapshot.tables, name) ? snapshot.tables[name] : undefined;
    if (!ts) continue; // not in the snapshot: closed
    tables.set(name, buildTableInfo(name, tc, ts, config, snapshot));
  }

  function info(table: string): TableInfo | undefined {
    if (typeof table !== "string" || isReservedTable(table)) return undefined;
    return tables.get(table);
  }

  function isOpen(table: string, op: Operation): boolean {
    const t = info(table);
    return t !== undefined && OPERATIONS.includes(op) && t.rules[op] !== undefined;
  }

  function fieldVisibility(t: TableInfo, ctx: CastraContext): { hidden: string[]; conditional: string[] } {
    const roles = effectiveRoles(ctx);
    const hidden = [...t.hiddenColumns];
    const conditional: string[] = [];
    for (const [col, visibleTo] of t.visibleTo) {
      if (t.hiddenColumns.has(col)) continue;
      if (visibleTo.some((r) => r !== "self" && roles.includes(r))) continue;
      if (visibleTo.includes("self") && t.selfColumn !== undefined && hasUser(ctx)) conditional.push(col);
      else hidden.push(col);
    }
    return { hidden, conditional };
  }

  function baseExplanation(table: string, op: Operation, ctx: CastraContext | null): Explanation {
    const t = info(table);
    const rule = t?.rules[op];
    const vis = t && ctx ? fieldVisibility(t, ctx) : { hidden: [], conditional: [] };
    const e: Explanation = {
      table,
      op,
      allowed: false,
      matchedRule: rule ? describeRule(rule) : "none",
      where: null,
      hiddenFields: vis.hidden,
    };
    if (vis.conditional.length > 0) e.conditionalFields = vis.conditional;
    return e;
  }

  function reject(
    status: PolicyErrorStatus,
    code: PolicyErrorCode,
    message: string,
    table: string,
    op: Operation,
    ctx: CastraContext | null,
  ): never {
    const e = baseExplanation(table, op, ctx);
    e.reason = message;
    throw new PolicyError(status, code, message, e);
  }

  function requireOpen(table: string, op: Operation, ctx: CastraContext): { t: TableInfo; rule: RuleNode } {
    const t = info(table);
    const rule = t?.rules[op];
    if (!t || !rule) reject(404, "not_found", `${op} on "${table}" is not exposed`, table, op, ctx);
    return { t, rule };
  }

  function residualFor(t: TableInfo, rule: RuleNode, ctx: CastraContext): Residual {
    return partialEvaluate(rule, ctx, t.name);
  }

  function explainResidual(t: TableInfo, op: Operation, ctx: CastraContext, residual: Residual): Explanation {
    const e = baseExplanation(t.name, op, ctx);
    e.allowed = residual.kind === "const" ? residual.value : "conditional";
    e.where = compileExpression(residualToExpression(residual, expressionBuilder<any, any>())); // eslint-disable-line @typescript-eslint/no-explicit-any
    e.reason = `residual for this context: ${describeResidual(residual)}`;
    return e;
  }

  function readFilter(table: string, op: "read" | "update" | "delete", ctx: CastraContext): Filter {
    if (op !== "read" && op !== "update" && op !== "delete") throw new TypeError(`readFilter: invalid op "${String(op)}"`);
    const { t, rule } = requireOpen(table, op, ctx);
    const residual = residualFor(t, rule, ctx);
    return Object.freeze({
      apply: (eb: AnyEB) => residualToExpression(residual, eb),
      explanation: explainResidual(t, op, ctx, residual),
    });
  }

  /** Could `ctx` read `key` on `row`? Mirrors {@link projectRow} for a single column. */
  function canSeeField(t: TableInfo, key: string, ctx: CastraContext, row: Record<string, unknown>): boolean {
    const visibleTo = t.visibleTo.get(key);
    if (!visibleTo) return true;
    const roles = effectiveRoles(ctx);
    if (visibleTo.some((r) => r !== "self" && roles.includes(r))) return true;
    if (!visibleTo.includes("self") || t.selfColumn === undefined || !hasUser(ctx)) return false;
    const v = row[t.selfColumn];
    return v !== null && v !== undefined && v === ctx.user.id;
  }

  function prepareWrite(
    table: string,
    op: "create" | "update",
    ctx: CastraContext,
    input: Record<string, unknown>,
    existing?: Record<string, unknown>,
  ): PreparedWrite {
    if (op !== "create" && op !== "update") throw new TypeError(`prepareWrite: invalid op "${String(op)}"`);
    const { t, rule } = requireOpen(table, op, ctx);
    const residual = residualFor(t, rule, ctx);
    if (residual.kind === "const" && !residual.value) {
      if (hasUser(ctx)) reject(403, "forbidden", `${op} on "${table}" is not allowed for this user`, table, op, ctx);
      reject(401, "unauthenticated", `${op} on "${table}" requires authentication`, table, op, ctx);
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      reject(400, "invalid_input", "input must be an object", table, op, ctx);
    }

    const values: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (!t.columns.has(key)) reject(400, "unknown_column", `unknown column "${key}"`, table, op, ctx);
      if (t.hiddenColumns.has(key)) reject(400, "hidden_column", `column "${key}" cannot be written`, table, op, ctx);
      if (t.readonlyColumns.has(key)) reject(400, "readonly_column", `column "${key}" is read-only`, table, op, ctx);
      if (!isBindable(value)) reject(400, "invalid_input", `column "${key}" has an unsupported value type`, table, op, ctx);
      if (typeof value === "string" && requiresNumericText(t, t.columns.get(key)!) && !NUMERIC_TEXT.test(value)) {
        reject(400, "invalid_input", `column "${key}" is numeric; a non-numeric text value is rejected`, table, op, ctx);
      }

      if (t.serverColumns.has(key)) {
        if (!t.ownerColumns.has(key)) {
          reject(400, "server_column", `column "${key}" is set by the server`, table, op, ctx);
        }
        let expected: unknown;
        if (op === "update" && existing !== undefined) expected = existing[key];
        else if (hasUser(ctx)) expected = ctx.user.id;
        else reject(401, "unauthenticated", `column "${key}" requires an authenticated user`, table, op, ctx);
        if (value !== expected) {
          reject(403, "forbidden", `column "${key}" is set by the server; a different client value is rejected`, table, op, ctx);
        }
        if (op === "update") continue; // server columns are immutable on update
      }
      values[key] = value;
    }

    if (op === "create") {
      for (const col of t.serverColumns) {
        if (!t.ownerColumns.has(col)) continue;
        if (!hasUser(ctx)) reject(401, "unauthenticated", `column "${col}" requires an authenticated user`, table, op, ctx);
        values[col] = ctx.user.id;
      }
    }

    // A visibleTo field may only be written by a ctx that could read it (ADR 0007 amendment 2).
    // Self is decided on the row: the stored one on update, the candidate on create.
    const candidate = op === "update" && existing !== undefined ? { ...existing, ...values } : values;
    for (const key of Object.keys(values)) {
      if (!canSeeField(t, key, ctx, candidate)) {
        reject(403, "forbidden", `column "${key}" cannot be written by this user`, table, op, ctx);
      }
    }
    return { values };
  }

  async function checkRow(
    db: Kysely<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    table: string,
    op: Operation,
    ctx: CastraContext,
    candidateRow: Record<string, unknown>,
  ): Promise<Decision> {
    if (!OPERATIONS.includes(op)) throw new TypeError(`checkRow: invalid op "${String(op)}"`);
    const t = info(table);
    const rule = t?.rules[op];
    if (!t || !rule) {
      const e = baseExplanation(table, op, ctx);
      e.reason = `${op} on "${table}" is not exposed`;
      return { table, op, allowed: false, explanation: e };
    }
    if (typeof candidateRow !== "object" || candidateRow === null || Array.isArray(candidateRow)) {
      reject(400, "invalid_input", "candidate row must be an object", table, op, ctx);
    }
    for (const key of Object.keys(candidateRow)) {
      if (!t.columns.has(key)) reject(400, "unknown_column", `unknown column "${key}"`, table, op, ctx);
      if (!isBindable(candidateRow[key])) reject(400, "invalid_input", `column "${key}" has an unsupported value type`, table, op, ctx);
    }

    const residual = residualFor(t, rule, ctx);
    const explanation = explainResidual(t, op, ctx, residual);
    // Storage effects the candidate cannot reproduce: reported, never silently ignored.
    const approximate: string[] = [];
    const strict = t.snapshot.strict === true;
    const cells = t.snapshot.columns.map((c) => {
      const given = Object.hasOwn(candidateRow, c.name);
      const value = given ? candidateRow[c.name] : undefined;
      if (given && typeof value === "string" && isNumericAffinity(t, c) && !NUMERIC_TEXT.test(value)) {
        approximate.push(`non-numeric text in numeric column "${c.name}"`);
      }
      if (given || op !== "create") return castToAffinity(c, value ?? null, strict).as(c.name);
      // Create with the column omitted: the database stores the column DEFAULT (ADR 0050).
      const isRowidAlias = t.snapshot.primaryKey.length === 1 && c.primaryKeyPosition === 1 && c.type === "INTEGER";
      if (isRowidAlias) {
        approximate.push(`rowid column "${c.name}" is assigned by the database`);
        return sql`${null}`.as(c.name);
      }
      const dflt = parseDefault(c.defaultValue);
      if (dflt.kind === "expr") {
        approximate.push(`non-literal default of "${c.name}"`);
        return sql`${null}`.as(c.name);
      }
      if (dflt.kind === "numeric") return castNumericLiteral(c, dflt.text, strict).as(c.name);
      return castToAffinity(c, dflt.value, strict).as(c.name);
    });
    let allowed: boolean;
    if (residual.kind === "const") {
      allowed = residual.value;
    } else {
      // SELECT 1 FROM (SELECT CAST(? AS <affinity>) AS "c1", ...) AS "<table>" WHERE <rule>
      // Identifiers come from the snapshot only; values are bound parameters.
      const candidate = db.selectNoFrom(() => cells).as(t.name);
      const found = await db
        .selectFrom(candidate)
        .select(sql<number>`1`.as("ok"))
        .where((eb) => residualToExpression(residual, eb))
        .limit(1)
        .executeTakeFirst();
      allowed = found !== undefined;
    }
    explanation.allowed = allowed;
    explanation.reason = `${allowed ? "row satisfies" : "row violates"} ${describeRule(rule)} (${explanation.reason ?? ""})`;
    if (approximate.length > 0 && residual.kind !== "const") {
      explanation.reason += `; approximate dry run: ${approximate.join(", ")}; the guarded write decides`;
    }
    return { table, op, allowed, explanation };
  }

  function writeGuard(table: string, op: "create" | "update", ctx: CastraContext, target: WriteTarget): WriteGuard {
    if (op !== "create" && op !== "update") throw new TypeError(`writeGuard: invalid op "${String(op)}"`);
    const { t, rule } = requireOpen(table, op, ctx);
    const residual = residualFor(t, rule, ctx);

    let targetSql: RawBuilder<SqlBool>;
    if (target === "last_insert_rowid") {
      const alias = ["rowid", "_rowid_", "oid"].find((a) => !t.columns.has(a));
      if (alias === undefined) reject(400, "invalid_input", `"${table}" shadows every rowid alias; pass its primary key`, table, op, ctx);
      // Identifier parts: the snapshot table name and a fixed rowid alias.
      targetSql = sql<SqlBool>`${sql.id(t.name, alias)} = last_insert_rowid()`;
    } else {
      if (typeof target !== "object" || target === null || Array.isArray(target)) {
        reject(400, "invalid_input", "write target must be a primary key object or \"last_insert_rowid\"", table, op, ctx);
      }
      const pk = t.snapshot.primaryKey;
      const keys = Object.keys(target);
      if (pk.length === 0) reject(400, "invalid_input", `"${table}" has no primary key; use "last_insert_rowid"`, table, op, ctx);
      if (keys.length !== pk.length || !pk.every((k) => Object.hasOwn(target, k))) {
        reject(400, "invalid_input", `write target must name exactly the primary key (${pk.join(", ")})`, table, op, ctx);
      }
      const parts = pk.map((k) => {
        const v = target[k];
        if (v === null || v === undefined || !isBindable(v)) {
          reject(400, "invalid_input", `primary key column "${k}" needs a non-null scalar value`, table, op, ctx);
        }
        return sql<SqlBool>`${sql.id(t.name, k)} = ${v}`;
      });
      targetSql = sql<SqlBool>`(${sql.join(parts, sql` AND `)})`;
    }

    const db = compileOnlyDb() as Kysely<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const stored = db
      .selectFrom(t.name)
      .select(sql<number>`1`.as("ok"))
      .where(() => targetSql)
      .where((eb) => residualToExpression(residual, eb));
    // The fixed error-raising expression: json_extract() with an invalid path raises
    // "bad JSON path: 'castra_write_check_failed'" (verified on local D1, ADR 0050). Nothing interpolated.
    const query = db.selectNoFrom((eb) =>
      sql<string>`json_extract('{}', CASE WHEN ${eb.exists(stored)} THEN '$' ELSE 'castra_write_check_failed' END)`.as(
        "castra_write_guard",
      ),
    );
    const explanation = explainResidual(t, op, ctx, residual);
    explanation.reason = `guarded write: the stored row must satisfy ${describeRule(rule)} (${explanation.reason ?? ""})`;
    return Object.freeze({
      query,
      explanation,
      compile: (): CompiledQuery<unknown> => query.compile(),
    });
  }

  function projectRow(table: string, ctx: CastraContext, row: Record<string, unknown>): Record<string, unknown> {
    const t = info(table);
    if (!t) reject(404, "not_found", `"${table}" is not exposed`, table, "read", ctx);
    const roles = effectiveRoles(ctx);
    const isSelf =
      t.selfColumn !== undefined && hasUser(ctx) && row[t.selfColumn] !== null && row[t.selfColumn] !== undefined
        ? row[t.selfColumn] === ctx.user.id
        : false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      if (!t.columns.has(key)) continue;
      if (t.hiddenColumns.has(key)) continue;
      const visibleTo = t.visibleTo.get(key);
      if (visibleTo) {
        const byRole = visibleTo.some((r) => r !== "self" && roles.includes(r));
        const bySelf = visibleTo.includes("self") && isSelf;
        if (!byRole && !bySelf) continue;
      }
      out[key] = row[key];
    }
    return out;
  }

  function canFilter(table: string, column: string, ctx: CastraContext): boolean {
    const t = info(table);
    if (!t || !t.rules.read || typeof column !== "string" || !t.columns.has(column)) return false;
    if (t.hiddenColumns.has(column)) return false;
    if (t.config.filterable !== undefined && !t.config.filterable.includes(column)) return false;
    const visibleTo = t.visibleTo.get(column);
    if (visibleTo) {
      const roles = effectiveRoles(ctx);
      return visibleTo.some((r) => r !== "self" && roles.includes(r));
    }
    return true;
  }

  function canReadColumn(table: string, column: string, ctx: CastraContext): boolean {
    const t = info(table);
    if (!t || typeof column !== "string" || !t.columns.has(column) || t.hiddenColumns.has(column)) return false;
    const visibleTo = t.visibleTo.get(column);
    if (!visibleTo) return true;
    const roles = effectiveRoles(ctx);
    return visibleTo.some((r) => r !== "self" && roles.includes(r));
  }

  function explain(decision: Decision | Filter): Explanation {
    const e = decision.explanation;
    return {
      ...e,
      where: e.where ? { sql: e.where.sql, parameters: [...e.where.parameters] } : null,
      hiddenFields: [...e.hiddenFields],
      ...(e.conditionalFields ? { conditionalFields: [...e.conditionalFields] } : {}),
    };
  }

  return Object.freeze({ isOpen, readFilter, prepareWrite, writeGuard, checkRow, projectRow, canFilter, canReadColumn, explain });
}

function buildTableInfo(
  name: string,
  tc: TableConfig,
  ts: TableSnapshot,
  config: CastraConfig,
  snapshot: SchemaSnapshot,
): TableInfo {
  const columns = new Map(ts.columns.map((c) => [c.name, c] as const));
  const requireColumn = (col: string, where: string) => {
    if (!columns.has(col)) throw new CastraConfigError(`tables.${name}.${where}: column "${col}" does not exist in the schema snapshot`);
  };

  const rules: Partial<Record<Operation, RuleNode>> = {};
  const ownerColumns = new Set<string>();
  for (const op of OPERATIONS) {
    const rule = tc[op];
    if (!rule) continue;
    rules[op] = rule.node;
    walkRule(rule.node, (n) => {
      if (n.kind === "owner") {
        requireColumn(n.column, `${op} owner()`);
        ownerColumns.add(n.column);
      }
      if (n.kind === "where" || n.kind === "custom") validatePredicateReferences(name, op, n, columns, config, snapshot);
    });
  }

  const serverColumns = new Set<string>();
  const readonlyColumns = new Set<string>();
  const hiddenColumns = new Set<string>();
  const visibleTo = new Map<string, readonly string[]>();
  for (const [col, fc] of Object.entries(tc.fields ?? {})) {
    requireColumn(col, "fields");
    if (fc.setBy === "server") serverColumns.add(col);
    if (fc.readonly) readonlyColumns.add(col);
    if (fc.hidden) hiddenColumns.add(col);
    if (fc.visibleTo) visibleTo.set(col, [...fc.visibleTo]);
  }
  for (const col of tc.filterable ?? []) {
    requireColumn(col, "filterable");
    if (hiddenColumns.has(col)) throw new CastraConfigError(`tables.${name}.filterable: column "${col}" is hidden`);
  }
  // ADR 0007 amendment: every column named by an owner() rule is implicitly setBy: "server".
  for (const col of ownerColumns) serverColumns.add(col);

  let selfColumn: string | undefined;
  if (tc.selfColumn !== undefined) {
    requireColumn(tc.selfColumn, "selfColumn");
    selfColumn = tc.selfColumn;
  } else if (name === "users") {
    selfColumn = columns.has("id") ? "id" : undefined;
  } else if (rules.read) {
    const readOwners = new Set<string>();
    walkRule(rules.read, (n) => {
      if (n.kind === "owner") readOwners.add(n.column);
    });
    selfColumn = readOwners.size === 1 ? [...readOwners][0] : undefined;
  }

  return {
    name,
    snapshot: ts,
    columns,
    config: tc,
    rules,
    ownerColumns,
    serverColumns,
    readonlyColumns,
    hiddenColumns,
    visibleTo,
    selfColumn,
  };
}

/**
 * Best-effort check that `where`/`custom` predicates only reference tables and columns that exist.
 * The predicate is built once with a probe context (authenticated, holding every role) and its
 * operation tree is walked. Raw `sql` fragments cannot be inspected and are not checked.
 */
function validatePredicateReferences(
  table: string,
  op: Operation,
  node: Extract<RuleNode, { kind: "where" | "custom" }>,
  baseColumns: Map<string, ColumnSnapshot>,
  config: CastraConfig,
  snapshot: SchemaSnapshot,
): void {
  const probe: CastraContext = {
    user: { id: PROBE_USER_ID },
    roles: [...config.roles],
    session: null,
    request: null,
    via: "test",
  };
  const eb = expressionBuilder<any, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const label = node.kind === "custom" ? `custom("${node.name}")` : "where()";
  let expr: unknown;
  try {
    expr = node.kind === "custom" ? node.fn(eb, probe) : node.fn({ eb, ctx: probe });
  } catch (err) {
    throw new CastraConfigError(`tables.${table}.${op} ${label} threw while being validated: ${(err as Error).message}`);
  }
  if (typeof expr !== "object" || expr === null || typeof (expr as { toOperationNode?: unknown }).toOperationNode !== "function") {
    throw new CastraConfigError(`tables.${table}.${op} ${label} must return a Kysely expression`);
  }
  const root = (expr as Expression<SqlBool>).toOperationNode();

  const tableNames = new Set<string>();
  const aliases = new Set<string>();
  const columnNames = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const n = value as { kind?: unknown; [k: string]: unknown };
    if (n.kind === "TableNode") {
      const id = (n.table as { identifier?: { name?: unknown } } | undefined)?.identifier?.name;
      if (typeof id === "string") tableNames.add(id);
    } else if (n.kind === "ColumnNode") {
      const id = (n.column as { name?: unknown } | undefined)?.name;
      if (typeof id === "string") columnNames.add(id);
    } else if (n.kind === "AliasNode") {
      const id = (n.alias as { kind?: unknown; name?: unknown } | undefined)?.name;
      if (typeof id === "string") aliases.add(id);
    }
    for (const v of Object.values(n)) visit(v);
  };
  visit(root);

  const known = [baseColumns];
  for (const tn of tableNames) {
    if (tn === table || aliases.has(tn)) continue;
    const ts = Object.hasOwn(snapshot.tables, tn) ? snapshot.tables[tn] : undefined;
    if (!ts) throw new CastraConfigError(`tables.${table}.${op} ${label}: table "${tn}" does not exist in the schema snapshot`);
    known.push(new Map(ts.columns.map((c) => [c.name, c] as const)));
  }
  for (const col of columnNames) {
    if (aliases.has(col)) continue;
    if (!known.some((m) => m.has(col))) {
      throw new CastraConfigError(`tables.${table}.${op} ${label}: column "${col}" does not exist in the schema snapshot`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function isBindable(v: unknown): boolean {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "bigint" ||
    typeof v === "boolean" ||
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer
  );
}

/**
 * Marker in the SQL error raised by a {@link WriteGuard} that fails (ADR 0050). D1 reports it as
 * `bad JSON path: 'castra_write_check_failed'`.
 */
export const WRITE_CHECK_MARKER = "castra_write_check_failed";

// SQLite skips only ASCII whitespace (space, \t, \n, \v, \f, \r) around numeric text; JS `\s` also matches
// U+00A0, U+2028, U+FEFF, U+3000 and friends, which SQLite treats as non-numeric (the text stays TEXT).
const NUMERIC_TEXT = /^[ \t\n\v\f\r]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\v\f\r]*$/;
const INT_LITERAL = /^[+-]?\d+$/;
const NUM_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** True when the column converts stored values with a numeric affinity (STRICT `ANY` columns do not). */
function isNumericAffinity(t: TableInfo, col: ColumnSnapshot): boolean {
  if (t.snapshot.strict === true && col.type === "ANY") return false;
  return col.affinity === "INTEGER" || col.affinity === "REAL" || col.affinity === "NUMERIC";
}

/**
 * Columns where `prepareWrite` rejects non-numeric text (finding A, ADR 0050): numeric affinity, except
 * declared types naming DATE or TIME, which SQLite date conventions fill with ISO-8601 text.
 */
function requiresNumericText(t: TableInfo, col: ColumnSnapshot): boolean {
  return isNumericAffinity(t, col) && !/DATE|TIME/.test(col.type);
}

/** A JS number SQLite would store as an INTEGER in an INTEGER/NUMERIC column (sqlite3VdbeIntegerAffinity). */
function isExactInteger(v: unknown): boolean {
  if (typeof v === "boolean") return true;
  return typeof v === "number" && Number.isInteger(v) && v > -(2 ** 63) && v < 2 ** 63;
}

/**
 * Binds a candidate value so it compares like a value stored in a column of that affinity. A bound
 * parameter has no affinity, but a stored value does: SQLite converts on storage (TEXT columns store
 * numbers as text; numeric columns store well-formed numeric text as numbers, and integral REALs as
 * INTEGERs in INTEGER/NUMERIC columns) and applies the column affinity to the other operand of a
 * comparison. `CAST(x AS type)` carries the affinity of `type`, and a derived-table column keeps the
 * affinity of its expression, so we CAST wherever SQLite would have converted. Non-numeric text in
 * numeric columns, blobs and values of STRICT `ANY` columns are bound as-is, as SQLite stores them.
 */
function castToAffinity(col: ColumnSnapshot, value: unknown, strict: boolean): RawBuilder<unknown> {
  if (value === null) return sql`${null}`;
  if (strict && col.type === "ANY") return sql`${value}`;
  const isNumberLike = typeof value === "number" || typeof value === "bigint" || typeof value === "boolean";
  const isNumericText = typeof value === "string" && NUMERIC_TEXT.test(value);
  switch (col.affinity) {
    case "TEXT":
      return isNumberLike || typeof value === "string" ? sql`CAST(${value} AS TEXT)` : sql`${value}`;
    case "INTEGER":
    case "NUMERIC":
      // D1 binds every JS number as REAL; storage turns an integral REAL into an INTEGER (finding B).
      if (isExactInteger(value)) return sql`CAST(${value} AS INTEGER)`;
      return isNumberLike || isNumericText ? sql`CAST(${value} AS NUMERIC)` : sql`${value}`;
    case "REAL":
      return isNumberLike || isNumericText ? sql`CAST(${value} AS REAL)` : sql`${value}`;
    default:
      return sql`${value}`;
  }
}

type ParsedDefault = { kind: "value"; value: unknown } | { kind: "numeric"; text: string } | { kind: "expr" };

/**
 * Parses a `PRAGMA table_info.dflt_value` that is a plain literal: NULL, a quoted string, a number,
 * TRUE/FALSE or a blob. Anything else (CURRENT_TIMESTAMP, `(expr)`, hex integers, ...) is `expr`: the
 * dry run cannot evaluate it without building SQL from schema text (CLAUDE.md rule 5).
 */
function parseDefault(d: string | null): ParsedDefault {
  if (d === null) return { kind: "value", value: null };
  const s = d.trim();
  if (/^null$/i.test(s)) return { kind: "value", value: null };
  const str = /^'((?:[^']|'')*)'$/.exec(s);
  if (str) return { kind: "value", value: str[1]!.replace(/''/g, "'") };
  if (NUM_LITERAL.test(s)) return { kind: "numeric", text: s };
  if (/^true$/i.test(s)) return { kind: "numeric", text: "1" };
  if (/^false$/i.test(s)) return { kind: "numeric", text: "0" };
  const blob = /^[xX]'((?:[0-9a-fA-F]{2})*)'$/.exec(s);
  if (blob) {
    const hex = blob[1]!;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return { kind: "value", value: bytes };
  }
  return { kind: "expr" };
}

/**
 * The value a numeric literal default is stored as. SQLite parses an integer literal that fits in 64
 * bits as INTEGER, any other numeric literal as REAL, then applies the column affinity.
 */
function castNumericLiteral(col: ColumnSnapshot, text: string, strict: boolean): RawBuilder<unknown> {
  const isInt = INT_LITERAL.test(text) && BigInt(text) >= INT64_MIN && BigInt(text) <= INT64_MAX;
  // The literal itself, typed as SQLite's parser types it. `text` is bound, never spliced into SQL.
  const literal = isInt ? sql`CAST(${text} AS INTEGER)` : sql`CAST(${text} AS REAL)`;
  if (strict && col.type === "ANY") return literal;
  switch (col.affinity) {
    case "TEXT":
      return sql`CAST(${literal} AS TEXT)`;
    case "INTEGER":
    case "NUMERIC":
      return isInt || !isExactInteger(Number(text)) ? literal : sql`CAST(${Number(text)} AS INTEGER)`;
    case "REAL":
      return sql`CAST(${literal} AS REAL)`;
    default:
      return literal;
  }
}
