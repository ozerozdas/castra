import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
  type CompiledQuery,
  type Expression,
  type ExpressionBuilder,
  type SqlBool,
} from "kysely";
import type { CastraConfig } from "../config.js";
import type { Filter, PolicyEngine, WriteGuard } from "../policy/engine.js";
import { PolicyError, type Explanation } from "../policy/errors.js";
import { hasUser } from "../policy/compile.js";
import type { CastraContext, Operation, SchemaSnapshot } from "../types.js";
import {
  alwaysVisible,
  apiModel,
  coerceJson,
  coerceText,
  colRef,
  DEFAULT_PAGE_SIZE,
  evaluateDefault,
  INCLUDE_MANY_PER_PARENT,
  isBlobColumn,
  validateValues,
  type ApiModel,
  type Relation,
  type TableModel,
} from "./model.js";
import { encodeCursor, type ParsedFilter, type ParsedRequest, type SortKey } from "./parse.js";
import { runGuardedWrite, type D1DatabaseLike } from "../db/guarded-write.js";
import { ApiError, notFound } from "./problem.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEB = ExpressionBuilder<any, any>;
type Cond = (eb: AnyEB) => Expression<SqlBool>;

/** D1 accepts at most 100 bound parameters per statement. */
const D1_MAX_PARAMS = 100;
/** Placeholder shown in plans for values only known at execution time. */
export const PARENT_KEYS = "$parentKeys";

/**
 * A query builder that can only compile. Plans are built and compiled without a database; the
 * compiled SQL is executed later by `executePlan` on the caller's Kysely instance.
 */
