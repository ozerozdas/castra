/**
 * The four shared tools over an in-memory MCP transport with local (unrestricted) access, on real D1.
 * Every tool: allow and deny. Hidden columns and reserved tables never leak.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SchemaSnapshot } from "@castra-kit/core";
import { beforeAll, describe, expect, it } from "vitest";
import { localAccess, mcpDb, parseRestPath, TOOL_NAMES, WRITE_TOOLS } from "../src/index.js";
import { call, config, connect, count, NOTES, SECRET, setup, testDb, USERS } from "./fixtures.js";

let snapshot: SchemaSnapshot;
let client: Client;

beforeAll(async () => {
  snapshot = await setup();
  client = await connect(snapshot, localAccess(mcpDb(testDb()), config));
});

const RESERVED = ["user", "_castra_roles", "_castra_mcp_tokens", "_castra_audit", "logs", "session", "account", "verification"];

describe("tools/list", () => {
  it("lists the shared tools; only the write tools are not read-only", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      const write = (WRITE_TOOLS as readonly string[]).includes(t.name);
      expect(t.annotations?.readOnlyHint).toBe(!write);
      expect(t.annotations?.destructiveHint).toBe(write && t.name !== "create_data");
      expect(t.inputSchema.type).toBe("object");
    }
  });
});

describe("describe_schema", () => {
  it("allow: lists exposed tables with policies, field rules and relations", async () => {
    const r = await call(client, "describe_schema");
    expect(r.isError).toBe(false);
    expect(Object.keys(r.data.tables)).toEqual(["notes"]);
    const notes = r.data.tables.notes;
    expect(notes.policies).toEqual({
      read: "or(and(public, where), owner(owner_id), role(admin))",
      create: "authenticated",
      update: "owner(owner_id)",
      delete: "role(admin)",
    });
    const cols = notes.columns.map((c: { name: string }) => c.name);
    expect(cols).toEqual(["id", "owner_id", "title", "status", "staff_note"]);
    expect(notes.columns.find((c: { name: string }) => c.name === "owner_id").fields).toEqual({ setBy: "server", owner: true });
    expect(notes.columns.find((c: { name: string }) => c.name === "staff_note").fields).toEqual({ visibleTo: ["admin"] });
    expect(r.data.roles).toEqual(["admin", "member"]);
  });
  it("never contains reserved/unconfigured tables or hidden columns", async () => {
    const r = await call(client, "describe_schema");
    for (const t of RESERVED) expect(Object.keys(r.data.tables)).not.toContain(t);
    expect(r.text).not.toContain("secret_hash");
    expect(r.text).not.toMatch(/_castra_|"user"|token_hash/);
  });
  it("deny: an unknown, reserved or unexposed table is the same 404", async () => {
    for (const t of ["nope", "user", "_castra_mcp_tokens", "logs"]) {
      const r = await call(client, "describe_schema", { table: t });
      expect(r.isError).toBe(true);
      expect(r.data).toEqual({ type: "https://castra.mehmetozer.dev/problems/not_found", title: "Not Found", status: 404, detail: "The requested resource does not exist." });
    }
  });
});

describe("check_access", () => {
  it("allow: owner read is conditional with the compiled WHERE and hidden fields", async () => {
    const r = await call(client, "check_access", { table: "notes", op: "read", as: { userId: USERS.alice } });
    expect(r.isError).toBe(false);
    expect(r.data.allowed).toBe("conditional");
    expect(r.data.explanation.matchedRule).toBe("or(and(public, where), owner(owner_id), role(admin))");
    expect(r.data.explanation.where.sql).toContain('"notes"."owner_id" = ?');
    expect(r.data.explanation.where.parameters).toContain(USERS.alice);
    expect(r.data.explanation.hiddenFields).toEqual(expect.arrayContaining(["secret_hash", "staff_note"]));
    expect(r.data.as).toEqual({ userId: USERS.alice, roles: [] });
    expect(r.data.dryRun).toBe(true);
  });
  it("allow: admin roles come from _castra_roles", async () => {
    const r = await call(client, "check_access", { table: "notes", op: "delete", as: { userId: USERS.admin } });
    expect(r.data.allowed).toBe(true);
    expect(r.data.as.roles).toEqual(["admin"]);
  });
  it("deny: anonymous delete and create", async () => {
    expect((await call(client, "check_access", { table: "notes", op: "delete", as: "anonymous" })).data.allowed).toBe(false);
    expect((await call(client, "check_access", { table: "notes", op: "create" })).data.allowed).toBe(false);
  });
  it("row: owner may update own row (allow) but not someone else's (deny)", async () => {
    const own = await call(client, "check_access", { table: "notes", op: "update", as: { userId: USERS.alice }, row: { id: "x", owner_id: USERS.alice, title: "t", status: "draft" } });
    expect(own.data.allowed).toBe(true);
    const other = await call(client, "check_access", { table: "notes", op: "update", as: { userId: USERS.alice }, row: { id: "x", owner_id: USERS.bob, title: "t", status: "draft" } });
    expect(other.data.allowed).toBe(false);
  });
  it("row: create with a spoofed owner is denied (403), a clean create allowed", async () => {
    const spoof = await call(client, "check_access", { table: "notes", op: "create", as: { userId: USERS.alice }, row: { title: "t", owner_id: USERS.bob } });
    expect(spoof.data.allowed).toBe(false);
    expect(spoof.data.status).toBe(403);
    const ok = await call(client, "check_access", { table: "notes", op: "create", as: { userId: USERS.alice }, row: { id: "n-new", title: "t" } });
    expect(ok.data.allowed).toBe(true);
  });
  it("hypothetical roles: explicit roles replace the stored ones; unknown roles are rejected", async () => {
    const r = await call(client, "check_access", { table: "notes", op: "delete", as: { userId: USERS.bob, roles: ["admin"] } });
    expect(r.data.allowed).toBe(true);
    const bad = await call(client, "check_access", { table: "notes", op: "delete", as: { userId: USERS.bob, roles: ["root"] } });
    expect(bad.isError).toBe(true);
    expect(bad.data.status).toBe(400);
  });
  it("closed / reserved tables: a uniform not-exposed decision", async () => {
    for (const table of ["logs", "user", "_castra_audit", "nope"]) {
      const r = await call(client, "check_access", { table, op: "read", as: { userId: USERS.admin } });
      expect(r.data.allowed).toBe(false);
      expect(r.data.explanation).toEqual({ table, op: "read", allowed: false, matchedRule: "none", where: null, hiddenFields: [], reason: `read on "${table}" is not exposed` });
    }
  });
  it("never writes", async () => {
    const before = await count("notes");
    await call(client, "check_access", { table: "notes", op: "create", as: { userId: USERS.alice }, row: { id: "n-x", title: "t" } });
    expect(await count("notes")).toBe(before);
  });
  it("invalid input is refused by the schema", async () => {
    const r = await call(client, "check_access", { table: "notes", op: "drop" });
    expect(r.isError).toBe(true);
  });
});

describe("explain_query", () => {
  it("allow: returns the planned SQL and explanations without executing", async () => {
    const r = await call(client, "explain_query", { method: "GET", path: "/api/notes?status=eq.published", query: { sort: "-title" }, as: { userId: USERS.alice } });
    expect(r.isError).toBe(false);
    expect(r.data.executed).toBe(false);
    expect(r.data.plan.table).toBe("notes");
    expect(r.data.plan.statements[0].name).toBe("list");
    expect(r.data.plan.statements[0].sql).toMatch(/^select /);
    expect(r.data.plan.statements[0].parameters).toEqual(expect.arrayContaining([USERS.alice, "published"]));
    expect(r.data.plan.explanations[0].matchedRule).toContain("owner(owner_id)");
  });
  it("write plans are explained, never executed (row counts unchanged)", async () => {
    const before = await count("notes");
    const post = await call(client, "explain_query", { method: "POST", path: "/api/notes", body: { title: "planned" }, as: { userId: USERS.alice } });
    expect(post.isError).toBe(false);
    expect(post.data.plan.statements.map((s: { name: string }) => s.name)).toContain("insert");
    const patch = await call(client, "explain_query", { method: "PATCH", path: `/api/notes/${NOTES.alicePub}`, body: { title: "changed" }, as: { userId: USERS.alice } });
    expect(patch.isError).toBe(false);
    const del = await call(client, "explain_query", { method: "DELETE", path: `/api/notes/${NOTES.bobPub}`, as: { userId: USERS.admin } });
    expect(del.isError).toBe(false);
    expect(await count("notes")).toBe(before);
    const row = await testDb().selectFrom("notes").select("title").where("id", "=", NOTES.alicePub).executeTakeFirst();
    expect(row?.title).toBe("Alice public");
    expect(await testDb().selectFrom("notes").select("id").where("id", "=", NOTES.bobPub).executeTakeFirst()).toBeDefined();
  });
  it("deny: closed operations and tables are 404, constant-false rules 401/403", async () => {
    expect((await call(client, "explain_query", { method: "GET", path: "/api/logs" })).data.status).toBe(404);
    expect((await call(client, "explain_query", { method: "GET", path: "/api/_castra_mcp_tokens" })).data.status).toBe(404);
    expect((await call(client, "explain_query", { method: "DELETE", path: `/api/notes/${NOTES.bobPub}` })).data.status).toBe(401);
    expect((await call(client, "explain_query", { method: "DELETE", path: `/api/notes/${NOTES.bobPub}`, as: { userId: USERS.alice } })).data.status).toBe(403);
    expect((await call(client, "explain_query", { method: "POST", path: "/api/notes", body: { title: "t", owner_id: USERS.bob }, as: { userId: USERS.alice } })).data.status).toBe(403);
  });
});

describe("query_data", () => {
  it("allow: anonymous sees published notes only, never hidden columns", async () => {
    const r = await call(client, "query_data", { path: "/api/notes" });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe(200);
    expect(r.data.body.data.map((n: { id: string }) => n.id).sort()).toEqual([NOTES.alicePub, NOTES.bobPub]);
    expect(r.text).not.toContain("secret_hash");
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain("staff only");
  });
  it("allow: owner sees own draft, admin sees staff_note", async () => {
    const own = await call(client, "query_data", { path: `/api/notes/${NOTES.aliceDraft}`, as: { userId: USERS.alice } });
    expect(own.data).toMatchObject({ status: 200, body: { id: NOTES.aliceDraft } });
    const admin = await call(client, "query_data", { path: `/api/notes/${NOTES.alicePub}`, as: { userId: USERS.admin } });
    expect(admin.data.body.staff_note).toBe("staff only");
    expect(admin.data.body).not.toHaveProperty("secret_hash");
  });
  it("deny: others get 404 for a draft; filters on hidden columns look like unknown columns", async () => {
    const r = await call(client, "query_data", { path: `/api/notes/${NOTES.aliceDraft}`, as: { userId: USERS.bob } });
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ status: 404, body: { status: 404 } });
    const hidden = await call(client, "query_data", { path: "/api/notes", query: "secret_hash=eq.x", as: { userId: USERS.admin } });
    const unknown = await call(client, "query_data", { path: "/api/notes", query: "nope=eq.x", as: { userId: USERS.admin } });
    expect(hidden.data.status).toBe(400);
    expect(hidden.data.body.detail.replace("secret_hash", "X")).toBe(unknown.data.body.detail.replace("nope", "X"));
    expect(JSON.stringify(hidden.data.body)).not.toMatch(/select |SQLITE|matchedRule|hiddenFields/i);
  });
  it("deny: reserved and unconfigured tables are 404", async () => {
    for (const t of ["user", "_castra_roles", "_castra_mcp_tokens", "_castra_audit", "logs"]) {
      const r = await call(client, "query_data", { path: `/api/${t}`, as: { userId: USERS.admin } });
      expect(r.data.status).toBe(404);
    }
  });
  it("only paths under the REST base path", async () => {
    expect((await call(client, "query_data", { path: "/notes" })).data.status).toBe(404);
    expect((await call(client, "query_data", { path: "/api/notes/a/b" })).data.status).toBe(404);
  });
  it("local server needs a userId when impersonating", async () => {
    const r = await call(client, "query_data", { path: "/api/notes", as: { roles: ["admin"] } });
    expect(r.isError).toBe(true);
    expect(r.data.status).toBe(400);
  });
});

describe("parseRestPath", () => {
  it("splits base path, table, id and merges query sources", () => {
    const p = parseRestPath("/api/notes/a%2Fb?x=1", "/api", { y: ["2", "3"] });
    expect(p.table).toBe("notes");
    expect(p.id).toBe("a/b");
    expect([...p.query]).toEqual([["x", "1"], ["y", "2"], ["y", "3"]]);
  });
});
