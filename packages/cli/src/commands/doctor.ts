import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CloudflareApiError } from "../cloudflare/api.js";
import type { CloudflareApi, TokenPolicy } from "../cloudflare/api.js";
import { connect } from "../cloudflare/connect.js";
import type { CloudflareSession } from "../cloudflare/connect.js";
import type { OpenDatabaseFn } from "../local-d1.js";
import { ProblemError, TOKEN_DOCS } from "../problems.js";
import { isPlaceholderId, readWranglerConfig } from "../wrangler-config.js";
import type { WranglerConfig } from "../wrangler-config.js";
import { remoteD1Opener } from "../remote-d1.js";
import { generate } from "./generate.js";
import { KV_BINDING } from "./provision.js";
import type { CloudflareDeps } from "./provision.js";

/** Options of `castra doctor`. */
export interface DoctorOptions {
  cwd: string;
  config: string;
  accountId?: string;
  /** Treat R2 as required even if the config declares no bucket. */
  storage?: boolean;
  /** Snapshot directory for the drift check (default `castra`). */
  out?: string;
  /** Compare the snapshot with the deployed D1 (D1 HTTP API) instead of the local one (ADR 0079). */
  remote?: boolean;
}

/** What {@link doctor} found. */
export interface DoctorResult {
  code: number;
  checks: DoctorCheck[];
  /** Schema drift lines (snapshot vs D1); empty when there is none or the check did not run. */
  drift: string[];
}

/** Side effects of `castra doctor`. */
export interface DoctorDeps extends CloudflareDeps {
  openDatabase: OpenDatabaseFn;
}

/**
 * Status of one check.
 * - `ok`: verified.
 * - `readable`: a read-only probe succeeded; the Edit level cannot be verified without writing (see ADR 0033).
 * - `missing`: the probe was refused, or the token's policies show only the Read level.
 * - `warn`: not fatal (e.g. a binding not provisioned yet).
 * - `skipped`: not applicable or could not run.
 */
export type CheckStatus = "ok" | "readable" | "missing" | "warn" | "skipped";

/** One row of the doctor report. */
export interface DoctorCheck {
  check: string;
  status: CheckStatus;
  required: boolean;
  fix: string;
}

/** A Cloudflare API token permission Castra relies on, with the read-only probe that detects it. */
export interface PermissionSpec {
  /** Exact permission group name in the Cloudflare dashboard (Account scope). */
  name: string;
  /** Read-level group name (what a successful read-only probe proves). */
  readName: string;
  /** Edit-level aliases as shown in the API's permission group list. */
  editNames: string[];
  why: string;
  probe: (api: CloudflareApi, accountId: string) => Promise<unknown>;
}

/**
 * The minimum token permissions (verified 2026-10-10 against
 * https://developers.cloudflare.com/fundamentals/api/reference/permissions/; see docs/cloudflare-token.md).
 */
export const PERMISSIONS = {
  workers: {
    name: "Workers Scripts Edit",
    readName: "Workers Scripts Read",
    editNames: ["Workers Scripts Edit", "Workers Scripts Write"],
    why: "deploy the Worker and set its secrets",
    probe: (api, accountId) => api.request("GET", `/accounts/${accountId}/workers/scripts`),
  },
  d1: {
    name: "D1 Edit",
    readName: "D1 Read",
    editNames: ["D1 Edit", "D1 Write"],
    why: "create the database and apply migrations",
    probe: (api, accountId) => api.request("GET", `/accounts/${accountId}/d1/database?page=1&per_page=10`),
  },
  kv: {
    name: "Workers KV Storage Edit",
    readName: "Workers KV Storage Read",
    editNames: ["Workers KV Storage Edit", "Workers KV Storage Write"],
    why: "create the CACHE namespace",
    probe: (api, accountId) => api.request("GET", `/accounts/${accountId}/storage/kv/namespaces?page=1&per_page=1`),
  },
  r2: {
    name: "Workers R2 Storage Edit",
    readName: "Workers R2 Storage Read",
    editNames: ["Workers R2 Storage Edit", "Workers R2 Storage Write"],
    why: "create the storage bucket (only with storage enabled)",
    probe: (api, accountId) => api.request("GET", `/accounts/${accountId}/r2/buckets?per_page=1`),
  },
} satisfies Record<string, PermissionSpec>;

