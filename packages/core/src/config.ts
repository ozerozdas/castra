import { CastraConfigError } from "./policy/errors.js";
import { isRule, walkRule, type Rule } from "./policy/rules.js";
import type { Operation } from "./types.js";

/** Per-column field rules. */
export interface FieldConfig {
  /** Never returned to any caller (including admins) and never writable. */
  hidden?: true;
  /** Never writable by clients (create or update). */
  readonly?: true;
  /**
   * Value is set by the server, never taken from input. Owner columns (used in an `owner()` rule of
   * the table) are filled from `ctx.user.id` on create. A client value that differs is rejected.
   * Owner columns are implicitly `setBy: "server"`; declaring it is optional (ADR 0007, amendment).
   */
  setBy?: "server";
  /** Returned only to callers holding one of these roles. `"self"` matches the caller's own row. */
  visibleTo?: string[];
}

/** Policy and field rules for one table. An operation without a rule is closed. */
export interface TableConfig {
  read?: Rule;
  create?: Rule;
  update?: Rule;
  delete?: Rule;
  fields?: Record<string, FieldConfig>;
  /** Columns clients may filter on. Must exist in the schema snapshot and must not be `hidden`. */
  filterable?: string[];
  /**
   * Column compared with `ctx.user.id` for the `"self"` pseudo-role. Defaults to `"id"` for a table
   * named `users`, otherwise to the single `owner()` column of the `read` rule (if exactly one).
   * Without a default, `"self"` never matches. See ADR 0006.
   */
  selfColumn?: string;
}

/** Authentication settings (consumed by `@castra-kit/auth`). */
export interface AuthConfig {
  provider?: "better-auth";
  methods?: string[];
}

/** Top-level Castra configuration, the argument of {@link defineConfig}. */
export interface CastraConfig {
  database: "d1";
  auth?: AuthConfig;
  storage?: boolean;
  /** `maxLimit` caps `?limit` (default 100). `welcome: false` turns off the `GET /` response (ADR 0071). */
  api?: { maxLimit?: number; welcome?: boolean };
  /** All role names used anywhere in the config. `"self"` is reserved. */
  roles: string[];
  /** Tables exposed through the API. Tables not listed here are closed. */
  tables: Record<string, TableConfig>;
}

/** Better Auth core tables. Never exposed, never configurable. */
export const AUTH_TABLES: readonly string[] = Object.freeze(["user", "session", "account", "verification"]);

/** The CRUD operations, in a fixed order. */
export const OPERATIONS: readonly Operation[] = Object.freeze(["read", "create", "update", "delete"]);

/**
 * True for tables Castra never exposes: Better Auth tables, `_castra_*` internal tables, SQLite
 * internal tables and the wrangler migration ledger (`d1_migrations`). Compared case-insensitively, because SQLite identifiers are case-insensitive.
 */
export function isReservedTable(name: string): boolean {
  const n = name.toLowerCase();
  return AUTH_TABLES.includes(n) || n.startsWith("_castra_") || n.startsWith("sqlite_") || n.startsWith("_cf_") || n === "d1_migrations";
}

