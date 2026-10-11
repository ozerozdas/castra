import type { ColumnSnapshot, ForeignKeySnapshot, IndexSnapshot, SchemaSnapshot, TableSnapshot } from "../types.js";

const q = (s: string): string => JSON.stringify(s);

function fkKey(fk: ForeignKeySnapshot): string {
  return `${fk.column} -> ${fk.referencesTable}.${fk.referencesColumn}`;
}

function describeFk(fk: ForeignKeySnapshot): string {
  return `${fkKey(fk)} (on delete ${fk.onDelete}, on update ${fk.onUpdate})`;
}

function describeIndex(ix: IndexSnapshot): string {
  return `${ix.unique ? "unique " : ""}(${ix.columns.join(", ")})`;
}

function diffMaps<T>(
  scope: string,
  kind: string,
  a: Map<string, T>,
  b: Map<string, T>,
  out: string[],
  changed: (key: string, left: T, right: T) => void,
): void {
  for (const key of [...a.keys()].sort()) {
    if (!b.has(key)) out.push(`${scope}${kind} ${q(key)} is missing from the database`);
  }
  for (const key of [...b.keys()].sort()) {
    if (!a.has(key)) out.push(`${scope}${kind} ${q(key)} is not in the snapshot`);
  }
  for (const key of [...a.keys()].sort()) {
    const right = b.get(key);
    if (right !== undefined) changed(key, a.get(key) as T, right);
  }
}

function diffColumn(table: string, left: ColumnSnapshot, right: ColumnSnapshot, out: string[]): void {
  const where = `table ${q(table)}, column ${q(left.name)}: `;
  const fields = ["type", "affinity", "notNull", "defaultValue", "primaryKeyPosition"] as const;
  for (const field of fields) {
    if (left[field] !== right[field]) {
      out.push(`${where}${field} changed from ${JSON.stringify(left[field])} to ${JSON.stringify(right[field])}`);
    }
  }
  const [lc, rc] = [left.collation ?? "BINARY", right.collation ?? "BINARY"];
  if (lc !== rc) out.push(`${where}collation changed from ${JSON.stringify(lc)} to ${JSON.stringify(rc)}`);
}

function diffTable(left: TableSnapshot, right: TableSnapshot, out: string[]): void {
  const scope = `table ${q(left.name)}: `;

  const colsA = new Map(left.columns.map((c) => [c.name, c]));
  const colsB = new Map(right.columns.map((c) => [c.name, c]));
  diffMaps(scope, "column", colsA, colsB, out, (_, l, r) => diffColumn(left.name, l, r, out));
  const sharedA = left.columns.map((c) => c.name).filter((n) => colsB.has(n));
  const sharedB = right.columns.map((c) => c.name).filter((n) => colsA.has(n));
  if (sharedA.join("\0") !== sharedB.join("\0")) {
    out.push(`${scope}column order changed from [${sharedA.join(", ")}] to [${sharedB.join(", ")}]`);
  }

  if ((left.strict === true) !== (right.strict === true)) {
    out.push(`${scope}STRICT changed from ${left.strict === true} to ${right.strict === true}`);
  }

  if ((left.conflictReplace === true) !== (right.conflictReplace === true)) {
    out.push(`${scope}ON CONFLICT REPLACE changed from ${left.conflictReplace === true} to ${right.conflictReplace === true}`);
  }

  if (left.primaryKey.join("\0") !== right.primaryKey.join("\0")) {
    out.push(`${scope}primary key changed from (${left.primaryKey.join(", ")}) to (${right.primaryKey.join(", ")})`);
  }

  const fksA = new Map(left.foreignKeys.map((f) => [fkKey(f), f]));
  const fksB = new Map(right.foreignKeys.map((f) => [fkKey(f), f]));
  diffMaps(scope, "foreign key", fksA, fksB, out, (key, l, r) => {
    if (l.onDelete !== r.onDelete || l.onUpdate !== r.onUpdate) {
      out.push(`${scope}foreign key ${q(key)} changed from ${describeFk(l)} to ${describeFk(r)}`);
    }
  });

  const ixA = new Map(left.indexes.map((i) => [i.name, i]));
  const ixB = new Map(right.indexes.map((i) => [i.name, i]));
  diffMaps(scope, "index", ixA, ixB, out, (key, l, r) => {
    if (describeIndex(l) !== describeIndex(r)) {
      out.push(`${scope}index ${q(key)} changed from ${describeIndex(l)} to ${describeIndex(r)}`);
    }
  });
}

/**
 * Compare two snapshots and describe the differences in plain language. `a` is the expected state
 * (the committed snapshot), `b` the actual one (the live database). An empty array means no drift.
 * `generatedAt` is ignored. Output order is deterministic.
 */
export function diffSnapshots(a: SchemaSnapshot, b: SchemaSnapshot): string[] {
  const out: string[] = [];
  if (a.version !== b.version) out.push(`snapshot version changed from ${a.version} to ${b.version}`);

  const tablesA = new Map(Object.entries(a.tables));
  const tablesB = new Map(Object.entries(b.tables));
  diffMaps("", "table", tablesA, tablesB, out, (_, l, r) => diffTable(l, r, out));
  return out;
}
