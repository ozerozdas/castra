/**
 * Write tools (ADR 0081): allow and deny for every rule type, through the local (stdio) access and the remote
 * `/mcp` handler, on real D1. Both go through the REST write path, so the outcomes match REST.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authenticated, custom, defineConfig, introspect, isPublic, owner, role, type SchemaSnapshot, type WhereArgs } from "@castra-kit/core";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createCastraMcpServer, createMcpToken, handleMcpRequest, localAccess, mcpDb, type D1Like } from "../src/index.js";
import { DDL, testDb, USERS } from "./fixtures.js";

const KINDS = ["public", "auth", "role", "owner", "custom", "where", "and", "or"] as const;
type Kind = (typeof KINDS)[number];

const notBad = custom("not_bad", (eb) => eb("title", "!=", "bad"));
const open = (q: WhereArgs) => q.eb("status", "=", "open");
const RULES = {
  public: { create: isPublic(), update: isPublic(), delete: undefined },
  auth: { create: authenticated(), update: authenticated(), delete: authenticated() },
  role: { create: role("admin"), update: role("admin"), delete: role("admin") },
  owner: { create: authenticated(), update: owner("owner_id"), delete: owner("owner_id") },
  custom: { create: notBad, update: notBad, delete: notBad },
  where: { create: authenticated().where(open), update: authenticated().where(open), delete: authenticated().where(open) },
  and: { create: role("admin").and(notBad), update: role("admin").and(notBad), delete: role("admin").and(notBad) },
  or: { create: role("admin").or(isPublic().where(open)), update: role("admin").or(isPublic().where(open)), delete: role("admin").or(isPublic().where(open)) },
} as const;

const config = defineConfig({
  database: "d1",
  roles: ["admin", "member"],
  tables: Object.fromEntries(
    KINDS.map((k) => {
      const r = RULES[k];
      return [`w_${k}`, { read: isPublic(), create: r.create, update: r.update, ...(r.delete ? { delete: r.delete } : {}) }];
    }),
  ),
});

let snapshot: SchemaSnapshot;
beforeAll(async () => {
  for (const s of DDL) await env.DB.prepare(s).run();
  const u = env.DB.prepare(`INSERT OR IGNORE INTO "user" (id, name, email) VALUES (?, ?, ?)`);
  await env.DB.batch([
    u.bind(USERS.alice, "Alice", "alice@example.com"),
    u.bind(USERS.bob, "Bob", "bob@example.com"),
    u.bind(USERS.admin, "Admin", "admin@example.com"),
    env.DB.prepare(`INSERT OR IGNORE INTO _castra_roles (user_id, role) VALUES (?, 'admin')`).bind(USERS.admin),
  ]);
  for (const k of KINDS) {
    const owned = k === "owner" ? "owner_id TEXT NOT NULL, " : "";
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS w_${k} (id TEXT PRIMARY KEY NOT NULL, ${owned}title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open')`).run();
  }
  snapshot = await introspect(async (sql, params = []) => (await env.DB.prepare(sql).bind(...params).all()).results as Record<string, unknown>[]);
});

type Who = "anonymous" | keyof typeof USERS;
type Call = (who: Who, tool: string, args: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

const noValidation = { getValidator: () => () => ({ valid: false as const, data: undefined, errorMessage: "unsupported" }) };

/** Local (stdio) access: any identity via `as`. */
async function localCaller(): Promise<Call> {
  const server = createCastraMcpServer({ config, snapshot, db: testDb(), d1: env.DB, access: localAccess(mcpDb(testDb()), config) });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" }, { jsonSchemaValidator: noValidation });
  await client.connect(clientSide);
  return async (who, tool, args) => {
    const as = who === "anonymous" ? "anonymous" : { userId: USERS[who] };
    const r = await client.callTool({ name: tool, arguments: { ...args, as } });
    return r.structuredContent as { status: number; body: unknown };
  };
}

/** Remote `/mcp`: the caller is the token's own user (anonymous has no token, so no remote case). */
async function remoteCaller(): Promise<Call> {
  const tokens: Partial<Record<Who, string>> = {};
  for (const who of ["alice", "bob", "admin"] as const) tokens[who] = (await createMcpToken(env.DB, { userId: USERS[who], scopes: "data:write" })).token;
  let id = 0;
  return async (who, tool, args) => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    const res = await handleMcpRequest(req, env.DB, { config, snapshot });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: { structuredContent: { status: number; body: unknown } } }).result.structuredContent;
  };
}

async function row(table: string, id: string) {
  return env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>();
}

/** One allow and one deny per op and rule type. `seed` rows are inserted before the case (id, title, status). */
interface Case {
  kind: Kind;
  who: Who;
  op: "create" | "update" | "delete";
  seed?: { title?: string; status?: string; owner_id?: string };
  body?: Record<string, unknown>;
  status: number;
}

