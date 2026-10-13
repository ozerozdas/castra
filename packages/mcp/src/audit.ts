import type { CompiledQuery } from "kysely";
import { AUDIT_ARGUMENTS_MAX, compileOnly, type AuditTable, type McpDb } from "./db.js";

/** One audit row before it is stored (`id` and `at` are filled by {@link writeAudit}). */
export type AuditEntry = Omit<AuditTable, "id" | "at">;

/** Audit argument structure controls. Values are always redacted. */
export interface AuditArgumentOptions {
  /** Case-insensitive keys whose entire subtree is replaced rather than traversed. */
  redactKeys?: readonly string[];
}

/** Remote audit controls. Retention is disabled unless explicitly configured. */
export interface AuditOptions extends AuditArgumentOptions {
  /** Days to keep; positive integer up to 36500. One prune batch per known-token request. */
  retentionDays?: number;
}

/** Reject invalid retention before a request can perform any writes. */
export function validateAuditOptions(options: AuditOptions = {}): void {
  const days = options.retentionDays;
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 36500)) {
    throw new Error("audit.retentionDays must be an integer between 1 and 36500");
  }
}

/** Retains bounded structure only; never invokes a caller's toJSON method. */
function redactArguments(value: unknown, options: AuditArgumentOptions): unknown {
  const keys = new Set(options.redactKeys?.map((key) => key.toLowerCase()));
  const seen = new WeakSet<object>();
  let nodes = 0;
  function visit(input: unknown, depth: number): unknown {
    if (++nodes > 1000 || depth >= 32 || typeof input !== "object" || input === null) return "[REDACTED]";
    if (seen.has(input)) return "[REDACTED]";
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, 1000).map((item) => visit(item, depth + 1));
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(input).slice(0, 1000)) {
      out[key] = keys.has(key.toLowerCase()) ? "[REDACTED]" : visit((input as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return visit(value, 0);
}

/** Redacted structure of `value`, truncated to {@link AUDIT_ARGUMENTS_MAX} characters as valid JSON. */
export function auditArguments(value: unknown, options: AuditArgumentOptions = {}): string | null {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(redactArguments(value, options)) ?? "null";
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

/** Rows deleted per {@link pruneAuditQuery} statement, so one statement stays short on D1. */
export const AUDIT_PRUNE_BATCH = 5000;

/**
 * Deletes up to {@link AUDIT_PRUNE_BATCH} `_castra_audit` rows older than `before` and returns their ids.
 * Run it until it returns no rows. `at` is an ISO-8601 UTC string, so string order is time order.
 */
export function pruneAuditQuery(before: Date): CompiledQuery {
  return compileOnly
    .deleteFrom("_castra_audit")
    .where("id", "in", (eb) =>
      eb.selectFrom("_castra_audit").select("id").where("at", "<", before.toISOString()).limit(AUDIT_PRUNE_BATCH),
    )
    .returning("id")
    .compile();
}

/** Runs one retention batch after auditing. Cleanup failure never changes a tool result. */
export async function retainAudit(db: McpDb, options: AuditOptions = {}, now: Date = new Date()): Promise<void> {
  validateAuditOptions(options);
  if (options.retentionDays === undefined) return;
  try {
    await db.executeQuery(pruneAuditQuery(new Date(now.getTime() - options.retentionDays * 86400000)));
  } catch (err) {
    console.error("castra mcp: audit retention failed", err);
  }
}
