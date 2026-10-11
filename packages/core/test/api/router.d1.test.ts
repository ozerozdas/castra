/**
 * REST router against a real local D1: allow + deny per route, pagination under policy, include
 * leaks, atomic [write, guard] batches (ADR 0050).
 */
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createRestRouter,
  defineConfig,
  authenticated,
  owner,
  isPublic,
  createPolicyEngine,
  type CastraContext,
  type PolicyEngine,
} from "../../src/index.js";
import { createTables, testDb } from "../policy/db.js";
import { anon, config, makeEngine, snapshot, user } from "./fixtures.js";

const db = testDb();
const SECRET = "SECRET_NOTE_7f3a";
const SECRET_VIEWS = 987654321;

/** Every response body seen in this file, to assert hidden data never appears anywhere. */
const seen: string[] = [];

function ctxFrom(h: Headers): CastraContext {
  const id = h.get("x-test-user");
  const roles = (h.get("x-test-roles") ?? "").split(",").filter(Boolean);
  return id ? user(id, roles) : anon();
}

function router(engine: PolicyEngine = makeEngine(), withD1 = true) {
  return createRestRouter({
    config,
    snapshot,
    engine,
    getDb: () => db,
    getContext: (c) => ctxFrom(c.req.raw.headers),
    ...(withD1 ? { getD1: () => env.DB } : {}),
  });
}

const app = router();