const CASES: Case[] = [
  // public: anyone; no delete policy, so delete is a 404 like an unknown table.
  { kind: "public", who: "anonymous", op: "create", body: { title: "t" }, status: 201 },
  { kind: "public", who: "alice", op: "update", seed: {}, body: { title: "u" }, status: 200 },
  { kind: "public", who: "alice", op: "delete", seed: {}, status: 404 },
  // authenticated
  { kind: "auth", who: "alice", op: "create", body: { title: "t" }, status: 201 },
  { kind: "auth", who: "anonymous", op: "create", body: { title: "t" }, status: 401 },
  { kind: "auth", who: "alice", op: "update", seed: {}, body: { title: "u" }, status: 200 },
  { kind: "auth", who: "anonymous", op: "update", seed: {}, body: { title: "u" }, status: 401 },
  { kind: "auth", who: "alice", op: "delete", seed: {}, status: 204 },
  { kind: "auth", who: "anonymous", op: "delete", seed: {}, status: 401 },
  // role
  { kind: "role", who: "admin", op: "create", body: { title: "t" }, status: 201 },
  { kind: "role", who: "alice", op: "create", body: { title: "t" }, status: 403 },
  { kind: "role", who: "admin", op: "update", seed: {}, body: { title: "u" }, status: 200 },
  { kind: "role", who: "alice", op: "update", seed: {}, body: { title: "u" }, status: 403 },
  { kind: "role", who: "admin", op: "delete", seed: {}, status: 204 },
  { kind: "role", who: "alice", op: "delete", seed: {}, status: 403 },
  // owner: rows of someone else are not found for update/delete
  { kind: "owner", who: "alice", op: "update", seed: { owner_id: USERS.alice }, body: { title: "u" }, status: 200 },
  { kind: "owner", who: "bob", op: "update", seed: { owner_id: USERS.alice }, body: { title: "u" }, status: 404 },
  { kind: "owner", who: "alice", op: "delete", seed: { owner_id: USERS.alice }, status: 204 },
  { kind: "owner", who: "bob", op: "delete", seed: { owner_id: USERS.alice }, status: 404 },
  // custom: compiled into the write guard and the row filter
  { kind: "custom", who: "alice", op: "create", body: { title: "good" }, status: 201 },
  { kind: "custom", who: "alice", op: "create", body: { title: "bad" }, status: 403 },
  { kind: "custom", who: "alice", op: "update", seed: {}, body: { title: "bad" }, status: 403 },
  { kind: "custom", who: "alice", op: "delete", seed: { title: "bad" }, status: 404 },
  { kind: "custom", who: "alice", op: "delete", seed: {}, status: 204 },
  // where
  { kind: "where", who: "alice", op: "create", body: { title: "t", status: "open" }, status: 201 },
  { kind: "where", who: "alice", op: "create", body: { title: "t", status: "closed" }, status: 403 },
  { kind: "where", who: "alice", op: "update", seed: {}, body: { status: "closed" }, status: 403 },
  { kind: "where", who: "alice", op: "update", seed: { status: "closed" }, body: { title: "u" }, status: 404 },
  { kind: "where", who: "alice", op: "delete", seed: {}, status: 204 },
  { kind: "where", who: "alice", op: "delete", seed: { status: "closed" }, status: 404 },
  // and: both sides must hold
  { kind: "and", who: "admin", op: "create", body: { title: "good" }, status: 201 },
  { kind: "and", who: "admin", op: "create", body: { title: "bad" }, status: 403 },
  { kind: "and", who: "alice", op: "create", body: { title: "good" }, status: 403 },
  { kind: "and", who: "admin", op: "delete", seed: {}, status: 204 },
  { kind: "and", who: "admin", op: "delete", seed: { title: "bad" }, status: 404 },
  // or: either side
  { kind: "or", who: "alice", op: "create", body: { title: "t", status: "open" }, status: 201 },
  { kind: "or", who: "admin", op: "create", body: { title: "t", status: "closed" }, status: 201 },
  { kind: "or", who: "alice", op: "create", body: { title: "t", status: "closed" }, status: 403 },
  { kind: "or", who: "alice", op: "update", seed: { status: "closed" }, body: { title: "u" }, status: 404 },
  { kind: "or", who: "admin", op: "update", seed: { status: "closed" }, body: { title: "u" }, status: 200 },
];

const TOOL = { create: "create_data", update: "update_data", delete: "delete_data" } as const;
let seq = 0;
const seqRowid: Record<string, number> = {};

