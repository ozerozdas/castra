import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { quoteIdentifier } from "@castra-kit/core";
import type { CloudflareEnv } from "../cloudflare/connect.js";
import type { ExecFn } from "../exec.js";
import type { OpenDatabaseFn } from "../local-d1.js";
import { CliError, readD1Target, UsageError } from "../wrangler-config.js";
import type { D1Target } from "../wrangler-config.js";

/** Options of `castra migrate`. */
export interface MigrateOptions {
  cwd: string;
  config: string;
  /** `local` applies to the miniflare state under `.wrangler/`; `remote` to the Cloudflare database. */
  target: "local" | "remote";
  /** D1 binding when the config declares several. */
  binding?: string;
  /** Passed to wrangler as `CLOUDFLARE_ACCOUNT_ID` for remote runs. */
  accountId?: string;
}

/** Side effects of `castra migrate`. */
export interface MigrateDeps {
  exec: ExecFn;
  /**
   * Source of `CLOUDFLARE_API_TOKEN` for remote runs; it is passed to wrangler explicitly so wrangler uses the same
   * identity as the caller's API calls, not whatever `process.env` holds.
   */
  env?: CloudflareEnv;
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * `castra migrate`: run `wrangler d1 migrations apply <database> --local|--remote`.
 *
 * Auth, internal (`_castra_*`) and user migrations are all ordered SQL files in the binding's `migrations_dir`
 * (ADR 0032), so wrangler's own `d1_migrations` bookkeeping is the single source of truth. For remote runs the
 * token from `deps.env` is handed to wrangler as `CLOUDFLARE_API_TOKEN` in its environment; it is never put on the
 * command line.
 *
 * @returns the process exit code (wrangler's).
 */
export async function migrate(options: MigrateOptions, deps: MigrateDeps): Promise<number> {
  const configPath = resolve(options.cwd, options.config);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new CliError(`Wrangler config not found: ${configPath}`);
  }
  const target = readD1Target(text, options.binding);
  const database = target.databaseName ?? target.binding;

  deps.log(`Applying migrations to ${database} (${options.target})...`);
  const result = await deps.exec(
    "wrangler",
    ["d1", "migrations", "apply", database, `--${options.target}`, "--config", configPath],
    {
      cwd: dirname(configPath),
      env: options.target === "remote" ? wranglerEnv(deps.env, options.accountId) : {},
    },
  );
  if (result.code !== 0) {
    deps.error(`wrangler d1 migrations apply exited with code ${result.code}.`);
    return result.code;
  }
  if (options.target === "local") deps.log("Run `castra generate` to refresh castra/ if the schema changed.");
  return 0;
}

/** The config, its directory and the selected D1 target; refuses `migrations_pattern` layouts (ADR 0080). */
async function migrationsTarget(cwd: string, config: string, binding?: string): Promise<{ configPath: string; dir: string; target: D1Target }> {
  const configPath = resolve(cwd, config);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new CliError(`Wrangler config not found: ${configPath}`);
  }
  const target = readD1Target(text, binding);
  if (target.migrationsPattern) {
    throw new CliError(
      `D1 binding "${target.binding}" uses migrations_pattern; castra migrate create/status only support flat ` +
        `<migrations_dir>/*.sql. Use \`wrangler d1 migrations create/list\` instead.`,
    );
  }
  return { configPath, dir: resolve(dirname(configPath), target.migrationsDir), target };
}

/** `.sql` files in the migrations directory, sorted as wrangler applies them. Missing directory → `[]`. */
async function migrationFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** Options of `castra migrate create`. */
export interface MigrateCreateOptions {
  cwd: string;
  config: string;
  binding?: string;
  /** Free text; becomes the file name's slug. */
  name: string;
}

/**
 * `castra migrate create <name>` (ADR 0080): write `<migrations_dir>/NNNN_<slug>.sql`, numbered after the highest
 * existing file with wrangler's four-digit scheme. Creates the directory if needed and never overwrites.
 *
 * @returns the path of the new file.
 */
