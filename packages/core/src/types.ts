/**
 * Contract types shared across all Castra packages.
 *
 * These types are the stable seam between the schema, policy, API, auth and MCP layers.
 * Changing them is a cross-package change; record the reason in an ADR.
 */

/** A CRUD operation a policy can govern. An operation without a policy is closed. */
export type Operation = "read" | "create" | "update" | "delete";

/**
 * SQLite column type affinity, derived from the declared type using SQLite's affinity rules.
 * @see https://www.sqlite.org/datatype3.html#determination_of_column_affinity
 */
export type SqliteAffinity = "INTEGER" | "REAL" | "TEXT" | "BLOB" | "NUMERIC";

/** One column of a table, as discovered via `PRAGMA table_info`. */
export interface ColumnSnapshot {
  /** Column name. Identifiers used in SQL must come from the snapshot only. */
  name: string;
  /** Declared SQLite type, uppercased (e.g. `"TEXT"`, `"INTEGER"`, `"VARCHAR(255)"`). Empty string if undeclared. */
  type: string;
  /** Type affinity derived from the declared type. */
  affinity: SqliteAffinity;
  /** True if the column is declared `NOT NULL` (or is part of the primary key where SQLite enforces it). */
  notNull: boolean;
  /** Default value expression exactly as SQLite reports it, or `null` when there is none. */
  defaultValue: string | null;
  /** 1-based position within the primary key; `0` when the column is not part of the primary key. */
  primaryKeyPosition: number;
}

/** A foreign key from a column of this table to a column of another table. */
export interface ForeignKeySnapshot {
  /** Local column holding the reference. */
  column: string;
  /** Referenced table. */
  referencesTable: string;
  /** Referenced column in `referencesTable`. */
  referencesColumn: string;
  /** `ON DELETE` action as reported by SQLite (e.g. `"NO ACTION"`, `"CASCADE"`). */
  onDelete: string;
  /** `ON UPDATE` action as reported by SQLite (e.g. `"NO ACTION"`, `"CASCADE"`). */
  onUpdate: string;
}

/** An index on a table, as discovered via `PRAGMA index_list` / `index_info`. */
export interface IndexSnapshot {
  /** Index name. */
  name: string;
  /** True for unique indexes. */
  unique: boolean;
  /** Indexed columns in index order. */
  columns: string[];
}

/** One table of the database. */
export interface TableSnapshot {
  /** Table name. */
  name: string;
  /** Columns in declaration order. */
  columns: ColumnSnapshot[];
  /** Primary key column names ordered by `primaryKeyPosition`; empty when the table has none. */
  primaryKey: string[];
  /** Foreign keys declared on this table. */
  foreignKeys: ForeignKeySnapshot[];
  /** Indexes declared on this table. */
  indexes: IndexSnapshot[];
  /**
   * `true` for a `STRICT` table (values are type-checked, `ANY` columns store values verbatim).
   * Omitted for ordinary tables, so snapshots of non-STRICT schemas are unchanged (ADR 0050).
   */
  strict?: true;
}

/**
 * Committed JSON snapshot of the database schema. The runtime uses this instead of
 * introspecting per request; deploy compares it against the live database (drift check).
 */
export interface SchemaSnapshot {
  /** Snapshot format version. */
  version: 1;
  /** ISO 8601 timestamp of generation. */
  generatedAt: string;
  /** Tables keyed by table name. */
  tables: Record<string, TableSnapshot>;
}

/** How the identity in a {@link CastraContext} was established. */
export type ContextVia = "session" | "apiKey" | "mcpToken" | "anonymous" | "test";

/**
 * Request context (`ctx`) every policy is evaluated against. Built by the auth layer for REST
 * and MCP alike, so both paths run the same engine with the same inputs.
 */
export interface CastraContext {
  /** The authenticated user, or `null` for anonymous callers. */
  user: { id: string; email?: string; name?: string } | null;
  /** Role names granted to the user (from the roles table). Empty for anonymous callers. */
  roles: string[];
  /** The session backing this request, or `null` when not session-based. */
  session: { id: string; expiresAt: Date } | null;
  /** The originating HTTP request, or `null` when evaluated outside a request (tests, MCP dry-runs). */
  request: { method: string; url: string; headers: Headers } | null;
  /** How the identity was established. */
  via: ContextVia;
}
