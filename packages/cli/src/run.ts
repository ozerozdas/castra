import { parseArgs } from "node:util";
import { generate } from "./commands/generate.js";
import { openLocalD1 } from "./local-d1.js";
import type { OpenDatabaseFn } from "./local-d1.js";
import { CliError } from "./wrangler-config.js";

/** Commands that are planned (ARCHITECTURE section 6) but not built yet. */
const PLANNED = ["init", "provision", "migrate", "deploy", "test", "mcp", "doctor"] as const;

const USAGE = `castra - Cloudflare-native, agent-safe BaaS toolkit

Usage: castra <command> [options]

Commands:
  generate   Write castra/schema.json and castra/db.d.ts from the local D1 database
  ${PLANNED.join(", ")}   (not implemented yet)

Run \`castra generate --help\` for command options.`;

const GENERATE_USAGE = `Usage: castra generate [options]

Options:
  --local            Introspect the local D1 database (the only supported mode; implied)
  --config <path>    Wrangler config (default: wrangler.jsonc)
  --out <dir>        Output directory (default: castra)
  --binding <name>   D1 binding to use when the config declares several
  --check            Do not write; exit 1 and list the drift if the committed snapshot is stale`;

/** I/O seams of {@link run}; defaults use the real process. */
export interface RunEnv {
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
  openDatabase: OpenDatabaseFn;
}

const defaultEnv = (): RunEnv => ({
  cwd: process.cwd(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  openDatabase: openLocalD1,
});

/**
 * Entry point of the `castra` binary. Dispatches the first argument to a subcommand.
 *
 * Exit codes: `0` success, `1` check failed or runtime error, `2` usage error or command not implemented.
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
    if (command === "generate") return await runGenerate(rest, env);

    if ((PLANNED as readonly string[]).includes(command)) {
      env.error(`castra ${command}: not implemented yet`);
      return 2;
    }

    env.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  } catch (e) {
    if (e instanceof CliError) {
      env.error(`error: ${e.message}`);
      return 2;
    }
    env.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function runGenerate(args: string[], env: RunEnv): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        local: { type: "boolean", default: false },
        config: { type: "string", default: "wrangler.jsonc" },
        out: { type: "string", default: "castra" },
        binding: { type: "string" },
        check: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }));
  } catch (e) {
    throw new CliError(`${e instanceof Error ? e.message : String(e)}\n\n${GENERATE_USAGE}`);
  }

  if (values.help) {
    env.log(GENERATE_USAGE);
    return 0;
  }

  return generate(
    { cwd: env.cwd, config: values.config, out: values.out, check: values.check, binding: values.binding },
    { openDatabase: env.openDatabase, log: env.log, error: env.error },
  );
}
