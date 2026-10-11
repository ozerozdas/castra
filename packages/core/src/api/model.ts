import { sql, type RawBuilder } from "kysely";
import { z } from "zod";
import { CastraConfigError } from "../policy/errors.js";
import { walkRule } from "../policy/rules.js";
import { OPERATIONS, type CastraConfig } from "../config.js";
import { effectiveRoles } from "../policy/compile.js";
import type { CastraContext, ColumnSnapshot, SchemaSnapshot, TableSnapshot } from "../types.js";
import { ApiError } from "./problem.js";

/** Default `api.maxLimit` (ARCHITECTURE §4). */
export const DEFAULT_MAX_LIMIT = 100;
/** Default page size when `?limit` is absent: `min(25, maxLimit)` (ADR 0040). */
export const DEFAULT_PAGE_SIZE = 25;
/** Max children loaded per parent row for a one-to-many include (ADR 0042). */
export const INCLUDE_MANY_PER_PARENT = 25;
/** Key on a parent row listing the one-to-many includes cut at {@link INCLUDE_MANY_PER_PARENT} rows (ADR 0074). */
export const TRUNCATED_KEY = "$truncated";

/** A relation reachable through `?include=`. Derived from foreign keys in the snapshot (ADR 0042). */
export interface Relation {
  /** Name used in `?include=` and as the key in the response row. */
  name: string;
  /** `one`: many-to-one (`posts.author_id → users.id`); `many`: one-to-many (`posts ← comments.post_id`). */
  kind: "one" | "many";
  /** Included table. */
  target: string;
  /** Column on the base table whose value is matched. */
  localColumn: string;
  /** Column on the included table that is matched against `localColumn`. */
  targetColumn: string;
}

/** Everything the API layer needs to know about one table, computed once per config + snapshot. */
export interface TableModel {
  name: string;
  snapshot: TableSnapshot;
  columns: Map<string, ColumnSnapshot>;
  /** Single-column primary key, or `undefined` (then `/:id` routes do not exist). */
  pk: ColumnSnapshot | undefined;
  /** How a single-column primary key is produced on create. */
  pkStrategy: "uuid" | "rowid" | "client" | "none";
  hidden: Set<string>;
  visibleTo: Map<string, readonly string[]>;
  readonly: Set<string>;
  /** `setBy: "server"` plus every `owner()` column (ADR 0007 amendment). */
  server: Set<string>;
  owner: Set<string>;
  relations: Map<string, Relation>;
  /** `filterable` from config, if set. */
  filterable: readonly string[] | undefined;
}

/** The API model of a config + snapshot. */
export interface ApiModel {
  config: CastraConfig;
  snapshot: SchemaSnapshot;
  maxLimit: number;
  tables: Map<string, TableModel>;
}

const modelCache = new WeakMap<SchemaSnapshot, WeakMap<CastraConfig, ApiModel>>();

/**
 * Builds (and caches per snapshot × config object) the API model. Only tables present in both the
 * config and the snapshot are modelled; whether an operation is open is still decided by the engine.
 * Throws {@link CastraConfigError} for identifiers the API cannot address safely (a `.` in a
 * configured table or column name).
 */
