import { createAuthDb, type AuthDbInput } from "./db.js";
import { sha256Hex, timingSafeEqual, toHex } from "./hash.js";
import { assertKnownRoles } from "./roles.js";

export { sha256Hex, timingSafeEqual } from "./hash.js";

/** Every Castra API key starts with this prefix. */
export const API_KEY_PREFIX = "castra_ak_";

const ID_HEX_LENGTH = 16; // 8 random bytes, public lookup id
const SECRET_BYTES = 32;
const KEY_PATTERN = /^castra_ak_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

/** Input for {@link createApiKey}. */
export interface CreateApiKeyInput {
  /** Owner of the key; the key acts as this user. */
  userId: string;
  /** Human-readable label. */
  name?: string;
  /**
   * Optional role subset. The key never grants more than the user currently holds; `undefined`
   * means "whatever roles the user has". An empty array means "no roles".
   */
  roles?: string[];
  /** Optional expiry. */
  expiresAt?: Date;
}

/** Result of {@link createApiKey}. `key` is shown once and never stored. */
export interface CreatedApiKey {
  id: string;
  key: string;
}

/** A verified API key. */
export interface VerifiedApiKey {
  id: string;
  userId: string;
  /** Role subset stored on the key, or `null` for "all of the user's roles". */
  roles: string[] | null;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Splits a well-formed key into its public id, or returns `null` for anything malformed. */
export function parseApiKey(key: string): { id: string } | null {
  const match = KEY_PATTERN.exec(key);
  return match ? { id: match[1]! } : null;
}

/**
 * Creates an API key for a user. Only the SHA-256 hash is stored. Roles must be in `allowedRoles`.
 */
export async function createApiKey(
  database: AuthDbInput,
  input: CreateApiKeyInput,
  allowedRoles: readonly string[],
): Promise<CreatedApiKey> {
  if (input.roles) assertKnownRoles(input.roles, allowedRoles);
  const id = toHex(crypto.getRandomValues(new Uint8Array(ID_HEX_LENGTH / 2)));
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  const key = `${API_KEY_PREFIX}${id}_${secret}`;
  await createAuthDb(database)
    .insertInto("_castra_api_keys")
    .values({
      id,
      user_id: input.userId,
      name: input.name ?? null,
      key_hash: await sha256Hex(key),
      roles: input.roles ? JSON.stringify([...new Set(input.roles)]) : null,
      expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      revoked_at: null,
      created_at: new Date().toISOString(),
    })
    .execute();
  return { id, key };
}

/** Revokes a key immediately. Returns `true` when an active key was revoked. */
export async function revokeApiKey(database: AuthDbInput, id: string): Promise<boolean> {
  const result = await createAuthDb(database)
    .updateTable("_castra_api_keys")
    .set({ revoked_at: new Date().toISOString() })
    .where("id", "=", id)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

function parseRoles(raw: string | null): string[] | null | undefined {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((r) => typeof r === "string")) return parsed;
  } catch {
    // fall through
  }
  return undefined; // corrupt: treat the key as invalid
}

/**
 * Verifies a plaintext API key against D1. Returns `null` when the key is malformed, unknown,
 * revoked, expired or corrupt. The hash comparison is constant-time.
 */
export async function verifyApiKey(
  database: AuthDbInput,
  key: string,
  now: Date = new Date(),
): Promise<VerifiedApiKey | null> {
  const parsed = parseApiKey(key);
  if (!parsed) return null;
  const row = await createAuthDb(database)
    .selectFrom("_castra_api_keys")
    .select(["id", "user_id", "key_hash", "roles", "expires_at", "revoked_at"])
    .where("id", "=", parsed.id)
    .executeTakeFirst();
  const hash = await sha256Hex(key);
  // Compare even when no row exists so timing does not reveal whether the id is known.
  const matches = timingSafeEqual(hash, row?.key_hash ?? "0".repeat(64));
  if (!row || !matches) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null) {
    const expires = Date.parse(row.expires_at);
    if (Number.isNaN(expires) || expires <= now.getTime()) return null;
  }
  const roles = parseRoles(row.roles);
  if (roles === undefined) return null;
  return { id: row.id, userId: row.user_id, roles };
}
