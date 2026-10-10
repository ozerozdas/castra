import { AUDIT_ARGUMENTS_MAX, type AuditTable, type McpDb } from "./db.js";

/** One audit row before it is stored (`id` and `at` are filled by {@link writeAudit}). */
export type AuditEntry = Omit<AuditTable, "id" | "at">;

/** JSON text of `value`, truncated to {@link AUDIT_ARGUMENTS_MAX} characters while staying valid JSON. */
export function auditArguments(value: unknown): string | null {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    text = JSON.stringify({ unserializable: true });
  }
  if (text.length <= AUDIT_ARGUMENTS_MAX) return text;
  const note = { truncated: true, length: text.length, prefix: "" };
  const room = AUDIT_ARGUMENTS_MAX - JSON.stringify(note).length - 64;
  note.prefix = text.slice(0, Math.max(0, room));
  let out = JSON.stringify(note);
  // Escaping can grow the prefix; shrink until it fits.
  while (out.length > AUDIT_ARGUMENTS_MAX && note.prefix.length > 0) {
    note.prefix = note.prefix.slice(0, Math.floor(note.prefix.length * 0.9));
    out = JSON.stringify(note);
  }
  return out;
}

/** Rows per INSERT: 8 bound parameters per row stays under D1's 100-parameter limit. */
const ROWS_PER_INSERT = 12;

/** Appends audit rows (one INSERT per 12 rows). Throws on failure, so callers can fail closed. */
export async function writeAudit(db: McpDb, entries: AuditEntry[], now: Date = new Date()): Promise<void> {
  if (entries.length === 0) return;
  const at = now.toISOString();
  const rows: AuditTable[] = entries.map((e) => ({ id: crypto.randomUUID(), at, ...e }));
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    await db.insertInto("_castra_audit").values(rows.slice(i, i + ROWS_PER_INSERT)).execute();
  }
}