/** Runs one case and checks both the answer and the database. */
async function runCase(call: Call, c: Case) {
  const table = `w_${c.kind}`;
  let id = `r${++seq}`;
  if (c.seed) {
    const s = { title: "t", status: "open", ...c.seed };
    const cols = ["id", ...Object.keys(s)];
    await env.DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(id, ...Object.values(s)).run();
  }
  const before = c.seed ? await row(table, id) : null;
  seqRowid[table] = Number(await env.DB.prepare(`SELECT coalesce(max(rowid), 0) AS m FROM ${table}`).first("m"));
  const path = c.op === "create" ? `/api/${table}` : `/api/${table}/${id}`;
  // Primary keys are server-generated: a create reports its id in the body.
  const r = await call(c.who, TOOL[c.op], c.op === "delete" ? { path } : { path, body: c.body });
  if (c.op === "create") {
    if (r.status !== 201) {
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE title = ? AND rowid > ?`).bind(String(c.body!.title), seqRowid[table] ?? 0).first("n")).toBe(0);
    }
    id = (r.body as { id?: string }).id ?? id;
  }
  const label = `${c.who} ${c.op} ${table} ${JSON.stringify(c.seed ?? c.body)}`;
  expect(r.status, `${label} ${JSON.stringify(r.body)}`).toBe(c.status);
  const after = await row(table, id);
  if (c.status >= 400) {
    expect(after, `${label}: unchanged`).toEqual(before);
  } else if (c.op === "delete") {
    expect(after).toBeNull();
  } else {
    expect(after).toMatchObject(c.body!);
  }
}

describe("write tools: allow and deny per rule type", () => {
  it("local (stdio) access", async () => {
    const call = await localCaller();
    for (const c of CASES) await runCase(call, c);
  });
  it("remote /mcp with data:write (as the token's own user)", async () => {
    const call = await remoteCaller();
    for (const c of CASES.filter((c) => c.who !== "anonymous")) await runCase(call, c);
  });
});

describe("write tools: field rules and audit", () => {
  it("an owner column naming someone else is refused; omitted, it is the caller", async () => {
    const call = await localCaller();
    const r = await call("alice", "create_data", { path: "/api/w_owner", body: { title: "t", owner_id: USERS.bob } });
    expect(r.status).toBe(403);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM w_owner WHERE owner_id = ?").bind(USERS.bob).first("n")).toBe(0);
    const ok = await call("alice", "create_data", { path: "/api/w_owner", body: { title: "t" } });
    expect(ok.status).toBe(201);
    expect((await row("w_owner", (ok.body as { id: string }).id))?.owner_id).toBe(USERS.alice);
  });
  it("remote writes are audited with the tool, arguments and status", async () => {
    const call = await remoteCaller();
    expect((await call("alice", "create_data", { path: "/api/w_auth", body: { title: "aud1" } })).status).toBe(201);
    const audit = await env.DB.prepare("SELECT * FROM _castra_audit ORDER BY rowid DESC LIMIT 1").first<Record<string, unknown>>();
    expect(audit).toMatchObject({ tool: "create_data", user_id: USERS.alice, outcome: "ok", status: 201 });
    expect(JSON.parse(audit!.arguments as string)).toEqual({ path: "/api/w_auth", body: { title: "aud1" } });
  });
  it("remote: the attempt row is stored before the write; if it cannot be, nothing is written", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:write" });
    const send = (d1: D1Like, title: string) =>
      handleMcpRequest(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_data", arguments: { path: "/api/w_auth", body: { title } } } }),
        }),
        d1,
        { config, snapshot },
      );
    expect((await send(env.DB, "att1")).status).toBe(200);
    const rows = await env.DB.prepare("SELECT outcome, status FROM _castra_audit WHERE tool = 'create_data' AND arguments LIKE '%att1%' ORDER BY rowid").all();
    expect(rows.results).toEqual([{ outcome: "attempt", status: 0 }, { outcome: "ok", status: 201 }]);

    const noAudit = {
      prepare: (sql: string) => {
        if (/insert into "_castra_audit"/i.test(sql)) throw new Error("audit down");
        return env.DB.prepare(sql);
      },
      batch: (s: D1PreparedStatement[]) => env.DB.batch(s),
    } as unknown as D1Like;
    const r = await send(noAudit, "att2");
    expect(r.status).toBe(500);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM w_auth WHERE title = 'att2'").first("n")).toBe(0);
  });
  it("without a D1 binding, creates fail closed", async () => {
    const server = createCastraMcpServer({ config, snapshot, db: testDb(), access: localAccess(mcpDb(testDb()), config) });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" }, { jsonSchemaValidator: noValidation });
    await client.connect(clientSide);
    const r = await client.callTool({ name: "create_data", arguments: { path: "/api/w_public", body: { title: "nod1" } } });
    expect((r.structuredContent as { status: number }).status).toBe(500);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM w_public WHERE title = 'nod1'").first("n")).toBe(0);
  });
});
