/**
 * Third security review (M2 REST): adversarial tests through HTTP (Hono `app.request`) on a real
 * local D1. The schema snapshot is introspected from the live database, so the router sees exactly
 * what `castra generate` would produce. Tables are prefixed `r3_` so they never collide with other
 * test files. Every test asserts the CORRECT behaviour; a failing test is a finding.
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
  encodeCursor,
  generateOpenApi,
  introspect,
  isPublic,
  owner,
  role,
  type CastraConfig,
  type CastraContext,
  type SchemaSnapshot,
} from "../../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = new Kysely<any>({ dialect: new D1Dialect({ database: env.DB }) });

const SECRET = "R3_SECRET_c0ffee";
const NOTE = "R3_ADMIN_NOTE_beef";
const EMAIL_MARK = "r3-private-mail";

const DDL = [
  `CREATE TABLE IF NOT EXISTS r3_users (id TEXT PRIMARY KEY NOT NULL, email TEXT, name TEXT, secret TEXT, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS r3_posts (id TEXT PRIMARY KEY NOT NULL, author_id TEXT NOT NULL REFERENCES r3_users (id), title TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'draft', secret TEXT, notes TEXT, score INTEGER, ghost_id TEXT REFERENCES r3_users (id))`,
  `CREATE TABLE IF NOT EXISTS r3_comments (id TEXT PRIMARY KEY NOT NULL, post_id TEXT NOT NULL REFERENCES r3_posts (id),
     user_id TEXT NOT NULL REFERENCES r3_users (id), body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS r3_items (id INTEGER PRIMARY KEY, owner_id TEXT, status TEXT)`,
  `CREATE TABLE IF NOT EXISTS r3_log (id INTEGER PRIMARY KEY, msg TEXT)`,
  // Re-owns the row after insert: the guard must see the stored row, not the input.
  `CREATE TRIGGER IF NOT EXISTS r3_items_hijack AFTER INSERT ON r3_items WHEN NEW.status = 'hijack'
     BEGIN UPDATE r3_items SET owner_id = 'victim' WHERE id = NEW.id; END`,
  // Inserts into another rowid table: last_insert_rowid() must still point at the r3_items row.
  `CREATE TRIGGER IF NOT EXISTS r3_items_log AFTER INSERT ON r3_items BEGIN INSERT INTO r3_log (msg) VALUES ('x'); END`,
  `CREATE TRIGGER IF NOT EXISTS r3_items_upd AFTER UPDATE ON r3_items WHEN NEW.status = 'hijack'
     BEGIN UPDATE r3_items SET owner_id = 'victim' WHERE id = NEW.id; END`,
];

const config: CastraConfig = defineConfig({
  database: "d1",
  roles: ["admin", "editor", "member"],
  api: { maxLimit: 50 },
  tables: {
    r3_users: {
      read: authenticated(),
      fields: { secret: { hidden: true }, notes: { visibleTo: ["admin"] }, email: { visibleTo: ["self", "admin"] } },
    },
    r3_posts: {
      read: isPublic()
        .where((q) => q.eb("status", "=", "published"))
        .or(owner("author_id"))
        .or(role("admin")),
      create: authenticated(),
      update: owner("author_id").or(role("editor")),
      delete: role("admin"),
      fields: { secret: { hidden: true }, notes: { visibleTo: ["admin"] }, ghost_id: { hidden: true } },
    },
    r3_comments: {
      read: isPublic(),
      create: authenticated(),
      update: owner("user_id"),
      delete: owner("user_id"),
    },
    r3_items: {
      read: owner("owner_id"),
      create: authenticated().where((q) => q.eb("status", "=", "ok")),
      update: owner("owner_id").where((q) => q.eb("status", "=", "ok")),
    },
  },
});

let snapshot: SchemaSnapshot;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
const seen: string[] = [];

function ctxFrom(h: Headers): CastraContext {
  const id = h.get("x-test-user");
  const roles = (h.get("x-test-roles") ?? "").split(",").filter(Boolean);
  return id ? { user: { id }, roles, session: null, request: null, via: "test" } : { user: null, roles: [], session: null, request: null, via: "anonymous" };
}

interface CallOpts {
  as?: string;
  roles?: string[];
  body?: unknown;
  raw?: string | ReadableStream<Uint8Array>;
  type?: string | null;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, o: CallOpts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.as) headers["x-test-user"] = o.as;
  if (o.roles) headers["x-test-roles"] = o.roles.join(",");
  let body: string | ReadableStream<Uint8Array> | undefined;
  if (o.raw !== undefined || o.body !== undefined) {
    if (o.type !== null) headers["content-type"] = o.type ?? "application/json";
    body = o.raw ?? JSON.stringify(o.body);
  }
  const init: RequestInit & { duplex?: string } = { method, headers, body };
  if (body instanceof ReadableStream) init.duplex = "half";
  const res: Response = await app.request(path, init);
  const text = await res.text();
  seen.push(text);
  return { status: res.status, type: res.headers.get("content-type") ?? "", text, body: (text ? safeJson(text) : null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function expectProblem(r: { status: number; type: string; body: unknown; text: string }, status: number) {
  expect(r.status, r.text).toBe(status);
  expect(r.type).toMatch(/^application\/problem\+json/);
  expect(Object.keys(r.body as object).sort()).toEqual(["detail", "status", "title", "type"]);
  expect(r.text).not.toMatch(/select |insert |update "|delete from|SQLITE|D1_ERROR|json_extract|castra_write|stack|explanation|matchedRule|hiddenFields/i);
}

const ALICE = "r3-alice";
const BOB = "r3-bob";
const ADMIN = "r3-admin";
const EDITOR = "r3-editor";

async function seed() {
  for (const t of ["r3_comments", "r3_posts", "r3_items", "r3_log", "r3_users"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const u = env.DB.prepare("INSERT INTO r3_users (id, email, name, secret, notes) VALUES (?, ?, ?, ?, ?)");
  await env.DB.batch([ALICE, BOB, ADMIN, EDITOR, "victim"].map((id) => u.bind(id, `${id}@${EMAIL_MARK}.test`, id, SECRET, NOTE)));
  const p = env.DB.prepare("INSERT INTO r3_posts (id, author_id, title, status, secret, notes, score, ghost_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const posts = [
    ["pub1", ALICE, "Hello", "published", 10],
    ["pub2", BOB, "100% real_title", "published", 20],
    ["pub3", BOB, "plain", "published", 30],
    ["draftA", ALICE, "alice draft", "draft", 40],
    ["draftB", BOB, "bob draft", "draft", 50],
  ] as const;
  await env.DB.batch(posts.map(([id, a, t, s, sc]) => p.bind(id, a, t, s, SECRET, NOTE, sc, "victim")));
  const c = env.DB.prepare("INSERT INTO r3_comments (id, post_id, user_id, body) VALUES (?, ?, ?, ?)");
  await env.DB.batch([c.bind("c1", "pub1", BOB, "nice"), c.bind("c2", "draftA", ALICE, "on alice draft")]);
  // Make r3_log rowids diverge from r3_items rowids.
  const l = env.DB.prepare("INSERT INTO r3_log (msg) VALUES (?)");
  await env.DB.batch(Array.from({ length: 40 }, () => l.bind("pad")));
  await env.DB.prepare("INSERT INTO r3_items (id, owner_id, status) VALUES (1, ?, 'ok')").bind("victim").run();
}

beforeAll(async () => {
  for (const s of DDL) await env.DB.prepare(s).run();
  snapshot = await introspect(async (sql, params = []) => (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results);
  const engine = createPolicyEngine({ config, snapshot });
  app = createRestRouter({ config, snapshot, engine, getDb: () => db, getD1: () => env.DB, getContext: (c) => ctxFrom(c.req.raw.headers) });
});
beforeEach(seed);

// -------------------------------------------------------------------------------------------------
describe("review3: reserved, unknown and closed tables are indistinguishable", () => {
  const names = [
    "nope",
    "user",
    "USER",
    "session",
    "account",
    "verification",
    "_castra_roles",
    "_castra_audit",
    "sqlite_master",
    "sqlite_schema",
    "_cf_KV",
    "d1_migrations",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "R3_POSTS",
    "r3_log",
    "r3_posts%00",
  ];
  it.each(names)("%s answers every method with the canonical 404", async (name) => {
    const ref = await call("GET", "/api/nope", { as: ADMIN, roles: ["admin"] });
    for (const [m, path, body] of [
      ["GET", `/api/${name}`, undefined],
      ["GET", `/api/${name}/1`, undefined],
      ["POST", `/api/${name}`, { a: 1 }],
      ["PATCH", `/api/${name}/1`, { a: 1 }],
      ["DELETE", `/api/${name}/1`, undefined],
      ["GET", `/api/${name}?id=eq.1&sort=id&include=x`, undefined],
    ] as const) {
      const r = await call(m, path, { as: ADMIN, roles: ["admin"], body });
      expectProblem(r, 404);
      expect(r.text, `${m} ${path}`).toBe(ref.text);
    }
  });
  it("closed operations (users create/update/delete, posts collection PATCH) are the same 404", async () => {
    const ref = (await call("GET", "/api/nope")).text;
    for (const [m, p] of [
      ["POST", "/api/r3_users"],
      ["PATCH", `/api/r3_users/${ALICE}`],
      ["DELETE", `/api/r3_users/${ALICE}`],
      ["DELETE", "/api/r3_items/1"],
      ["PUT", "/api/r3_posts/pub1"],
      ["PATCH", "/api/r3_posts"],
      ["POST", "/api/r3_posts/pub1"],
    ] as const) {
      const r = await call(m, p, { as: ADMIN, roles: ["admin"], body: { title: "x" } });
      expectProblem(r, 404);
      expect(r.text).toBe(ref);
    }
  });
  it("a closed table returns 404 even with a giant or non-JSON body (body never read)", async () => {
    const r = await call("POST", "/api/r3_log", { as: ADMIN, raw: "not json", type: "text/plain" });
    expectProblem(r, 404);
  });
});

// -------------------------------------------------------------------------------------------------
describe("review3: filters and sort never reveal hidden or unreadable columns", () => {
  const anonVsBob = [undefined, BOB];
  it.each(anonVsBob)("hidden / visibleTo / unknown columns give byte-identical errors (as %s)", async (who) => {
    const msg = async (q: string) => {
      const r = await call("GET", `/api/r3_posts?${q}`, { as: who });
      expectProblem(r, 400);
      return r.text;
    };
    for (const [col, op] of [
      ["secret", "eq.x"],
      ["ghost_id", "eq.victim"],
      ["notes", `like.*${NOTE.slice(0, 4)}*`],
      ["SECRET", "eq.x"],
      ["Status", "eq.published"],
      ["or", "(secret.eq.x)"],
      ["and", "(secret.eq.x)"],
      ["select", "secret"],
      ["order", "secret"],
      ["rowid", "gt.0"],
      ["_rowid_", "gt.0"],
      ["oid", "gt.0"],
    ] as const) {
      const norm = (t: string) => t.replace(/\\"[^"\\]*\\"/, '\\"COL\\"');
      const a = await msg(`${col}=${op}`);
      const b = await msg(`zz_nope=${op}`);
      expect(norm(a)).toBe(norm(b));
      const s1 = await msg(`sort=-${col}`);
      const s2 = await msg(`sort=-zz_nope`);
      expect(norm(s1)).toBe(norm(s2));
    }
  });

  it("an admin may filter on a visibleTo column; others cannot even with role headers while anonymous", async () => {
    expect((await call("GET", `/api/r3_posts?notes=eq.${NOTE}`, { as: ADMIN, roles: ["admin"] })).status).toBe(200);
    expectProblem(await call("GET", `/api/r3_posts?notes=eq.${NOTE}`, { roles: ["admin"] }), 400);
  });

  it("like: % and _ are literals, * is the only wildcard", async () => {
    const pct = await call("GET", "/api/r3_posts?title=like.*100%25*");
    expect(pct.body.data.map((r: { id: string }) => r.id)).toEqual(["pub2"]);
    const pctOnly = await call("GET", "/api/r3_posts?title=like.%25");
    expect(pctOnly.body.data).toEqual([]);
    const under = await call("GET", "/api/r3_posts?title=like.*e_l*"); // wildcard _ would match "Hello"
    expect(under.body.data).toEqual([]);
    const esc = await call("GET", "/api/r3_posts?title=like.*%5C*");
    expect(esc.status).toBe(200);
    expect(esc.body.data).toEqual([]);
  });

  it("in.(): 100 values ok, 101 rejected, quoted commas work, policy still applies", async () => {
    const hundred = Array.from({ length: 99 }, (_, i) => `x${i}`).concat(["draftB"]).join(",");
    const ok = await call("GET", `/api/r3_posts?id=in.(${hundred})`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual([]); // draftB is not readable by anonymous
    const tooMany = Array.from({ length: 101 }, (_, i) => `x${i}`).join(",");
    expectProblem(await call("GET", `/api/r3_posts?id=in.(${tooMany})`), 400);
    const quoted = await call("GET", `/api/r3_posts?title=in.("100%25 real_title","a,b")`);
    expect(quoted.body.data.map((r: { id: string }) => r.id)).toEqual(["pub2"]);
  });

  it("is.: only null/true/false; is.true on a text column cannot widen the policy", async () => {
    for (const v of ["NULL", "1", "not.null", "unknown", ""]) expectProblem(await call("GET", `/api/r3_posts?title=is.${v}`), 400);
    const r = await call("GET", "/api/r3_posts?status=is.null");
    expect(r.body.data).toEqual([]);
  });

  it("duplicated reserved params are rejected; duplicated filters are ANDed (never ORed)", async () => {
    expectProblem(await call("GET", "/api/r3_posts?limit=1&limit=2"), 400);
    expectProblem(await call("GET", "/api/r3_posts?sort=id&sort=-id"), 400);
    expectProblem(await call("GET", "/api/r3_posts?include=r3_comments&include=author"), 400);
    const r = await call("GET", "/api/r3_posts?status=eq.published&status=eq.draft&count=exact");
    expect(r.body.count).toBe(0);
  });

  it("type coercion of filter values: integer column rejects text, floats and unsafe integers", async () => {
    for (const v of ["abc", "1.5", "1e3", "9007199254740993", "0x10", " 1", "", "Infinity"]) {
      expectProblem(await call("GET", `/api/r3_posts?score=eq.${encodeURIComponent(v)}`), 400);
    }
    expect((await call("GET", "/api/r3_posts?score=gte.20&count=exact")).body.count).toBe(2);
  });
});

// -------------------------------------------------------------------------------------------------
describe("review3: pagination and counts are computed under the policy (rule 2)", () => {
  it("anonymous count and pages equal the published rows only, for every limit", async () => {
    for (const limit of [1, 2, 3, 50, 1000]) {
      const ids: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const r = await call("GET", `/api/r3_posts?limit=${limit}&count=exact&sort=-score${cursor ? `&cursor=${cursor}` : ""}`);
        expect(r.status, r.text).toBe(200);
        expect(r.body.count).toBe(3);
        expect(r.body.data.length).toBeLessThanOrEqual(Math.min(limit, 50));
        ids.push(...r.body.data.map((x: { id: string }) => x.id));
        cursor = r.body.nextCursor;
      } while (cursor && ++guard < 10);
      expect(ids).toEqual(["pub3", "pub2", "pub1"]);
    }
  });

  it("offset pagination: an offset past the visible rows is empty, never another user's rows", async () => {
    const r = await call("GET", "/api/r3_posts?offset=3&count=exact");
    expect(r.body.data).toEqual([]);
    expect(r.body.count).toBe(3);
  });

  it("a cursor issued to alice and replayed by bob or anonymous only yields rows they may read", async () => {
    const first = await call("GET", "/api/r3_posts?limit=1&sort=-score", { as: ALICE });
    expect(first.body.data[0].id).toBe("draftA");
    const cur = first.body.nextCursor as string;
    const asBob = await call("GET", `/api/r3_posts?limit=50&sort=-score&cursor=${cur}`, { as: BOB });
    for (const r of asBob.body.data) expect(r.id === "draftA").toBe(false);
    const asAnon = await call("GET", `/api/r3_posts?limit=50&sort=-score&cursor=${cur}`);
    expect(asAnon.body.data.map((r: { id: string }) => r.id)).toEqual(["pub3", "pub2", "pub1"]);
  });

  it("forged cursors: hidden/unknown keys, mismatched sort, wrong types, objects, huge and non-JSON are 400 with one message", async () => {
    const forged = [
      encodeCursor({ keys: ["secret", "id"], values: ["R3", "a"] }),
      encodeCursor({ keys: ["-secret", "id"], values: ["R3", "a"] }),
      encodeCursor({ keys: ["notes", "id"], values: ["R3", "a"] }),
      encodeCursor({ keys: ["ghost_id", "id"], values: ["victim", "a"] }),
      encodeCursor({ keys: ["rowid"], values: [1] }),
      encodeCursor({ keys: ["id"], values: [5] }),
      encodeCursor({ keys: ["id", "id"], values: ["a", "a"] }),
      encodeCursor({ keys: ["-score", "id"], values: ["ten", "a"] }),
      encodeCursor({ keys: ["-score", "id"], values: [1.5, "a"] }),
      btoa(JSON.stringify({ k: ["id"], v: [{ $gt: "" }] })).replace(/=+$/, ""),
      btoa(JSON.stringify({ k: ["id"], v: ["a"], x: 1 })).replace(/=+$/, ""),
      btoa(JSON.stringify({ k: ["id"], v: [null] })).replace(/=+$/, ""),
      btoa("not json at all"),
      "%%%",
      "A".repeat(5000),
    ];
    const details = new Set<string>();
    for (const c of forged) {
      const sort = c === forged[7] || c === forged[8] ? "&sort=-score" : "";
      const r = await call("GET", `/api/r3_posts?cursor=${encodeURIComponent(c)}${sort}`, { as: BOB });
      expectProblem(r, 400);
      expect(r.text).not.toContain("secret");
      expect(r.text).not.toContain("ghost");
      details.add(r.body.type);
    }
    expect([...details]).toEqual(["https://castra.mehmetozer.dev/problems/invalid_cursor"]);
  });

  it("a cursor on a column the caller may sort by cannot reach rows outside the policy", async () => {
    // keyset on id with a value below every key: still only the published rows.
    const c = encodeCursor({ keys: ["id"], values: [""] });
    const r = await call("GET", `/api/r3_posts?cursor=${c}&count=exact`);
    expect(r.body.data.map((x: { id: string }) => x.id).sort()).toEqual(["pub1", "pub2", "pub3"]);
  });

  it("keyset pagination stays complete and duplicate-free with NULL sort values, both directions", async () => {
    const p = env.DB.prepare("INSERT INTO r3_posts (id, author_id, title, status, score) VALUES (?, ?, 't', 'published', ?)");
    await env.DB.batch([p.bind("n1", BOB, null), p.bind("n2", BOB, null), p.bind("n3", BOB, 20), p.bind("n4", ALICE, null)]);
    const expected = ["n1", "n2", "n3", "n4", "pub1", "pub2", "pub3"];
    for (const sort of ["score", "-score", "-score,-id", "score,-id"]) {
      for (const limit of [1, 2, 3]) {
        const got: string[] = [];
        let cursor: string | null = null;
        let n = 0;
        do {
          const r = await call("GET", `/api/r3_posts?sort=${sort}&limit=${limit}&count=exact${cursor ? `&cursor=${cursor}` : ""}`);
          expect(r.status, r.text).toBe(200);
          expect(r.body.count).toBe(7);
          got.push(...r.body.data.map((x: { id: string }) => x.id));
          cursor = r.body.nextCursor;
        } while (cursor && ++n < 20);
        expect(got.length, `${sort} limit ${limit}`).toBe(7);
        expect([...got].sort()).toEqual(expected);
      }
    }
  });

  it("a LIKE pattern SQLite refuses as too complex is a client error (400), not a 500", async () => {
    const r = await call("GET", `/api/r3_posts?title=like.${"*a".repeat(120)}b`);
    expectProblem(r, 400);
  });

  it("maxLimit clamps, limit=0 / negative / non-numeric / huge offset are 400", async () => {
    expect((await call("GET", "/api/r3_posts?limit=999999", { as: ADMIN, roles: ["admin"] })).body.data.length).toBe(5);
    for (const q of ["limit=0", "limit=-1", "limit=1e2", "limit=abc", "offset=100001", "offset=-1", "limit=1&offset=0&cursor=abc"]) {
      expectProblem(await call("GET", `/api/r3_posts?${q}`), 400);
    }
  });
});

// -------------------------------------------------------------------------------------------------
describe("review3: includes obey the included table's own policy", () => {
  it("many-to-one to a table anonymous cannot read is null, not 401, and never leaks", async () => {
    const r = await call("GET", "/api/r3_posts?include=author");
    expect(r.status).toBe(200);
    for (const p of r.body.data) expect(p.author).toBeNull();
  });

  it("included users rows are projected: hidden never, visibleTo only for self/admin", async () => {
    const r = await call("GET", "/api/r3_posts?include=author&limit=50", { as: BOB });
    expect(r.status).toBe(200);
    for (const p of r.body.data) {
      expect(p.author).not.toBeNull();
      expect(p.author).not.toHaveProperty("secret");
      expect(p.author).not.toHaveProperty("notes");
      // r3_users has no selfColumn (ADR 0006), so `self` never matches: email is admin-only here.
      expect(p.author).not.toHaveProperty("email");
      expect(p).not.toHaveProperty("secret");
      expect(p).not.toHaveProperty("ghost_id");
      expect(p).not.toHaveProperty("notes");
    }
  });

  it("a relation through a hidden FK (ghost_id → ghost) is unavailable and answers like an unknown include", async () => {
    const a = await call("GET", "/api/r3_posts?include=ghost", { as: ADMIN, roles: ["admin"] });
    const b = await call("GET", "/api/r3_posts?include=zz_nope", { as: ADMIN, roles: ["admin"] });
    expectProblem(a, 400);
    expect(a.text.replace("ghost", "X")).toBe(b.text.replace("zz_nope", "X"));
  });

  it("includes of reserved, unrelated or closed tables are refused like unknown names", async () => {
    for (const n of ["user", "session", "_castra_roles", "r3_items", "r3_log", "r3_users", "author_id", "__proto__", "constructor", "secret"]) {
      const r = await call("GET", `/api/r3_posts?include=${n}`, { as: ADMIN, roles: ["admin"] });
      expectProblem(r, 400);
      expect(r.body.detail).toBe(`include "${n}" is not available`);
    }
  });

  it("many-to-one where the parent post is invisible yields null (comment on alice's draft, seen by bob)", async () => {
    const r = await call("GET", "/api/r3_comments/c2?include=post", { as: BOB });
    expect(r.status).toBe(200);
    expect(r.body.post).toBeNull();
    const own = await call("GET", "/api/r3_comments/c2?include=post", { as: ALICE });
    expect(own.body.post.id).toBe("draftA");
    expect(own.body.post).not.toHaveProperty("secret");
  });

  it("one-to-many is capped at 25 per parent and only counts rows the caller may read", async () => {
    const c = env.DB.prepare("INSERT INTO r3_comments (id, post_id, user_id, body) VALUES (?, ?, ?, ?)");
    await env.DB.batch(Array.from({ length: 30 }, (_, i) => c.bind(`cc${String(i).padStart(2, "0")}`, "pub3", BOB, `b${i}`)));
    const r = await call("GET", "/api/r3_posts/pub3?include=r3_comments");
    expect(r.status).toBe(200);
    expect(r.body.r3_comments.length).toBe(25);
    // A draft's children never surface through a parent the caller cannot see.
    const list = await call("GET", "/api/r3_posts?include=r3_comments&limit=50");
    for (const p of list.body.data) for (const cm of p.r3_comments) expect(cm.post_id).toBe(p.id);
    expect(list.text).not.toContain("on alice draft");
  });

  it("duplicate include names are de-duplicated (one key, one query)", async () => {
    const r = await call("GET", "/api/r3_posts/pub1?include=author,author", { as: BOB });
    expect(r.status).toBe(200);
    expect(r.body.author.id).toBe(ALICE);
  });
});

// -------------------------------------------------------------------------------------------------
describe("review3: writes", () => {
  it("owner spoofing on create is 403 and nothing is written; same id is accepted", async () => {
    expectProblem(await call("POST", "/api/r3_posts", { as: BOB, body: { title: "x", author_id: ALICE } }), 403);
    expect((await db.selectFrom("r3_posts").select("id").where("title", "=", "x").execute()).length).toBe(0);
    const ok = await call("POST", "/api/r3_posts", { as: BOB, body: { title: "x", author_id: BOB } });
    expect(ok.status).toBe(201);
    expect(ok.body.author_id).toBe(BOB);
  });

  it("client-supplied primary keys are rejected on create (uuid and rowid tables)", async () => {
    expectProblem(await call("POST", "/api/r3_posts", { as: BOB, body: { id: "pub1", title: "x" } }), 400);
    expectProblem(await call("POST", "/api/r3_items", { as: BOB, body: { id: 1, status: "ok" } }), 400);
  });

  it("PATCH cannot change the primary key or the owner", async () => {
    expectProblem(await call("PATCH", "/api/r3_posts/pub1", { as: ALICE, body: { id: "zzz" } }), 400);
    expectProblem(await call("PATCH", "/api/r3_posts/pub1", { as: ALICE, body: { author_id: BOB } }), 403);
    expectProblem(await call("PATCH", "/api/r3_posts/pub1", { as: EDITOR, roles: ["editor"], body: { author_id: EDITOR } }), 403);
    const row = await db.selectFrom("r3_posts").selectAll().where("id", "=", "pub1").executeTakeFirst();
    expect(row!.author_id).toBe(ALICE);
  });

  it("PATCH/DELETE on a readable-but-not-writable row is the same 404 as a missing row", async () => {
    const a = await call("PATCH", "/api/r3_posts/pub1", { as: BOB, body: { title: "pwn" } });
    const b = await call("PATCH", "/api/r3_posts/does-not-exist", { as: BOB, body: { title: "pwn" } });
    const c = await call("PATCH", "/api/r3_posts/draftA", { as: BOB, body: { title: "pwn" } });
    expectProblem(a, 404);
    expect(a.text).toBe(b.text);
    expect(c.text).toBe(b.text);
    const d1 = await call("PATCH", "/api/r3_comments/c1", { as: ALICE, body: { body: "pwn" } });
    const d2 = await call("DELETE", "/api/r3_comments/c1", { as: ALICE });
    const d3 = await call("DELETE", "/api/r3_comments/nope", { as: ALICE });
    expect([d1.status, d2.status, d3.status]).toEqual([404, 404, 404]);
    expect(d2.text).toBe(d3.text);
    expect((await db.selectFrom("r3_comments").select("body").where("id", "=", "c1").executeTakeFirst())!.body).toBe("nice");
  });

  it("DELETE under policy: non-admin 403/401 for a constant-false rule, admin deletes, then 404", async () => {
    expectProblem(await call("DELETE", "/api/r3_posts/pub3", { as: BOB }), 403);
    expectProblem(await call("DELETE", "/api/r3_posts/pub3"), 401);
    expect((await call("DELETE", "/api/r3_posts/pub3", { as: ADMIN, roles: ["admin"] })).status).toBe(204);
    expectProblem(await call("DELETE", "/api/r3_posts/pub3", { as: ADMIN, roles: ["admin"] }), 404);
    // pub1 has a comment: the FK makes it a generic 409 without the database message.
    expectProblem(await call("DELETE", "/api/r3_posts/pub1", { as: ADMIN, roles: ["admin"] }), 409);
  });

  it("prototype keys in JSON are rejected and never reach D1", async () => {
    for (const raw of [
      `{"title":"proto","__proto__":{"author_id":"${ALICE}"}}`,
      `{"title":"proto","constructor":{"prototype":{"x":1}}}`,
      `{"title":"proto","__proto__":null}`,
      `{"title":"proto","toString":"x"}`,
    ]) {
      expectProblem(await call("POST", "/api/r3_posts", { as: BOB, raw }), 400);
      expectProblem(await call("PATCH", "/api/r3_posts/pub2", { as: BOB, raw }), 400);
    }
    expect((await db.selectFrom("r3_posts").select("id").where("title", "=", "proto").execute()).length).toBe(0);
  });

  it("non-object JSON bodies are 400; invalid JSON is 400; empty PATCH is 400", async () => {
    for (const raw of ["[]", '"x"', "null", "1", "true", "[{}]", "{", ""]) {
      expectProblem(await call("POST", "/api/r3_posts", { as: BOB, raw }), 400);
    }
    expectProblem(await call("PATCH", "/api/r3_posts/pub2", { as: BOB, raw: "{}" }), 400);
  });

  it("content-type: missing, text/plain, form, application/jsonx are 415; charset param is fine", async () => {
    for (const type of [null, "text/plain", "application/x-www-form-urlencoded", "application/jsonx", "application/json-patch+json", "multipart/form-data"]) {
      expectProblem(await call("POST", "/api/r3_posts", { as: BOB, raw: '{"title":"ct"}', type }), 415);
    }
    expect((await call("POST", "/api/r3_posts", { as: BOB, raw: '{"title":"ct"}', type: "Application/JSON; charset=utf-8" })).status).toBe(201);
  });

  it("bodies over 1 MiB are 413, with and without content-length (chunked)", async () => {
    const big = JSON.stringify({ title: "a".repeat(1024 * 1024 + 10) });
    expectProblem(await call("POST", "/api/r3_posts", { as: BOB, raw: big }), 413);
    const enc = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (let i = 0; i < enc.length; i += 65536) ctrl.enqueue(enc.slice(i, i + 65536));
        ctrl.close();
      },
    });
    expectProblem(await call("POST", "/api/r3_posts", { as: BOB, raw: stream }), 413);
    expectProblem(await call("PATCH", "/api/r3_posts/pub2", { as: BOB, raw: big }), 413);
    expect((await db.selectFrom("r3_posts").select("id").where("author_id", "=", BOB).execute()).length).toBe(3);
  });

  it("type coercion: wrong JSON types never reach D1", async () => {
    for (const score of ["5", true, false, {}, [], [1], 1.5, 2 ** 53, -(2 ** 53), "1e2", { valueOf: 1 }]) {
      expectProblem(await call("POST", "/api/r3_posts", { as: BOB, body: { title: "typed", score } }), 400);
    }
    for (const title of [5, true, null, {}, ["a"]]) {
      expectProblem(await call("POST", "/api/r3_posts", { as: BOB, body: { title } }), 400);
    }
    expect((await db.selectFrom("r3_posts").select("id").where("title", "=", "typed").execute()).length).toBe(0);
  });

  it("hidden columns in write bodies are reported exactly like unknown columns (create and update)", async () => {
    for (const [m, p] of [
      ["POST", "/api/r3_posts"],
      ["PATCH", "/api/r3_posts/pub2"],
    ] as const) {
      for (const col of ["secret", "ghost_id"]) {
        const a = await call(m, p, { as: BOB, body: { [col]: "x" } });
        const b = await call(m, p, { as: BOB, body: { zz_nope: "x" } });
        expectProblem(a, 400);
        expect(a.text.replace(col, "C")).toBe(b.text.replace("zz_nope", "C"));
      }
    }
  });

  it("FK references to rows the caller cannot read are refused like missing rows", async () => {
    const a = await call("POST", "/api/r3_comments", { as: ALICE, body: { post_id: "draftB", body: "x" } });
    const b = await call("POST", "/api/r3_comments", { as: ALICE, body: { post_id: "missing", body: "x" } });
    expectProblem(a, 400);
    expect(a.text).toBe(b.text);
  });

  it("PATCH cannot move a comment onto a post the caller cannot read", async () => {
    const mine = await call("POST", "/api/r3_comments", { as: ALICE, body: { post_id: "pub1", body: "mine" } });
    expect(mine.status).toBe(201);
    const a = await call("PATCH", `/api/r3_comments/${mine.body.id}`, { as: ALICE, body: { post_id: "draftB" } });
    const b = await call("PATCH", `/api/r3_comments/${mine.body.id}`, { as: ALICE, body: { post_id: "missing" } });
    expectProblem(a, 400);
    expect(a.text).toBe(b.text);
  });

  it("server-set user_id cannot be spoofed on comments", async () => {
    expectProblem(await call("POST", "/api/r3_comments", { as: ALICE, body: { post_id: "pub1", user_id: BOB, body: "x" } }), 403);
  });
});

// -------------------------------------------------------------------------------------------------
describe("review3: the write guard checks the stored row (rowid tables, triggers)", () => {
  it("rowid create: the guard and the response address the inserted row even when a trigger inserts elsewhere", async () => {
    const r = await call("POST", "/api/r3_items", { as: BOB, body: { status: "ok" } });
    expect(r.status, r.text).toBe(201);
    const stored = await db.selectFrom("r3_items").selectAll().where("id", "=", r.body.id).executeTakeFirst();
    expect(stored).toMatchObject({ owner_id: BOB, status: "ok" });
    expect(r.body).toMatchObject({ id: stored!.id, owner_id: BOB, status: "ok" });
  });

  it("rowid create violating the create rule is 403 and rolled back (also the trigger's side effects)", async () => {
    const before = await env.DB.prepare("SELECT count(*) AS n FROM r3_log").first<{ n: number }>();
    expectProblem(await call("POST", "/api/r3_items", { as: BOB, body: { status: "bad" } }), 403);
    expect((await db.selectFrom("r3_items").select("id").where("status", "=", "bad").execute()).length).toBe(0);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM r3_log").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("a trigger that re-owns the row after insert/update cannot slip past the guard", async () => {
    // create rule is authenticated + status = 'ok': 'hijack' fails it anyway; the read is owner-only.
    expectProblem(await call("POST", "/api/r3_items", { as: BOB, body: { status: "hijack" } }), 403);
    expect((await db.selectFrom("r3_items").select("id").where("status", "=", "hijack").execute()).length).toBe(0);
    const mine = await call("POST", "/api/r3_items", { as: BOB, body: { status: "ok" } });
    expectProblem(await call("PATCH", `/api/r3_items/${mine.body.id}`, { as: BOB, body: { status: "hijack" } }), 403);
    const row = await db.selectFrom("r3_items").selectAll().where("id", "=", mine.body.id).executeTakeFirst();
    expect(row).toMatchObject({ owner_id: BOB, status: "ok" });
  });

  it("rowid ids in the URL: non-integers and other users' rows are the same 404", async () => {
    const a = await call("PATCH", "/api/r3_items/1", { as: BOB, body: { status: "ok" } });
    const b = await call("PATCH", "/api/r3_items/1.0", { as: BOB, body: { status: "ok" } });
    const c = await call("GET", "/api/r3_items/0x1", { as: BOB });
    const d = await call("GET", "/api/r3_items/999", { as: BOB });
    for (const r of [a, b, c, d]) expectProblem(r, 404);
    expect(new Set([a.text, b.text, c.text, d.text]).size).toBe(1);
    expect((await db.selectFrom("r3_items").selectAll().where("id", "=", 1).executeTakeFirst())!.owner_id).toBe("victim");
  });
});

// -------------------------------------------------------------------------------------------------
describe("review3: errors and OpenAPI", () => {
  it("every unmatched path under the API prefix is a problem+json 404", async () => {
    for (const [m, p] of [
      ["GET", "/api/r3_posts/pub1/extra"],
      ["GET", "/api/"],
      ["GET", "/api/r3_posts/"],
      ["OPTIONS", "/api/r3_posts"],
      ["HEAD", "/api/nope"],
    ] as const) {
      const r = await call(m, p);
      expect(r.status, `${m} ${p}`).toBe(404);
      if (m !== "HEAD") expect(r.type, `${m} ${p}`).toMatch(/^application\/problem\+json/);
    }
  });

  it("OpenAPI lists exactly the open operations and no hidden field or hidden relation", () => {
    const doc = generateOpenApi({ config, snapshot });
    const text = JSON.stringify(doc);
    for (const s of ["secret", "ghost", "r3_log", "r3_items_hijack", "sqlite_", "_castra_"]) expect(text).not.toContain(s);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paths = (doc as any).paths as Record<string, Record<string, unknown>>;
    const ops = Object.entries(paths)
      .flatMap(([p, item]) => Object.keys(item).filter((m) => ["get", "post", "patch", "delete", "put"].includes(m)).map((m) => `${m.toUpperCase()} ${p}`))
      .sort();
    expect(ops).toEqual(
      [
        "GET /api/r3_users",
        "GET /api/r3_users/{id}",
        "GET /api/r3_posts",
        "POST /api/r3_posts",
        "GET /api/r3_posts/{id}",
        "PATCH /api/r3_posts/{id}",
        "DELETE /api/r3_posts/{id}",
        "GET /api/r3_comments",
        "POST /api/r3_comments",
        "GET /api/r3_comments/{id}",
        "PATCH /api/r3_comments/{id}",
        "DELETE /api/r3_comments/{id}",
        "GET /api/r3_items",
        "POST /api/r3_items",
        "GET /api/r3_items/{id}",
        "PATCH /api/r3_items/{id}",
      ].sort(),
    );
  });

  it("no response in this file ever contained a hidden value or a visibleTo value for a non-admin", () => {
    const all = seen.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toMatch(/SQLITE|D1_ERROR|castra_write_check_failed/);
  });
});