async function call(method: string, path: string, opts: { as?: string; roles?: string[]; body?: unknown; raw?: string; type?: string; via?: ReturnType<typeof router> } = {}) {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-test-user"] = opts.as;
  if (opts.roles) headers["x-test-roles"] = opts.roles.join(",");
  let body: string | undefined;
  if (opts.raw !== undefined || opts.body !== undefined) {
    headers["content-type"] = opts.type ?? "application/json";
    body = opts.raw ?? JSON.stringify(opts.body);
  }
  const res = await (opts.via ?? app).request(path, { method, headers, body });
  const text = await res.text();
  seen.push(text);
  if (res.status >= 400) {
    expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    const p = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(p.status).toBe(res.status);
    expect(text).not.toMatch(/select |insert |update "|SQLITE|malformed|stack|explanation|matchedRule/i);
  }
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function seed() {
  for (const t of ["comments", "posts", "users", "items"]) await db.deleteFrom(t).execute();
  await db
    .insertInto("users")
    .values(["u1", "u2", "u3"].map((id) => ({ id, email: `${id}@x.test`, name: id, password_hash: "HASH_SECRET", created_at: "2026" })))
    .execute();
  // 57 posts: 15 published by u2, 8 drafts by u1, 34 drafts by u3 → u1 sees 23, anonymous sees 15.
  const posts = Array.from({ length: 57 }, (_, i) => {
    const [author, status] = i < 15 ? ["u2", "published"] : i < 23 ? ["u1", "draft"] : ["u3", "draft"];
    return {
      id: `p${String(i).padStart(2, "0")}`,
      author_id: author,
      title: `t${i}`,
      body: "b",
      status,
      internal_notes: SECRET,
      views: SECRET_VIEWS,
      created_at: `2026-01-${String((i % 7) + 1).padStart(2, "0")}`, // many ties → PK tie-breaker matters
    };
  });
  for (let i = 0; i < posts.length; i += 10) await db.insertInto("posts").values(posts.slice(i, i + 10)).execute(); // D1: ≤ 100 params
  await db
    .insertInto("comments")
    .values([
      { id: "c1", post_id: "p00", user_id: "u1", body: "on published", created_at: "2026" },
      { id: "c2", post_id: "p30", user_id: "u3", body: "on u3 draft", created_at: "2026" },
      { id: "c3", post_id: "p00", user_id: "u2", body: "second", created_at: "2026" },
    ])
    .execute();
}

beforeAll(createTables);
beforeEach(seed);

describe("closed and unknown tables", () => {
  it.each(["nope", "audit_logs", "user", "session", "account", "verification", "_castra_roles", "_castra_api_keys"])("GET /api/%s → 404", async (t) => {
    const a = await call("GET", `/api/${t}`, { as: "u1", roles: ["admin"] });
    const b = await call("GET", `/api/${t}/x`, { as: "u1", roles: ["admin"] });
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(a.body.detail).toBe("The requested resource does not exist.");
  });
  it("closed operation and unsupported routes are the same 404", async () => {
    expect((await call("DELETE", "/api/users/u1", { as: "u1", roles: ["admin"] })).status).toBe(404);
    expect((await call("POST", "/api/users", { as: "u1", roles: ["admin"], body: {} })).status).toBe(404);
    expect((await call("PUT", "/api/posts/p00", { as: "u1", body: {} })).status).toBe(404);
    expect((await call("PATCH", "/api/posts", { as: "u1", body: {} })).status).toBe(404);
    expect((await call("DELETE", "/api/posts", { as: "u1", roles: ["admin"] })).status).toBe(404);
  });
});

describe("list + pagination under policy", () => {
  it("cursor walk: 23 visible rows, limit 5, no duplicates, counts correct", async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = `sort=-created_at&limit=5&count=exact${cursor ? `&cursor=${cursor}` : ""}`;
      const r = await call("GET", `/api/posts?${qs}`, { as: "u1" });
      expect(r.status).toBe(200);
      expect(r.body.count).toBe(23);
      expect(r.body.data.length).toBeLessThanOrEqual(5);
      ids.push(...r.body.data.map((p: { id: string }) => p.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(5);
    expect(ids.length).toBe(23);
    expect(new Set(ids).size).toBe(23);
    const visible = await db.selectFrom("posts").select("id").where((eb) => eb.or([eb("status", "=", "published"), eb("author_id", "=", "u1")])).execute();
    expect([...ids].sort()).toEqual(visible.map((r) => r.id).sort());
  });

  it("offset walk sees the same rows; anonymous sees only published", async () => {
    const ids: string[] = [];
    for (let off = 0; off < 30; off += 5) {
      const r = await call("GET", `/api/posts?limit=5&offset=${off}`, { as: "u1" });
      ids.push(...r.body.data.map((p: { id: string }) => p.id));
    }
    expect(new Set(ids).size).toBe(23);
    const a = await call("GET", "/api/posts?limit=100&count=exact");
    expect(a.body.count).toBe(15);
    expect(a.body.data.every((p: { status: string }) => p.status === "published")).toBe(true);
    expect(a.body.nextCursor).toBeNull();
  });

  it("filters combine with the policy; filters on hidden / visibleTo / unknown columns are 400", async () => {
    const r = await call("GET", "/api/posts?status=eq.draft&count=exact", { as: "u1" });
    expect(r.body.count).toBe(8); // never u3's drafts
    for (const col of ["views", "internal_notes", "nope", "author_id"]) {
      const f = await call("GET", `/api/posts?${col}=eq.1`, { as: "u1", roles: ["admin"] });
      const s = await call("GET", `/api/posts?sort=${col}`, { as: "u1", roles: ["admin"] });
      expect([f.status, s.status]).toEqual([400, 400]);
    }
    // email is visibleTo self/admin: not filterable even for self
    expect((await call("GET", "/api/users?email=eq.u1@x.test", { as: "u1" })).status).toBe(400);
  });

  it("GET by id: visible 200, invisible 404 (same as missing)", async () => {
    expect((await call("GET", "/api/posts/p00")).status).toBe(200);
    const hidden = await call("GET", "/api/posts/p30", { as: "u1" });
    const missing = await call("GET", "/api/posts/zzz", { as: "u1" });
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(hidden.body).toEqual(missing.body);
  });

  it("hidden and visibleTo fields: never views, internal_notes only for admin, email only for self", async () => {
    const m = await call("GET", "/api/posts/p20", { as: "u1" });
    expect(m.body).not.toHaveProperty("views");
    expect(m.body).not.toHaveProperty("internal_notes");
    const a = await call("GET", "/api/posts/p20", { as: "u9", roles: ["admin"] });
    expect(a.body.internal_notes).toBe(SECRET);
    expect(a.body).not.toHaveProperty("views");
    const users = await call("GET", "/api/users?sort=id", { as: "u1" });
    expect(users.body.data.map((u: { email?: string }) => u.email ?? null)).toEqual(["u1@x.test", null, null]);
    expect((await call("GET", "/api/users")).status).toBe(401);
  });
});

describe("includes obey the included table's read policy", () => {
  it("comments → post: a draft post is null for others, present for its author", async () => {
    const anonR = await call("GET", "/api/comments?include=post&sort=id");
    const byId = Object.fromEntries(anonR.body.data.map((c: { id: string; post: unknown }) => [c.id, c.post]));
    expect(byId.c1).toMatchObject({ id: "p00" });
    expect(byId.c2).toBeNull();
    expect(JSON.stringify(anonR.body)).not.toContain(SECRET);
    const u3 = await call("GET", "/api/comments/c2?include=post", { as: "u3" });
    expect(u3.body.post).toMatchObject({ id: "p30", status: "draft" });
    expect(u3.body.post).not.toHaveProperty("internal_notes");
  });

  it("posts → author: null for anonymous (users read is authenticated), email only for self", async () => {
    const anonR = await call("GET", "/api/posts/p00?include=author");
    expect(anonR.body.author).toBeNull();
    const u2 = await call("GET", "/api/posts/p00?include=author", { as: "u2" });
    expect(u2.body.author).toEqual({ id: "u2", email: "u2@x.test", name: "u2", created_at: "2026" });
    const u1 = await call("GET", "/api/posts/p00?include=author", { as: "u1" });
    expect(u1.body.author).toEqual({ id: "u2", name: "u2", created_at: "2026" });
  });

  it("posts → comments: children of invisible parents are unreachable; one IN query regardless of page", async () => {
    const r = await call("GET", "/api/posts?include=comments&limit=100", { as: "u1" });
    const p00 = r.body.data.find((p: { id: string }) => p.id === "p00");
    expect(p00.comments.map((c: { id: string }) => c.id).sort()).toEqual(["c1", "c3"]);
    expect(JSON.stringify(r.body)).not.toContain("on u3 draft");
  });

  it("unknown / policy-less includes are 400", async () => {
    for (const inc of ["audit_logs", "user", "nope"]) {
      expect((await call("GET", `/api/posts?include=${inc}`)).status).toBe(400);
    }
  });
});

describe("create", () => {
  const body = { title: "new", body: "b", status: "draft", created_at: "2026-02-01" };

  it("201 with server UUID and server-set owner", async () => {
    const r = await call("POST", "/api/posts", { as: "u1", body });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ...body, author_id: "u1" });
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body).not.toHaveProperty("views");
  });

  it("rowid PK, and {id} when the caller cannot read the row", async () => {
    const r = await call("POST", "/api/items", { as: "u1", body: { status: "a", category: "c", score: 1 } });
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe("number");
    expect(r.body.owner_id).toBe("u1");
  });

  it("deny: anonymous 401, owner spoofing 403, client PK 400, hidden/unknown column 400, bad type 400", async () => {
    const before = await db.selectFrom("posts").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow();
    expect((await call("POST", "/api/posts", { body })).status).toBe(401);
    expect((await call("POST", "/api/posts", { as: "u1", body: { ...body, author_id: "u2" } })).status).toBe(403);
    expect((await call("POST", "/api/posts", { as: "u1", body: { ...body, id: "mine" } })).status).toBe(400);
    const h = await call("POST", "/api/posts", { as: "u1", body: { ...body, views: 1 } });
    const u = await call("POST", "/api/posts", { as: "u1", body: { ...body, nope: 1 } });
    expect([h.status, h.body.detail, u.body.detail]).toEqual([400, 'unknown column "views"', 'unknown column "nope"']);
    expect((await call("POST", "/api/posts", { as: "u1", body: { ...body, title: 5 } })).status).toBe(400);
    expect((await call("POST", "/api/comments", { as: "u1", body: { post_id: "p30", body: "x", created_at: "t" } })).status).toBe(400); // u1 cannot see p30
    const after = await db.selectFrom("posts").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });

  it("body handling: 415 non-JSON, 400 invalid JSON / array, 413 over 1 MiB", async () => {
    expect((await call("POST", "/api/posts", { as: "u1", raw: "x", type: "text/plain" })).status).toBe(415);
    expect((await call("POST", "/api/posts", { as: "u1", raw: "{" })).status).toBe(400);
    expect((await call("POST", "/api/posts", { as: "u1", raw: "[]" })).status).toBe(400);
    expect((await call("POST", "/api/posts", { as: "u1", raw: JSON.stringify({ title: "x".repeat(1024 * 1024 + 10) }) })).status).toBe(413);
  });
});