const addPermission = (p: PermissionSpec) =>
  `Edit the token: add Account > ${p.name} (needed to ${p.why}). See ${TOKEN_DOCS}.`;

/** Account-level resource keys of a token policy (https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/). */
const ACCOUNT_RESOURCE = "com.cloudflare.api.account.";

/**
 * Whether a policy's `resources` grant its (account-scoped) permission groups on `accountId`: a key
 * `com.cloudflare.api.account.<accountId>` or `com.cloudflare.api.account.*` whose value is `"*"`. A nested object
 * value (e.g. `{ "com.cloudflare.api.account.zone.*": "*" }`) selects zones inside the account, not the account
 * itself, so it does not count. Zone and user keys never cover an account. Cloudflare documents no
 * organization-level resource key for token policies (checked 2026-10-11), so none is recognised.
 */
export function policyCoversAccount(resources: TokenPolicy["resources"], accountId: string): boolean {
  if (!resources || typeof resources !== "object") return false;
  for (const key of [`${ACCOUNT_RESOURCE}${accountId}`, `${ACCOUNT_RESOURCE}*`]) {
    if (resources[key] === "*") return true;
  }
  return false;
}

/**
 * Permission group names the token's policies grant on `accountId` (allow policies covering the account, minus
 * deny policies covering it; Cloudflare evaluates explicit deny before allow).
 */
export function grantedGroupNames(policies: TokenPolicy[], accountId: string): Set<string> {
  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const p of policies) {
    if (!policyCoversAccount(p.resources, accountId)) continue;
    const target = p.effect === "allow" ? allowed : p.effect === "deny" ? denied : undefined;
    if (!target) continue;
    for (const g of p.permission_groups) if (g.name) target.add(g.name);
  }
  for (const name of denied) allowed.delete(name);
  return allowed;
}

/** {@link grantedGroupNames} for the session's token, or `null` if the token cannot read its own policies. */
async function readGrantedNames(session: CloudflareSession): Promise<Set<string> | null> {
  let policies: TokenPolicy[];
  try {
    policies = await session.api.getTokenPolicies(session.token, session.accountId);
  } catch {
    return null; // Needs "API Tokens Read"; deploy tokens normally lack it. Fall back to probing.
  }
  return grantedGroupNames(policies, session.accountId);
}

/**
 * Check one permission. The read-only probe always runs: a refusal (401/403) is `missing` whatever the policy
 * list says. When the token's policies are readable they then tell Edit (`ok`) from Read only (`missing`);
 * otherwise a successful probe is `readable`.
 */
async function checkPermission(
  spec: PermissionSpec,
  session: CloudflareSession,
  granted: Set<string> | null,
  required: boolean,
): Promise<DoctorCheck> {
  const row = (status: CheckStatus, fix = ""): DoctorCheck => ({ check: spec.name, status, required, fix });
  try {
    await spec.probe(session.api, session.accountId);
  } catch (e) {
    if (e instanceof CloudflareApiError && e.isAuthError) return row("missing", addPermission(spec));
    const msg = e instanceof Error ? e.message : String(e);
    return row("missing", `Probe failed: ${msg}`);
  }
  if (granted !== null) {
    if (spec.editNames.some((n) => granted.has(n))) return row("ok");
    if (granted.has(spec.readName)) return row("missing", `Token has only ${spec.readName}. ${addPermission(spec)}`);
    // The probe worked but no recognised policy covers this account (e.g. a resource format Castra does not parse):
    // do not guess Edit either way.
    return row(
      "readable",
      `Read access works, but no token policy recognised by doctor grants ${spec.name} on account ${session.accountId}. Make sure the token has it.`,
    );
  }
  return row("readable", `Read access works; Edit cannot be verified read-only. Make sure the token has ${spec.name}.`);
}

/**
 * Rate-limit bindings `createCastraApp` reads (ADRs 0072, 0078), with the `ratelimits` entry new projects get.
 * A release that adds a binding adds it here and to its upgrade note.
 */
export const RATE_LIMIT_BINDINGS: Readonly<Record<string, string>> = {
  RATE_LIMITER: `{ "name": "RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }`,
  AUTH_RATE_LIMITER: `{ "name": "AUTH_RATE_LIMITER", "namespace_id": "1002", "simple": { "limit": 10, "period": 60 } }`,
};

