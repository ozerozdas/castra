import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";
import { D1Dialect } from "kysely-d1";

/** `_castra_mcp_tokens`: hashed remote MCP tokens (migration `0003_mcp.sql`). */
export interface McpTokensTable {
  /** Public lookup id (16 hex chars), also embedded in the token. */
  id: string;
  user_id: string;
  name: string | null;
  /** Lowercase hex SHA-256 of the full plaintext token. */
  token_hash: string;
  /** Space-separated scopes. */
  scopes: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/** `_castra_audit`: one row per remote MCP call. */
export interface AuditTable {
  id: string;
  at: string;
  token_id: string | null;
  user_id: string | null;
  /** Tool name for `tools/call`, otherwise the JSON-RPC method; `null` when the request was not read. */
  tool: string | null;
  /** JSON text of the arguments, at most {@link AUDIT_ARGUMENTS_MAX} characters. */
  arguments: string | null;
  outcome: string;
  status: number;
}

/** Tables the MCP package reads or writes. */
export interface McpDatabase {
  _castra_mcp_tokens: McpTokensTable;
  _castra_audit: AuditTable;
  _castra_roles: { user_id: string; role: string; created_at: string };
  user: { id: string; name: string; email: string };
}

/** Max length of the stored `arguments` JSON. */
export const AUDIT_ARGUMENTS_MAX = 4096;

/** A D1 binding (structural, so the package does not depend on workers types at runtime). */
export type D1Like = ConstructorParameters<typeof D1Dialect>[0]["database"];

/** Kysely over the MCP tables. */
export type McpDb = Kysely<McpDatabase>;

/** Either a D1 binding or an existing Kysely instance. */
export type McpDbInput = D1Like | Kysely<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const cache = new WeakMap<object, McpDb>();

/** Kysely (D1 dialect) for `database`, cached per binding. A Kysely instance is returned as is. */
export function mcpDb(database: McpDbInput): McpDb {
  if (database instanceof Kysely) return database as McpDb;
  let db = cache.get(database);
  if (!db) {
    db = new Kysely<McpDatabase>({ dialect: new D1Dialect({ database }) });
    cache.set(database, db);
  }
  return db;
}

/** Kysely that can only compile (for running the same statements over the D1 HTTP API from the CLI). */
export const compileOnly: McpDb = new Kysely<McpDatabase>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});
