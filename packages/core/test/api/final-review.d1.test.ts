/**
 * Final v0.1 adversarial review: REST tests through Hono `app.request` on a real local D1. The
 * snapshot is introspected from the live database. Tables are prefixed `fr_`. Every test asserts the
 * CORRECT behaviour; a failing test is a finding (FR-N in the review report).
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
  generateOpenApi,
  introspect,
  owner,
  role,
  type CastraConfig,
  type CastraContext,
  type SchemaSnapshot,
} from "../../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = new Kysely<any>({ dialect: new D1Dialect({ database: env.DB }) });

const DDL = [
  // FR-1: a UNIQUE ... ON CONFLICT REPLACE column (a common "upsert by slug" schema).
  `CREATE TABLE IF NOT EXISTS fr_pages (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL,
     slug TEXT NOT NULL UNIQUE ON CONFLICT REPLACE, body TEXT)`,
  // FR-2: a hidden rowid primary key on a table the creator cannot read.
  `CREATE TABLE IF NOT EXISTS fr_tickets (id INTEGER PRIMARY KEY, body TEXT)`,
  // FR-3: no single-column primary key, create rule present.
  `CREATE TABLE IF NOT EXISTS fr_pairs (a TEXT NOT NULL, b TEXT NOT NULL, note TEXT, PRIMARY KEY (a, b))`,
];

const config: CastraConfig = defineConfig({
  database: "d1",
  roles: ["admin"],
  tables: {
    fr_pages: {
      read: owner("owner_id").or(role("admin")),
      create: authenticated(),
      update: owner("owner_id"),
      delete: owner("owner_id"),
    },
    fr_tickets: {
      // Write-only inbox: anyone signed in files a ticket, only admins read them; the id is internal.
      read: role("admin"),
      create: authenticated(),
      fields: { id: { hidden: true } },
    },
    fr_pairs: {
      read: authenticated(),
      create: authenticated(),
    },
  },
});

let snapshot: SchemaSnapshot;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

function ctxFrom(h: Headers): CastraContext {
  const id = h.get("x-test-user");
  const roles = (h.get("x-test-roles") ?? "").split(",").filter(Boolean);
  return id ? { user: { id }, roles, session: null, request: null, via: "test" } : { user: null, roles: [], session: null, request: null, via: "anonymous" };
}

async function call(method: string, path: string, o: { as?: string; roles?: string[]; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (o.as) headers["x-test-user"] = o.as;
  if (o.roles) headers["x-test-roles"] = o.roles.join(",");
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res: Response = await app.request(path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, text, body: body as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const ALICE = "fr-alice";
const BOB = "fr-bob";

beforeAll(async () => {
  for (const s of DDL) await env.DB.prepare(s).run();
  snapshot = await introspect(async (sql, params = []) => (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results);
  const engine = createPolicyEngine({ config, snapshot });
  app = createRestRouter({ config, snapshot, engine, getDb: () => db, getD1: () => env.DB, getContext: (c) => ctxFrom(c.req.raw.headers) });
});

beforeEach(async () => {
  for (const t of ["fr_pages", "fr_tickets", "fr_pairs"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare("INSERT INTO fr_pages (id, owner_id, slug, body) VALUES ('alice-page', ?, 'home', 'ALICE_PRIVATE')").bind(ALICE).run();
  // Some existing tickets so the rowid is not trivially 1.
  for (let i = 0; i < 7; i++) await env.DB.prepare("INSERT INTO fr_tickets (body) VALUES ('x')").run();
});

describe("final review FR-1: create/update must not delete rows the caller cannot delete (ON CONFLICT REPLACE)", () => {
  it("FR-1a create with another user's slug does not destroy that user's row", async () => {
    // Bob cannot read, update or delete Alice's page. He only creates his own row.
    const r = await call("POST", "/api/fr_pages", { as: BOB, body: { slug: "home", body: "bob" } });
    const alice = await env.DB.prepare("SELECT * FROM fr_pages WHERE id = 'alice-page'").first();
    // Correct: the create is refused (409/403) and Alice's row survives.
    expect(alice, `Alice's page was deleted by Bob's create (status ${r.status}: ${r.text})`).not.toBeNull();
    expect([403, 409]).toContain(r.status);
  });

  it("FR-1b update of one's own row to another user's slug does not destroy that user's row", async () => {
    await env.DB.prepare("INSERT INTO fr_pages (id, owner_id, slug, body) VALUES ('bob-page', ?, 'bob', 'b')").bind(BOB).run();
    const r = await call("PATCH", "/api/fr_pages/bob-page", { as: BOB, body: { slug: "home" } });
    const alice = await env.DB.prepare("SELECT * FROM fr_pages WHERE id = 'alice-page'").first();
    expect(alice, `Alice's page was deleted by Bob's update (status ${r.status}: ${r.text})`).not.toBeNull();
    expect([403, 409]).toContain(r.status);
  });
});

describe("final review FR-2: hidden columns never leave the server", () => {
  it("FR-2 create response does not reveal a hidden primary key when the caller cannot read the row", async () => {
    const r = await call("POST", "/api/fr_tickets", { as: BOB, body: { body: "help" } });
    expect(r.status, r.text).toBe(201);
    // SECURITY.md guarantee 6: "hidden columns never leave the server". The rowid also reveals how
    // many tickets exist.
    expect(r.body, `hidden id returned: ${r.text}`).not.toHaveProperty("id");
  });
});

describe("final review FR-3: OpenAPI lists exactly the operations REST serves", () => {
  it("FR-3 POST is not advertised for a table REST cannot create into (no single-column primary key)", async () => {
    const r = await call("POST", "/api/fr_pairs", { as: ALICE, body: { a: "x", b: "y" } });
    const doc = generateOpenApi({ config, snapshot, engine: createPolicyEngine({ config, snapshot }), basePath: "/api" }) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const advertised = Object.hasOwn(doc.paths["/api/fr_pairs"] ?? {}, "post");
    // Either REST serves the create, or OpenAPI must not list it.
    expect({ restStatus: r.status, advertised }).not.toEqual({ restStatus: 404, advertised: true });
  });
});
