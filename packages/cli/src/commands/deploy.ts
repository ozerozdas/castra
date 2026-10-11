import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { ExecFn } from "../exec.js";
import { trimEnd } from "../text.js";
import type { OpenDatabaseFn } from "../local-d1.js";
import { remoteD1Opener } from "../remote-d1.js";
import { CloudflareApiError } from "../cloudflare/api.js";
import type { CloudflareApi } from "../cloudflare/api.js";
import { problems } from "../problems.js";
import { generate } from "./generate.js";
import { migrate, wranglerEnv } from "./migrate.js";
import { provision } from "./provision.js";
import type { CloudflareDeps } from "./provision.js";

/** Name of the Worker secret Better Auth signs sessions with. */
export const AUTH_SECRET_NAME = "BETTER_AUTH_SECRET";

/** Options of `castra deploy`. */
export interface DeployOptions {
  cwd: string;
  config: string;
  accountId?: string;
  storage?: boolean;
  /** D1 binding to migrate and drift-check when the config declares several. */
  binding?: string;
  /** Snapshot directory (default `castra`). */
  out?: string;
}

/** Side effects of `castra deploy`. */
export interface DeployDeps extends CloudflareDeps {
  exec: ExecFn;
  /** Opens the remote database for the drift check. Defaults to the D1 HTTP query API. */
  openRemoteDatabase?: (api: CloudflareApi, accountId: string) => OpenDatabaseFn;
  /** Secret generator; defaults to 32 random bytes from `node:crypto`, base64url. */
  generateSecret?: () => string;
}

/** URLs printed after a successful deploy. */
export interface DeployResult {
  code: number;
  /** The step that failed, if any. */
  failedStep?: "provision" | "migrate" | "drift" | "secret" | "deploy";
  url?: string;
}

const defaultSecret = () => randomBytes(32).toString("base64url");

/** Pick the first `https://...` URL from `wrangler deploy` output, preferring `*.workers.dev`. */
export function parseDeployedUrl(output: string): string | undefined {
  const urls = output.match(/https:\/\/[^\s"'<>()]+/g) ?? [];
  const clean = urls.map((u) => trimEnd(u, ".,;"));
  return clean.find((u) => hostname(u)?.endsWith(".workers.dev")) ?? clean.find((u) => !isCloudflareHost(hostname(u)));
}

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Dashboard and docs links in wrangler output, which are never the deployed Worker. */
function isCloudflareHost(host: string | undefined): boolean {
  return host === "cloudflare.com" || !!host?.endsWith(".cloudflare.com");
}

/**
 * `castra deploy`: provision → migrate (remote) → drift check against the remote database → ensure
 * `BETTER_AUTH_SECRET` → `wrangler deploy`, then print the API, OpenAPI and MCP URLs.
 *
 * The secret is created only when the Worker does not have it yet; it is 32 random bytes, passed to
 * `wrangler secret put` on stdin, never logged, never written to disk. It is put BEFORE the first deploy: for a
 * Worker that does not exist yet, wrangler creates an empty draft Worker to hold it, so the real code never runs
 * without its secret (ADR 0034). Every step stops the run on failure.
 */
export async function deploy(options: DeployOptions, deps: DeployDeps): Promise<DeployResult> {
  // 1. Provision (verifies the token and resolves the account).
  const provisioned = await provision(
    { cwd: options.cwd, config: options.config, accountId: options.accountId, storage: options.storage },
    deps,
  );
  const { accountId, workerName, configPath, session } = provisioned;
  const cwd = dirname(configPath);
  // wrangler gets the same token as the API calls above (deps.env), never an unrelated process.env token.
  const env = wranglerEnv(deps.env, accountId);

  // 2. Remote migrations.
  const migrated = await migrate(
    { cwd: options.cwd, config: options.config, target: "remote", binding: options.binding, accountId },
    deps,
  );
  if (migrated !== 0) return { code: migrated, failedStep: "migrate" };

  // 3. Drift: the committed snapshot must match the migrated remote database.
  const open = (deps.openRemoteDatabase ?? remoteD1Opener)(session.api, accountId);
  const drift = await generate(
    {
      cwd: options.cwd,
      config: options.config,
      out: options.out ?? "castra",
      check: true,
      binding: options.binding ?? provisioned.resources.find((r) => r.kind === "d1")?.binding,
      source: "remote database",
    },
    { openDatabase: open, log: deps.log, error: deps.error },
  );
  if (drift !== 0) {
    deps.error("Deploy stopped: the schema snapshot does not match the remote database. Nothing was deployed.");
    return { code: 1, failedStep: "drift" };
  }

  // 4. BETTER_AUTH_SECRET, only if missing.
  let secrets: string[] | null;
  try {
    secrets = await session.api.listWorkerSecretNames(accountId, workerName);
  } catch (e) {
    if (e instanceof CloudflareApiError && e.isAuthError) {
      throw problems.missingPermission("Workers Scripts Edit", `list the secrets of Worker "${workerName}"`);
    }
    throw e;
  }
  if (secrets === null || !secrets.includes(AUTH_SECRET_NAME)) {
    deps.log(`Setting ${AUTH_SECRET_NAME} (generated, not shown)...`);
    const put = await deps.exec("wrangler", ["secret", "put", AUTH_SECRET_NAME, "--config", configPath], {
      cwd,
      env,
      input: (deps.generateSecret ?? defaultSecret)(),
    });
    if (put.code !== 0) {
      deps.error(`wrangler secret put exited with code ${put.code}.`);
      return { code: put.code, failedStep: "secret" };
    }
  } else {
    deps.log(`${AUTH_SECRET_NAME} already set; leaving it unchanged.`);
  }

  // 5. Deploy.
  const deployed = await deps.exec("wrangler", ["deploy", "--config", configPath], { cwd, env });
  if (deployed.code !== 0) {
    deps.error(`wrangler deploy exited with code ${deployed.code}.`);
    return { code: deployed.code, failedStep: "deploy" };
  }

  let url = parseDeployedUrl(`${deployed.stdout}\n${deployed.stderr}`);
  if (url === undefined) {
    try {
      url = `https://${workerName}.${await session.api.getWorkersSubdomain(accountId)}.workers.dev`;
    } catch {
      deps.error("Deployed, but could not determine the URL (no workers.dev route in the output).");
      return { code: 0 };
    }
  }
  url = url.replace(/\/$/, "");
  deps.log("");
  deps.log(`Deployed ${workerName}`);
  deps.log(`  API:      ${url}`);
  deps.log(`  OpenAPI:  ${url}/openapi.json`);
  deps.log(`  MCP:      ${url}/mcp`);
  return { code: 0, url };
}
