/**
 * REST API end to end on the blog Worker: real Better Auth sessions, real D1, the example config.
 * The policy engine's writeGuard is not merged yet (ADR 0043): until it is, creates/updates must fail
 * closed; the success paths are skipped and switch on automatically once `engine.writeGuard` exists.
 */
import { assignRole } from "@castra/auth";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { authOptions, engine } from "../src/index";

const BASE = "http://localhost";
const hasWriteGuard = typeof (engine as { writeGuard?: unknown }).writeGuard === "function";
const seen: string[] = [];

interface Who {
  id: string;
  headers: Record<string, string>;
}

async function call(method: string, path: string, who?: Who, body?: unknown) {
  const headers: Record<string, string> = { ...(who?.headers ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await exports.default.fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  seen.push(text);
  if (res.status >= 400) {
    expect(res.headers.get("content-type"), `${method} ${path}`).toMatch(/^application\/problem\+json/);
    const p = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(text).not.toMatch(/select |insert |SQLITE|stack|matchedRule|hiddenFields/i);
  }
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function signUp(role?: string): Promise<Who> {
  const email = `api-${crypto.randomUUID()}@example.com`;
  const res = await exports.default.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "API" }),
  });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string } };
  if (role) await assignRole(env.DB, user.id, role, authOptions.roles);
  // @castra/auth mirrors the user into the app `users` table that posts/comments reference.
  return { id: user.id, headers: { authorization: `Bearer ${res.headers.get("set-auth-token")}` } };
}

const NOTE = `internal-${crypto.randomUUID()}`;
let alice: Who, bob: Who, admin: Who, editor: Who;
const ids = { published: crypto.randomUUID(), draft: crypto.randomUUID(), bobPost: crypto.randomUUID(), c1: crypto.randomUUID(), c2: crypto.randomUUID() };

beforeAll(async () => {
  [alice, bob, admin, editor] = await Promise.all([signUp(), signUp(), signUp("admin"), signUp("editor")]);
  const insertPost = env.DB.prepare("INSERT INTO posts (id, author_id, title, body, status, internal_notes) VALUES (?, ?, ?, ?, ?, ?)");
  const insertComment = env.DB.prepare("INSERT INTO comments (id, post_id, user_id, body) VALUES (?, ?, ?, ?)");
  await env.DB.batch([
    insertPost.bind(ids.published, alice.id, "Published", "b", "published", NOTE),
    insertPost.bind(ids.draft, alice.id, "Draft", "b", "draft", NOTE),
    insertPost.bind(ids.bobPost, bob.id, "Bob", "b", "published", null),
    insertComment.bind(ids.c1, ids.published, bob.id, "visible"),
    insertComment.bind(ids.c2, ids.draft, alice.id, "on a draft"),
  ]);
});

describe("routes that must not exist", () => {
  it.each(["audit_logs", "user", "session", "account", "verification", "_castra_roles", "_castra_api_keys", "nope"])("%s → 404", async (t) => {
    const list = await call("GET", `/api/${t}`, admin);
    const one = await call("GET", `/api/${t}/x`, admin);
    expect([list.status, one.status]).toEqual([404, 404]);
  });
  it("closed ops are 404 too", async () => {
    expect((await call("POST", "/api/users", admin, { name: "x" })).status).toBe(404);
    expect((await call("DELETE", `/api/users/${alice.id}`, admin)).status).toBe(404);
  });
  it("existing routes still work", async () => {
    expect((await call("GET", "/health")).status).toBe(200);
    expect((await call("GET", "/me", alice)).body.user.id).toBe(alice.id);
  });
});

describe("read", () => {
  it("anonymous sees published posts only, without internal_notes", async () => {
    const r = await call("GET", `/api/posts?limit=100&count=exact`);
    expect(r.status).toBe(200);
    const mine = r.body.data.filter((p: { id: string }) => Object.values(ids).includes(p.id)).map((p: { id: string }) => p.id);
    expect(mine.sort()).toEqual([ids.published, ids.bobPost].sort());
    expect(r.body.data.every((p: { status: string }) => p.status === "published")).toBe(true);
    expect(r.body.data.some((p: object) => "internal_notes" in p)).toBe(false);
  });
  it("owner sees own draft; others get 404", async () => {
    expect((await call("GET", `/api/posts/${ids.draft}`, alice)).status).toBe(200);
    expect((await call("GET", `/api/posts/${ids.draft}`, bob)).status).toBe(404);
    expect((await call("GET", `/api/posts/${ids.draft}`)).status).toBe(404);
  });
  it("internal_notes only for admin; not filterable by others", async () => {
    expect((await call("GET", `/api/posts/${ids.published}`, admin)).body.internal_notes).toBe(NOTE);
    expect((await call("GET", `/api/posts/${ids.published}`, alice)).body).not.toHaveProperty("internal_notes");
    expect((await call("GET", `/api/posts?internal_notes=eq.x`, alice)).status).toBe(400);
    expect((await call("GET", `/api/posts?sort=internal_notes`, alice)).status).toBe(400);
    expect((await call("GET", `/api/posts?nope=eq.x`, alice)).status).toBe(400);
  });
  it("users: email only for self (and admin), anonymous 401", async () => {
    expect((await call("GET", `/api/users/${alice.id}`, alice)).body.email).toMatch(/@example\.com$/);
    expect((await call("GET", `/api/users/${alice.id}`, bob)).body).not.toHaveProperty("email");
    expect((await call("GET", `/api/users/${alice.id}`, admin)).body.email).toMatch(/@example\.com$/);
    expect((await call("GET", "/api/users")).status).toBe(401);
    expect((await call("GET", "/api/users?email=eq.x", bob)).status).toBe(400);
  });
  it("cursor pagination returns each visible row once", async () => {
    const seenIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { body: { data: { id: string }[]; nextCursor: string | null } } = await call("GET", `/api/posts?limit=1&sort=-created_at${cursor ? `&cursor=${cursor}` : ""}`, alice);
      seenIds.push(...r.body.data.map((p) => p.id));
      cursor = r.body.nextCursor;
    } while (cursor && ++pages < 50);
    expect(new Set(seenIds).size).toBe(seenIds.length);
    expect(seenIds).toEqual(expect.arrayContaining([ids.published, ids.draft, ids.bobPost]));
  });
});

