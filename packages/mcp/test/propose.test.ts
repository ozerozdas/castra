/**
 * `propose_policy` (ADR 0082): a diff of castra.config.ts, validated against the running config and schema, never
 * applied. Rule text is parsed, never evaluated.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SchemaSnapshot } from "@castra-kit/core";
import { beforeAll, describe, expect, it } from "vitest";
import { createCastraMcpServer, localAccess, mcpDb, parseRuleExpression, proposePolicy } from "../src/index.js";
import { call, config, setup, testDb, USERS } from "./fixtures.js";

// The fixture config as a developer would have written it.
const SOURCE = `import { authenticated, defineConfig, isPublic, owner, role } from "@castra-kit/core";

export default defineConfig({
  database: "d1",
  roles: ["admin", "member"],
  tables: {
    notes: {
      read: isPublic()
        .where((q) => q.eb("status", "=", "published"))
        .or(owner("owner_id"))
        .or(role("admin")),
      create: authenticated(),
      update: owner("owner_id"), // only the author
      delete: role("admin"),
      fields: { secret_hash: { hidden: true }, staff_note: { visibleTo: ["admin"] } },
    },
  },
});
`;

let snapshot: SchemaSnapshot;
beforeAll(async () => {
  snapshot = await setup();
});

const propose = (table: string, op: "read" | "create" | "update" | "delete", rule: string | null) =>
  proposePolicy({ table, op, rule }, { config, snapshot, path: "castra.config.ts", source: SOURCE }) as Record<string, string | boolean | null>;

describe("propose_policy: allow", () => {
  it("replaces one rule and keeps the comment", () => {
    const r = propose("notes", "update", 'owner( "owner_id" ).or(role(\'admin\', "member"))');
    expect(r).toMatchObject({ applied: false, before: "owner(owner_id)", after: "or(owner(owner_id), role(admin, member))" });
    expect(r.diff).toContain('-      update: owner("owner_id"), // only the author');
    expect(r.diff).toContain('+      update: owner("owner_id").or(role("admin", "member")), // only the author');
    expect(r.diff).toMatch(/^--- a\/castra\.config\.ts\n\+\+\+ b\/castra\.config\.ts\n@@ -10,7 \+10,7 @@\n/);
  });
  it("null removes the operation's policy line (closes it)", () => {
    const r = propose("notes", "delete", null);
    expect(r).toMatchObject({ before: "role(admin)", after: null });
    expect(r.diff).toContain('-      delete: role("admin"),');
    expect(String(r.diff).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"))).toEqual([]);
  });
  it("a configured table without the op gets a new line; a table without policies gets an entry", () => {
    const logs = propose("logs", "read", 'role("admin")');
    expect(logs.diff).toContain('+    logs: {\n+      read: role("admin"),\n+    },');
  });
  it("adds a builder the import lacks", () => {
    const source = `import { defineConfig } from "@castra-kit/core";\n\nexport default defineConfig({\n  database: "d1",\n  roles: ["admin"],\n  tables: {},\n});\n`;
    const r = proposePolicy({ table: "logs", op: "read", rule: 'role("admin")' }, { config, snapshot, path: "castra.config.ts", source });
    expect(r.diff).toContain('+import { defineConfig, role } from "@castra-kit/core";');
    expect(r.diff).toContain('+    logs: {\n+      read: role("admin"),\n+    },');
  });
});

describe("propose_policy: deny", () => {
  it.each([
    ["an unknown role", 'role("owner")', /owner/],
    ["an owner column that does not exist", 'owner("author_id")', /author_id/],
    [".where(), which needs code", 'isPublic().where((q) => true)', /where\(\) and custom\(\) need code/],
    ["custom()", 'custom("x", () => true)', /"custom" is not allowed/],
    ["arbitrary code", 'globalThis.process.exit(1)', /"globalThis" is not allowed/],
    ["a template or escaped string", 'role(`admin`)', /expected a string/],
    ["trailing code", 'isPublic(); fetch("x")', /unexpected text/],
  ])("%s is rejected", (_label, rule, message) => {
    expect(() => propose("notes", "read", rule)).toThrow(message);
  });
  it("an unknown table is 404; removing a missing policy is 400", () => {
    expect(() => propose("nope", "read", "isPublic()")).toThrow(/no table "nope"/);
    expect(() => propose("logs", "read", null)).toThrow(/no policies to remove/);
  });
  it("parses only the allowed grammar", () => {
    expect(parseRuleExpression("authenticated().and(owner('x'))")).toEqual({
      fn: "and",
      args: [{ fn: "authenticated", args: [] }, { fn: "owner", args: ["x"] }],
    });
  });
});

describe("propose_policy over MCP", () => {
  it("is registered only with a config source, and never changes the running policy", async () => {
    let reads = 0;
    const server = createCastraMcpServer({
      config,
      snapshot,
      db: testDb(),
      access: localAccess(mcpDb(testDb()), config),
      configSource: async () => (reads++, { path: "castra.config.ts", source: SOURCE }),
    });
    const [s, c] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" }, { jsonSchemaValidator: { getValidator: () => () => ({ valid: false as const, data: undefined, errorMessage: "x" }) } });
    await client.connect(c);

    const before = await call(client, "check_access", { table: "notes", op: "delete", as: { userId: USERS.alice } });
    expect(before.data.allowed).toBe(false);
    const r = await call(client, "propose_policy", { table: "notes", op: "delete", rule: "authenticated()" });
    expect(r.isError).toBe(false);
    expect(r.data.applied).toBe(false);
    expect(reads).toBe(1);
    const after = await call(client, "check_access", { table: "notes", op: "delete", as: { userId: USERS.alice } });
    expect(after.data.allowed).toBe(false);
    expect(String(config.tables.notes!.delete)).toBe("role(admin)");

    const denied = await call(client, "propose_policy", { table: "notes", op: "delete", rule: "fetch()" });
    expect(denied).toMatchObject({ isError: true, data: { status: 400 } });
  });
  it("is not on the server without a config source (the remote /mcp route)", async () => {
    const server = createCastraMcpServer({ config, snapshot, db: testDb(), access: localAccess(mcpDb(testDb()), config) });
    const [s, c] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("propose_policy");
  });
});
