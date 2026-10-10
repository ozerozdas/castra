import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

/** Better Auth `user` table (read-only for Castra; Better Auth owns writes). */
export interface BetterAuthUserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `_castra_roles`: role grants tied to the Better Auth user. */
export interface CastraRolesTable {
  user_id: string;
  role: string;
  created_at: string;
}

/** `_castra_api_keys`: hashed API keys. The plaintext key is never stored. */
export interface CastraApiKeysTable {
  id: string;
  user_id: string;
  name: string | null;
  /** Lowercase hex SHA-256 of the full plaintext key. */
  key_hash: string;
  /** JSON array of role names, or `null` for "all of the user's roles". */
  roles: string | null;
  /** ISO 8601 timestamp, or `null` for no expiry. */
  expires_at: string | null;
  /** ISO 8601 timestamp, or `null` while active. */
  revoked_at: string | null;
  created_at: string;
}

/** Public profile mirror of the Better Auth user (the app-facing `users` table). */
export interface UsersMirrorTable {
  id: string;
  email: string;
  name: string | null;
}

/** Tables the auth package reads or writes through Kysely. */
export interface CastraAuthDatabase {
  user: BetterAuthUserTable;
  _castra_roles: CastraRolesTable;
  _castra_api_keys: CastraApiKeysTable;
  users: UsersMirrorTable;
}

/** Kysely instance over the auth tables. */
export type AuthDb = Kysely<CastraAuthDatabase>;

/** Either a raw D1 binding or an existing {@link AuthDb}. */
export type AuthDbInput = D1Database | AuthDb;

const cache = new WeakMap<D1Database, AuthDb>();

/**
 * Returns a Kysely instance (D1 dialect) for the auth tables. Instances are cached per binding.
 */
export function createAuthDb(database: AuthDbInput): AuthDb {
  if (database instanceof Kysely) return database;
  let db = cache.get(database);
  if (!db) {
    db = new Kysely<CastraAuthDatabase>({ dialect: new D1Dialect({ database }) });
    cache.set(database, db);
  }
  return db;
}
