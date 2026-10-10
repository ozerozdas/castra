import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExecFn } from "../exec.js";
import { CliError, readD1Target } from "../wrangler-config.js";

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
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * `castra migrate`: run `wrangler d1 migrations apply <database> --local|--remote`.
 *
 * Auth, internal (`_castra_*`) and user migrations are all ordered SQL files in the binding's `migrations_dir`
 * (ADR 0032), so wrangler's own `d1_migrations` bookkeeping is the single source of truth. The token is read by
 * wrangler from `CLOUDFLARE_API_TOKEN`; it is never put on the command line.
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
      env: options.target === "remote" && options.accountId ? { CLOUDFLARE_ACCOUNT_ID: options.accountId } : {},
    },
  );
  if (result.code !== 0) {
    deps.error(`wrangler d1 migrations apply exited with code ${result.code}.`);
    return result.code;
  }
  return 0;
}
