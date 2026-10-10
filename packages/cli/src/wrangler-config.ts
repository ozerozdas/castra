import { parse, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

/** The D1 database a command operates on, as declared in `wrangler.jsonc`. */
export interface D1Target {
  /** Binding name in the Worker `env` (e.g. `DB`). */
  binding: string;
  /** `database_name` from the config, if present. */
  databaseName?: string;
}

/** Thrown for problems the user can fix (missing file, ambiguous binding); printed without a stack. */
export class CliError extends Error {}

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
