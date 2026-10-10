import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CloudflareApiError } from "../cloudflare/api.js";
import type { FetchFn } from "../cloudflare/api.js";
import { connect } from "../cloudflare/connect.js";
import type { CloudflareEnv, CloudflareSession } from "../cloudflare/connect.js";
import { problems } from "../problems.js";
import { CliError, isPlaceholderId, readWranglerConfig, setJsoncValue } from "../wrangler-config.js";

/** Binding name of the KV namespace every Castra project gets. */
export const KV_BINDING = "CACHE";
/** Binding name used when storage is enabled and the config declares no R2 bucket. */
export const R2_BINDING = "STORAGE";

/** Options of `castra provision`. */
export interface ProvisionOptions {
  /** Directory relative paths are resolved against. */
  cwd: string;
  /** Path to the wrangler config. */
  config: string;
  /** Account id; overrides `CLOUDFLARE_ACCOUNT_ID`. */
  accountId?: string;
  /** Provision an R2 bucket even if the config declares none (`--storage`). */
  storage?: boolean;
}

/** Side effects shared by the Cloudflare-facing commands. */
export interface CloudflareDeps {
  fetch: FetchFn;
  env: CloudflareEnv;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** One resource after provisioning. */
export interface ProvisionedResource {
  kind: "d1" | "kv" | "r2";
  binding: string;
  /** D1 database name, KV namespace title or R2 bucket name. */
  name: string;
  /** D1 uuid or KV id; the bucket name for R2. */
  id: string;
  created: boolean;
}

/** What `provision` did. */
export interface ProvisionResult {
  accountId: string;
  workerName: string;
  configPath: string;
  resources: ProvisionedResource[];
  /** Whether wrangler.jsonc was rewritten. */
  configChanged: boolean;
  session: CloudflareSession;
}

async function readConfigText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`Wrangler config not found: ${path}`);
    throw e;
  }
}

/** Run a Cloudflare call, turning 401/403 into a "missing permission" problem. */
async function guarded<T>(permission: string, action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CloudflareApiError && e.isAuthError) throw problems.missingPermission(permission, action);
    throw e;
  }
}

/**
 * `castra provision`: find-or-create the D1 database(s), the `CACHE` KV namespace and (with storage) the R2
 * bucket, then write their ids into the wrangler config with `jsonc-parser` edits, preserving comments.
 *
 * Idempotent: resources are looked up by name first, so a second run issues no create call and leaves the file
 * untouched. Placeholder ids (all zeros) count as "not provisioned". Pass `session` to reuse a verified client.
 */
export async function provision(
  options: ProvisionOptions,
  deps: CloudflareDeps,
  session?: CloudflareSession,
): Promise<ProvisionResult> {
  const configPath = resolve(options.cwd, options.config);
  const original = await readConfigText(configPath);
  const config = readWranglerConfig(original);
  if (!config.name) throw new CliError(`The wrangler config has no "name"; set the Worker name first (${configPath}).`);
  const workerName = config.name;

  const cf = session ?? (await connect({ env: deps.env, fetch: deps.fetch, accountId: options.accountId }));
  const { api, accountId } = cf;
  let text = original;
  const resources: ProvisionedResource[] = [];

  // D1: one database per d1_databases entry, found by database_name.
  if (config.d1.length === 0) throw new CliError("No d1_databases entry found in the wrangler config.");
  for (const db of config.d1) {
    const name = db.databaseName ?? `${workerName}-db`;
    if (db.databaseName === undefined) text = setJsoncValue(text, ["d1_databases", db.index, "database_name"], name);
    const found = (await guarded("D1 Edit", "list D1 databases", () => api.listD1(accountId, name))).find(
      (d) => d.name === name,
    );
    const target = found ?? (await guarded("D1 Edit", `create D1 database "${name}"`, () => api.createD1(accountId, name)));
    if (!found) deps.log(`Created D1 database ${name} (${target.uuid})`);
    if (!isPlaceholderId(db.databaseId) && db.databaseId !== target.uuid) {
      deps.error(`warning: ${db.binding} pointed at ${db.databaseId}, which is not "${name}"; using ${target.uuid}.`);
    }
    if (db.databaseId !== target.uuid) text = setJsoncValue(text, ["d1_databases", db.index, "database_id"], target.uuid);
    resources.push({ kind: "d1", binding: db.binding, name, id: target.uuid, created: !found });
  }

  // KV: the CACHE namespace, titled "<worker>-cache". Added to the config when missing.
  const kvTitle = `${workerName}-cache`;
  const kvEntry = config.kv.find((k) => k.binding === KV_BINDING);
  const namespaces = await guarded("Workers KV Storage Edit", "list KV namespaces", () => api.listKv(accountId));
  const kvFound =
    (kvEntry && !isPlaceholderId(kvEntry.id) ? namespaces.find((n) => n.id === kvEntry.id) : undefined) ??
    namespaces.find((n) => n.title === kvTitle);
  const kv =
    kvFound ??
    (await guarded("Workers KV Storage Edit", `create KV namespace "${kvTitle}"`, () => api.createKv(accountId, kvTitle)));
  if (!kvFound) deps.log(`Created KV namespace ${kvTitle} (${kv.id})`);
  if (!kvEntry) {
    text =
      config.kv.length === 0
        ? setJsoncValue(text, ["kv_namespaces"], [{ binding: KV_BINDING, id: kv.id }])
        : setJsoncValue(text, ["kv_namespaces", -1], { binding: KV_BINDING, id: kv.id }, true);
  } else if (kvEntry.id !== kv.id) {
    text = setJsoncValue(text, ["kv_namespaces", kvEntry.index, "id"], kv.id);
  }
  resources.push({ kind: "kv", binding: KV_BINDING, name: kv.title, id: kv.id, created: !kvFound });

  // R2: only when storage is on (flag, or the config already declares buckets). See ADR 0031.
  if (options.storage || config.r2.length > 0) {
    const entries = config.r2.length > 0 ? config.r2 : [{ index: -1, binding: R2_BINDING, bucketName: undefined }];
    for (const entry of entries) {
      const name = entry.bucketName ?? `${workerName}-storage`;
      const found = (
        await guarded("Workers R2 Storage Edit", "list R2 buckets", () => api.listR2(accountId, name))
      ).find((b) => b.name === name);
      if (!found) {
        await guarded("Workers R2 Storage Edit", `create R2 bucket "${name}"`, () => api.createR2(accountId, name));
        deps.log(`Created R2 bucket ${name}`);
      }
      if (entry.index === -1) {
        text = setJsoncValue(text, ["r2_buckets"], [{ binding: entry.binding, bucket_name: name }]);
      } else if (entry.bucketName === undefined) {
        text = setJsoncValue(text, ["r2_buckets", entry.index, "bucket_name"], name);
      }
      resources.push({ kind: "r2", binding: entry.binding, name, id: name, created: !found });
    }
  }

  const configChanged = text !== original;
  if (configChanged) {
    await writeFile(configPath, text);
    deps.log(`Updated ${configPath}`);
  }
  const createdCount = resources.filter((r) => r.created).length;
  deps.log(
    createdCount === 0
      ? `All resources already provisioned in account ${accountId}.`
      : `Provisioned ${createdCount} new resource(s) in account ${accountId}.`,
  );
  return { accountId, workerName, configPath, resources, configChanged, session: cf };
}