const TABLE_KEYS = new Set(["read", "create", "update", "delete", "fields", "filterable", "selfColumn"]);
const FIELD_KEYS = new Set(["hidden", "readonly", "setBy", "visibleTo"]);
const TOP_KEYS = new Set(["database", "auth", "storage", "api", "roles", "tables"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function fail(msg: string): never {
  throw new CastraConfigError(msg);
}

/**
 * Validates a Castra configuration and returns it frozen.
 *
 * Throws {@link CastraConfigError} on: policies for Better Auth tables (`user`, `session`, `account`,
 * `verification`) or `_castra_*` / `sqlite_*` tables; unknown roles in `role(...)`; `visibleTo` naming
 * unknown roles (except `"self"`); rule slots holding anything other than a rule; unknown keys.
 * Column names are checked against the schema snapshot later, by `createPolicyEngine`.
 */
export function defineConfig(config: CastraConfig): CastraConfig {
  if (!isPlainObject(config)) fail("config must be an object");
  for (const k of Object.keys(config)) if (!TOP_KEYS.has(k)) fail(`unknown config key "${k}"`);
  if (config.database !== "d1") fail(`database must be "d1"`);
  if (config.storage !== undefined && typeof config.storage !== "boolean") fail("storage must be a boolean");
  if (config.api !== undefined) {
    if (!isPlainObject(config.api)) fail("api must be an object");
    const max = config.api.maxLimit;
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) fail("api.maxLimit must be a positive integer");
    if (config.api.welcome !== undefined && typeof config.api.welcome !== "boolean") fail("api.welcome must be a boolean");
  }
  if (config.auth !== undefined && !isPlainObject(config.auth)) fail("auth must be an object");

  if (!Array.isArray(config.roles)) fail("roles must be an array of role names");
  const roles = new Set<string>();
  for (const r of config.roles) {
    if (typeof r !== "string" || r.length === 0) fail("role names must be non-empty strings");
    if (r === "self") fail(`"self" is a reserved pseudo-role and cannot be declared in roles`);
    if (roles.has(r)) fail(`duplicate role "${r}"`);
    roles.add(r);
  }

  if (!isPlainObject(config.tables)) fail("tables must be an object");
  for (const [table, tc] of Object.entries(config.tables)) {
    if (isReservedTable(table)) fail(`table "${table}" is reserved (auth or internal) and can never be exposed`);
    if (!isPlainObject(tc)) fail(`tables.${table} must be an object`);
    for (const k of Object.keys(tc)) if (!TABLE_KEYS.has(k)) fail(`tables.${table}: unknown key "${k}"`);

    for (const op of OPERATIONS) {
      const rule = tc[op];
      if (rule === undefined) continue;
      if (!isRule(rule)) fail(`tables.${table}.${op} must be a rule built with castra's rule builders`);
      walkRule(rule.node, (n) => {
        if (n.kind === "role") {
          for (const r of n.roles) if (!roles.has(r)) fail(`tables.${table}.${op}: role("${r}") is not declared in roles`);
        }
      });
    }

    if (tc.fields !== undefined) {
      if (!isPlainObject(tc.fields)) fail(`tables.${table}.fields must be an object`);
      for (const [col, fc] of Object.entries(tc.fields)) {
        if (!isPlainObject(fc)) fail(`tables.${table}.fields.${col} must be an object`);
        for (const k of Object.keys(fc)) if (!FIELD_KEYS.has(k)) fail(`tables.${table}.fields.${col}: unknown key "${k}"`);
        if (fc.hidden !== undefined && fc.hidden !== true) fail(`tables.${table}.fields.${col}.hidden must be true`);
        if (fc.readonly !== undefined && fc.readonly !== true) fail(`tables.${table}.fields.${col}.readonly must be true`);
        if (fc.setBy !== undefined && fc.setBy !== "server") fail(`tables.${table}.fields.${col}.setBy must be "server"`);
        if (fc.visibleTo !== undefined) {
          if (!Array.isArray(fc.visibleTo)) fail(`tables.${table}.fields.${col}.visibleTo must be an array`);
          for (const r of fc.visibleTo) {
            if (r !== "self" && !roles.has(r as string)) {
              fail(`tables.${table}.fields.${col}.visibleTo: role "${String(r)}" is not declared in roles`);
            }
          }
        }
      }
    }

    if (tc.filterable !== undefined) {
      if (!Array.isArray(tc.filterable) || tc.filterable.some((c) => typeof c !== "string" || c.length === 0)) {
        fail(`tables.${table}.filterable must be an array of column names`);
      }
      for (const col of tc.filterable) {
        const fields = tc.fields as Record<string, FieldConfig> | undefined;
        if (fields !== undefined && Object.hasOwn(fields, col) && fields[col]?.hidden) fail(`tables.${table}.filterable: column "${col}" is hidden; filtering on it would leak its value`);
      }
    }
    if (tc.selfColumn !== undefined && (typeof tc.selfColumn !== "string" || tc.selfColumn.length === 0)) {
      fail(`tables.${table}.selfColumn must be a column name`);
    }
  }

  return deepFreeze(config);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const v of value) deepFreeze(v);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    return Object.freeze(value);
  }
  return value; // rules are frozen by construction; functions are left alone
}
