import type {
  ColumnSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "../types.js";
import { affinityOf } from "./affinity.js";

/**
 * Runs one SQL statement against the database and returns its rows. Implemented by the caller
 * (D1 binding, `getPlatformProxy`, a test harness, ...) so that introspection stays transport-agnostic.
 */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Options for {@link introspect}. */
export interface IntrospectOptions {
  /** Value for `SchemaSnapshot.generatedAt`. Defaults to the current time (ISO 8601). */
  generatedAt?: string;
}

/**
 * True for tables that are SQLite or D1 internals and never part of the snapshot:
 * `sqlite_*`, `_cf_*` (Workers/D1 internal) and `d1_migrations` (wrangler migration bookkeeping).
 *
 * Better Auth tables and `_castra_*` tables are deliberately NOT excluded: the snapshot is complete,
 * and the policy engine is what refuses to expose them. Consumers recognise them by name
 * (`_castra_` prefix, or the auth package's table list).
 */
export function isInternalTable(name: string): boolean {
  return name.startsWith("sqlite_") || name.startsWith("_cf_") || name === "d1_migrations";
}

/**
 * Quote an identifier for use in SQL text: wrap in double quotes and double any embedded double quote.
 * NUL characters cannot be represented safely and are rejected. Introspection no longer needs this
 * (it binds names to `pragma_*()` table-valued functions, ADR 0009); also used by the collation probe.
 */
export function quoteIdentifier(name: string): string {
  if (name.includes("\0")) throw new Error("Invalid identifier: contains a NUL character");
  return `"${name.replace(/"/g, '""')}"`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Does a `CREATE TABLE` statement (as stored in `sqlite_master.sql`) carry an `ON CONFLICT REPLACE`
 * clause that can delete rows, i.e. one on a `UNIQUE` or `PRIMARY KEY` constraint (ADR 0066)?
 *
 * With such a clause, an `INSERT`/`UPDATE` that collides on the constraint silently deletes the
 * conflicting row, which no delete policy sees. The scan is conservative: it tokenizes the statement
 * (skipping string literals, quoted identifiers and comments) and flags every `ON CONFLICT REPLACE`
 * except the one form that never deletes a row, `NOT NULL ON CONFLICT REPLACE` (it substitutes the
 * column default). Anything it cannot tokenize (an unterminated literal or comment) is flagged.
 */
export function hasReplaceConflictClause(createSql: string): boolean {
  const tokens: string[] = [];
  let i = 0;
  const n = createSql.length;
  while (i < n) {
    const ch = createSql[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "-" && createSql[i + 1] === "-") {
      const end = createSql.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
    } else if (ch === "/" && createSql[i + 1] === "*") {
      const end = createSql.indexOf("*/", i + 2);
      if (end < 0) return true; // unterminated comment: unsure, flag
      i = end + 2;
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      for (;;) {
        if (j >= n) return true; // unterminated literal or identifier: unsure, flag
        if (createSql[j] === close) {
          if (close !== "]" && createSql[j + 1] === close) {
            j += 2; // doubled quote inside the literal
            continue;
          }
          break;
        }
        j++;
      }
      tokens.push(ch === "'" ? "'literal'" : '"identifier"');
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(createSql[j]!)) j++;
      tokens.push(createSql.slice(i, j).toUpperCase());
      i = j;
    } else {
      tokens.push(ch);
      i++;
    }
  }
  for (let k = 0; k + 2 < tokens.length; k++) {
    if (tokens[k] !== "ON" || tokens[k + 1] !== "CONFLICT" || tokens[k + 2] !== "REPLACE") continue;
    const notNull = k >= 2 && tokens[k - 2] === "NOT" && tokens[k - 1] === "NULL";
    if (!notNull) return true;
  }
  return false;
}

/**
 * Sets `collation` on columns declared `COLLATE NOCASE` or `COLLATE RTRIM` (ADR 0075). No pragma reports a
 * column's collation, so SQLite is asked directly: a compound SELECT takes each column's collation from
 * its leftmost SELECT, so comparing a probe row against `'A'` and `'a '` reveals NOCASE and RTRIM.
 * Identifiers come from `pragma_table_info` and are quoted; no row of the table is read (`WHERE 0`).
 */
async function readCollations(query: QueryFn, table: string, columns: ColumnSnapshot[]): Promise<void> {
  if (columns.length === 0) return;
  const probes = columns.map((_, i) => `x${i} = 'A' AS n${i}, x${i} = 'a ' AS r${i}`).join(", ");
  const sources = columns.map((c, i) => `${quoteIdentifier(c.name)} AS x${i}`).join(", ");
  const literals = columns.map(() => "'a'").join(", ");
  const [row] = await query(`SELECT ${probes} FROM (SELECT ${sources} FROM ${quoteIdentifier(table)} WHERE 0 UNION ALL SELECT ${literals})`);
  columns.forEach((c, i) => {
    if (num(row?.[`n${i}`]) === 1) c.collation = "NOCASE";
    else if (num(row?.[`r${i}`]) === 1) c.collation = "RTRIM";
  });
}

/** A foreign key row before implicit parent columns are resolved. */
interface RawForeignKey {
  column: string;
  referencesTable: string;
  /** `null` when the parent column was omitted (`REFERENCES parent`). */
  referencesColumn: string | null;
  /** Position within a composite key (`seq` of `PRAGMA foreign_key_list`). */
  seq: number;
  onDelete: string;
  onUpdate: string;
}

/**
 * Build a {@link SchemaSnapshot} from a live SQLite/D1 database.
 *
 * Sources: `sqlite_master` (tables) and the table-valued functions `pragma_table_info`,
 * `pragma_foreign_key_list`, `pragma_index_list`, `pragma_index_info` and `pragma_table_list` (STRICT flag), plus the stored `CREATE TABLE` text (`sqlite_master.sql`, for
 * conflict clauses), called with bound parameters (ADR 0009). Views and the tables matched by {@link isInternalTable}
 * are skipped. Output is deterministic: tables sorted by name, columns in declaration order, foreign
 * keys sorted by (column, table, referenced column), indexes sorted by name.
 *
 * Mapping notes:
 * - `conflictReplace: true` when the stored `CREATE TABLE` text has an `ON CONFLICT REPLACE` clause
 *   that can delete rows ({@link hasReplaceConflictClause}, ADR 0066).
 * - `notNull` follows `PRAGMA table_info`, plus single-column `INTEGER PRIMARY KEY` columns (rowid
 *   aliases), which can never read back as NULL.
 * - A foreign key that omits the parent column (`REFERENCES users`) is resolved to the parent's
 *   primary key column at the same position.
 * - Composite foreign keys yield one entry per column pair.
 * - Primary-key-origin indexes are omitted (covered by `primaryKey`); partial and expression indexes
 *   are omitted because the contract cannot express them faithfully.
 */
export async function introspect(query: QueryFn, options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
  const masterRows = await query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  const names = masterRows
    .map((r) => str(r.name))
    .filter((n) => !isInternalTable(n))
    .sort(compare);

  const tables: Record<string, TableSnapshot> = {};
  const rawForeignKeys = new Map<string, RawForeignKey[]>();
  for (const name of names) {
    const { table, foreignKeys } = await introspectTable(query, name);
    tables[name] = table;
    rawForeignKeys.set(name, foreignKeys);
  }

  // Second pass: resolve implicit parent columns now that every primary key is known.
  for (const [name, raw] of rawForeignKeys) {
    const resolved: ForeignKeySnapshot[] = raw.map((fk) => ({
      column: fk.column,
      referencesTable: fk.referencesTable,
      referencesColumn: fk.referencesColumn ?? tables[fk.referencesTable]?.primaryKey[fk.seq] ?? "",
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    }));
    resolved.sort(
      (a, b) =>
        compare(a.column, b.column) ||
        compare(a.referencesTable, b.referencesTable) ||
        compare(a.referencesColumn, b.referencesColumn),
    );
    tables[name]!.foreignKeys = resolved;
  }

  return { version: 1, generatedAt: options.generatedAt ?? new Date().toISOString(), tables };
}

async function introspectTable(
  query: QueryFn,
  name: string,
): Promise<{ table: TableSnapshot; foreignKeys: RawForeignKey[] }> {
  const infoRows = await query("SELECT * FROM pragma_table_info(?)", [name]);
  const ordered = [...infoRows].sort((a, b) => num(a.cid) - num(b.cid));
  const pkColumnCount = ordered.filter((r) => num(r.pk) > 0).length;

  const columns: ColumnSnapshot[] = ordered.map((r) => {
    const type = str(r.type).trim().toUpperCase();
    const primaryKeyPosition = num(r.pk);
    const isRowidAlias = pkColumnCount === 1 && primaryKeyPosition === 1 && type === "INTEGER";
    return {
      name: str(r.name),
      type,
      affinity: affinityOf(type),
      notNull: num(r.notnull) === 1 || isRowidAlias,
      defaultValue: r.dflt_value === null || r.dflt_value === undefined ? null : str(r.dflt_value),
      primaryKeyPosition,
    };
  });

  const primaryKey = columns
    .filter((c) => c.primaryKeyPosition > 0)
    .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
    .map((c) => c.name);

  const fkRows = await query("SELECT * FROM pragma_foreign_key_list(?)", [name]);
  const foreignKeys: RawForeignKey[] = fkRows.map((r) => ({
    column: str(r.from),
    referencesTable: str(r.table),
    referencesColumn: r.to === null || r.to === undefined ? null : str(r.to),
    seq: num(r.seq),
    onDelete: str(r.on_delete),
    onUpdate: str(r.on_update),
  }));

  const indexRows = await query("SELECT * FROM pragma_index_list(?)", [name]);
  const indexes: IndexSnapshot[] = [];
  for (const idx of indexRows) {
    if (str(idx.origin) === "pk" || num(idx.partial) === 1) continue;
    const indexName = str(idx.name);
    const cols = await query("SELECT * FROM pragma_index_info(?)", [indexName]);
    const inOrder = [...cols].sort((a, b) => num(a.seqno) - num(b.seqno));
    // Expression indexes report a NULL column name (cid -2); the contract cannot represent them.
    if (inOrder.some((c) => c.name === null || c.name === undefined)) continue;
    indexes.push({ name: indexName, unique: num(idx.unique) === 1, columns: inOrder.map((c) => str(c.name)) });
  }
  indexes.sort((a, b) => compare(a.name, b.name));

  const listRows = await query("SELECT * FROM pragma_table_list(?) WHERE schema = 'main'", [name]);
  const strict = listRows.some((r) => num(r.strict) === 1);

  // The stored CREATE TABLE text is the only place SQLite keeps constraint conflict clauses.
  const sqlRows = await query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
  const createSql = sqlRows[0]?.sql;
  const conflictReplace = typeof createSql === "string" && hasReplaceConflictClause(createSql);

  await readCollations(query, name, columns);

  const table: TableSnapshot = { name, columns, primaryKey, foreignKeys: [], indexes };
  if (strict) table.strict = true;
  if (conflictReplace) table.conflictReplace = true;
  return { table, foreignKeys };
}