/**
 * Every `@castra-kit/*` dependency of the project is installed at one version (ADR 0079). `null` without a
 * package.json or Castra dependencies.
 */
export async function packageCheck(projectDir: string): Promise<DoctorCheck | null> {
  let deps: string[];
  try {
    const pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    deps = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])]
      .filter((d) => d.startsWith("@castra-kit/"))
      .sort();
  } catch {
    return null;
  }
  if (deps.length === 0) return null;
  const versions = new Map<string, string | undefined>();
  for (const d of deps) {
    try {
      versions.set(d, (JSON.parse(await readFile(join(projectDir, "node_modules", d, "package.json"), "utf8")) as { version?: string }).version);
    } catch {
      versions.set(d, undefined);
    }
  }
  const missing = deps.filter((d) => versions.get(d) === undefined);
  if (missing.length > 0) {
    return { check: "Castra packages", status: "warn", required: false, fix: `Not installed: ${missing.join(", ")}. Run your package manager's install.` };
  }
  const distinct = [...new Set(versions.values())] as string[];
  if (distinct.length === 1) return { check: `Castra packages (${distinct[0]})`, status: "ok", required: true, fix: "" };
  const newest = distinct.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]!;
  return {
    check: "Castra packages",
    status: "missing",
    required: true,
    fix: `Mixed versions (${deps.map((d) => `${d}@${versions.get(d)}`).join(", ")}). Align them: \`pnpm add ${deps.map((d) => `${d}@${newest}`).join(" ")}\` (or npm install).`,
  };
}

function bindingChecks(config: WranglerConfig, storage: boolean): DoctorCheck[] {
  const fix = "Run `castra provision`.";
  const rows: DoctorCheck[] = [];
  for (const d of config.d1) {
    rows.push({
      check: `D1 binding ${d.binding}`,
      status: isPlaceholderId(d.databaseId) ? "warn" : "ok",
      required: false,
      fix: isPlaceholderId(d.databaseId) ? `database_id is a placeholder. ${fix}` : "",
    });
  }
  const kv = config.kv.find((k) => k.binding === KV_BINDING);
  rows.push({
    check: `KV binding ${KV_BINDING}`,
    status: kv && !isPlaceholderId(kv.id) ? "ok" : "warn",
    required: false,
    fix: kv && !isPlaceholderId(kv.id) ? "" : `${kv ? "id is a placeholder" : "binding missing"}. ${fix}`,
  });
  if (storage) {
    rows.push({
      check: "R2 binding",
      status: config.r2.some((r) => r.bucketName) ? "ok" : "warn",
      required: false,
      fix: config.r2.some((r) => r.bucketName) ? "" : `No r2_buckets entry. Run \`castra provision --storage\`.`,
    });
  }
  for (const [name, entry] of Object.entries(RATE_LIMIT_BINDINGS)) {
    const present = config.ratelimits.includes(name);
    rows.push({
      check: `Rate limit binding ${name}`,
      status: present ? "ok" : "warn",
      required: false,
      fix: present ? "" : `Not in ratelimits, so this limit is off. Add ${entry} (docs/rate-limiting.md).`,
    });
  }
  return rows;
}