const builder: AnyDb = new Kysely({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

/** One SQL statement of a plan, as it will be sent to D1 (`?` placeholders). */
export interface PlannedStatement {
  /** What the statement is for: `list`, `count`, `get`, `include:<name>`, `load`, `insert`, `update`, `delete`, `reread`, `reference:<column>`. */
  name: string;
  sql: string;
  /** Bound parameters. `"$parentKeys"` / `"$insertedId"` stand for values known only at execution. */
  parameters: unknown[];
  /** Extra notes, e.g. when the statement is conditional or its values are finalised at execution. */
  note?: string;
}

/** Result of executing a plan: an HTTP-style status and a JSON body (`null` for 204). */
export interface ApiResult {
  status: 200 | 201 | 204;
  body: unknown;
}

const RUN: unique symbol = Symbol("castra.plan.run");

/**
 * A planned request: every SQL statement it will run (compiled, not executed) and the policy
 * explanations that shaped them (base table first, then one per include / referenced table).
 * `JSON.stringify(plan)` gives exactly what MCP `explain_query` returns; the executable part is
 * held under a symbol and is not serialised.
 */
export interface Plan {
  kind: ParsedRequest["kind"];
  table: string;
  op: Operation;
  statements: PlannedStatement[];
  explanations: Explanation[];
  /** Includes that will be loaded, in order. */
  includes: string[];
  /** Page size for list requests. */
  limit?: number;
  [RUN]: (db: AnyDb, options: ExecuteOptions) => Promise<ApiResult>;
}

const OP_OF: Record<ParsedRequest["kind"], Operation> = {
  list: "read",
  get: "read",
  create: "create",
  update: "update",
  delete: "delete",
};

function show(name: string, q: CompiledQuery, note?: string): PlannedStatement {
  const s: PlannedStatement = { name, sql: q.sql, parameters: [...q.parameters] };
  if (note) s.note = note;
  return s;
}

/** Throws 401/403 when the operation's rule is constant-false for this caller (ADR 0044). */
function denyIfConstFalse(f: Filter, ctx: CastraContext): void {
  if (f.explanation.allowed !== false) return;
  if (hasUser(ctx)) throw new ApiError(403, "forbidden", "This operation is not allowed for this user.");
  throw new ApiError(401, "unauthenticated", "Authentication required.");
}

function selectColumns(t: TableModel) {
  return t.snapshot.columns.map((c) => colRef(t.name, c.name).as(c.name));
}

function pkValue(t: TableModel, id: string): string | number {
  try {
    return coerceText(t.pk!, id, "id");
  } catch {
    throw notFound();
  }
}

/**
 * Builds the queries for a parsed request without executing them. Checks, in this order: the
 * table × operation is open (else 404, identical for unknown and closed tables); the rule is not
 * constant-false for `ctx` (else 401/403); filter, sort and include columns against
 * `engine.canFilter` and field visibility; cursor against the current sort; create input through
 * `engine.prepareWrite` and the column types. Throws {@link ApiError} or {@link PolicyError}.
 */
export function planRequest(
  engine: PolicyEngine,
  snapshot: SchemaSnapshot,
  config: CastraConfig,
  parsed: ParsedRequest,
  ctx: CastraContext,
): Plan {
  const model = apiModel(config, snapshot);
  const op = OP_OF[parsed.kind];
  const t = model.tables.get(parsed.table);
  if (!t || !engine.isOpen(parsed.table, op)) throw notFound();
  if (parsed.kind !== "list" && parsed.kind !== "create" && !t.pk) throw notFound();
  // Item routes address rows by primary key: refuse them for callers who cannot read the key, so
  // `/:id` is not a probe of a hidden or role-gated key column. Answers like a closed route.
  if ((parsed.kind === "get" || parsed.kind === "update" || parsed.kind === "delete") && !engine.canReadColumn(t.name, t.pk!.name, ctx)) {
    throw notFound();
  }

  switch (parsed.kind) {
    case "list":
    case "get":
      return planRead(engine, model, t, parsed, ctx);
    case "create":
      return planCreate(engine, model, t, parsed.body, ctx);
    case "update":
      return planUpdate(engine, model, t, parsed.id, parsed.body, ctx);
    case "delete":
      return planDelete(engine, t, parsed.id, ctx);
  }
}

/** Options of {@link executePlan}. */
export interface ExecuteOptions {
  /**
   * The D1 binding (`env.DB`). Creates and updates run through `runGuardedWrite` as one atomic
   * `batch()` of [write, write guard] (ADR 0050). Without it, creates and updates fail closed (500).
   */
  d1?: D1DatabaseLike;
}

/**
 * Runs a plan built by {@link planRequest}. Reads go through `db` (Kysely on D1); creates and
 * updates run as one atomic [write, guard] batch on `options.d1`, then the row is re-read under the
 * read policy. Every returned row, base or included, passes through `engine.projectRow`.
 */
export async function executePlan(db: AnyDb, plan: Plan, options: ExecuteOptions = {}): Promise<ApiResult> {
  const run = plan[RUN];
  if (typeof run !== "function") throw new TypeError("executePlan: not a plan built by planRequest");
  return run(db, options);
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

interface IncludePlan {
  rel: Relation;
  target: TableModel;
  filter: Filter;
  build: (keys: unknown[]) => CompiledQuery;
}

function filterCondition(t: TableModel, f: ParsedFilter): Cond {
  const c = t.columns.get(f.column)!;
  const ref = colRef(t.name, c.name);
  const what = `filter "${f.column}"`;
  switch (f.op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const v = coerceText(c, f.value, what);
      const sqlOp = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.op] as "=" | "<>" | ">" | ">=" | "<" | "<=";
      return (eb) => eb(ref, sqlOp, v);
    }
    case "in": {
      const values = f.value.map((v) => coerceText(c, v, what));
      const json = JSON.stringify(values);
      return () => sql<SqlBool>`${ref} in (select "value" from json_each(${json}))`;
    }
    case "like": {
      if (isBlobColumn(c)) throw new ApiError(400, "invalid_filter", `${what}: BLOB columns cannot be compared`);
      const pattern = f.value.replace(/[\\%_]/g, (m) => `\\${m}`).replace(/\*/g, "%");
      return () => sql<SqlBool>`${ref} like ${pattern} escape '\\'`;
    }
    case "is":
      if (f.value === "null") return () => sql<SqlBool>`${ref} is null`;
      if (f.value === "true") return () => sql<SqlBool>`${ref} is true`;
      return () => sql<SqlBool>`${ref} is false`;
  }
}

/**
 * Keyset condition "row comes after `values` in the order `keys`", NULL-aware for SQLite's default
 * ordering (NULLs first ascending, last descending).
 */
function keysetCondition(t: TableModel, keys: SortKey[], values: (string | number | null)[]): Cond {
  return (eb) => {
    const branches: Expression<SqlBool>[] = [];
    for (let i = 0; i < keys.length; i++) {
      const parts: Expression<SqlBool>[] = [];
      for (let j = 0; j < i; j++) {
        const ref = colRef(t.name, keys[j]!.column);
        const v = values[j]!;
        parts.push(v === null ? sql<SqlBool>`${ref} is null` : eb(ref, "=", v));
      }
      const ref = colRef(t.name, keys[i]!.column);
      const v = values[i]!;
      if (keys[i]!.desc) {
        if (v === null) continue; // nothing sorts after NULL when descending
        parts.push(eb.or([eb(ref, "<", v), sql<SqlBool>`${ref} is null`]));
      } else {
        parts.push(v === null ? sql<SqlBool>`${ref} is not null` : eb(ref, ">", v));
      }
      branches.push(eb.and(parts));
    }
    return branches.length === 0 ? sql<SqlBool>`1 = 0` : eb.or(branches);
  };
}

function sortKeyString(k: SortKey): string {
  return k.desc ? `-${k.column}` : k.column;
}

function planIncludes(engine: PolicyEngine, model: ApiModel, t: TableModel, names: string[], ctx: CastraContext): IncludePlan[] {
  const out: IncludePlan[] = [];
  for (const name of names) {
    const unavailable = () => new ApiError(400, "invalid_include", `include "${name}" is not available`);
    const rel = t.relations.get(name);
    if (!rel) throw unavailable();
    const target = model.tables.get(rel.target);
    if (!target || !engine.isOpen(rel.target, "read")) throw unavailable();
    // The join columns must be visible to this caller on every row, or attaching rows would reveal them.
    if (!alwaysVisible(t, rel.localColumn, ctx) || !alwaysVisible(target, rel.targetColumn, ctx)) throw unavailable();
    const filter = engine.readFilter(rel.target, "read", ctx);
    const build = (keys: unknown[]): CompiledQuery => {
      const json = keys.length === 1 && keys[0] === PARENT_KEYS ? PARENT_KEYS : JSON.stringify(keys);
      const where: Cond = (eb) =>
        eb.and([filter.apply(eb), sql<SqlBool>`${colRef(target.name, rel.targetColumn)} in (select "value" from json_each(${json}))`]);
      if (rel.kind === "one") {
        return builder.selectFrom(target.name).select(selectColumns(target)).where(where).compile();
      }
      const order = target.snapshot.primaryKey.length > 0 ? target.snapshot.primaryKey : [rel.targetColumn];
      const inner = builder
        .selectFrom(target.name)
        .select([
          ...selectColumns(target),
          sql<number>`row_number() over (partition by ${colRef(target.name, rel.targetColumn)} order by ${sql.join(order.map((c) => colRef(target.name, c)))})`.as(
            "__castra_rn",
          ),
        ])
        .where(where);
      return builder
        .selectFrom(inner.as("__castra_inc"))
        .selectAll()
        .where(sql.id("__castra_rn"), "<=", INCLUDE_MANY_PER_PARENT)
        .orderBy(sql.id("__castra_rn"))
        .compile();
    };
    out.push({ rel, target, filter, build });
  }
  return out;
}

function planRead(
  engine: PolicyEngine,
  model: ApiModel,
  t: TableModel,
  parsed: Extract<ParsedRequest, { kind: "list" | "get" }>,
  ctx: CastraContext,
): Plan {
  const policy = engine.readFilter(t.name, "read", ctx);
  denyIfConstFalse(policy, ctx);
  const includes = planIncludes(engine, model, t, parsed.include, ctx);
  const explanations = [engine.explain(policy), ...includes.map((i) => engine.explain(i.filter))];
  const includeStatements = includes.map((i) =>
    show(`include:${i.rel.name}`, i.build([PARENT_KEYS]), i.rel.kind === "many" ? `at most ${INCLUDE_MANY_PER_PARENT} rows per parent` : undefined),
  );

  if (parsed.kind === "get") {
    const id = pkValue(t, parsed.id);
    const q = builder
      .selectFrom(t.name)
      .select(selectColumns(t))
      .where((eb) => eb.and([policy.apply(eb), eb(colRef(t.name, t.pk!.name), "=", id)]))
      .limit(1)
      .compile();
    return {
      kind: "get",
      table: t.name,
      op: "read",
      statements: [show("get", q), ...includeStatements],
      explanations,
      includes: includes.map((i) => i.rel.name),
      [RUN]: async (db) => {
        const rows = (await db.executeQuery<Record<string, unknown>>(q)).rows;
        if (rows.length === 0) throw notFound();
        const [row] = await attach(db, engine, t, ctx, rows, includes);
        return { status: 200, body: row };
      },
    };
  }

  // list
  const filters = parsed.filters.map((f) => {
    if (!engine.canFilter(t.name, f.column, ctx)) {
      throw new ApiError(400, "invalid_filter", `column "${f.column}" cannot be used for filtering`);
    }
    return filterCondition(t, f);
  });
  const keys: SortKey[] = [];
  for (const s of parsed.sort) {
    if (!engine.canFilter(t.name, s.column, ctx)) {
      throw new ApiError(400, "invalid_sort", `column "${s.column}" cannot be used for sorting`);
    }
    keys.push(s);
  }
  for (const pkCol of t.snapshot.primaryKey) if (!keys.some((k) => k.column === pkCol)) keys.push({ column: pkCol, desc: false });
  const cursorAllowed = t.snapshot.primaryKey.length > 0 && t.snapshot.primaryKey.every((c) => alwaysVisible(t, c, ctx));
  const keyStrings = keys.map(sortKeyString);

  let keyset: Cond | undefined;
  if (parsed.cursor) {
    if (!cursorAllowed) throw new ApiError(400, "invalid_cursor", "cursor pagination is not available for this table; use offset");
    const ck = parsed.cursor.keys;
    if (ck.length !== keyStrings.length || ck.some((k, i) => k !== keyStrings[i])) {
      throw new ApiError(400, "invalid_cursor", "cursor does not match the current sort");
    }
    const values = keys.map((k, i) => coerceJson(t.columns.get(k.column)!, parsed.cursor!.values[i]));
    keyset = keysetCondition(t, keys, values);
  }

  const limit = Math.min(parsed.limit ?? Math.min(DEFAULT_PAGE_SIZE, model.maxLimit), model.maxLimit);
  const where = (withKeyset: boolean): Cond => (eb) =>
    eb.and([policy.apply(eb), ...filters.map((f) => f(eb)), ...(withKeyset && keyset ? [keyset(eb)] : [])]);

  let main = builder.selectFrom(t.name).select(selectColumns(t)).where(where(true));
  for (const k of keys) main = main.orderBy(colRef(t.name, k.column), k.desc ? "desc" : "asc");
  main = main.limit(limit + 1);
  if (parsed.offset !== undefined) main = main.offset(parsed.offset);
  const mainQ = main.compile();
  const countQ = parsed.count
    ? builder.selectFrom(t.name).select(sql<number>`count(*)`.as("count")).where(where(false)).compile()
    : undefined;
  for (const q of [mainQ, countQ]) {
    if (q && q.parameters.length > D1_MAX_PARAMS) throw new ApiError(400, "invalid_request", "too many filter values in one request");
  }

  return {
    kind: "list",
    table: t.name,
    op: "read",
    statements: [show("list", mainQ, `fetches limit + 1 rows to detect a next page`), ...(countQ ? [show("count", countQ)] : []), ...includeStatements],
    explanations,
    includes: includes.map((i) => i.rel.name),
    limit,
    [RUN]: async (db) => {
      const [res, countRes] = await Promise.all([
        db.executeQuery<Record<string, unknown>>(mainQ),
        countQ ? db.executeQuery<{ count: number }>(countQ) : Promise.resolve(undefined),
      ]);
      const rows = res.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      const nextCursor =
        res.rows.length > limit && cursorAllowed && last ? encodeCursor({ keys: keyStrings, values: keys.map((k) => last[k.column] ?? null) }) : null;
      const data = await attach(db, engine, t, ctx, rows, includes);
      const body: Record<string, unknown> = { data, nextCursor };
      if (countRes) body.count = Number(countRes.rows[0]?.count ?? 0);
      return { status: 200, body };
    },
  };
}

function jsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      row[k] = btoa(bin);
    } else if (typeof v === "bigint") {
      row[k] = Number(v);
    }
  }
  return row;
}

