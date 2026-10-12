import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import type { FetchFn } from "./cloudflare/api.js";
import type { CloudflareEnv } from "./cloudflare/connect.js";
import { createInterface } from "node:readline/promises";
import { deploy } from "./commands/deploy.js";
import { destroy } from "./commands/destroy.js";
import { doctor } from "./commands/doctor.js";
import { generate } from "./commands/generate.js";
import { createMcpTokenCommand, pruneMcpAuditCommand, revokeMcpTokenCommand } from "./commands/mcp-token.js";
import { mcp } from "./commands/mcp.js";
import { migrate, migrateCreate, migrateStatus } from "./commands/migrate.js";
import { provision } from "./commands/provision.js";
import { testPolicies } from "./commands/test-policies.js";
import { spawnExec } from "./exec.js";
import type { ExecFn } from "./exec.js";
import { connect } from "./cloudflare/connect.js";
import { openLocalD1 } from "./local-d1.js";
import type { OpenDatabaseFn } from "./local-d1.js";
import { ProblemError } from "./problems.js";
import { remoteD1Opener } from "./remote-d1.js";
import { CliError, UsageError } from "./wrangler-config.js";

/** Commands that are planned (ARCHITECTURE section 6) but not built yet. */
const PLANNED = ["init"] as const;

const USAGE = `castra - Cloudflare-native, agent-safe BaaS toolkit

Usage: castra <command> [options]

Commands:
  generate   Write castra/schema.json and castra/db.d.ts from the local D1 database
  provision  Create D1, KV (CACHE) and, with storage, R2; write their ids into wrangler.jsonc
  migrate    Apply migrations with wrangler (--local by default, or --remote); create <name>; status
  doctor     Check the API token, its permissions, bindings and schema drift
  deploy     provision -> migrate --remote -> drift check -> secrets -> wrangler deploy
  destroy    Delete the Worker, D1 (exported first), KV and R2 recorded in wrangler.jsonc
  mcp        Serve the read-only MCP tools over stdio against the local D1; \`mcp token\` and \`mcp audit\` manage /mcp
  test       \`test policies\`: run the project's policy allow/deny tests (vitest, local D1)
  ${PLANNED.join(", ")}   (not implemented yet)

Environment: CLOUDFLARE_API_TOKEN (required for provision/doctor/deploy/destroy/migrate --remote),
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

const MIGRATE_USAGE = `Usage: castra migrate [apply] [--local | --remote] [options]
       castra migrate create <name> [--config <path>] [--binding <name>]
       castra migrate status [--local | --remote] [options]

apply (default)  Runs \`wrangler d1 migrations apply <database>\` for the migrations directory in wrangler.jsonc.
create <name>    Writes <migrations_dir>/NNNN_<name>.sql, numbered after the last file. Edit it, then apply.
status           Lists applied, pending and unknown migrations from the database's migrations table. Read-only.

Options:
  --local              Apply to the local database (default)
  --remote             Apply to the Cloudflare database (needs CLOUDFLARE_API_TOKEN)
  --config <path>      Wrangler config (default: wrangler.jsonc)
  --binding <name>     D1 binding when the config declares several
  --account-id <id>    Cloudflare account for --remote`;

const DOCTOR_USAGE = `Usage: castra doctor [options]

Verifies the API token and each required permission (read-only), that bindings (D1, KV, rate limits) are
provisioned, that the @castra-kit/* packages share one version, and that the committed schema snapshot matches the
local D1 (if it exists) or, with --remote, the deployed one. Exit 1 if anything required is missing.

Options:
  --config <path>      Wrangler config (default: wrangler.jsonc)
  --account-id <id>    Cloudflare account
  --storage            Also require R2
  --remote             Check schema drift against the deployed D1 instead of the local one
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

const DESTROY_USAGE = `Usage: castra destroy [options]

Deletes what castra deploy created and wrangler.jsonc records: the Worker, the D1 database(s), the CACHE KV
namespace and R2 buckets (which must be empty). Prints the plan, asks you to type the Worker name, exports every
D1 database with \`wrangler d1 export\`, then deletes. Recorded ids are reset to placeholders. Safe to re-run.

Options:
  --config <path>      Wrangler config (default: wrangler.jsonc)
  --account-id <id>    Cloudflare account
  --dry-run            Print the plan; delete nothing
  --confirm <name>     Confirm without a prompt (must equal the Worker name)
  --backup-dir <dir>   Where D1 exports go (default: castra-backups)
  --skip-backup        Do not export D1 first (the data cannot be recovered)`;

