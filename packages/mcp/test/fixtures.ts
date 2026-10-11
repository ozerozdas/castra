import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authenticated, defineConfig, introspect, isPublic, owner, role, type SchemaSnapshot } from "@castra-kit/core";
import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { createCastraMcpServer, type ToolAccess } from "../src/index.js";

/**
 * Minimal Castra database: Better Auth `user`, `_castra_roles`, the MCP tables exactly as in
 * examples/blog/migrations/0003_mcp.sql, an app table with a hidden and a role-gated column, and a
 * table without a policy.
 */
export const DDL = [
  `CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS _castra_roles (user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE, role TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), PRIMARY KEY (user_id, role))`,
  `CREATE TABLE IF NOT EXISTS _castra_mcp_tokens (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
     name TEXT, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), expires_at TEXT, revoked_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS _castra_audit (id TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     token_id TEXT, user_id TEXT, tool TEXT, arguments TEXT, outcome TEXT NOT NULL, status INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES "user" (id), title TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'draft', secret_hash TEXT, staff_note TEXT)`,
  `CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY NOT NULL, msg TEXT)`,
];

export const config = defineConfig({
  database: "d1",
  roles: ["admin", "member"],
  tables: {
    notes: {
      read: isPublic()
        .where((q) => q.eb("status", "=", "published"))
        .or(owner("owner_id"))
        .or(role("admin")),
      create: authenticated(),
      update: owner("owner_id"),
      delete: role("admin"),
      fields: { secret_hash: { hidden: true }, staff_note: { visibleTo: ["admin"] } },
    },
  },
});

export const USERS = { alice: "u-alice", bob: "u-bob", admin: "u-admin" } as const;
export const NOTES = { alicePub: "n-1", aliceDraft: "n-2", bobPub: "n-3" } as const;
export const SECRET = "s3cr3t-hash-value";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function testDb(): Kysely<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Kysely<any>({ dialect: new D1Dialect({ database: env.DB }) });
}

let ready: Promise<SchemaSnapshot> | undefined;

/** Creates the tables and seed rows once per test file and returns the introspected snapshot. */
export function setup(): Promise<SchemaSnapshot> {
  ready ??= (async () => {
    for (const s of DDL) await env.DB.prepare(s).run();
    const u = env.DB.prepare(`INSERT OR IGNORE INTO "user" (id, name, email) VALUES (?, ?, ?)`);
    const n = env.DB.prepare(`INSERT OR IGNORE INTO notes (id, owner_id, title, status, secret_hash, staff_note) VALUES (?, ?, ?, ?, ?, ?)`);
    await env.DB.batch([
      u.bind(USERS.alice, "Alice", "alice@example.com"),
      u.bind(USERS.bob, "Bob", "bob@example.com"),
      u.bind(USERS.admin, "Admin", "admin@example.com"),
      env.DB.prepare(`INSERT OR IGNORE INTO _castra_roles (user_id, role) VALUES (?, 'admin')`).bind(USERS.admin),
      n.bind(NOTES.alicePub, USERS.alice, "Alice public", "published", SECRET, "staff only"),
      n.bind(NOTES.aliceDraft, USERS.alice, "Alice draft", "draft", SECRET, null),
      n.bind(NOTES.bobPub, USERS.bob, "Bob public", "published", SECRET, null),
    ]);
    return introspect(async (sql, params = []) => (await env.DB.prepare(sql).bind(...params).all()).results as Record<string, unknown>[]);
  })();
  return ready;
}

const noValidation = { getValidator: () => () => ({ valid: false as const, data: undefined, errorMessage: "unsupported" }) };

/** An MCP client connected in memory to a server with the shared tools. */
export async function connect(snapshot: SchemaSnapshot, access: ToolAccess): Promise<Client> {
  const server = createCastraMcpServer({ config, snapshot, db: testDb(), access });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" }, { jsonSchemaValidator: noValidation });
  await client.connect(clientSide);
  return client;
}

/** Calls a tool and returns `isError` + structured content. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: r.isError === true, data: r.structuredContent as any, text: JSON.stringify(r.content) };
}

export async function count(table: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return r!.n;
}
