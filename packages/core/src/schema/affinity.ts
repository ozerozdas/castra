import type { SqliteAffinity } from "../types.js";

/**
 * Derive the SQLite column affinity from a declared type, following the rules in section 3.1 of
 * https://www.sqlite.org/datatype3.html (applied in order, first match wins):
 *
 * 1. contains "INT" -> INTEGER
 * 2. contains "CHAR", "CLOB" or "TEXT" -> TEXT
 * 3. contains "BLOB" or the type is empty -> BLOB
 * 4. contains "REAL", "FLOA" or "DOUB" -> REAL
 * 5. otherwise -> NUMERIC
 *
 * @param declaredType The declared type as written in `CREATE TABLE` (case-insensitive, may be empty).
 */
export function affinityOf(declaredType: string): SqliteAffinity {
  const t = declaredType.toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB") || t.trim() === "") return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}
