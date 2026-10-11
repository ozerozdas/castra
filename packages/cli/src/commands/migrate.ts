import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CloudflareEnv } from "../cloudflare/connect.js";
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
  return 0;
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