/** Projects base rows and attaches includes, each loaded in one query under its own read policy. */
async function attach(
  db: AnyDb,
  engine: PolicyEngine,
  t: TableModel,
  ctx: CastraContext,
  rows: Record<string, unknown>[],
  includes: IncludePlan[],
): Promise<Record<string, unknown>[]> {
  const out = rows.map((r) => jsonSafe(engine.projectRow(t.name, ctx, r)));
  for (const inc of includes) {
    const keys = [...new Set(rows.map((r) => r[inc.rel.localColumn]).filter((v) => v !== null && v !== undefined))];
    const byKey = new Map<unknown, Record<string, unknown>[]>();
    if (keys.length > 0 && inc.filter.explanation.allowed !== false) {
      const res = await db.executeQuery<Record<string, unknown>>(inc.build(keys));
      for (const r of res.rows) {
        const k = r[inc.rel.targetColumn];
        const list = byKey.get(k) ?? [];
        list.push(jsonSafe(engine.projectRow(inc.target.name, ctx, r)));
        byKey.set(k, list);
      }
    }
    rows.forEach((r, i) => {
      const found = byKey.get(r[inc.rel.localColumn]) ?? [];
      out[i]![inc.rel.name] = inc.rel.kind === "one" ? (found[0] ?? null) : found;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

interface ReferenceCheck {
  column: string;
  explanation: Explanation;
  build: (value: unknown) => CompiledQuery;
}

/**
 * For every foreign key whose target table has an open `read` policy, the referenced row must be
 * readable by the caller, so writes cannot attach data to (or probe the existence of) rows the
 * caller cannot see (ADR 0043). Targets without a read policy are left to the database.
 */
function referenceChecks(engine: PolicyEngine, model: ApiModel, t: TableModel, ctx: CastraContext): ReferenceCheck[] {
  const out: ReferenceCheck[] = [];
  for (const fk of t.snapshot.foreignKeys) {
    const target = model.tables.get(fk.referencesTable);
    if (!target || !target.columns.has(fk.referencesColumn) || !engine.isOpen(target.name, "read")) continue;
    const filter = engine.readFilter(target.name, "read", ctx);
    out.push({
      column: fk.column,
      explanation: engine.explain(filter),
      build: (value) =>
        builder
          .selectFrom(target.name)
          .select(sql<number>`1`.as("ok"))
          .where((eb) => eb.and([filter.apply(eb), eb(colRef(target.name, fk.referencesColumn), "=", value)]))
          .limit(1)
          .compile(),
    });
  }
  return out;
}

async function runReferenceChecks(db: AnyDb, checks: ReferenceCheck[], values: Record<string, unknown>): Promise<void> {
  for (const c of checks) {
    if (!Object.hasOwn(values, c.column)) continue;
    const v = values[c.column];
    if (v === null || v === undefined) continue;
    const res = await db.executeQuery(c.build(v));
    if (res.rows.length === 0) throw new ApiError(400, "invalid_reference", `column "${c.column}" references a row that does not exist`);
  }
}

function d1Unavailable(): ApiError {
  return new ApiError(500, "write_unavailable", "Writes are disabled: no D1 binding is configured.");
}

/** A compiled query as a Kysely `Compilable` (what `runGuardedWrite` takes). */
function compilable(q: CompiledQuery) {
  return { compile: () => q };
}

async function runWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError || err instanceof PolicyError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/constraint/i.test(msg)) throw new ApiError(409, "constraint", "The write violates a database constraint.");
    throw err;
  }
}

/** Re-read of a written row under the read policy (ADR 0043). */
function rereadPlan(engine: PolicyEngine, t: TableModel, ctx: CastraContext) {
  const pk = t.pk!;
  if (!engine.isOpen(t.name, "read")) return { build: undefined, explanation: undefined };
  const filter = engine.readFilter(t.name, "read", ctx);
  return {
    explanation: engine.explain(filter),
    build: (id: unknown) =>
      builder
        .selectFrom(t.name)
        .select(selectColumns(t))
        .where((eb) => eb.and([filter.apply(eb), eb(colRef(t.name, pk.name), "=", id)]))
        .limit(1)
        .compile(),
  };
}

/**
 * The projected re-read row. When the caller cannot read the written row, `{ <pk>: id }` if the
 * caller may read the key column (`canReadColumn`), otherwise `{}`: a hidden or role-gated key
 * (e.g. a rowid that also counts the table's rows) never leaves the server.
 */
function rereadBody(
  engine: PolicyEngine,
  t: TableModel,
  ctx: CastraContext,
  rows: Record<string, unknown>[] | undefined,
  id: unknown,
): Record<string, unknown> {
  const row = rows?.[0];
  if (row) return jsonSafe(engine.projectRow(t.name, ctx, row));
  const pk = t.pk!.name;
  if (!engine.canReadColumn(t.name, pk, ctx)) return {};
  return { [pk]: typeof id === "bigint" ? Number(id) : id };
}

function planCreate(engine: PolicyEngine, model: ApiModel, t: TableModel, body: Record<string, unknown>, ctx: CastraContext): Plan {
  const prepared = engine.prepareWrite(t.name, "create", ctx, body);
  const values = { ...prepared.values };
  validateValues(t, values);
  const pk = t.pk;
  // The write guard and the re-read address the row by a single-column primary key (ADR 0043).
  if (!pk) throw notFound();
  if ((t.pkStrategy === "uuid" || t.pkStrategy === "rowid") && Object.hasOwn(body, pk.name)) {
    throw new ApiError(400, "server_column", `column "${pk.name}" is generated by the server`);
  }
  if (t.pkStrategy === "uuid") values[pk.name] = crypto.randomUUID();
  for (const c of t.snapshot.columns) {
    if (Object.hasOwn(values, c.name) || !c.notNull || c.defaultValue !== null) continue;
    if (t.pkStrategy === "rowid" && c === pk) continue;
    if (t.hidden.has(c.name)) continue; // never named to clients; the database rejects the insert (409)
    throw new ApiError(400, "missing_column", `missing required column "${c.name}"`);
  }

  // Early pre-check candidate (a clean 403 before anything is written): the input merged with the
  // defaults that can be evaluated. The authoritative check is the write guard on the stored row.
  const now = new Date();
  const candidate: Record<string, unknown> = {};
  for (const c of t.snapshot.columns) {
    if (Object.hasOwn(values, c.name)) candidate[c.name] = values[c.name];
    else {
      const d = evaluateDefault(c.defaultValue, now);
      if (d !== undefined) candidate[c.name] = d;
    }
  }

  const rowid = t.pkStrategy === "rowid";
  // A rowid key is assigned by SQLite: the guard targets last_insert_rowid() inside the batch and
  // the insert RETURNs the key for the re-read.
  const insertQ = builder.insertInto(t.name).values(values).returning(colRef(t.name, pk.name).as(pk.name)).compile();
  const guard: WriteGuard = engine.writeGuard(t.name, "create", ctx, rowid ? "last_insert_rowid" : { [pk.name]: values[pk.name] });
  const refs = referenceChecks(engine, model, t, ctx);
  const rr = rereadPlan(engine, t, ctx);
  const rereadQ = rowid ? undefined : rr.build?.(values[pk.name]);

  const statements: PlannedStatement[] = [
    ...refs
      .filter((r) => Object.hasOwn(values, r.column) && values[r.column] !== null)
      .map((r) => show(`reference:${r.column}`, r.build(values[r.column]))),
    show("insert", insertQ, "batch statement 1; sent only after the early write check (engine.checkRow) passes"),
    show("guard", guard.compile(), "batch statement 2: raises and rolls back the insert when the stored row violates the create policy"),
  ];
  if (rr.build) statements.push(show("reread", rereadQ ?? rr.build("$insertedId"), "after the batch, under the read policy"));

  return {
    kind: "create",
    table: t.name,
    op: "create",
    statements,
    explanations: [guard.explanation, ...refs.map((r) => r.explanation), ...(rr.explanation ? [rr.explanation] : [])],
    includes: [],
    [RUN]: async (db, options) =>
      runWrite(async () => {
        await runReferenceChecks(db, refs, values);
        const decision = await engine.checkRow(db, t.name, "create", ctx, candidate);
        if (!decision.allowed) throw new ApiError(403, "forbidden", "The new row would violate the create policy.");
        // Fail closed: nothing is written without an atomic [write, guard] batch (ADR 0050).
        if (!options.d1) throw d1Unavailable();
        const written = await runGuardedWrite<Record<string, unknown>>(options.d1, compilable(insertQ), guard);
        const id = rowid ? (written.results[0]?.[pk.name] ?? null) : values[pk.name];
        const reread = rr.build && id !== null ? (rereadQ ?? rr.build(id)) : undefined;
        const rows = reread ? (await db.executeQuery<Record<string, unknown>>(reread)).rows : undefined;
        return { status: 201, body: rereadBody(engine, t, ctx, rows, id) };
      }),
  };
}

function planUpdate(
  engine: PolicyEngine,
  model: ApiModel,
  t: TableModel,
  rawId: string,
  body: Record<string, unknown>,
  ctx: CastraContext,
): Plan {
  const pk = t.pk!;
  const policy = engine.readFilter(t.name, "update", ctx);
  denyIfConstFalse(policy, ctx);
  if (Object.keys(body).length === 0) throw new ApiError(400, "invalid_body", "request body has no columns to update");
  validateValues(t, body);
  const id = pkValue(t, rawId);

  const byPk: Cond = (eb) => eb.and([policy.apply(eb), eb(colRef(t.name, pk.name), "=", id)]);
  const loadQ = builder.selectFrom(t.name).select(selectColumns(t)).where(byPk).limit(1).compile();
  const refs = referenceChecks(engine, model, t, ctx);
  const rr = rereadPlan(engine, t, ctx);
  const rereadQ = rr.build?.(id);
  // The key cannot change (checked before the write), so the guard targets the same key.
  const guard: WriteGuard = engine.writeGuard(t.name, "update", ctx, { [pk.name]: id });
  // USING: the UPDATE re-applies the update policy, so a row that stopped matching is not touched.
  const buildUpdate = (values: Record<string, unknown>): CompiledQuery => builder.updateTable(t.name).set(values).where(byPk).compile();

  const templateValues = Object.fromEntries(Object.entries(body).filter(([k]) => !t.server.has(k) && k !== pk.name));
  const statements: PlannedStatement[] = [show("load", loadQ, "the row must match the update policy (USING)")];
  for (const r of refs) {
    if (Object.hasOwn(body, r.column) && body[r.column] !== null) statements.push(show(`reference:${r.column}`, r.build(body[r.column])));
  }
  if (Object.keys(templateValues).length > 0) {
    statements.push(
      show(
        "update",
        buildUpdate(templateValues),
        "batch statement 1; values finalised by engine.prepareWrite against the loaded row, sent only after the early write check (engine.checkRow) passes",
      ),
    );
  }
  statements.push(show("guard", guard.compile(), "batch statement 2: raises and rolls back the update when the stored row violates the update policy"));
  if (rereadQ) statements.push(show("reread", rereadQ, "after the batch, under the read policy"));

  return {
    kind: "update",
    table: t.name,
    op: "update",
    statements,
    explanations: [engine.explain(policy), guard.explanation, ...refs.map((r) => r.explanation), ...(rr.explanation ? [rr.explanation] : [])],
    includes: [],
    [RUN]: async (db, options) =>
      runWrite(async () => {
        const existing = (await db.executeQuery<Record<string, unknown>>(loadQ)).rows[0];
        if (!existing) throw notFound();
        const prepared = engine.prepareWrite(t.name, "update", ctx, body, existing);
        const values = { ...prepared.values };
        validateValues(t, values);
        if (Object.hasOwn(values, pk.name) && values[pk.name] !== existing[pk.name]) {
          throw new ApiError(400, "readonly_column", `column "${pk.name}" cannot be changed`);
        }
        delete values[pk.name];
        if (Object.keys(values).length === 0) {
          // Nothing to write: only unchanged server-set columns (or the unchanged key) were sent.
          const rows = rereadQ ? (await db.executeQuery<Record<string, unknown>>(rereadQ)).rows : undefined;
          return { status: 200, body: rereadBody(engine, t, ctx, rows, id) };
        }
        await runReferenceChecks(db, refs, values);
        const decision = await engine.checkRow(db, t.name, "update", ctx, { ...existing, ...values });
        if (!decision.allowed) throw new ApiError(403, "forbidden", "The updated row would violate the update policy.");
        // Fail closed: nothing is written without an atomic [write, guard] batch (ADR 0050).
        if (!options.d1) throw d1Unavailable();
        const written = await runGuardedWrite(options.d1, compilable(buildUpdate(values)), guard);
        if (Number(written.meta.changes ?? 0) === 0) {
          throw new ApiError(409, "conflict", "The row changed while it was being updated; retry the request.");
        }
        const rows = rereadQ ? (await db.executeQuery<Record<string, unknown>>(rereadQ)).rows : undefined;
        return { status: 200, body: rereadBody(engine, t, ctx, rows, id) };
      }),
  };
}

function planDelete(engine: PolicyEngine, t: TableModel, rawId: string, ctx: CastraContext): Plan {
  const pk = t.pk!;
  const policy = engine.readFilter(t.name, "delete", ctx);
  denyIfConstFalse(policy, ctx);
  const id = pkValue(t, rawId);
  const q = builder
    .deleteFrom(t.name)
    .where((eb) => eb.and([policy.apply(eb), eb(colRef(t.name, pk.name), "=", id)]))
    .compile();
  return {
    kind: "delete",
    table: t.name,
    op: "delete",
    statements: [show("delete", q)],
    explanations: [engine.explain(policy)],
    includes: [],
    [RUN]: async (db) =>
      runWrite(async () => {
        const res = await db.executeQuery(q);
        if (!res.numAffectedRows) throw notFound();
        return { status: 204, body: null };
      }),
  };
}
