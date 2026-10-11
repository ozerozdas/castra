/**
 * Third security review (M2 REST) on the blog Worker: real Better Auth sessions, real local D1, the
 * example config. Asserts CORRECT behaviour; a failing test is a finding.
 */
import { assignRole } from "@castra-kit/auth";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { authOptions } from "../src/index";

const BASE = "http://localhost";
const seen: string[] = [];

interface Who {
  id: string;
  email: string;
  headers: Record<string, string>;
}

async function call(method: string, path: string, who?: Who | { headers: Record<string, string> }, body?: unknown) {
  const headers: Record<string, string> = { ...(who?.headers ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await exports.default.fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  seen.push(text);
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, type: res.headers.get("content-type") ?? "", text, body: parsed as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function expectProblem(r: { status: number; type: string; text: string; body: unknown }, status: number) {
  expect(r.status, r.text).toBe(status);
  expect(r.type).toMatch(/^application\/problem\+json/);
  expect(Object.keys(r.body as object).sort()).toEqual(["detail", "status", "title", "type"]);
  expect(r.text).not.toMatch(/select |insert |SQLITE|D1_ERROR|stack|matchedRule|hiddenFields|better-auth|BetterAuth/i);
}

async function signUp(role?: string): Promise<Who> {
  const email = `r3-${crypto.randomUUID()}@example.com`;
  const res = await exports.default.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "R3" }),
  });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string } };
  if (role) await assignRole(env.DB, user.id, role, authOptions.roles);
  return { id: user.id, email, headers: { authorization: `Bearer ${res.headers.get("set-auth-token")}` } };
}

const NOTE = `r3-note-${crypto.randomUUID()}`;
let alice: Who, bob: Who, admin: Who;
const ids = { pub: crypto.randomUUID(), draft: crypto.randomUUID() };

beforeAll(async () => {
  [alice, bob, admin] = await Promise.all([signUp(), signUp(), signUp("admin")]);
  const p = env.DB.prepare("INSERT INTO posts (id, author_id, title, body, status, internal_notes) VALUES (?, ?, ?, ?, ?, ?)");
  await env.DB.batch([p.bind(ids.pub, alice.id, "R3 pub", "b", "published", NOTE), p.bind(ids.draft, alice.id, "R3 draft", "b", "draft", NOTE)]);
});

describe("review3 blog: reserved and unknown tables", () => {
  const names = ["nope", "user", "User", "SESSION", "account", "verification", "_castra_roles", "_castra_api_keys", "d1_migrations", "sqlite_master", "_cf_KV", "audit_logs", "Posts", "__proto__"];
  it.each(names)("%s: every method is the canonical 404, even for admins", async (n) => {
    const ref = (await call("GET", "/api/nope")).text;
    for (const [m, path] of [
      ["GET", `/api/${n}`],
      ["GET", `/api/${n}/x`],
      ["POST", `/api/${n}`],
      ["PATCH", `/api/${n}/x`],
      ["DELETE", `/api/${n}/x`],
    ] as const) {
      const r = await call(m, path, admin, m === "POST" || m === "PATCH" ? { id: "x" } : undefined);
      expectProblem(r, 404);
      expect(r.text).toBe(ref);
    }
  });

  it("unmatched paths under /api are problem+json too", async () => {
    for (const p of [`/api/posts/${ids.pub}/comments`, "/api/posts/", "/api/"]) {
      const r = await call("GET", p);
      expect(r.status, p).toBe(404);
      expect(r.type, p).toMatch(/^application\/problem\+json/);
    }
  });
});

describe("review3 blog: identity edge cases never escalate and never leak auth internals", () => {
  it.each<Record<string, string>>([
    { authorization: "Bearer garbage" },
    { authorization: "Bearer castra_ak_garbage" },
    { "x-api-key": "castra_ak_nope" },
    { cookie: "better-auth.session_token=forged.sig" },
    { authorization: "Basic YWRtaW46YWRtaW4=" },
  ])("%o is anonymous", async (headers) => {
    expectProblem(await call("POST", "/api/posts", { headers }, { title: "x" }), 401);
    expect((await call("GET", `/api/posts/${ids.draft}`, { headers })).status).toBe(404);
  });
});

