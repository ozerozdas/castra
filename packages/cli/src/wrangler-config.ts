import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import type { FormattingOptions, JSONPath, ParseError } from "jsonc-parser";

/** The D1 database a command operates on, as declared in `wrangler.jsonc`. */
export interface D1Target {
  /** Binding name in the Worker `env` (e.g. `DB`). */
  binding: string;
  /** `database_name` from the config, if present. */
  databaseName?: string;
}

/**
 * Thrown for runtime problems the user can fix (missing file, ambiguous or unprovisioned binding); printed without
 * a stack. `castra` exits 1.
 */
export class CliError extends Error {}

/** A {@link CliError} caused by the command line itself (unknown flag, missing/conflicting argument). Exit 2. */
export class UsageError extends CliError {}

/**
 * Pick the D1 binding out of a `wrangler.jsonc` / `wrangler.json` document. JSONC (comments, trailing
 * commas) is parsed with `jsonc-parser`.
 *
 * @param text Raw file contents.
 * @param binding Binding name to select. Required when the config declares more than one D1 database.
 */
export function readD1Target(text: string, binding?: string): D1Target {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new CliError(`Cannot parse wrangler config: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }

  const raw = (config as { d1_databases?: unknown } | null)?.d1_databases;
  const databases = (Array.isArray(raw) ? raw : []).filter(
    (d): d is { binding: string; database_name?: string } =>
      typeof d === "object" && d !== null && typeof (d as { binding?: unknown }).binding === "string",
  );

  if (databases.length === 0) throw new CliError("No d1_databases entry found in the wrangler config.");

  let chosen = databases[0]!;
  if (binding !== undefined) {
    const match = databases.find((d) => d.binding === binding);
    if (!match) {
      throw new CliError(
        `No D1 binding named "${binding}" in the wrangler config (found: ${databases.map((d) => d.binding).join(", ")}).`,
      );
    }
    chosen = match;
  } else if (databases.length > 1) {
    throw new CliError(
      `The wrangler config declares several D1 databases (${databases.map((d) => d.binding).join(", ")}); pass --binding <name>.`,
    );
  }

  return { binding: chosen.binding, databaseName: chosen.database_name };
}

/** Ids treated as "not provisioned": empty, or only zeros and dashes (e.g. `00000000-0000-0000-0000-000000000000`). */
export function isPlaceholderId(id: unknown): boolean {
  return typeof id !== "string" || id.trim() === "" || /^[0-]+$/.test(id.trim());
}

/** A `d1_databases` entry plus its index in the array (needed to edit it in place). */
export interface D1Binding {
  index: number;
  binding: string;
  databaseName?: string;
  databaseId?: string;
  migrationsDir?: string;
}

/** A `kv_namespaces` entry plus its index. */
export interface KvBinding {
  index: number;
  binding: string;
  id?: string;
}

/** An `r2_buckets` entry plus its index. */
export interface R2Binding {
  index: number;
  binding: string;
  bucketName?: string;
}

/** The parts of a wrangler config the CLI provisions and deploys. */
export interface WranglerConfig {
  /** Worker name (`name`). */
  name?: string;
  d1: D1Binding[];
  kv: KvBinding[];
  r2: R2Binding[];
}

/**
 * Parse the bindings out of a `wrangler.jsonc` document (top-level only; `env.*` overrides are not provisioned).
 */
export function readWranglerConfig(text: string): WranglerConfig {
  const errors: ParseError[] = [];
  const raw = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | null;
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new CliError(`Cannot parse wrangler config: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  const config = raw ?? {};
  const list = (key: string): [Record<string, unknown>, number][] =>
    (Array.isArray(config[key]) ? (config[key] as unknown[]) : [])
      .map((v, i) => [v, i] as [unknown, number])
      .filter((p): p is [Record<string, unknown>, number] => typeof p[0] === "object" && p[0] !== null)
      .filter(([v]) => typeof v.binding === "string");
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  return {
    name: str(config.name),
    d1: list("d1_databases").map(([v, index]) => ({
      index,
      binding: v.binding as string,
      databaseName: str(v.database_name),
      databaseId: str(v.database_id),
      migrationsDir: str(v.migrations_dir),
    })),
    kv: list("kv_namespaces").map(([v, index]) => ({ index, binding: v.binding as string, id: str(v.id) })),
    r2: list("r2_buckets").map(([v, index]) => ({ index, binding: v.binding as string, bucketName: str(v.bucket_name) })),
  };
}

/** Detect the indentation of a JSONC document so inserted values match it. */
function formattingFor(text: string): FormattingOptions {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  const tabs = indent.startsWith("\t");
  return { insertSpaces: !tabs, tabSize: tabs ? 1 : indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

/**
 * Set a value in a JSONC document while preserving comments and formatting (`jsonc-parser` `modify`).
 * Pass `insert: true` with a trailing `-1` index to append to an array.
 */
export function setJsoncValue(text: string, path: JSONPath, value: unknown, insert = false): string {
  const edits = modify(text, path, value, { formattingOptions: formattingFor(text), isArrayInsertion: insert });
  return applyEdits(text, edits);
}
