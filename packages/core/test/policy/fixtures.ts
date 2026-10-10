import type { CastraContext, ColumnSnapshot, SchemaSnapshot, SqliteAffinity, TableSnapshot } from "../../src/index.js";

type ColSpec = [name: string, type: string, opts?: { notNull?: boolean; pk?: boolean }];

function affinityOf(type: string): SqliteAffinity {
  const t = type.toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t === "" || t.includes("BLOB")) return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** Builds a table snapshot by hand (the Schema agent's generator is not a dependency of these tests). */
export function table(name: string, cols: ColSpec[]): TableSnapshot {
  const columns: ColumnSnapshot[] = cols.map(([n, type, opts]) => ({
    name: n,
    type,
    affinity: affinityOf(type),
    notNull: opts?.notNull ?? false,
    defaultValue: null,
    primaryKeyPosition: opts?.pk ? 1 : 0,
  }));
  return {
    name,
    columns,
    primaryKey: cols.filter(([, , o]) => o?.pk).map(([n]) => n),
    foreignKeys: [],
    indexes: [],
  };
}

export function snapshotOf(...tables: TableSnapshot[]): SchemaSnapshot {
  return { version: 1, generatedAt: "2026-10-10T00:00:00.000Z", tables: Object.fromEntries(tables.map((t) => [t.name, t])) };
}

/** Mirrors examples/blog/migrations plus Better Auth / internal tables and a property-test table. */
export const blogSnapshot: SchemaSnapshot = snapshotOf(
  table("users", [
    ["id", "TEXT", { pk: true, notNull: true }],
    ["email", "TEXT", { notNull: true }],
    ["name", "TEXT"],
    ["password_hash", "TEXT"],
    ["created_at", "TEXT", { notNull: true }],
  ]),
  table("posts", [
    ["id", "TEXT", { pk: true, notNull: true }],
    ["author_id", "TEXT", { notNull: true }],
    ["title", "TEXT", { notNull: true }],
    ["body", "TEXT", { notNull: true }],
    ["status", "TEXT", { notNull: true }],
    ["internal_notes", "TEXT"],
    ["views", "INTEGER"],
    ["created_at", "TEXT", { notNull: true }],
  ]),
  table("comments", [
    ["id", "TEXT", { pk: true, notNull: true }],
    ["post_id", "TEXT", { notNull: true }],
    ["user_id", "TEXT", { notNull: true }],
    ["body", "TEXT", { notNull: true }],
    ["created_at", "TEXT", { notNull: true }],
  ]),
  table("audit_logs", [
    ["id", "TEXT", { pk: true }],
    ["action", "TEXT"],
    ["created_at", "TEXT"],
  ]),
  table("user", [["id", "TEXT", { pk: true }]]),
  table("session", [["id", "TEXT", { pk: true }]]),
  table("account", [["id", "TEXT", { pk: true }]]),
  table("verification", [["id", "TEXT", { pk: true }]]),
  table("_castra_roles", [["user_id", "TEXT"], ["role", "TEXT"]]),
  table("items", [
    ["id", "INTEGER", { pk: true }],
    ["owner_id", "TEXT"],
    ["status", "TEXT"],
    ["category", "TEXT"],
    ["score", "INTEGER"],
  ]),
);

export const ROLES = ["admin", "editor", "member"];

export function anon(roles: string[] = []): CastraContext {
  return { user: null, roles, session: null, request: null, via: "anonymous" };
}

export function user(id: string, roles: string[] = []): CastraContext {
  return { user: { id }, roles, session: null, request: null, via: "test" };
}

/** DDL for the tables the D1 tests execute against. */
export const DDL = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, name TEXT, password_hash TEXT, created_at TEXT NOT NULL DEFAULT '2026-01-01')`,
  `CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY NOT NULL, author_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', internal_notes TEXT, views INTEGER, created_at TEXT NOT NULL DEFAULT '2026-01-01')`,
  `CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY NOT NULL, post_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '2026-01-01')`,
  `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, owner_id TEXT, status TEXT, category TEXT, score INTEGER)`,
];
