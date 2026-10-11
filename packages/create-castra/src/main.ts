import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  scaffold,
  ScaffoldError,
  TEMPLATES,
  UsageError,
  validateProjectName,
  type PackageManager,
  type TemplateName,
} from "./scaffold.js";

export const USAGE = `create-castra - scaffold a Castra app (Cloudflare Workers + D1 + Better Auth + MCP)

Usage: npm create @castra-kit@latest <name> [options]
       npm create @castra-kit@latest my-app

<name> is the directory, the Worker name and the D1 database prefix (<name>-db): lowercase letters, digits
and dashes, at most 63 characters.

Options:
  --template <name>            Template to use (default: default)
  --package-manager <pm>       pnpm | npm (default: the one running create-castra, else pnpm)
  --no-install                 Do not install dependencies
  --local-packages <path>      Use @castra-kit/* from a local Castra repository checkout (link:/file: paths)
  -h, --help                   Show this help`;

/** Runs a program with inherited stdio and resolves with its exit code. Injected so tests never install. */
export type RunCommandFn = (command: string, args: string[], cwd: string) => Promise<number>;

/** Default {@link RunCommandFn}: `child_process.spawn` without a shell (except on Windows for .cmd shims). */
export const spawnCommand: RunCommandFn = (command, args, cwd) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });

/** I/O seams of {@link main}. */
export interface MainEnv {
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
  runCommand: RunCommandFn;
  /** Used to detect the package manager (`npm_config_user_agent`). */
  env: Record<string, string | undefined>;
  /** Version written for the Castra packages. */
  version: string;
}

/** The scaffolder's own version (the Castra packages are released with the same version). */
export function ownVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

const defaultEnv = (): MainEnv => ({
  cwd: process.cwd(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  runCommand: spawnCommand,
  env: process.env,
  version: ownVersion(),
});

/** `npm_config_user_agent` is set by npm/pnpm/yarn when they run a package binary (`npx`, `pnpm create`). */
export function detectPackageManager(env: Record<string, string | undefined>): PackageManager {
  return env.npm_config_user_agent?.startsWith("npm/") ? "npm" : "pnpm";
}

/** The commands printed after scaffolding. */
export function nextSteps(dir: string, pm: PackageManager, installed: boolean): string[] {
  const r = (script: string) => `${pm} run ${script}`;
  return [
    "Next steps:",
    `  cd ${dir}`,
    ...(installed ? [] : [`  ${pm} install`]),
    "  cp .dev.vars.example .dev.vars        # then set BETTER_AUTH_SECRET to: openssl rand -base64 32",
    `  ${r("db:migrate:local")}`,
    `  ${r("dev")}                            # http://localhost:8787/health, /openapi.json, /api/notes`,
    `  ${r("test:policies")}`,
    `  CLOUDFLARE_API_TOKEN=... ${r("deploy")}`,
    "",
    "Token permissions and what deploy does: README.md.",
  ];
}

/**
 * Entry point of the `create-castra` binary.
 *
 * Exit codes: `0` success, `1` the target is not empty, a bad `--local-packages` path or a failed install,
 * `2` usage error (missing or invalid name, unknown option or template).
 *
 * @param argv Arguments without the `node` and script path.
 */
export async function main(argv: string[], overrides: Partial<MainEnv> = {}): Promise<number> {
  const env = { ...defaultEnv(), ...overrides };
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        template: { type: "string", default: "default" },
        "package-manager": { type: "string" },
        "no-install": { type: "boolean", default: false },
        "local-packages": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    env.error(`error: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    env.log(USAGE);
    return 0;
  }

  const usage = (message: string) => {
    env.error(`error: ${message}\n\n${USAGE}`);
    return 2;
  };
  if (positionals.length === 0) return usage("Missing project name.");
  if (positionals.length > 1) return usage(`Expected one project name, got ${positionals.length}: ${positionals.join(" ")}.`);
  const name = positionals[0]!;
  const nameError = validateProjectName(name);
  if (nameError) return usage(nameError);
  if (!(TEMPLATES as readonly string[]).includes(values.template)) {
    return usage(`Unknown template "${values.template}". Available: ${TEMPLATES.join(", ")}.`);
  }
  const pmFlag = values["package-manager"];
  if (pmFlag !== undefined && pmFlag !== "pnpm" && pmFlag !== "npm") return usage(`--package-manager must be pnpm or npm, got "${pmFlag}".`);
  const pm: PackageManager = pmFlag ?? detectPackageManager(env.env);

  const targetDir = resolve(env.cwd, name);
  let result;
  try {
    result = await scaffold({
      name,
      targetDir,
      template: values.template as TemplateName,
      packageManager: pm,
      castraVersion: env.version,
      localPackages: values["local-packages"] === undefined ? undefined : resolve(env.cwd, values["local-packages"]),
    });
  } catch (e) {
    if (e instanceof UsageError) return usage(e.message);
    if (e instanceof ScaffoldError) {
      env.error(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }

  env.log(`Created ${name} in ${targetDir} (${result.files.length} files).`);
  for (const w of result.warnings) env.error(`warning: ${w}`);

  let installed = false;
  if (!values["no-install"]) {
    env.log(`Installing dependencies with ${pm}...`);
    let code: number;
    try {
      code = await env.runCommand(pm, ["install"], targetDir);
    } catch (e) {
      env.error(`error: could not run ${pm}: ${e instanceof Error ? e.message : String(e)}`);
      code = 1;
    }
    if (code !== 0) {
      env.error(`error: \`${pm} install\` failed (exit ${code}). The project is created; fix the problem and run it again.`);
      for (const line of nextSteps(relative(env.cwd, targetDir) || ".", pm, false)) env.log(line);
      return 1;
    }
    installed = true;
  }

  env.log("");
  for (const line of nextSteps(relative(env.cwd, targetDir) || ".", pm, installed)) env.log(line);
  return 0;
}
