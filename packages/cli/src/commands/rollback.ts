import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connect } from "../cloudflare/connect.js";
import type { CloudflareDeps } from "./provision.js";
import type { CloudflareApi } from "../cloudflare/api.js";
import type { OpenDatabaseFn } from "../local-d1.js";
import { remoteD1Opener } from "../remote-d1.js";
import { captureRollbackMetadata, parseRollbackMessage } from "../rollback-metadata.js";
import { CliError, readWranglerConfig } from "../wrangler-config.js";

/** Options for a schema-compatible Worker rollback; D1 data is never restored. */
export interface RollbackOptions {
  cwd: string;
  config: string;
  accountId?: string;
  /** Defaults to the immediately preceding deployment's single version. */
  version?: string;
  dryRun?: boolean;
  /** Must equal the configured Worker name. */
  confirm?: string;
}
/** Injected Cloudflare, prompt and remote schema effects. */
export interface RollbackDeps extends CloudflareDeps {
  prompt?: (message: string) => Promise<string>;
  openRemoteDatabase?: (api: CloudflareApi, accountId: string) => OpenDatabaseFn;
}
interface Deployment { id: string; versions: { version_id: string; percentage: number }[] }
interface Version { annotations?: { "workers/message"?: string } }
function singleVersion(deployment: Deployment | undefined): string {
  if (!deployment || deployment.versions.length !== 1 || deployment.versions[0]?.percentage !== 100) {
    throw new CliError("Rollback requires a deployment with exactly one version at 100% traffic.");
  }
  return deployment.versions[0].version_id;
}
/** Check compatibility, confirm and recheck, then activate a version without forcing provider refusals. */
export async function rollback(options: RollbackOptions, deps: RollbackDeps): Promise<number> {
  if (options.version && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(options.version)) {
    throw new CliError("--version must be a Worker version UUID.");
  }
  const configPath = resolve(options.cwd, options.config);
  const worker = readWranglerConfig(await readFile(configPath, "utf8")).name;
  if (!worker) throw new CliError("Rollback requires a Worker name in the config.");
  const { api, accountId } = await connect({ env: deps.env, fetch: deps.fetch, accountId: options.accountId });
  const base = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(worker)}`;
  const deployments = async () => (await api.request<{ deployments: Deployment[] }>("GET", `${base}/deployments`)).result.deployments;
  const history = await deployments();
  const current = singleVersion(history[0]);
  const target = options.version ?? singleVersion(history[1]);
  if (target === current) throw new CliError("Rollback target is already active.");
  const version = async (id: string, role: "current" | "target") => {
    const result = (await api.request<Version>("GET", `${base}/versions/${encodeURIComponent(id)}`)).result;
    try {
      return parseRollbackMessage(result.annotations?.["workers/message"]);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      throw new CliError(`Rollback refused: ${role} version ${id} has no valid Castra rollback metadata. Deploy two compatible versions with castra deploy before rolling back; secret-only and older unmarked versions cannot be targets.`);
    }
  };
  const currentMetadata = await version(current, "current");
  const targetMetadata = await version(target, "target");
  const open = (deps.openRemoteDatabase ?? remoteD1Opener)(api, accountId);
  const check = async () => {
    const live = await captureRollbackMetadata(configPath, open);
    if (live.config !== currentMetadata.config || live.config !== targetMetadata.config) {
      throw new CliError("Rollback refused: current, target and local Wrangler configs must match.");
    }
    if (live.schema !== targetMetadata.schema) throw new CliError("Rollback refused: target schema does not match live D1.");
  };
  await check();
  deps.log(`Rollback ${worker}: ${current} -> ${target} (schema and config compatible; D1 data unchanged).`);
  if (options.dryRun) return 0;
  const answer = options.confirm ?? (deps.prompt ? (await deps.prompt(`Type the Worker name (${worker}) to confirm: `)).trim() : undefined);
  if (answer !== worker) throw new CliError(`Rollback requires confirmation: --confirm ${worker}.`);
  const latest = (await deployments())[0];
  if (latest?.id !== history[0]?.id || singleVersion(latest) !== current) {
    throw new CliError("Rollback refused: active deployment changed. Re-run to review the new plan.");
  }
  await check();
  await api.request("POST", `${base}/deployments?force=false`, {
    strategy: "percentage", versions: [{ version_id: target, percentage: 100 }],
    annotations: { "workers/message": "Castra schema-compatible rollback" },
  });
  try {
    if (singleVersion((await deployments())[0]) !== target) throw new Error("Target is not active.");
  } catch (error) {
    throw new CliError(`Rollback submitted, but target activation could not be verified. Inspect Cloudflare deployments before retrying. ${error instanceof Error ? error.message : String(error)}`);
  }
  deps.log(`Rolled back ${worker} to ${target}.`);
  return 0;
}