const MCP_USAGE = `Usage: castra mcp [options]
       castra mcp token create --user <id> --scopes "<scopes>" [--name <n>] [--expires-in <days>] [--local | --remote]
       castra mcp token revoke <id> [--local | --remote]
       castra mcp audit prune --older-than <days> [--local | --remote]

castra mcp serves describe_schema, check_access, explain_query and query_data over stdio against the LOCAL D1
database, plus deploy_status (the castra doctor checks; uses CLOUDFLARE_API_TOKEN if set). It is a developer tool: \`as\` may impersonate ANY user or role, with no token and no audit log.
Never expose it over a network; the deployed Worker's /mcp route uses scoped tokens instead.

Options (serve):
  --config <path>      Castra config (default: castra.config.ts; .ts needs Node >= 22.18)
  --wrangler <path>    Wrangler config (default: wrangler.jsonc)
  --binding <name>     D1 binding when the wrangler config declares several
  --out <dir>          Snapshot directory holding schema.json (default: castra)

Options (token):
  --config <path>      Wrangler config (default: wrangler.jsonc)
  --scopes "<list>"    schema:read access:check data:read data:read:any_user (space or comma separated)
  --local              Write to the local D1 database (default)
  --remote             Write to the Cloudflare database (needs CLOUDFLARE_API_TOKEN)
  --account-id <id>    Cloudflare account for --remote`;

const TEST_USAGE = `Usage: castra test policies [-- <vitest options>]

Runs \`vitest run policies\` in the current directory with the project's vitest config: every test file whose path
contains "policies" (e.g. test/policies.test.ts). Exits with vitest's code; no matching file is a failure.`;

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
  /** Asks a question on the terminal; absent when stdin is not a TTY. */
  prompt?: (question: string) => Promise<string>;
}

