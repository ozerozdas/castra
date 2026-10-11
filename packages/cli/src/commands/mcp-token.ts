import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AUDIT_PRUNE_BATCH, insertMcpTokenQuery, mintMcpToken, parseScopes, pruneAuditQuery, revokeMcpTokenQuery } from "@castra-kit/mcp";
import type { OpenDatabaseFn } from "../local-d1.js";
import { CliError, readD1Target, UsageError } from "../wrangler-config.js";

/** Options shared by `castra mcp token create|revoke`. */
export interface McpTokenTarget {
  cwd: string;
  /** Wrangler config path (default `wrangler.jsonc`). */
  config: string;
  binding?: string;
}

/** Options of {@link createMcpTokenCommand}. */
export interface CreateMcpTokenOptions extends McpTokenTarget {
  user: string;
  /** Space- or comma-separated scopes. */
  scopes: string;
  name?: string;
  /** Lifetime in days; omitted = no expiry. */
  expiresInDays?: number;
}

/** Side effects: which database to open (local or remote) and where to print. */
export interface McpTokenDeps {
  openDatabase: OpenDatabaseFn;
  log: (line: string) => void;
  error: (line: string) => void;
}

async function open(options: McpTokenTarget, deps: McpTokenDeps) {
  const configPath = resolve(options.cwd, options.config);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new CliError(`Cannot read wrangler config at ${configPath}.`);
  }
  return deps.openDatabase(configPath, readD1Target(text, options.binding).binding);
}

/**
 * Mints an MCP token for an existing user and prints it ONCE (only its SHA-256 hash is stored).
 * Scopes: `schema:read`, `access:check`, `data:read`, `data:read:any_user`.
 */
export async function createMcpTokenCommand(options: CreateMcpTokenOptions, deps: McpTokenDeps): Promise<number> {
  let scopes;
  try {
    scopes = parseScopes(options.scopes.replaceAll(",", " "));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (options.expiresInDays !== undefined && !(options.expiresInDays > 0)) throw new UsageError("--expires-in must be a positive number of days.");
  const expiresAt = options.expiresInDays === undefined ? undefined : new Date(Date.now() + options.expiresInDays * 86_400_000);

  const db = await open(options, deps);
  try {
    const user = await db.query(`SELECT id FROM "user" WHERE id = ?`, [options.user]);
    if (user.length === 0) {
      deps.error(`error: no user with id "${options.user}".`);
      return 1;
    }
    const minted = await mintMcpToken({ userId: options.user, scopes, name: options.name, expiresAt });
    const insert = insertMcpTokenQuery(minted.row);
    await db.query(insert.sql, [...insert.parameters]);
    deps.error(`Created MCP token ${minted.id} for user ${options.user} (scopes: ${minted.scopes.join(" ")}${expiresAt ? `, expires ${expiresAt.toISOString()}` : ""}).`);
    deps.error("Store it now; it is not shown again.");
    deps.log(minted.token);
    return 0;
  } finally {
    await db.close();
  }
}

/** Revokes an MCP token by id. Exit 1 when no active token has that id. */
export async function revokeMcpTokenCommand(options: McpTokenTarget & { id: string }, deps: McpTokenDeps): Promise<number> {
  const db = await open(options, deps);
  try {
    const q = revokeMcpTokenQuery(options.id);
    const rows = await db.query(q.sql, [...q.parameters]);
    if (rows.length === 0) {
      deps.error(`error: no active MCP token with id "${options.id}".`);
      return 1;
    }
    deps.log(`Revoked MCP token ${options.id}.`);
    return 0;
  } finally {
    await db.close();
  }
}

/**
 * Deletes `_castra_audit` rows older than `olderThanDays` days, in batches of {@link AUDIT_PRUNE_BATCH}, and prints
 * how many were removed. The audit table has no automatic retention (ADR 0070).
 */
export async function pruneMcpAuditCommand(
  options: McpTokenTarget & { olderThanDays: number; now?: Date },
  deps: McpTokenDeps,
): Promise<number> {
  if (!Number.isInteger(options.olderThanDays) || options.olderThanDays < 1) {
    throw new UsageError("--older-than must be a whole number of days, at least 1.");
  }
  const before = new Date((options.now ?? new Date()).getTime() - options.olderThanDays * 86_400_000);
  const db = await open(options, deps);
  try {
    const q = pruneAuditQuery(before);
    let deleted = 0;
    for (;;) {
      const rows = await db.query(q.sql, [...q.parameters]);
      deleted += rows.length;
      if (rows.length < AUDIT_PRUNE_BATCH) break;
    }
    deps.log(`Deleted ${deleted} audit row${deleted === 1 ? "" : "s"} older than ${before.toISOString()}.`);
    return 0;
  } finally {
    await db.close();
  }
}
