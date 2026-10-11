/**
 * Policy tests: one allow AND one deny case for every rule in castra.config.ts, through the real REST API,
 * real Better Auth sessions and a local D1 with all migrations applied. Run with `pnpm test:policies`.
 * When you change a policy, change these tests in the same commit.
 */
import { assignRole } from "@castra/auth";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { authOptions } from "../src/index";

const BASE = "http://localhost";

interface Who {
  id: string;
  headers: Record<string, string>;
}

interface Note {
  id: string;
  owner_id: string;
  title: string;
  is_public: number;
}

async function call(method: string, path: string, who?: Who, body?: unknown) {
  const headers: Record<string, string> = { ...(who?.headers ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await exports.default.fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status >= 400) expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function signUp(role?: string): Promise<Who> {
  const res = await exports.default.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: `${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "Test" }),
  });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string } };
  if (role) await assignRole(env.DB, user.id, role, authOptions.roles);
  return { id: user.id, headers: { authorization: `Bearer ${res.headers.get("set-auth-token")}` } };
}

/** Inserts a note directly (bypassing the API) and returns its id. */
async function seed(ownerId: string, isPublic: boolean): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO notes (id, owner_id, title, is_public) VALUES (?, ?, ?, ?)")
    .bind(id, ownerId, "seeded", isPublic ? 1 : 0)
    .run();
  return id;
}

const count = async () => (await env.DB.prepare("SELECT count(*) AS n FROM notes").first<{ n: number }>())!.n;
const listIds = async (who?: Who) =>
  ((await call("GET", "/api/notes?limit=100", who)).body.data as Note[]).map((n) => n.id);

let alice: Who, bob: Who, admin: Who;
let alicePublic: string, alicePrivate: string;

beforeAll(async () => {
  [alice, bob, admin] = await Promise.all([signUp(), signUp("member"), signUp("admin")]);
  alicePublic = await seed(alice.id, true);
  alicePrivate = await seed(alice.id, false);
});

describe("notes.read = isPublic().where(is_public = 1) | owner(owner_id) | role(admin)", () => {
  it("allow: anonymous reads public notes", async () => {
    expect((await call("GET", `/api/notes/${alicePublic}`)).status).toBe(200);
    expect(await listIds()).toContain(alicePublic);
  });
  it("deny: anonymous cannot read private notes (404, absent from lists)", async () => {
    expect((await call("GET", `/api/notes/${alicePrivate}`)).status).toBe(404);
    expect(await listIds()).not.toContain(alicePrivate);
  });
  it("allow: the owner reads their private note", async () => {
    expect((await call("GET", `/api/notes/${alicePrivate}`, alice)).status).toBe(200);
    expect(await listIds(alice)).toContain(alicePrivate);
  });
  it("deny: another signed-in user cannot read someone else's private note", async () => {
    expect((await call("GET", `/api/notes/${alicePrivate}`, bob)).status).toBe(404);
    expect(await listIds(bob)).not.toContain(alicePrivate);
  });
  it("allow: admin reads every note", async () => {
    expect((await call("GET", `/api/notes/${alicePrivate}`, admin)).status).toBe(200);
    expect(await listIds(admin)).toEqual(expect.arrayContaining([alicePublic, alicePrivate]));
  });
  it("counts and pages only see readable rows (policy compiled to SQL)", async () => {
    const r = await call("GET", "/api/notes?limit=100&count=exact&is_public=eq.0");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });
});

describe("notes.create = authenticated()", () => {
  it("allow: a signed-in user creates a note; owner_id is set by the server", async () => {
    const r = await call("POST", "/api/notes", bob, { title: "mine" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ title: "mine", owner_id: bob.id, is_public: 0 });
  });
  it("deny: anonymous gets 401 and nothing is written", async () => {
    const before = await count();
    expect((await call("POST", "/api/notes", undefined, { title: "x" })).status).toBe(401);
    expect(await count()).toBe(before);
  });
  it("deny: owner_id cannot be spoofed (403) and nothing is written", async () => {
    const before = await count();
    expect((await call("POST", "/api/notes", bob, { title: "x", owner_id: alice.id })).status).toBe(403);
    expect(await count()).toBe(before);
  });
});

describe("notes.update = owner(owner_id) | role(admin)", () => {
  it("allow: the owner updates their note", async () => {
    const r = await call("PATCH", `/api/notes/${alicePublic}`, alice, { title: "renamed" });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("renamed");
  });
  it("allow: admin updates any note", async () => {
    expect((await call("PATCH", `/api/notes/${alicePrivate}`, admin, { title: "by admin" })).status).toBe(200);
  });
  it("deny: another user cannot update someone else's note, readable or not (404: the update filter matches no row)", async () => {
    expect((await call("PATCH", `/api/notes/${alicePublic}`, bob, { title: "hijack" })).status).toBe(404);
    expect((await call("PATCH", `/api/notes/${alicePrivate}`, bob, { title: "hijack" })).status).toBe(404);
    const row = await env.DB.prepare("SELECT title FROM notes WHERE id = ?").bind(alicePublic).first<{ title: string }>();
    expect(row!.title).not.toBe("hijack");
  });
  it("deny: anonymous gets 401; the owner cannot hand the note to someone else (403)", async () => {
    expect((await call("PATCH", `/api/notes/${alicePublic}`, undefined, { title: "x" })).status).toBe(401);
    expect((await call("PATCH", `/api/notes/${alicePublic}`, alice, { owner_id: bob.id })).status).toBe(403);
  });
});

describe("notes.delete = owner(owner_id) | role(admin)", () => {
  it("allow: the owner deletes their note", async () => {
    const id = await seed(alice.id, false);
    expect((await call("DELETE", `/api/notes/${id}`, alice)).status).toBe(204);
    expect((await call("GET", `/api/notes/${id}`, alice)).status).toBe(404);
  });
  it("allow: admin deletes any note", async () => {
    const id = await seed(alice.id, true);
    expect((await call("DELETE", `/api/notes/${id}`, admin)).status).toBe(204);
  });
  it("deny: another user (404, readable or not) and anonymous (401) cannot delete", async () => {
    const before = await count();
    expect((await call("DELETE", `/api/notes/${alicePublic}`, bob)).status).toBe(404);
    expect((await call("DELETE", `/api/notes/${alicePrivate}`, bob)).status).toBe(404);
    expect((await call("DELETE", `/api/notes/${alicePublic}`)).status).toBe(401);
    expect(await count()).toBe(before);
  });
});

describe("default closed", () => {
  it.each(["users", "user", "session", "account", "verification", "_castra_roles", "_castra_api_keys", "_castra_mcp_tokens", "_castra_audit"])(
    "%s has no route",
    async (table) => {
      expect((await call("GET", `/api/${table}`, admin)).status).toBe(404);
    },
  );
  it("OpenAPI lists only notes", async () => {
    const r = await call("GET", "/openapi.json");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.paths).sort()).toEqual(["/api/notes", "/api/notes/{id}"]);
  });
});
