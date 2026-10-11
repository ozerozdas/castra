/**
 * Allow AND deny tests for the final v0.1 review fixes (FR-1 ADR 0066, FR-2, FR-3), on a real local
 * D1 with a snapshot introspected from it. Tables are prefixed `frx_`. The review's own failing tests
 * live in final-review.d1.test.ts; this file covers the other side of each decision.
 */
import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authenticated,
  createPolicyEngine,
  createRestRouter,
  defineConfig,
  diffSnapshots,
  generateOpenApi,
  hasReplaceConflictClause,
  introspect,
  owner,
  PolicyError,
  role,
  type CastraConfig,
  type CastraContext,
  type PolicyEngine,
  type SchemaSnapshot,
} from "../../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = new Kysely<any>({ dialect: new D1Dialect({ database: env.DB }) });

const DDL = [
  // Flagged: column-level UNIQUE ... ON CONFLICT REPLACE.
  `CREATE TABLE IF NOT EXISTS frx_replace_col (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL,
     slug TEXT NOT NULL UNIQUE ON CONFLICT REPLACE, body TEXT)`,
  // Flagged: table-level PRIMARY KEY ... ON CONFLICT REPLACE.
  `CREATE TABLE IF NOT EXISTS frx_replace_pk (id TEXT NOT NULL, owner_id TEXT NOT NULL, body TEXT,
     PRIMARY KEY (id) ON CONFLICT REPLACE)`,
  // Not flagged: NOT NULL ... ON CONFLICT REPLACE substitutes the default, it never deletes a row.
  `CREATE TABLE IF NOT EXISTS frx_notnull (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL,
     body TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'empty')`,
  // Not flagged: the same "upsert by slug" schema with the default conflict clause (ABORT).
  `CREATE TABLE IF NOT EXISTS frx_plain (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL,
     slug TEXT NOT NULL UNIQUE, body TEXT)`,
  // FR-2: the key is role-gated; the row is admin-only.
  `CREATE TABLE IF NOT EXISTS frx_inbox (id INTEGER PRIMARY KEY, body TEXT)`,
  // FR-2: the key is visible, the row is admin-only.
  `CREATE TABLE IF NOT EXISTS frx_drop (id INTEGER PRIMARY KEY, body TEXT)`,
  // FR-3: hidden key: no item routes.
  `CREATE TABLE IF NOT EXISTS frx_hidden_pk (id INTEGER PRIMARY KEY, body TEXT)`,
];

const pageRules = {
  read: owner("owner_id").or(role("admin")),
  create: authenticated(),
  update: owner("owner_id").or(role("admin")),
  delete: owner("owner_id").or(role("admin")),
};

const config: CastraConfig = defineConfig({
  database: "d1",
  roles: ["admin", "staff"],
  tables: {
    frx_replace_col: pageRules,
    frx_replace_pk: pageRules,
    frx_notnull: pageRules,
    frx_plain: pageRules,
    frx_inbox: { read: role("admin"), create: authenticated(), fields: { id: { visibleTo: ["staff"] } } },
    frx_drop: { read: role("admin"), create: authenticated() },
    frx_hidden_pk: {
      read: authenticated(),
      create: authenticated(),
      update: authenticated(),
      delete: authenticated(),
      fields: { id: { hidden: true } },
    },
  },
});

let snapshot: SchemaSnapshot;
let engine: PolicyEngine;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

function ctxFrom(h: Headers): CastraContext {
  const id = h.get("x-test-user");
  const roles = (h.get("x-test-roles") ?? "").split(",").filter(Boolean);
  return id ? { user: { id }, roles, session: null, request: null, via: "test" } : { user: null, roles: [], session: null, request: null, via: "anonymous" };
}

const asUser = (id: string, roles: string[] = []): CastraContext => ({ user: { id }, roles, session: null, request: null, via: "test" });