/** Render rows as an aligned text table. */
export function formatTable(rows: DoctorCheck[]): string[] {
  const header = ["Check", "Status", "How to fix"];
  const cells = rows.map((r) => [r.check, r.required || r.status === "ok" ? r.status : `${r.status} (optional)`, r.fix || "-"]);
  const widths = [0, 1].map((i) => Math.max(header[i]!.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => `${c[0]!.padEnd(widths[0]!)}  ${c[1]!.padEnd(widths[1]!)}  ${c[2]}`.trimEnd();
  return [line(header), line(header.map((h, i) => "-".repeat(i < 2 ? widths[i]! : h.length))), ...cells.map(line)];
}

/**
 * `castra doctor`: verify the API token and its permissions (read-only probes; nothing is created), that the
 * wrangler bindings are provisioned, that the `@castra-kit/*` packages share one version, and that the committed
 * schema snapshot matches the local D1 (if it exists) or, with `remote`, the deployed one. The MCP tool
 * `deploy_status` runs this same function (ADR 0079).
 *
 * @returns code 1 when the token is missing/invalid, a required permission is missing, the packages have mixed
 * versions, or the snapshot drifted.
 */
export async function doctor(options: DoctorOptions, deps: DoctorDeps): Promise<DoctorResult> {
  const configPath = resolve(options.cwd, options.config);
  const checks: DoctorCheck[] = [];
  let config: WranglerConfig | undefined;
  try {
    config = readWranglerConfig(await readFile(configPath, "utf8"));
    checks.push({ check: "wrangler config", status: "ok", required: true, fix: "" });
  } catch (e) {
    checks.push({
      check: "wrangler config",
      status: "missing",
      required: true,
      fix: e instanceof Error ? e.message : String(e),
    });
  }
  const storage = Boolean(options.storage) || (config?.r2.length ?? 0) > 0;

  let session: CloudflareSession | undefined;
  try {
    session = await connect({ env: deps.env, fetch: deps.fetch, accountId: options.accountId });
    checks.push({ check: `API token (${session.token.kind} token)`, status: "ok", required: true, fix: "" });
    checks.push({ check: `Account ${session.accountId}`, status: "ok", required: true, fix: "" });
  } catch (e) {
    if (!(e instanceof ProblemError)) throw e;
    checks.push({ check: "API token / account", status: "missing", required: true, fix: `${e.title}. ${e.fix}` });
  }

  if (session) {
    const granted = await readGrantedNames(session);
    checks.push(await checkPermission(PERMISSIONS.workers, session, granted, true));
    checks.push(await checkPermission(PERMISSIONS.d1, session, granted, true));
    checks.push(await checkPermission(PERMISSIONS.kv, session, granted, true));
    if (storage) checks.push(await checkPermission(PERMISSIONS.r2, session, granted, true));
  } else {
    for (const p of [PERMISSIONS.workers, PERMISSIONS.d1, PERMISSIONS.kv, ...(storage ? [PERMISSIONS.r2] : [])]) {
      checks.push({ check: p.name, status: "skipped", required: true, fix: "Fix the token first." });
    }
  }

  if (config) checks.push(...bindingChecks(config, storage));
  const packages = await packageCheck(dirname(configPath));
  if (packages) checks.push(packages);

  // Drift: the deployed D1 with `remote`, else the local one when its state exists (`castra migrate --local`).
  const drift: string[] = [];
  const where = options.remote ? "remote D1" : "local D1";
  const d1 = config?.d1[0];
  let skip: string | undefined;
  if (!d1) skip = "No d1_databases entry.";
  else if (options.remote && !session) skip = "Fix the token first.";
  else if (options.remote && isPlaceholderId(d1.databaseId)) skip = "Not provisioned yet; run `castra provision`.";
  else if (!options.remote && !existsSync(join(dirname(configPath), ".wrangler", "state", "v3", "d1"))) {
    skip = "No local D1 yet; run `castra migrate --local`.";
  }
  if (skip || !d1) {
    checks.push({ check: `Schema snapshot (${where})`, status: "skipped", required: false, fix: skip ?? "" });
  } else {
    const openDatabase = options.remote ? remoteD1Opener(session!.api, session!.accountId) : deps.openDatabase;
    const code = await generate(
      {
        cwd: options.cwd,
        config: options.config,
        out: options.out ?? "castra",
        check: true,
        binding: d1.binding,
        ...(options.remote ? { source: "deployed database" } : {}),
      },
      { openDatabase, log: () => {}, error: (l) => drift.push(l) },
    );
    checks.push({
      check: `Schema snapshot (${where})`,
      status: code === 0 ? "ok" : "missing",
      required: true,
      fix:
        code === 0
          ? ""
          : options.remote
            ? "The deployed D1 differs from castra/. Apply pending migrations (`castra migrate --remote`) or regenerate from the matching database."
            : "Run `castra generate` and commit castra/.",
    });
    for (const l of drift) deps.error(l);
  }

  for (const l of formatTable(checks)) deps.log(l);
  const failing = checks.filter((c) => c.required && c.status === "missing");
  const unverified = checks.filter((c) => c.status === "readable");
  if (unverified.length > 0) {
    deps.log("");
    deps.log(`"readable": the token can read this resource; the Edit level is only verifiable if the token has "API Tokens Read".`);
  }
  if (failing.length > 0) {
    deps.error("");
    deps.error(`Missing: ${failing.map((c) => c.check).join(", ")}`);
    return { code: 1, checks, drift };
  }
  deps.log("");
  deps.log("All required checks passed.");
  return { code: 0, checks, drift };
}