async function terminalPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const defaultEnv = (): RunEnv => ({
  cwd: process.cwd(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  openDatabase: openLocalD1,
  fetch: (input, init) => globalThis.fetch(input, init),
  exec: spawnExec,
  env: process.env,
  prompt: process.stdin.isTTY ? terminalPrompt : undefined,
});

/**
 * Entry point of the `castra` binary. Dispatches the first argument to a subcommand.
 *
 * Exit codes: `0` success, `1` check failed, runtime error (e.g. config not found, unprovisioned binding: a
 * {@link CliError}) or Cloudflare problem (token, permission, account), `2` usage error ({@link UsageError}: bad
 * flags or arguments) or command not implemented.
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
      case "destroy":
        return await runDestroy(rest, env);
      case "mcp":
        return await runMcp(rest, env);
      case "test":
        return await runTest(rest, env);
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
      return e instanceof UsageError ? 2 : 1;
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
    throw new UsageError(`${e instanceof Error ? e.message : String(e)}\n\n${usage}`);
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
  const sub = args[0] === "create" || args[0] === "status" || args[0] === "apply" ? args[0] : undefined;
  if (sub) args = args.slice(1);
  if (sub === "create") {
    let parsed;
    try {
      parsed = parseArgs({ args, strict: true, allowPositionals: true, options: { ...COMMON, binding: { type: "string" } } });
    } catch (e) {
      throw new UsageError(`${e instanceof Error ? e.message : String(e)}\n\n${MIGRATE_USAGE}`);
    }
    if (parsed.values.help) {
      env.log(MIGRATE_USAGE);
      return 0;
    }
    if (parsed.positionals.length === 0) throw new UsageError(`Missing the migration name.\n\n${MIGRATE_USAGE}`);
    await migrateCreate(
      { cwd: env.cwd, config: parsed.values.config, binding: parsed.values.binding, name: parsed.positionals.join(" ") },
      env,
    );
    return 0;
  }
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
  if (values.local && values.remote) throw new UsageError(`Pass either --local or --remote, not both.\n\n${MIGRATE_USAGE}`);
  if (sub === "status") {
    let openDatabase = env.openDatabase;
    if (values.remote) {
      const session = await connect({ env: env.env, fetch: env.fetch, accountId: values["account-id"] });
      openDatabase = remoteD1Opener(session.api, session.accountId);
    }
    await migrateStatus(
      { cwd: env.cwd, config: values.config, binding: values.binding, target: values.remote ? "remote" : "local" },
      { openDatabase, log: env.log },
    );
    return 0;
  }
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
      remote: { type: "boolean", default: false },
      out: { type: "string", default: "castra" },
    },
    DOCTOR_USAGE,
  );
  if (values.help) {
    env.log(DOCTOR_USAGE);
    return 0;
  }
  const result = await doctor(
    { cwd: env.cwd, config: values.config, accountId: values["account-id"], storage: values.storage, remote: values.remote, out: values.out },
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

async function runDestroy(args: string[], env: RunEnv): Promise<number> {
  const values = parse(
    args,
    {
      ...COMMON,
      "account-id": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      confirm: { type: "string" },
      "backup-dir": { type: "string" },
      "skip-backup": { type: "boolean", default: false },
    },
    DESTROY_USAGE,
  );
  if (values.help) {
    env.log(DESTROY_USAGE);
    return 0;
  }
  const result = await destroy(
    {
      cwd: env.cwd,
      config: values.config,
      accountId: values["account-id"],
      dryRun: values["dry-run"],
      confirm: values.confirm,
      backupDir: values["backup-dir"],
      skipBackup: values["skip-backup"],
    },
    env,
  );
  return result.code;
}

async function runTest(args: string[], env: RunEnv): Promise<number> {
  const sep = args.indexOf("--");
  const own = sep === -1 ? args : args.slice(0, sep);
  const extraArgs = sep === -1 ? [] : args.slice(sep + 1);
  if (own.length === 1 && (own[0] === "--help" || own[0] === "-h")) {
    env.log(TEST_USAGE);
    return 0;
  }
  if (own.length !== 1 || own[0] !== "policies") throw new UsageError(`Expected \`castra test policies\`.\n\n${TEST_USAGE}`);
  return testPolicies({ cwd: env.cwd, extraArgs }, env);
}

async function runMcp(args: string[], env: RunEnv): Promise<number> {
  if (args[0] === "token") return runMcpToken(args.slice(1), env);
  if (args[0] === "audit") return runMcpAudit(args.slice(1), env);
  const values = parse(
    args,
    {
      config: { type: "string", default: "castra.config.ts" },
      wrangler: { type: "string", default: "wrangler.jsonc" },
      binding: { type: "string" },
      out: { type: "string", default: "castra" },
      help: { type: "boolean", short: "h", default: false },
    },
    MCP_USAGE,
  );
  if (values.help) {
    env.log(MCP_USAGE);
    return 0;
  }
  // stdout carries the protocol; anything else that logs (wrangler, user config) goes to stderr.
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  return mcp({ cwd: env.cwd, config: values.config, wrangler: values.wrangler, binding: values.binding, out: values.out }, env);
}

async function runMcpAudit(args: string[], env: RunEnv): Promise<number> {
  const [action, ...rest] = args;
  if (action !== "prune") throw new UsageError(`Expected \`mcp audit prune --older-than <days>\`.\n\n${MCP_USAGE}`);
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        ...COMMON,
        binding: { type: "string" },
        local: { type: "boolean", default: false },
        remote: { type: "boolean", default: false },
        "account-id": { type: "string" },
        "older-than": { type: "string" },
      },
    }));
  } catch (e) {
    throw new UsageError(`${e instanceof Error ? e.message : String(e)}\n\n${MCP_USAGE}`);
  }
  if (values.help) {
    env.log(MCP_USAGE);
    return 0;
  }
  if (values.local && values.remote) throw new UsageError(`Pass either --local or --remote, not both.\n\n${MCP_USAGE}`);
  if (values["older-than"] === undefined) throw new UsageError(`--older-than <days> is required.\n\n${MCP_USAGE}`);
  let openDatabase = env.openDatabase;
  if (values.remote) {
    const session = await connect({ env: env.env, fetch: env.fetch, accountId: values["account-id"] });
    openDatabase = remoteD1Opener(session.api, session.accountId);
  }
  return pruneMcpAuditCommand(
    { cwd: env.cwd, config: values.config, binding: values.binding, olderThanDays: Number(values["older-than"]) },
    { openDatabase, log: env.log, error: env.error },
  );
}

async function runMcpToken(args: string[], env: RunEnv): Promise<number> {
  const [action, ...rest] = args;
  if (action !== "create" && action !== "revoke") throw new UsageError(`Expected \`mcp token create\` or \`mcp token revoke <id>\`.\n\n${MCP_USAGE}`);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: action === "revoke",
      options: {
        ...COMMON,
        binding: { type: "string" },
        local: { type: "boolean", default: false },
        remote: { type: "boolean", default: false },
        "account-id": { type: "string" },
        user: { type: "string" },
        scopes: { type: "string" },
        name: { type: "string" },
        "expires-in": { type: "string" },
      },
    });
  } catch (e) {
    throw new UsageError(`${e instanceof Error ? e.message : String(e)}\n\n${MCP_USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    env.log(MCP_USAGE);
    return 0;
  }
  if (values.local && values.remote) throw new UsageError(`Pass either --local or --remote, not both.\n\n${MCP_USAGE}`);
  let openDatabase = env.openDatabase;
  if (values.remote) {
    const session = await connect({ env: env.env, fetch: env.fetch, accountId: values["account-id"] });
    openDatabase = remoteD1Opener(session.api, session.accountId);
  }
  const target = { cwd: env.cwd, config: values.config, binding: values.binding };
  const deps = { openDatabase, log: env.log, error: env.error };
  if (action === "revoke") {
    if (positionals.length !== 1) throw new UsageError(`Usage: castra mcp token revoke <id>\n\n${MCP_USAGE}`);
    return revokeMcpTokenCommand({ ...target, id: positionals[0]! }, deps);
  }
  if (!values.user || !values.scopes) throw new UsageError(`--user and --scopes are required.\n\n${MCP_USAGE}`);
  return createMcpTokenCommand(
    {
      ...target,
      user: values.user,
      scopes: values.scopes,
      name: values.name,
      expiresInDays: values["expires-in"] === undefined ? undefined : Number(values["expires-in"]),
    },
    deps,
  );
}