export function apiModel(config: CastraConfig, snapshot: SchemaSnapshot): ApiModel {
  let byConfig = modelCache.get(snapshot);
  if (!byConfig) {
    byConfig = new WeakMap();
    modelCache.set(snapshot, byConfig);
  }
  const cached = byConfig.get(config);
  if (cached) return cached;

  const tables = new Map<string, TableModel>();
  for (const [name, tc] of Object.entries(config.tables)) {
    const ts = Object.hasOwn(snapshot.tables, name) ? snapshot.tables[name] : undefined;
    if (!ts) continue;
    if (name.includes(".")) throw new CastraConfigError(`table "${name}": names containing "." are not supported by the REST API`);
    for (const c of ts.columns) {
      if (c.name.includes(".")) throw new CastraConfigError(`column "${name}.${c.name}": names containing "." are not supported by the REST API`);
    }
    const columns = new Map(ts.columns.map((c) => [c.name, c] as const));
    const owner = new Set<string>();
    for (const op of OPERATIONS) {
      const rule = tc[op];
      if (rule) walkRule(rule.node, (n) => n.kind === "owner" && owner.add(n.column));
    }
    const hidden = new Set<string>();
    const readonly = new Set<string>();
    const server = new Set<string>(owner);
    const visibleTo = new Map<string, readonly string[]>();
    for (const [col, fc] of Object.entries(tc.fields ?? {})) {
      if (fc.hidden) hidden.add(col);
      if (fc.readonly) readonly.add(col);
      if (fc.setBy === "server") server.add(col);
      if (fc.visibleTo) visibleTo.set(col, fc.visibleTo);
    }
    const pk = ts.primaryKey.length === 1 ? columns.get(ts.primaryKey[0]!) : undefined;
    let pkStrategy: TableModel["pkStrategy"] = "none";
    if (pk) {
      if (pk.affinity === "TEXT") pkStrategy = "uuid";
      else if (pk.affinity === "INTEGER" && pk.type === "INTEGER") pkStrategy = "rowid";
      else pkStrategy = "client";
    }
    tables.set(name, { name, snapshot: ts, columns, pk, pkStrategy, hidden, visibleTo, readonly, server, owner, relations: new Map(), filterable: tc.filterable });
  }
  for (const t of tables.values()) t.relations = deriveRelations(t, tables);

  const model: ApiModel = { config, snapshot, maxLimit: config.api?.maxLimit ?? DEFAULT_MAX_LIMIT, tables };
  byConfig.set(config, model);
  return model;
}

/**
 * Relations of `base`, derived from foreign keys (ADR 0042):
 * - many-to-one: an FK column `<name>_id` on `base` gives relation `<name>`;
 * - one-to-many: a table `T` with exactly one FK column to `base` gives relation `T`.
 * Names that collide with a column of `base` or with each other are dropped (not includable).
 * Only configured tables are candidates; whether their `read` is open is checked per request.
 */
function deriveRelations(base: TableModel, tables: Map<string, TableModel>): Map<string, Relation> {
  const candidates: Relation[] = [];
  for (const fk of base.snapshot.foreignKeys) {
    if (!fk.column.endsWith("_id") || fk.column.length <= 3) continue;
    if (!tables.has(fk.referencesTable)) continue;
    candidates.push({ name: fk.column.slice(0, -3), kind: "one", target: fk.referencesTable, localColumn: fk.column, targetColumn: fk.referencesColumn });
  }
  for (const other of tables.values()) {
    const fks = other.snapshot.foreignKeys.filter((fk) => fk.referencesTable === base.name);
    if (fks.length !== 1) continue;
    const fk = fks[0]!;
    candidates.push({ name: other.name, kind: "many", target: other.name, localColumn: fk.referencesColumn, targetColumn: fk.column });
  }
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const out = new Map<string, Relation>();
  for (const c of candidates) {
    if (counts.get(c.name) !== 1 || base.columns.has(c.name)) continue;
    const target = tables.get(c.target)!;
    if (!base.columns.has(c.localColumn) || !target.columns.has(c.targetColumn)) continue;
    out.set(c.name, c);
  }
  return out;
}

/**
 * True when `column` of `t` is returned to `ctx` on every row: not hidden, and either not
 * `visibleTo`-gated or gated by a real role the caller holds (`self` is per row, so it never counts).
 */
export function alwaysVisible(t: TableModel, column: string, ctx: CastraContext): boolean {
  const roles = effectiveRoles(ctx);
  if (!t.columns.has(column) || t.hidden.has(column)) return false;
  const vt = t.visibleTo.get(column);
  if (!vt) return true;
  return vt.some((r) => r !== "self" && roles.includes(r));
}

/** True for a column whose declared type is BLOB (not representable in JSON in v0.1, ADR 0041). */
export function isBlobColumn(c: ColumnSnapshot): boolean {
  return c.affinity === "BLOB" && c.type !== "";
}

/** Zod schema for a non-null value of one column (ADR 0041). */
function baseSchema(c: ColumnSnapshot): z.ZodType {
  if (isBlobColumn(c)) return z.never({ error: "BLOB columns cannot be written over JSON" });
  if (c.affinity === "TEXT") return z.string();
  if (c.affinity === "INTEGER") return z.int();
  if (c.affinity === "REAL" || c.affinity === "NUMERIC") return z.number();
  return z.union([z.string(), z.number()]); // no declared type: any JSON scalar SQLite can store
}

