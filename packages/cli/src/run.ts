import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import type { FetchFn } from "./cloudflare/api.js";
import type { CloudflareEnv } from "./cloudflare/connect.js";
import { deploy } from "./commands/deploy.js";
import { doctor } from "./commands/doctor.js";
import { generate } from "./commands/generate.js";
import { migrate } from "./commands/migrate.js";
import { provision } from "./commands/provision.js";
import { spawnExec } from "./exec.js";
import type { ExecFn } from "./exec.js";
import { openLocalD1 } from "./local-d1.js";
import type { OpenDatabaseFn } from "./local-d1.js";
import { ProblemError } from "./problems.js";
import { CliError } from "./wrangler-config.js";

/** Commands that are planned (ARCHITECTURE section 6) but not built yet. */
const PLANNED = ["init", "test", "mcp"] as const;

const USAGE = `castra - Cloudflare-native, agent-safe BaaS toolkit

Usage: castra <command> [options]

Commands:
  generate   Write castra/schema.json and castra/db.d.ts from the local D1 database
  provision  Create D1, KV (CACHE) and, with storage, R2; write their ids into wrangler.jsonc
  migrate    Apply migrations with wrangler (--local by default, or --remote)
  doctor     Check the API token, its permissions, bindings and schema drift
  deploy     provision -> migrate --remote -> drift check -> secrets -> wrangler deploy
  ${PLANNED.join(", ")}   (not implemented yet)

Environment: CLOUDFLARE_API_TOKEN (required for provision/doctor/deploy/migrate --remote),
             CLOUDFLARE_ACCOUNT_ID (optional when the token sees a single account).

Run \`castra <command> --help\` for command options.`;

const GENERATE_USAGE = `Usage: castra generate [options]

Options:
  --local            Introspect the local D1 database (the only supported mode; implied)
  --config <path>    Wrangler config (default: wrangler.jsonc)
  --out <dir>        Output directory (default: castra)
  --binding <name>   D1 binding to use when the config declares several
  --check            Do not write; exit 1 and list the drift if the committed snapshot is stale`;

const PROVISION_USAGE = `Usage: castra provision [options]

Finds or creates the D1 database(s), the CACHE KV namespace and (with --storage, or when wrangler.jsonc already
declares r2_buckets) the R2 bucket, then writes the ids into wrangler.jsonc. Safe to re-run.

Options:
  --config <path>      Wrangler config (default: wrangler.jsonc)
  --account-id <id>    Cloudflare account (default: CLOUDFLARE_ACCOUNT_ID, or the token's only account)
  --storage            Also provision an R2 bucket`;

const MIGRATE_USAGE = `Usage: castra migrate [--local | --remote] [options]

Runs \`wrangler d1 migrations apply <database>\` for the migrations directory in wrangler.jsonc.

Options:
  --local              Apply to the local database (default)
  --remote             Apply to the Cloudflare database (needs CLOUDFLARE_API_TOKEN)
  --config <path>      Wrangler config (default: wrangler.jsonc)
  --binding <name>     D1 binding when the config declares several
  --account-id <id>    Cloudflare account for --remote`;

const DOCTOR_USAGE = `Usage: castra doctor [options]

Verifies the API token and each required permission (read-only), that bindings are provisioned, and that the
committed schema snapshot matches the local D1 (if it exists). Exit 1 if anything required is missing.

Options:
  --config <path>      Wrangler config (default: wrangler.jsonc)
  --account-id <id>    Cloudflare account
  --storage            Also require R2
  --out <dir>          Snapshot directory (default: castra)`;

const DEPLOY_USAGE = `Usage: castra deploy [options]

provision -> migrate --remote -> drift check (stops on mismatch) -> BETTER_AUTH_SECRET if missing ->
wrangler deploy, then prints the API, /openapi.json and /mcp URLs.

Options:
  --config <path>      Wrangler config (default: wrangler.jsonc)
  --account-id <id>    Cloudflare account
  --storage            Also provision an R2 bucket
  --binding <name>     D1 binding when the config declares several
  --out <dir>          Snapshot directory (default: castra)`;

/** I/O seams of {@link run}; defaults use the real process. */
export interface RunEnv {
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
  openDatabase: OpenDatabaseFn;
  /** HTTP client for the Cloudflare API. */
  fetch: FetchFn;
  /** Runs wrangler. */
  exec: ExecFn;
  /** Environment variables (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID). */
  env: CloudflareEnv;
}