export async function migrateCreate(options: MigrateCreateOptions, deps: { log: (line: string) => void }): Promise<string> {
  const slug = options.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) throw new UsageError("Give the migration a name with letters or digits, e.g. `castra migrate create add_tags`.");
  const { configPath, dir } = await migrationsTarget(options.cwd, options.config, options.binding);
  const numbers = (await migrationFiles(dir)).map((f) => Number(/^(\d+)/.exec(f)?.[1] ?? 0));
  const file = join(dir, `${String(Math.max(0, ...numbers) + 1).padStart(4, "0")}_${slug}.sql`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    `-- ${options.name.trim()}\n` +
      "--\n" +
      "-- D1 migrations are forward-only. Write the statements that undo this one below, commented out, for a manual\n" +
      "-- rollback. After `castra migrate` (local), run `castra generate` and commit castra/.\n" +
      "--\n" +
      "-- Rollback:\n" +
      "--\n\n",
    { flag: "wx" },
  );
  deps.log(`Created ${relative(dirname(configPath), file)}`);
  return file;
}

/** Options of `castra migrate status`. */
export interface MigrateStatusOptions {
  cwd: string;
  config: string;
  binding?: string;
  target: "local" | "remote";
}

/** What `castra migrate status` found, by file name (as recorded in the migrations table). */
export interface MigrateStatus {
  applied: string[];
  pending: string[];
  /** Recorded as applied, but no such file in the migrations directory (renamed or deleted). */
  unknown: string[];
}

/**
 * `castra migrate status` (ADR 0080): compare the files in `migrations_dir` with the names recorded in wrangler's
 * migrations table (`d1_migrations` by default) of the local or remote database. Read-only.
 */
export async function migrateStatus(
  options: MigrateStatusOptions,
  deps: { openDatabase: OpenDatabaseFn; log: (line: string) => void },
): Promise<MigrateStatus> {
  const { configPath, dir, target } = await migrationsTarget(options.cwd, options.config, options.binding);
  const files = await migrationFiles(dir);
  const db = await deps.openDatabase(configPath, target.binding);
  let recorded: string[];
  try {
    const exists = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [target.migrationsTable]);
    recorded =
      exists.length === 0
        ? []
        : (await db.query(`SELECT name FROM ${quoteIdentifier(target.migrationsTable)} ORDER BY id`)).map((r) => String(r.name));
  } finally {
    await db.close();
  }
  const done = new Set(recorded);
  const status: MigrateStatus = {
    applied: files.filter((f) => done.has(f)),
    pending: files.filter((f) => !done.has(f)),
    unknown: recorded.filter((r) => !files.includes(r)),
  };
  deps.log(`Migrations in ${relative(dirname(configPath), dir) || "."} for ${options.target} D1 "${target.databaseName ?? target.binding}":`);
  for (const f of files) deps.log(`  ${done.has(f) ? "applied" : "pending"}  ${f}`);
  for (const r of status.unknown) deps.log(`  unknown  ${r} (recorded as applied; the file is gone or renamed)`);
  deps.log(
    `${status.applied.length} applied, ${status.pending.length} pending` +
      (status.pending.length > 0 ? ` - run \`castra migrate${options.target === "remote" ? " --remote" : ""}\`.` : "."),
  );
  return status;
}

/**
 * Environment for a remote wrangler run: the caller's token and account, so wrangler acts as the same identity as
 * the CLI's own API calls. Unset values are left out (the child then inherits `process.env`).
 */
export function wranglerEnv(env: CloudflareEnv | undefined, accountId: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const token = env?.CLOUDFLARE_API_TOKEN?.trim();
  if (token) out.CLOUDFLARE_API_TOKEN = token;
  if (accountId) out.CLOUDFLARE_ACCOUNT_ID = accountId;
  return out;
}