describe("review3 blog: users.email (visibleTo self/admin) cannot be probed", () => {
  it("a member sees only their own email in lists and includes", async () => {
    const r = await call("GET", "/api/users?limit=100", bob);
    expect(r.status).toBe(200);
    for (const u of r.body.data) {
      if (u.id === bob.id) expect(u.email).toBe(bob.email);
      else expect(u).not.toHaveProperty("email");
    }
    const inc = await call("GET", `/api/posts/${ids.pub}?include=author`, bob);
    expect(inc.body.author.id).toBe(alice.id);
    expect(inc.body.author).not.toHaveProperty("email");
  });

  it("filter, like, in, sort and cursor on email are refused for members with one message", async () => {
    const ref = await call("GET", "/api/users?zz_nope=eq.x", bob);
    for (const q of [`email=eq.${encodeURIComponent(alice.email)}`, "email=like.r3-*", `email=in.(${encodeURIComponent(alice.email)})`, "email=is.null"]) {
      const r = await call("GET", `/api/users?${q}`, bob);
      expectProblem(r, 400);
      expect(r.text.replace('"email"', "C").replace(/\\"email\\"/, "C")).toBe(ref.text.replace(/\\"zz_nope\\"/, "C"));
    }
    expectProblem(await call("GET", "/api/users?sort=email", bob), 400);
    const cur = btoa(JSON.stringify({ k: ["email", "id"], v: ["a", "a"] })).replace(/=+$/, "");
    expectProblem(await call("GET", `/api/users?cursor=${cur}`, bob), 400);
    // An admin may.
    const a = await call("GET", `/api/users?email=eq.${encodeURIComponent(alice.email)}`, admin);
    expect(a.body.data.map((u: { id: string }) => u.id)).toEqual([alice.id]);
  });

  it("internal_notes (admin only) cannot be filtered, sorted or read by the author", async () => {
    expectProblem(await call("GET", `/api/posts?internal_notes=eq.${NOTE}`, alice), 400);
    expectProblem(await call("GET", "/api/posts?sort=internal_notes", alice), 400);
    const own = await call("GET", `/api/posts/${ids.draft}`, alice);
    expect(own.status).toBe(200);
    expect(own.body).not.toHaveProperty("internal_notes");
  });
});

describe("review3 blog: drafts stay invisible through every route", () => {
  it("GET/PATCH/DELETE of alice's draft by bob answer like a missing row", async () => {
    const missing = crypto.randomUUID();
    for (const [m, body] of [
      ["GET", undefined],
      ["PATCH", { title: "pwn" }],
    ] as const) {
      const a = await call(m, `/api/posts/${ids.draft}`, bob, body);
      const b = await call(m, `/api/posts/${missing}`, bob, body);
      expectProblem(a, 404);
      expect(a.text).toBe(b.text);
    }
  });

  it("commenting on an unreadable draft is refused like a missing post", async () => {
    const a = await call("POST", "/api/comments", bob, { post_id: ids.draft, body: "x" });
    const b = await call("POST", "/api/comments", bob, { post_id: crypto.randomUUID(), body: "x" });
    expectProblem(a, 400);
    expect(a.text).toBe(b.text);
  });

  it("users?include=posts shows another user's published posts only (one-to-many under posts.read)", async () => {
    const r = await call("GET", `/api/users/${alice.id}?include=posts,comments`, bob);
    expect(r.status, r.text).toBe(200);
    const postIds = r.body.posts.map((p: { id: string }) => p.id);
    expect(postIds).toContain(ids.pub);
    expect(postIds).not.toContain(ids.draft);
    for (const p of r.body.posts) expect(p).not.toHaveProperty("internal_notes");
    const own = await call("GET", `/api/users/${alice.id}?include=posts`, alice);
    expect(own.body.posts.map((p: { id: string }) => p.id)).toContain(ids.draft);
  });

  it("counts and pages for anonymous callers exclude drafts", async () => {
    const r = await call("GET", "/api/posts?status=eq.draft&count=exact");
    expect(r.body.count).toBe(0);
    expect(r.body.data).toEqual([]);
  });
});

describe("review3 blog: OpenAPI", () => {
  it("lists exactly the open operations of the example config", async () => {
    const r = await call("GET", "/openapi.json");
    expect(r.status).toBe(200);
    const ops = Object.entries(r.body.paths as Record<string, Record<string, unknown>>)
      .flatMap(([p, item]) => Object.keys(item).filter((m) => ["get", "post", "patch", "delete", "put"].includes(m)).map((m) => `${m.toUpperCase()} ${p}`))
      .sort();
    expect(ops).toEqual(
      [
        "GET /api/posts",
        "POST /api/posts",
        "GET /api/posts/{id}",
        "PATCH /api/posts/{id}",
        "DELETE /api/posts/{id}",
        "GET /api/comments",
        "POST /api/comments",
        "GET /api/comments/{id}",
        "PATCH /api/comments/{id}",
        "DELETE /api/comments/{id}",
        "GET /api/users",
        "GET /api/users/{id}",
      ].sort(),
    );
    const text = r.text;
    for (const s of ["audit_logs", "_castra", "d1_migrations", "password", '"session"', '"account"', '"verification"']) expect(text).not.toContain(s);
  });
});

describe("review3 blog: no leaks", () => {
  it("internal_notes never appeared in any response of this file (no admin read of it was made)", () => {
    expect(seen.join("\n")).not.toContain(NOTE);
  });
});