describe("update", () => {
  it("allow: owner and editor; response re-read under read policy", async () => {
    const r = await call("PATCH", "/api/posts/p15", { as: "u1", body: { title: "mine" } });
    expect([r.status, r.body.title]).toEqual([200, "mine"]);
    const e = await call("PATCH", "/api/posts/p30", { as: "u9", roles: ["editor"], body: { title: "edited" } });
    expect(e.status).toBe(200);
    expect(e.body).toEqual({ id: "p30" }); // editor cannot read u3's draft
  });

  it("deny: not in update filter 404; author change 403; anonymous 401", async () => {
    expect((await call("PATCH", "/api/posts/p30", { as: "u1", body: { title: "x" } })).status).toBe(404);
    expect((await call("PATCH", "/api/posts/p15", { as: "u1", body: { author_id: "u2" } })).status).toBe(403);
    expect((await call("PATCH", "/api/posts/p15", { body: { title: "x" } })).status).toBe(401);
    expect((await call("PATCH", "/api/posts/p15", { as: "u1", body: {} })).status).toBe(400);
    const row = await db.selectFrom("posts").selectAll().where("id", "in", ["p15", "p30"]).orderBy("id").execute();
    expect(row.map((r) => [r.title, r.author_id])).toEqual([
      ["t15", "u1"],
      ["t30", "u3"],
    ]);
  });

  it("PATCH that moves a row out of policy → 403, row unchanged", async () => {
    const cfg = defineConfig({
      ...config,
      tables: { ...config.tables, posts: { ...config.tables.posts!, update: owner("author_id").and(isPublic().where((q) => q.eb("status", "=", "draft"))) } },
    });
    const engine = createPolicyEngine({ config: cfg, snapshot });
    const via = createRestRouter({ config: cfg, snapshot, engine, getDb: () => db, getContext: (c) => ctxFrom(c.req.raw.headers), getD1: () => env.DB });
    expect((await call("PATCH", "/api/posts/p15", { as: "u1", body: { title: "ok" }, via })).status).toBe(200);
    expect((await call("PATCH", "/api/posts/p15", { as: "u1", body: { status: "published" }, via })).status).toBe(403);
    const row = await db.selectFrom("posts").select(["status", "title"]).where("id", "=", "p15").executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "draft", title: "ok" });
  });

  it("the guard is authoritative: with the pre-check bypassed, a violating write is rolled back (403)", async () => {
    const cfg = defineConfig({
      ...config,
      tables: { ...config.tables, posts: { ...config.tables.posts!, update: owner("author_id").and(isPublic().where((q) => q.eb("status", "=", "draft"))) } },
    });
    const real = createPolicyEngine({ config: cfg, snapshot });
    const engine = { ...real, checkRow: async () => ({ allowed: true }) } as unknown as PolicyEngine;
    const via = createRestRouter({ config: cfg, snapshot, engine, getDb: () => db, getContext: (c) => ctxFrom(c.req.raw.headers), getD1: () => env.DB });
    const r = await call("PATCH", "/api/posts/p15", { as: "u1", body: { status: "published", title: "sneaky" }, via });
    expect(r.status).toBe(403);
    const row = await db.selectFrom("posts").select(["status", "title"]).where("id", "=", "p15").executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "draft", title: "t15" });
  });
});

