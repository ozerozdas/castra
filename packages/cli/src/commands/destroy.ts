import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CloudflareApiError } from "../cloudflare/api.js";
import { connect } from "../cloudflare/connect.js";
import type { ExecFn } from "../exec.js";
import { problems } from "../problems.js";
import { CliError, isPlaceholderId, readWranglerConfig, setJsoncValue } from "../wrangler-config.js";
import { wranglerEnv } from "./migrate.js";
import { KV_BINDING } from "./provision.js";
import type { CloudflareDeps } from "./provision.js";

/** Written back over a deleted resource's id, so `castra deploy` provisions a fresh one. */
export const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

/** Options of `castra destroy`. */
export interface DestroyOptions {
  cwd: string;
  config: string;
  accountId?: string;
  /** Print the plan and stop. */
  dryRun?: boolean;
  /** Non-interactive confirmation: must equal the Worker name. */
  confirm?: string;
  /** Do not export D1 databases before deleting them. */
  skipBackup?: boolean;
  /** Directory for D1 exports (default `castra-backups`, relative to the wrangler config). */
  backupDir?: string;
}

/** Side effects of `castra destroy`. */
export interface DestroyDeps extends CloudflareDeps {
  exec: ExecFn;
  /** Asks a question on the terminal; `undefined` when there is no terminal to ask on. */
  prompt?: (question: string) => Promise<string>;
  /** Clock for backup file names. */
  now?: () => Date;
}

/** One resource `destroy` would delete. */
export interface DestroyTarget {
  kind: "worker" | "d1" | "kv" | "r2";
  /** Worker name, D1 database name, KV title or R2 bucket name. */
  name: string;
  /** D1 uuid or KV id; the name for Worker and R2. */
  id: string;
  /** Path of the id in wrangler.jsonc to reset after the delete. */
  configPath?: (string | number)[];
}

/** What `destroy` did. */
export interface DestroyResult {
  code: number;
  targets: DestroyTarget[];
  deleted: DestroyTarget[];
  backups: string[];
}

const ORDER: DestroyTarget["kind"][] = ["worker", "kv", "r2", "d1"];
const LABEL: Record<DestroyTarget["kind"], string> = { worker: "Worker", d1: "D1 database", kv: "KV namespace", r2: "R2 bucket" };

async function guarded<T>(permission: string, action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CloudflareApiError && e.isAuthError) throw problems.missingPermission(permission, action);
    throw e;
  }
}

/**
 * `castra destroy` (ADR 0076): delete the Worker, D1 databases, `CACHE` KV namespace and R2 buckets recorded in
 * `wrangler.jsonc`, after a plan, a confirmation (the Worker name) and a D1 export. Resources are found by their
 * recorded ids, never by name. Each delete resets the recorded id to a placeholder; a second run deletes nothing.
 */
