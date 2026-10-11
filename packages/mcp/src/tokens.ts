import { sha256Hex, timingSafeEqual } from "@castra-kit/auth";
import type { CompiledQuery } from "kysely";
import { compileOnly, mcpDb, type McpDbInput, type McpTokensTable } from "./db.js";
import { parseScopes, readStoredScopes, type McpScope } from "./scopes.js";

/** Every remote MCP token starts with this prefix. API keys (`castra_ak_`) are never accepted. */
export const MCP_TOKEN_PREFIX = "castra_mcp_";

const ID_BYTES = 8; // 16 hex chars, public lookup id
const SECRET_BYTES = 32; // 43 base64url chars
const TOKEN_PATTERN = /^castra_mcp_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

/** Input of {@link createMcpToken}. */
export interface CreateMcpTokenInput {
  /** Better Auth user the token acts as. */
  userId: string;
  /** Scopes, as a list or a space-separated string. At least one. */
  scopes: string | readonly string[];
  /** Human-readable label. */
  name?: string;
  /** Optional expiry. */
  expiresAt?: Date;
}

/** Result of {@link createMcpToken}: `token` is shown once and never stored. */
export interface CreatedMcpToken {
  id: string;
  token: string;
  scopes: McpScope[];
}

/** A token that passed {@link verifyMcpToken}. */
export interface VerifiedMcpToken {
  id: string;
  userId: string;
  scopes: McpScope[];
}

/** Why {@link verifyMcpToken} rejected a token. */
export type McpTokenFailure = "missing" | "malformed" | "unknown" | "revoked" | "expired" | "invalid";

/** Outcome of {@link verifyMcpToken}. `tokenId` is set when the presented id matches a stored row. */
export type McpTokenVerification =
  | { ok: true; token: VerifiedMcpToken }
  | { ok: false; reason: McpTokenFailure; tokenId: string | null; userId: string | null };

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Splits a well-formed token into its public id, or returns `null` for anything else. */
export function parseMcpToken(token: string): { id: string } | null {
  const match = TOKEN_PATTERN.exec(token);
  return match ? { id: match[1]! } : null;
}

/**
 * Generates a new token and the row to store (only the SHA-256 hash of the token is stored).
 * Pure apart from randomness; used by {@link createMcpToken} and by the CLI for remote databases.
 */
export async function mintMcpToken(
  input: CreateMcpTokenInput,
  now: Date = new Date(),
): Promise<{ id: string; token: string; scopes: McpScope[]; row: McpTokensTable }> {
  if (typeof input.userId !== "string" || input.userId.length === 0) throw new Error("userId is required");
  const scopes = parseScopes(input.scopes);
  if (input.expiresAt !== undefined && !(input.expiresAt instanceof Date && !Number.isNaN(input.expiresAt.getTime()))) {
    throw new Error("expiresAt must be a valid Date");
  }
  const id = toHex(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  const token = `${MCP_TOKEN_PREFIX}${id}_${secret}`;
  const row: McpTokensTable = {
    id,
    user_id: input.userId,
    name: input.name ?? null,
    token_hash: await sha256Hex(token),
    scopes: scopes.join(" "),
    created_at: now.toISOString(),
    expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
    revoked_at: null,
  };
  return { id, token, scopes, row };
}

/** The compiled `INSERT` for a minted row (Kysely; for executors that only take SQL + params). */
export function insertMcpTokenQuery(row: McpTokensTable): CompiledQuery {
  return compileOnly.insertInto("_castra_mcp_tokens").values(row).compile();
}

/** The compiled revoke `UPDATE ... RETURNING id`; a returned row means an active token was revoked. */
export function revokeMcpTokenQuery(id: string, now: Date = new Date()): CompiledQuery {
  return compileOnly
    .updateTable("_castra_mcp_tokens")
    .set({ revoked_at: now.toISOString() })
    .where("id", "=", id)
    .where("revoked_at", "is", null)
    .returning("id")
    .compile();
}

/**
 * Creates a remote MCP token for a user. Returns the plaintext token once; only its SHA-256 hash is
 * stored. The user must exist in the Better Auth `user` table (foreign key, `ON DELETE CASCADE`).
 */
export async function createMcpToken(database: McpDbInput, input: CreateMcpTokenInput): Promise<CreatedMcpToken> {
  const minted = await mintMcpToken(input);
  await mcpDb(database).insertInto("_castra_mcp_tokens").values(minted.row).execute();
  return { id: minted.id, token: minted.token, scopes: minted.scopes };
}

/** Revokes a token immediately. Returns `true` when an active token was revoked. */
export async function revokeMcpToken(database: McpDbInput, id: string, now: Date = new Date()): Promise<boolean> {
  const result = await mcpDb(database)
    .updateTable("_castra_mcp_tokens")
    .set({ revoked_at: now.toISOString() })
    .where("id", "=", id)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/**
 * Verifies a plaintext MCP token against D1: strict format, lookup by id, constant-time hash
 * comparison (also when the id is unknown), then revoked / expiry / scope checks.
 */
export async function verifyMcpToken(
  database: McpDbInput,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<McpTokenVerification> {
  if (!token) return { ok: false, reason: "missing", tokenId: null, userId: null };
  const parsed = parseMcpToken(token);
  if (!parsed) return { ok: false, reason: "malformed", tokenId: null, userId: null };
  const row = await mcpDb(database)
    .selectFrom("_castra_mcp_tokens")
    .select(["id", "user_id", "token_hash", "scopes", "expires_at", "revoked_at"])
    .where("id", "=", parsed.id)
    .executeTakeFirst();
  const hash = await sha256Hex(token);
  // Compare even when no row exists so timing does not reveal whether the id is known.
  const matches = timingSafeEqual(hash, row?.token_hash ?? "0".repeat(64));
  if (!row) return { ok: false, reason: "unknown", tokenId: null, userId: null };
  const known = { tokenId: row.id, userId: row.user_id };
  if (!matches) return { ok: false, reason: "invalid", ...known };
  if (row.revoked_at !== null) return { ok: false, reason: "revoked", ...known };
  if (row.expires_at !== null) {
    const expires = Date.parse(row.expires_at);
    if (Number.isNaN(expires) || expires <= now.getTime()) return { ok: false, reason: "expired", ...known };
  }
  const scopes = readStoredScopes(row.scopes);
  if (!scopes) return { ok: false, reason: "invalid", ...known };
  return { ok: true, token: { id: row.id, userId: row.user_id, scopes } };
}
