import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { diffSnapshots, generateKyselyTypes, introspect } from "castra";
import type { SchemaSnapshot } from "castra";
import type { OpenDatabaseFn } from "../local-d1.js";
import { CliError, readD1Target } from "../wrangler-config.js";

/** Options of `castra generate`. */
export interface GenerateOptions {
  /** Directory relative paths are resolved against. */
  cwd: string;
  /** Path to the wrangler config. */
  config: string;
  /** Output directory for `schema.json` and `db.d.ts`. */
  out: string;
  /** Verify instead of write: exit 1 when the committed files differ from the database. */
  check: boolean;
  /** D1 binding to introspect; required if the config has several. */
  binding?: string;
  /** Label of the database in messages. Default `local database`. */
  source?: string;
}

/** Side effects of `castra generate`, injectable for tests. */
export interface GenerateDeps {
  openDatabase: OpenDatabaseFn;
  log: (line: string) => void;
  error: (line: string) => void;
}

export const SCHEMA_FILE = "schema.json";
export const TYPES_FILE = "db.d.ts";

/** Serialise a snapshot the way it is committed (stable key order, trailing newline). */
export function serializeSnapshot(snapshot: SchemaSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function parseSnapshot(text: string, path: string): SchemaSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError(`${path} is not valid JSON.`);
  }
  const s = value as Partial<SchemaSnapshot> | null;
  if (!s || s.version !== 1 || typeof s.tables !== "object" || s.tables === null) {
    throw new CliError(`${path} is not a Castra schema snapshot (expected version 1).`);
  }
  return s as SchemaSnapshot;
}

/**
 * `castra generate`: introspect the local D1 database and write `<out>/schema.json` and `<out>/db.d.ts`.
 * With `check`, write nothing and return 1 if the committed files are missing or stale.
 *
 * Only the local database is supported in v0.1, so `--local` is accepted but implied.
 *
 * @returns the process exit code.
 */
export async function generate(options: GenerateOptions, deps: GenerateDeps): Promise<number> {
  const configPath = resolve(options.cwd, options.config);
  const outDir = resolve(options.cwd, options.out);
  const schemaPath = join(outDir, SCHEMA_FILE);
  const typesPath = join(outDir, TYPES_FILE);

  const configText = await readOptional(configPath);
  if (configText === null) throw new CliError(`Wrangler config not found: ${configPath}`);
  const target = readD1Target(configText, options.binding);

  const db = await deps.openDatabase(configPath, target.binding);
  let live: SchemaSnapshot;
  try {
    live = await introspect(db.query);
  } finally {
    await db.close();
  }

  for (const t of Object.values(live.tables)) {
    if (t.conflictReplace) {
      deps.error(
        `warning: table "${t.name}" has ON CONFLICT REPLACE on a UNIQUE or PRIMARY KEY constraint; ` +
          "Castra refuses every create and update on it (403 unsafe_schema, ADR 0066). Use the default conflict clause (ABORT).",
      );
    }
  }

  const committedText = await readOptional(schemaPath);
  const committed = committedText === null ? null : parseSnapshot(committedText, schemaPath);

  if (options.check) {
    if (committed === null) {
      deps.error(`${schemaPath} does not exist. Run \`castra generate\` and commit the result.`);
      return 1;
    }
    const drift = diffSnapshots(committed, live);
    const typesText = await readOptional(typesPath);
    if (typesText !== generateKyselyTypes(committed)) {
      drift.push(`${typesPath} is ${typesText === null ? "missing" : "out of date"} for the committed snapshot`);
    }
    if (drift.length > 0) {
      deps.error(`Schema drift between ${schemaPath} and the ${options.source ?? "local database"} "${target.binding}":`);
      for (const line of drift) deps.error(`  - ${line}`);
      deps.error("Run `castra generate` to update the snapshot.");
      return 1;
    }
    deps.log(`Schema snapshot is up to date (${Object.keys(live.tables).length} tables).`);
    return 0;
  }

  // Keep the committed timestamp when nothing changed so regenerating produces no diff.
  const snapshot = committed !== null && diffSnapshots(committed, live).length === 0 ? committed : live;
  await mkdir(outDir, { recursive: true });
  await writeFile(schemaPath, serializeSnapshot(snapshot));
  await writeFile(typesPath, generateKyselyTypes(snapshot));
  deps.log(`Wrote ${schemaPath} and ${typesPath} (${Object.keys(snapshot.tables).length} tables).`);
  return 0;
}