export async function destroy(options: DestroyOptions, deps: DestroyDeps): Promise<DestroyResult> {
  const configPath = resolve(options.cwd, options.config);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`Wrangler config not found: ${configPath}`);
    throw e;
  }
  const config = readWranglerConfig(text);
  if (!config.name) throw new CliError(`The wrangler config has no "name" (${configPath}).`);
  const workerName = config.name;

  const { api, accountId } = await connect({ env: deps.env, fetch: deps.fetch, accountId: options.accountId });

  // 1. Plan: only what is recorded, looked up by id.
  const targets: DestroyTarget[] = [];
  const gone: string[] = [];
  const workerSecrets = await guarded("Workers Scripts Edit", `look up Worker "${workerName}"`, () =>
    api.listWorkerSecretNames(accountId, workerName),
  );
  if (workerSecrets === null) gone.push(`Worker ${workerName}`);
  else targets.push({ kind: "worker", name: workerName, id: workerName });

  for (const db of config.d1) {
    if (isPlaceholderId(db.databaseId)) continue;
    const found = await guarded("D1 Edit", `look up D1 database ${db.databaseId}`, () => api.getD1(accountId, db.databaseId!));
    if (!found) {
      gone.push(`D1 database ${db.databaseName ?? db.binding} (${db.databaseId})`);
      continue;
    }
    if (db.databaseName !== undefined && found.name !== db.databaseName) {
      throw new CliError(
        `D1 binding "${db.binding}": database_id ${db.databaseId} is the database "${found.name}", not "${db.databaseName}". ` +
          `Nothing was deleted. Fix database_id or database_name in ${configPath} first.`,
      );
    }
    targets.push({ kind: "d1", name: found.name, id: found.uuid, configPath: ["d1_databases", db.index, "database_id"] });
  }

  const kvEntry = config.kv.find((k) => k.binding === KV_BINDING);
  if (kvEntry && !isPlaceholderId(kvEntry.id)) {
    const found = (await guarded("Workers KV Storage Edit", "list KV namespaces", () => api.listKv(accountId))).find(
      (n) => n.id === kvEntry.id,
    );
    if (found) targets.push({ kind: "kv", name: found.title, id: found.id, configPath: ["kv_namespaces", kvEntry.index, "id"] });
    else gone.push(`KV namespace ${kvEntry.id}`);
  }
  const keptKv = config.kv.filter((k) => k.binding !== KV_BINDING).map((k) => k.binding);

  for (const r2 of config.r2) {
    if (!r2.bucketName) continue;
    const found = (await guarded("Workers R2 Storage Edit", "list R2 buckets", () => api.listR2(accountId, r2.bucketName))).some(
      (b) => b.name === r2.bucketName,
    );
    if (found) targets.push({ kind: "r2", name: r2.bucketName, id: r2.bucketName });
    else gone.push(`R2 bucket ${r2.bucketName}`);
  }
  targets.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  const result: DestroyResult = { code: 0, targets, deleted: [], backups: [] };
  for (const g of gone) deps.log(`Already gone: ${g}`);
  if (targets.length === 0) {
    deps.log(`Nothing to delete for ${workerName} in account ${accountId}.`);
    return result;
  }

  const d1Targets = targets.filter((t) => t.kind === "d1");
  const backupDir = resolve(dirname(configPath), options.backupDir ?? "castra-backups");
  deps.log(`castra destroy will permanently delete, in account ${accountId}:`);
  for (const t of targets) deps.log(`  - ${LABEL[t.kind]} ${t.name}${t.id !== t.name ? ` (${t.id})` : ""}`);
  if (d1Targets.length > 0) {
    deps.log(
      options.skipBackup
        ? "  D1 data will NOT be exported (--skip-backup). It cannot be recovered."
        : `  D1 data is exported to ${backupDir} first.`,
    );
  }
  if (targets.some((t) => t.kind === "r2")) deps.log("  R2 buckets must be empty; Castra does not delete objects.");
  if (keptKv.length > 0) deps.log(`  Kept (not created by Castra): KV ${keptKv.join(", ")}.`);
  deps.log("  Not touched: routes, custom domains and DNS records; check them in the dashboard.");

  if (options.dryRun) {
    deps.log("Dry run: nothing was deleted.");
    return result;
  }

  // 2. Confirm with the Worker name.
  let answer = options.confirm;
  if (answer === undefined) {
    if (!deps.prompt) {
      deps.error(`Refusing to delete without confirmation. Re-run in a terminal, or pass --confirm ${workerName}.`);
      return { ...result, code: 1 };
    }
    answer = (await deps.prompt(`Type the Worker name (${workerName}) to confirm: `)).trim();
  }
  if (answer !== workerName) {
    deps.error("Confirmation did not match the Worker name. Nothing was deleted.");
    return { ...result, code: 1 };
  }

  // 3. Export D1 before anything is deleted.
  const env = wranglerEnv(deps.env, accountId);
  if (!options.skipBackup && d1Targets.length > 0) {
    await mkdir(backupDir, { recursive: true });
    const stamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
    for (const t of d1Targets) {
      const file = join(backupDir, `${t.name}-${stamp}.sql`);
      deps.log(`Exporting D1 database ${t.name} to ${file}...`);
      const r = await deps.exec("wrangler", ["d1", "export", t.name, "--remote", "--output", file, "--config", configPath], {
        cwd: dirname(configPath),
        env,
      });
      if (r.code !== 0) {
        deps.error(`wrangler d1 export exited with code ${r.code}. Nothing was deleted.`);
        return { ...result, code: r.code };
      }
      result.backups.push(file);
    }
  }

  // 4. Delete in order; reset recorded ids as we go so a rerun continues where this one stopped.
  const remove: Record<DestroyTarget["kind"], (t: DestroyTarget) => Promise<void>> = {
    worker: (t) => guarded("Workers Scripts Edit", `delete Worker "${t.name}"`, () => api.deleteWorker(accountId, t.id)),
    kv: (t) => guarded("Workers KV Storage Edit", `delete KV namespace "${t.name}"`, () => api.deleteKv(accountId, t.id)),
    r2: (t) => guarded("Workers R2 Storage Edit", `delete R2 bucket "${t.name}"`, () => api.deleteR2(accountId, t.id)),
    d1: (t) => guarded("D1 Edit", `delete D1 database "${t.name}"`, () => api.deleteD1(accountId, t.id)),
  };
  for (const t of targets) {
    try {
      await remove[t.kind](t);
    } catch (e) {
      if (!(e instanceof CloudflareApiError)) throw e;
      deps.error(`Could not delete ${LABEL[t.kind]} ${t.name}: ${e.message}`);
      if (t.kind === "r2") deps.error("Empty the bucket (dashboard or `wrangler r2 object delete`), then run castra destroy again.");
      deps.error(`Stopped. Deleted so far: ${result.deleted.map((d) => `${LABEL[d.kind]} ${d.name}`).join(", ") || "nothing"}.`);
      return { ...result, code: 1 };
    }
    result.deleted.push(t);
    deps.log(`Deleted ${LABEL[t.kind]} ${t.name}`);
    if (t.configPath) {
      text = setJsoncValue(text, t.configPath, PLACEHOLDER_ID);
      await writeFile(configPath, text);
    }
  }
  deps.log(`Destroyed ${workerName}. ${configPath} now holds placeholder ids; \`castra deploy\` provisions new resources.`);
  return result;
}
