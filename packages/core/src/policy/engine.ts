import { expressionBuilder, sql, type Expression, type ExpressionBuilder, type Kysely, type RawBuilder, type SqlBool } from "kysely";
import { defineConfig, isReservedTable, OPERATIONS, type CastraConfig, type TableConfig } from "../config.js";
import type { CastraContext, ColumnSnapshot, Operation, SchemaSnapshot, TableSnapshot } from "../types.js";
import {
  compileExpression,
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
   * WITH CHECK: evaluates the operation's rule against a candidate row in SQL, so `where` and
   * `custom` predicates behave exactly as in a `WHERE`. Use for create, and for update on the
   * existing row merged with the patch.
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
  const snapshot = options.snapshot;
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.tables !== "object" || snapshot.tables === null) {
    throw new CastraConfigError("snapshot must be a version 1 schema snapshot");
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
    let allowed: boolean;
    if (residual.kind === "const") {
      allowed = residual.value;
    } else {
      // SELECT 1 FROM (SELECT CAST(? AS <affinity>) AS "c1", ...) AS "<table>" WHERE <rule>
      // Identifiers come from the snapshot only; values are bound parameters.
      const candidate = db
        .selectNoFrom(() => t.snapshot.columns.map((c) => castToAffinity(c, candidateRow[c.name] ?? null).as(c.name)))
        .as(t.name);
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
    return { table, op, allowed, explanation };
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

  function explain(decision: Decision | Filter): Explanation {
    const e = decision.explanation;
    return {
      ...e,
      where: e.where ? { sql: e.where.sql, parameters: [...e.where.parameters] } : null,
      hiddenFields: [...e.hiddenFields],
      ...(e.conditionalFields ? { conditionalFields: [...e.conditionalFields] } : {}),
    };
  }

  return Object.freeze({ isOpen, readFilter, prepareWrite, checkRow, projectRow, explain });
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
  for (const col of tc.filterable ?? []) requireColumn(col, "filterable");

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

const NUMERIC_TEXT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

/**
 * Binds a candidate value so it compares like a value stored in a column of that affinity. A bound
 * parameter has no affinity, but a stored value does: SQLite converts on storage (TEXT columns store
 * numbers as text; numeric columns store well-formed numeric text as numbers) and applies the column
 * affinity to the other operand of a comparison. `CAST(x AS type)` carries the affinity of `type`, and
 * a derived-table column keeps the affinity of its expression, so we CAST wherever SQLite would have
 * converted. Non-numeric text in numeric columns and blobs are bound as-is, as SQLite stores them.
 */
function castToAffinity(col: ColumnSnapshot, value: unknown): RawBuilder<unknown> {
  if (value === null) return sql`${null}`;
  const isNumberLike = typeof value === "number" || typeof value === "bigint" || typeof value === "boolean";
  const isNumericText = typeof value === "string" && NUMERIC_TEXT.test(value);
  switch (col.affinity) {
    case "TEXT":
      return isNumberLike || typeof value === "string" ? sql`CAST(${value} AS TEXT)` : sql`${value}`;
    case "INTEGER":
    case "NUMERIC":
      return isNumberLike || isNumericText ? sql`CAST(${value} AS NUMERIC)` : sql`${value}`;
    case "REAL":
      return isNumberLike || isNumericText ? sql`CAST(${value} AS REAL)` : sql`${value}`;
    default:
      return sql`${value}`;
  }
}