const defaultEnv = (): RunEnv => ({
  cwd: process.cwd(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  openDatabase: openLocalD1,
  fetch: (input, init) => globalThis.fetch(input, init),
  exec: spawnExec,
  env: process.env,
});

/**
 * Entry point of the `castra` binary. Dispatches the first argument to a subcommand.
 *
 * Exit codes: `0` success, `1` check failed, runtime error or Cloudflare problem (token, permission, account),
 * `2` usage error or command not implemented.
 *
 * @param argv Arguments without the `node` and script path.
 */
export async function run(argv: string[], overrides: Partial<RunEnv> = {}): Promise<number> {
  const env = { ...defaultEnv(), ...overrides };
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    env.log(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case "generate":
        return await runGenerate(rest, env);
      case "provision":
        return await runProvision(rest, env);
      case "migrate":
        return await runMigrate(rest, env);
      case "doctor":
        return await runDoctor(rest, env);
      case "deploy":
        return await runDeploy(rest, env);
    }

    if ((PLANNED as readonly string[]).includes(command)) {
      env.error(`castra ${command}: not implemented yet`);
      return 2;
    }

    env.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  } catch (e) {
    if (e instanceof ProblemError) {
      for (const line of e.format()) env.error(line);
      return 1;
    }
    if (e instanceof CliError) {
      env.error(`error: ${e.message}`);
      return 2;
    }
    env.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

type Options = NonNullable<ParseArgsConfig["options"]>;

const COMMON = {
  config: { type: "string", default: "wrangler.jsonc" },
  help: { type: "boolean", short: "h", default: false },
} as const satisfies Options;

function parse<O extends Options>(args: string[], options: O, usage: string) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (e) {
    throw new CliError(`${e instanceof Error ? e.message : String(e)}\n\n${usage}`);
  }
}

async function runGenerate(args: string[], env: RunEnv): Promise<number> {
  const values = parse(
    args,
    {
      ...COMMON,
      local: { type: "boolean", default: false },
      out: { type: "string", default: "castra" },
      binding: { type: "string" },
      check: { type: "boolean", default: false },
    },
    GENERATE_USAGE,
  );
  if (values.help) {
    env.log(GENERATE_USAGE);
    return 0;
  }
  return generate(
    { cwd: env.cwd, config: values.config, out: values.out, check: values.check, binding: values.binding },
    { openDatabase: env.openDatabase, log: env.log, error: env.error },
  );
}

async function runProvision(args: string[], env: RunEnv): Promise<number> {
  const values = parse(
    args,
    { ...COMMON, "account-id": { type: "string" }, storage: { type: "boolean", default: false } },
    PROVISION_USAGE,
  );
  if (values.help) {
    env.log(PROVISION_USAGE);
    return 0;
  }
  await provision({ cwd: env.cwd, config: values.config, accountId: values["account-id"], storage: values.storage }, env);
  return 0;
}

async function runMigrate(args: string[], env: RunEnv): Promise<number> {
  const values = parse(
    args,
    {
      ...COMMON,
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      binding: { type: "string" },
      "account-id": { type: "string" },
    },
    MIGRATE_USAGE,
  );
  if (values.help) {
    env.log(MIGRATE_USAGE);
    return 0;
  }
  if (values.local && values.remote) throw new CliError(`Pass either --local or --remote, not both.\n\n${MIGRATE_USAGE}`);
  return migrate(
    {
      cwd: env.cwd,
      config: values.config,
      target: values.remote ? "remote" : "local",
      binding: values.binding,
      accountId: values["account-id"] ?? (env.env.CLOUDFLARE_ACCOUNT_ID || undefined),
    },
    env,
  );
}

async function runDoctor(args: string[], env: RunEnv): Promise<number> {
  const values = parse(
    args,
    {
      ...COMMON,
      "account-id": { type: "string" },
      storage: { type: "boolean", default: false },
      out: { type: "string", default: "castra" },
    },
    DOCTOR_USAGE,
  );
  if (values.help) {
    env.log(DOCTOR_USAGE);
    return 0;
  }
  const result = await doctor(
    { cwd: env.cwd, config: values.config, accountId: values["account-id"], storage: values.storage, out: values.out },
    env,
  );
  return result.code;
}

async function runDeploy(args: string[], env: RunEnv): Promise<number> {
  const values = parse(
    args,
    {
      ...COMMON,
      "account-id": { type: "string" },
      storage: { type: "boolean", default: false },
      binding: { type: "string" },
      out: { type: "string", default: "castra" },
    },
    DEPLOY_USAGE,
  );
  if (values.help) {
    env.log(DEPLOY_USAGE);
    return 0;
  }
  const result = await deploy(
    {
      cwd: env.cwd,
      config: values.config,
      accountId: values["account-id"],
      storage: values.storage,
      binding: values.binding,
      out: values.out,
    },
    env,
  );
  return result.code;
}