async function call(method: string, path: string, o: { as?: string; roles?: string[]; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (o.as) headers["x-test-user"] = o.as;
  if (o.roles) headers["x-test-roles"] = o.roles.join(",");
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res: Response = await app.request(path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const ALICE = "frx-alice";
const BOB = "frx-bob";
const ADMIN = "frx-admin";

const count = async (table: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

beforeAll(async () => {
  for (const s of DDL) await env.DB.prepare(s).run();
  snapshot = await introspect(async (sql, params = []) => (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results);
  engine = createPolicyEngine({ config, snapshot });
  app = createRestRouter({ config, snapshot, engine, getDb: () => db, getD1: () => env.DB, getContext: (c) => ctxFrom(c.req.raw.headers) });
});

beforeEach(async () => {
  for (const t of ["frx_replace_col", "frx_replace_pk", "frx_notnull", "frx_plain", "frx_inbox", "frx_drop", "frx_hidden_pk"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  for (const t of ["frx_replace_col", "frx_plain"]) {
    await env.DB.prepare(`INSERT INTO ${t} (id, owner_id, slug, body) VALUES ('alice-page', ?, 'home', 'ALICE')`).bind(ALICE).run();
  }
  await env.DB.prepare("INSERT INTO frx_replace_pk (id, owner_id, body) VALUES ('alice-page', ?, 'ALICE')").bind(ALICE).run();
});

describe("FR-1 hasReplaceConflictClause (conservative parse of sqlite_master.sql)", () => {
  it.each([
    ["column UNIQUE", "CREATE TABLE t (a TEXT UNIQUE ON CONFLICT REPLACE)"],
    ["column PRIMARY KEY", "CREATE TABLE t (a INTEGER PRIMARY KEY ON CONFLICT REPLACE)"],
    ["column PRIMARY KEY DESC", "CREATE TABLE t (a INTEGER PRIMARY KEY DESC ON CONFLICT REPLACE AUTOINCREMENT)"],
    ["named constraint", "CREATE TABLE t (a TEXT CONSTRAINT u UNIQUE ON CONFLICT REPLACE)"],
    ["table UNIQUE", "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a, b) ON CONFLICT REPLACE)"],
    ["table PRIMARY KEY", "CREATE TABLE t (a TEXT, PRIMARY KEY (a) ON CONFLICT REPLACE)"],
    ["lower case, comments and newlines between tokens", "create table t (a text unique on /* x */ conflict\n-- y\n replace)"],
    ["table CHECK (unsure: flagged)", "CREATE TABLE t (a TEXT, CHECK (a IS NOT NULL) ON CONFLICT REPLACE)"],
    ["unterminated literal (unsure: flagged)", "CREATE TABLE t (a TEXT DEFAULT 'x)"],
    ["unterminated comment (unsure: flagged)", "CREATE TABLE t (a TEXT) /* x"],
  ])("flags %s", (_, ddl) => {
    expect(hasReplaceConflictClause(ddl)).toBe(true);
  });

  it.each([
    ["no conflict clause", "CREATE TABLE t (a TEXT UNIQUE, b TEXT PRIMARY KEY)"],
    ["UNIQUE ON CONFLICT ABORT / IGNORE", "CREATE TABLE t (a TEXT UNIQUE ON CONFLICT ABORT, b TEXT UNIQUE ON CONFLICT IGNORE)"],
    ["NOT NULL ON CONFLICT REPLACE", "CREATE TABLE t (a TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'x')"],
    ["the words inside a string default", "CREATE TABLE t (a TEXT DEFAULT 'ON CONFLICT REPLACE')"],
    ["the words inside quoted identifiers", 'CREATE TABLE t ("on conflict replace" TEXT, [ON CONFLICT REPLACE] TEXT, `x` TEXT)'],
    ["the words inside a comment", "CREATE TABLE t (a TEXT UNIQUE -- ON CONFLICT REPLACE\n)"],
    ["replace() in a default expression", "CREATE TABLE t (a TEXT DEFAULT (replace('a', 'b', 'c')))"],
  ])("does not flag %s", (_, ddl) => {
    expect(hasReplaceConflictClause(ddl)).toBe(false);
  });
});

describe("FR-1 introspect records conflictReplace (real D1)", () => {
  it("flags column- and table-level REPLACE on UNIQUE / PRIMARY KEY", () => {
    expect(snapshot.tables.frx_replace_col?.conflictReplace).toBe(true);
    expect(snapshot.tables.frx_replace_pk?.conflictReplace).toBe(true);
  });

  it("omits the flag for NOT NULL ON CONFLICT REPLACE and ordinary tables", () => {
    expect(snapshot.tables.frx_notnull).not.toHaveProperty("conflictReplace");
    expect(snapshot.tables.frx_plain).not.toHaveProperty("conflictReplace");
  });

  it("reports a change of the flag as drift", () => {
    const flipped = structuredClone(snapshot);
    delete flipped.tables.frx_replace_col!.conflictReplace;
    expect(diffSnapshots(flipped, snapshot)).toContain('table "frx_replace_col": ON CONFLICT REPLACE changed from false to true');
  });
});

describe("FR-1 create/update are refused on a REPLACE table (deny), allowed elsewhere (allow)", () => {
  it("deny: create is 403 unsafe_schema for everyone, even without a conflict and for admins", async () => {
    for (const who of [{ as: BOB }, { as: ADMIN, roles: ["admin"] }]) {
      const r = await call("POST", "/api/frx_replace_col", { ...who, body: { slug: `fresh-${who.as}`, body: "x" } });
      expect(r.status, r.text).toBe(403);
      expect(r.body.type).toBe("https://castra.dev/problems/unsafe_schema");
    }
    const pk = await call("POST", "/api/frx_replace_pk", { as: BOB, body: { body: "x" } });
    expect(pk.status, pk.text).toBe(403);
    expect(await count("frx_replace_col")).toBe(1);
    expect(await count("frx_replace_pk")).toBe(1);
  });

  it("deny: update of one's own row is 403 unsafe_schema and nothing changes", async () => {
    const r = await call("PATCH", "/api/frx_replace_col/alice-page", { as: ALICE, body: { body: "changed" } });
    expect(r.status, r.text).toBe(403);
    expect(r.body.type).toBe("https://castra.dev/problems/unsafe_schema");
    expect((await env.DB.prepare("SELECT body FROM frx_replace_col WHERE id = 'alice-page'").first<{ body: string }>())!.body).toBe("ALICE");
  });

  it("deny: the engine refuses prepareWrite / writeGuard / readFilter(update) and checkRow says no", async () => {
    const ctx = asUser(ALICE, ["admin"]);
    expect(() => engine.prepareWrite("frx_replace_col", "create", ctx, { slug: "s" })).toThrow(PolicyError);
    expect(() => engine.writeGuard("frx_replace_col", "create", ctx, { id: "x" })).toThrow(/ON CONFLICT REPLACE/);
    expect(() => engine.readFilter("frx_replace_col", "update", ctx)).toThrow(/unsafe|ON CONFLICT REPLACE/);
    for (const op of ["create", "update"] as const) {
      const d = await engine.checkRow(db, "frx_replace_col", op, ctx, { id: "x", owner_id: ALICE, slug: "s" });
      expect(d.allowed).toBe(false);
      expect(d.explanation.reason).toMatch(/ON CONFLICT REPLACE/);
    }
  });

  it("allow: read and delete on the REPLACE table still follow their policies", async () => {
    expect((await call("GET", "/api/frx_replace_col/alice-page", { as: ALICE })).status).toBe(200);
    expect((await call("GET", "/api/frx_replace_col/alice-page", { as: BOB })).status).toBe(404);
    expect((await call("DELETE", "/api/frx_replace_col/alice-page", { as: BOB })).status).toBe(404);
    expect((await call("DELETE", "/api/frx_replace_col/alice-page", { as: ALICE })).status).toBe(204);
  });

  it("allow: the same schema with the default conflict clause creates and updates; a collision is a 409 that keeps the other row", async () => {
    const created = await call("POST", "/api/frx_plain", { as: BOB, body: { slug: "bob", body: "b" } });
    expect(created.status, created.text).toBe(201);
    const clash = await call("POST", "/api/frx_plain", { as: BOB, body: { slug: "home", body: "b" } });
    expect(clash.status, clash.text).toBe(409);
    const upd = await call("PATCH", `/api/frx_plain/${created.body.id}`, { as: BOB, body: { slug: "home" } });
    expect(upd.status, upd.text).toBe(409);
    expect(await env.DB.prepare("SELECT 1 FROM frx_plain WHERE id = 'alice-page' AND body = 'ALICE'").first()).not.toBeNull();
    const ok = await call("PATCH", `/api/frx_plain/${created.body.id}`, { as: BOB, body: { body: "b2" } });
    expect(ok.status, ok.text).toBe(200);
  });

  it("allow: NOT NULL ON CONFLICT REPLACE is not flagged and writes normally", async () => {
    const r = await call("POST", "/api/frx_notnull", { as: BOB, body: { body: "x" } });
    expect(r.status, r.text).toBe(201);
  });

  it("OpenAPI advertises read/delete but not create/update for the REPLACE table", () => {
    const doc = generateOpenApi({ config, snapshot, engine }) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths["/api/frx_replace_col"] ?? {})).not.toContain("post");
    expect(Object.keys(doc.paths["/api/frx_replace_col"] ?? {})).toContain("get");
    expect(Object.keys(doc.paths["/api/frx_replace_col/{id}"] ?? {})).not.toContain("patch");
    expect(Object.keys(doc.paths["/api/frx_replace_col/{id}"] ?? {})).toContain("delete");
    expect(Object.keys(doc.paths["/api/frx_plain"] ?? {})).toContain("post");
    expect(Object.keys(doc.paths["/api/frx_plain/{id}"] ?? {})).toContain("patch");
  });
});

describe("FR-2 a create the caller cannot re-read returns the key only if the key column is readable", () => {
  it("allow: a visible key is returned when the row is not readable", async () => {
    const r = await call("POST", "/api/frx_drop", { as: BOB, body: { body: "x" } });
    expect(r.status, r.text).toBe(201);
    expect(Object.keys(r.body)).toEqual(["id"]);
  });

  it("allow: a role-gated key is returned to a caller holding the role", async () => {
    const r = await call("POST", "/api/frx_inbox", { as: BOB, roles: ["staff"], body: { body: "x" } });
    expect(r.status, r.text).toBe(201);
    expect(Object.keys(r.body)).toEqual(["id"]);
  });

  it("deny: a role-gated key is not returned to a caller without the role", async () => {
    const r = await call("POST", "/api/frx_inbox", { as: BOB, body: { body: "x" } });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toEqual({});
  });
});

describe("FR-3 OpenAPI lists exactly what REST serves for item routes", () => {
  it("deny: no /{id} routes for a hidden key (REST answers 404 to everyone); allow: the collection stays", async () => {
    const doc = generateOpenApi({ config, snapshot, engine }) as { paths: Record<string, Record<string, unknown>> };
    expect(doc.paths["/api/frx_hidden_pk/{id}"]).toBeUndefined();
    expect(Object.keys(doc.paths["/api/frx_hidden_pk"] ?? {})).toEqual(expect.arrayContaining(["get", "post"]));
    for (const m of ["GET", "PATCH", "DELETE"]) {
      const body = m === "PATCH" ? { body: "y" } : undefined;
      expect((await call(m, "/api/frx_hidden_pk/1", { as: BOB, body })).status).toBe(404);
    }
  });
});