describe("includes", () => {
  it("comments of an invisible post: the post is null", async () => {
    const r = await call("GET", `/api/comments/${ids.c2}?include=post`);
    expect(r.status).toBe(200);
    expect(r.body.post).toBeNull();
    const own = await call("GET", `/api/comments/${ids.c2}?include=post`, alice);
    expect(own.body.post.id).toBe(ids.draft);
  });
  it("post → author obeys users.read and email visibility", async () => {
    expect((await call("GET", `/api/posts/${ids.published}?include=author`)).body.author).toBeNull();
    expect((await call("GET", `/api/posts/${ids.published}?include=author`, bob)).body.author).not.toHaveProperty("email");
    expect((await call("GET", `/api/posts/${ids.published}?include=author`, alice)).body.author.email).toMatch(/@example\.com$/);
  });
  it("post → comments; audit_logs can never be included", async () => {
    const r = await call("GET", `/api/posts/${ids.published}?include=comments`);
    expect(r.body.comments.map((c: { id: string }) => c.id)).toEqual([ids.c1]);
    expect((await call("GET", "/api/posts?include=audit_logs")).status).toBe(400);
    expect((await call("GET", "/api/comments?include=audit_logs")).status).toBe(400);
  });
});

describe("writes", () => {
  const count = async () => (await env.DB.prepare("SELECT count(*) AS n FROM posts").first<{ n: number }>())!.n;

  it("deny: anonymous 401, owner spoofing 403, unknown column 400", async () => {
    const before = await count();
    expect((await call("POST", "/api/posts", undefined, { title: "x" })).status).toBe(401);
    expect((await call("POST", "/api/posts", alice, { title: "x", author_id: bob.id })).status).toBe(403);
    expect((await call("POST", "/api/posts", alice, { title: "x", nope: 1 })).status).toBe(400);
    expect((await call("PATCH", `/api/posts/${ids.published}`, alice, { author_id: bob.id })).status).toBe(403);
    expect((await call("PATCH", `/api/posts/${ids.bobPost}`, alice, { title: "hijack" })).status).toBe(404);
    expect(await count()).toBe(before);
  });

  it.skipIf(hasWriteGuard)("fail closed while engine.writeGuard is missing: 500, nothing written", async () => {
    const before = await count();
    const c = await call("POST", "/api/posts", alice, { title: "x" });
    const u = await call("PATCH", `/api/posts/${ids.published}`, alice, { title: "changed" });
    expect([c.status, u.status]).toEqual([500, 500]);
    expect(await count()).toBe(before);
    const row = await env.DB.prepare("SELECT title FROM posts WHERE id = ?").bind(ids.published).first<{ title: string }>();
    expect(row!.title).toBe("Published");
  });

  it.skipIf(!hasWriteGuard)("allow: create 201 (server id, server author), owner and editor update", async () => {
    const c = await call("POST", "/api/posts", alice, { title: "new" });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ title: "new", author_id: alice.id, status: "draft" });
    expect((await call("PATCH", `/api/posts/${c.body.id}`, alice, { title: "renamed" })).body.title).toBe("renamed");
    expect((await call("PATCH", `/api/posts/${c.body.id}`, editor, { title: "edited" })).status).toBe(200);
  });

  it("delete: admin 204 then 404; member 403; comment owner only", async () => {
    const victim = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO posts (id, author_id, title, status) VALUES (?, ?, 'v', 'published')").bind(victim, bob.id).run();
    expect((await call("DELETE", `/api/posts/${victim}`, bob)).status).toBe(403);
    expect((await call("DELETE", `/api/posts/${victim}`)).status).toBe(401);
    expect((await call("DELETE", `/api/posts/${victim}`, admin)).status).toBe(204);
    expect((await call("DELETE", `/api/posts/${victim}`, admin)).status).toBe(404);
    expect((await call("DELETE", `/api/comments/${ids.c1}`, alice)).status).toBe(404);
    expect((await call("DELETE", `/api/comments/${ids.c1}`, editor)).status).toBe(404);
  });
});

describe("OpenAPI", () => {
  it("lists only open operations and no hidden or internal names", async () => {
    const r = await call("GET", "/openapi.json");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.paths).sort()).toEqual(["/api/comments", "/api/comments/{id}", "/api/posts", "/api/posts/{id}", "/api/users", "/api/users/{id}"]);
    const text = JSON.stringify(r.body);
    for (const name of ["audit_logs", "_castra", "verification", '"session"', '"account"']) expect(text).not.toContain(name);
  });
});

describe("no leaks", () => {
  it("internal_notes value appears only in admin reads", () => {
    const leaks = seen.filter((t) => t.includes(NOTE));
    expect(leaks.length).toBe(1); // the single admin GET above
  });
});