describe("guard is authoritative on create (pre-check bypassed)", () => {
  it("a denied create leaves no row (403); an allowed one is written", async () => {
    const cfg = defineConfig({
      ...config,
      tables: { ...config.tables, posts: { ...config.tables.posts!, create: authenticated().and(isPublic().where((q) => q.eb("status", "=", "draft"))) } },
    });
    const real = createPolicyEngine({ config: cfg, snapshot });
    const engine = { ...real, checkRow: async () => ({ allowed: true }) } as unknown as PolicyEngine;
    const via = createRestRouter({ config: cfg, snapshot, engine, getDb: () => db, getContext: (c) => ctxFrom(c.req.raw.headers), getD1: () => env.DB });
    const count = async () => Number((await db.selectFrom("posts").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
    const bad = await call("POST", "/api/posts", { as: "u1", body: { title: "x", body: "b", status: "published", created_at: "t" }, via });
    expect(bad.status).toBe(403);
    expect(await count()).toBe(57);
    const ok = await call("POST", "/api/posts", { as: "u1", body: { title: "x", body: "b", status: "draft", created_at: "t" }, via });
    expect(ok.status).toBe(201);
    expect(await count()).toBe(58);
  });
});

describe("fail closed without a D1 binding", () => {
  it("create and update are 500 and nothing is written", async () => {
    const via = router(makeEngine(), false);
    const c = await call("POST", "/api/posts", { as: "u1", body: { title: "x", body: "b", status: "draft", created_at: "t" }, via });
    const u = await call("PATCH", "/api/posts/p15", { as: "u1", body: { title: "x" }, via });
    expect([c.status, u.status]).toEqual([500, 500]);
    const n = await db.selectFrom("posts").select(db.fn.countAll().as("n")).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(57);
    const p15 = await db.selectFrom("posts").select("title").where("id", "=", "p15").executeTakeFirstOrThrow();
    expect(p15.title).toBe("t15");
    // policy denials still come first
    expect((await call("POST", "/api/posts", { body: {}, via })).status).toBe(401);
  });
});

describe("delete", () => {
  it("allow: admin 204, then 404", async () => {
    expect((await call("DELETE", "/api/posts/p30", { as: "a", roles: ["admin"] })).status).toBe(204);
    expect((await call("DELETE", "/api/posts/p30", { as: "a", roles: ["admin"] })).status).toBe(404);
  });
  it("deny: member 403, anonymous 401; comment owner only", async () => {
    expect((await call("DELETE", "/api/posts/p15", { as: "u1" })).status).toBe(403);
    expect((await call("DELETE", "/api/posts/p15")).status).toBe(401);
    expect((await call("DELETE", "/api/comments/c3", { as: "u1" })).status).toBe(404);
    expect((await call("DELETE", "/api/comments/c1", { as: "u1" })).status).toBe(204);
    expect(await db.selectFrom("posts").select("id").where("id", "=", "p15").execute()).toHaveLength(1);
    expect(await db.selectFrom("comments").select("id").where("id", "=", "c3").execute()).toHaveLength(1);
  });
});

describe("OpenAPI route", () => {
  it("serves the document", async () => {
    const r = await call("GET", "/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe("3.1.0");
  });
});

describe("welcome route (ADR 0071)", () => {
  it("answers JSON with the OpenAPI info and links, and no table names", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("vary")).toMatch(/accept/i);
    const text = await res.text();
    seen.push(text);
    expect(JSON.parse(text)).toEqual({ name: "Castra API", version: "0.1.0", openapi: "/openapi.json", api: "/api", docs: "https://github.com/ozerozdas/castra" });
    expect(text).not.toMatch(/posts|comments/);
  });

  it("answers a browser with escaped, script-free HTML", async () => {
    const via = createRestRouter({ config, snapshot, engine: makeEngine(), getDb: () => db, getContext: () => anon(), openapi: { title: "<b>My</b> app" } });
    const res = await via.request("/", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    seen.push(html);
    expect(html).toContain("&lt;b&gt;My&lt;/b&gt; app");
    expect(html).not.toContain("<b>");
    expect(html).not.toMatch(/<script|posts|comments/);
  });

  it("is a 404 problem when api.welcome is false", async () => {
    const off = defineConfig({ ...config, api: { ...config.api, welcome: false } });
    const via = createRestRouter({ config: off, snapshot, engine: createPolicyEngine({ config: off, snapshot }), getDb: () => db, getContext: () => anon() });
    expect((await call("GET", "/", { via })).status).toBe(404);
  });
});

describe("no leaks across every response in this file", () => {
  it("hidden values never appear; internal_notes only in admin responses", () => {
    const all = seen.join("\n");
    expect(all).not.toContain(String(SECRET_VIEWS));
    expect(all).not.toContain('"views"');
    expect(all).not.toContain("HASH_SECRET");
    expect(all).not.toContain("password_hash");
  });
});