/** Zod schema for one column value: nullable when the column is not `NOT NULL` (ADR 0041). */
export function columnSchema(c: ColumnSnapshot): z.ZodType {
  const s = baseSchema(c);
  return c.notNull ? s : s.nullable();
}

/**
 * Validates the values of a write body against the column types (strict: unknown keys are 400).
 * Hidden columns are reported exactly like unknown ones.
 */
export function validateValues(t: TableModel, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    const c = t.hidden.has(key) ? undefined : t.columns.get(key);
    if (!c) throw new ApiError(400, "unknown_column", `unknown column "${key}"`);
    const r = columnSchema(c).safeParse(value);
    if (!r.success) {
      throw new ApiError(400, "invalid_value", `column "${key}": ${r.error.issues[0]?.message ?? "invalid value"}`);
    }
  }
}

const INTEGER_TEXT = /^[+-]?\d{1,16}$/;
const NUMBER_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Coerces a query-string value to the column's JSON type (ADR 0041). Throws 400 on mismatch.
 * `what` names the value in the message (e.g. `filter "status"`).
 */
export function coerceText(c: ColumnSnapshot, raw: string, what: string): string | number {
  if (isBlobColumn(c)) throw new ApiError(400, "invalid_filter", `${what}: BLOB columns cannot be compared`);
  if (c.affinity === "INTEGER") {
    const n = Number(raw);
    if (!INTEGER_TEXT.test(raw) || !Number.isSafeInteger(n)) throw new ApiError(400, "invalid_value", `${what}: expected an integer`);
    return n;
  }
  if (c.affinity === "REAL" || c.affinity === "NUMERIC") {
    const n = Number(raw);
    if (!NUMBER_TEXT.test(raw) || !Number.isFinite(n)) throw new ApiError(400, "invalid_value", `${what}: expected a number`);
    return n;
  }
  return raw;
}

/** Coerces a JSON value from a cursor to the column's type; `null` allowed only for nullable columns. */
export function coerceJson(c: ColumnSnapshot, v: unknown): string | number | null {
  if (v === null) {
    if (c.notNull) throw new ApiError(400, "invalid_cursor", "invalid cursor");
    return null;
  }
  if (typeof v !== "string" && typeof v !== "number") throw new ApiError(400, "invalid_cursor", "invalid cursor");
  if (!baseSchema(c).safeParse(v).success) throw new ApiError(400, "invalid_cursor", "invalid cursor");
  return v;
}

/** `"table"."column"`, both identifiers taken from the snapshot and escaped by Kysely. */
export function colRef(table: string, column: string): RawBuilder<unknown> {
  return sql.id(table, column);
}

const STRFTIME_ISO = /^strftime\('%Y-%m-%dT%H:%M:%fZ',\s*'now'\)$/i;
const STRING_LITERAL = /^'((?:[^']|'')*)'$/;
const NUMERIC_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Best-effort value of a column default for the create write check (ADR 0043). Literal defaults
 * (strings, numbers, NULL, TRUE/FALSE) and the common timestamp defaults are evaluated in JS;
 * any other expression yields `undefined` (the column is NULL in the check candidate).
 */
export function evaluateDefault(defaultValue: string | null, now: Date = new Date()): unknown {
  if (defaultValue === null) return undefined;
  let d = defaultValue.trim();
  while (d.startsWith("(") && d.endsWith(")")) d = d.slice(1, -1).trim();
  const s = STRING_LITERAL.exec(d);
  if (s) return s[1]!.replace(/''/g, "'");
  if (NUMERIC_LITERAL.test(d)) return Number(d);
  const u = d.toUpperCase();
  if (u === "NULL") return null;
  if (u === "TRUE") return 1;
  if (u === "FALSE") return 0;
  const iso = now.toISOString();
  if (STRFTIME_ISO.test(d)) return iso;
  if (u === "CURRENT_TIMESTAMP") return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  if (u === "CURRENT_DATE") return iso.slice(0, 10);
  if (u === "CURRENT_TIME") return iso.slice(11, 19);
  return undefined;
}
