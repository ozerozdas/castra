import { assignRole, createApiKey, getRoles, revokeApiKey, revokeRole, UnknownRoleError } from "@castra-kit/auth";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authOptions } from "../src/index";

const BASE = "http://localhost";
const ROLES = authOptions.roles;

function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, init);
}

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `user${counter}-${crypto.randomUUID()}@example.com`;
}

interface Session {
  userId: string;
  cookie: string;
  token: string;
}

function sessionFrom(res: Response, userId: string): Session {
  const setCookie = res.headers.getSetCookie().find((c) => c.includes("session_token="));
  expect(setCookie, "session cookie").toBeDefined();
  const cookie = setCookie!.split(";")[0]!;
  const token = res.headers.get("set-auth-token");
  expect(token, "bearer token").toBeTruthy();
  return { userId, cookie, token: token! };
}

async function signUp(email = uniqueEmail(), password = "correct-horse-battery", name = "Test User") {
  const res = await fetchApp("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password, name }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string; email: string } };
  return { email, password, name, ...sessionFrom(res, body.user.id) };
}

async function signIn(email: string, password: string): Promise<Response> {
  return fetchApp("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password }),
  });
}

interface Me {
  user: { id: string; email?: string; name?: string } | null;
  roles: string[];
  via: string;
}

async function me(headers: HeadersInit = {}): Promise<Me> {
  const res = await fetchApp("/me", { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as Me;
}

async function adminPing(headers: HeadersInit = {}): Promise<Response> {
  return fetchApp("/admin/ping", { headers });
}

describe("email + password", () => {
  it("signs up, signs in and resolves the session to a ctx", async () => {
    const { email, password, userId } = await signUp();
    const res = await signIn(email, password);
    expect(res.status).toBe(200);
    const session = sessionFrom(res, userId);

    const viaCookie = await me({ cookie: session.cookie });
    expect(viaCookie).toEqual({ user: { id: userId, email, name: "Test User" }, roles: [], via: "session" });

    const viaBearer = await me({ authorization: `Bearer ${session.token}` });
    expect(viaBearer.user?.id).toBe(userId);
    expect(viaBearer.via).toBe("session");
  });

  it("rejects a wrong password", async () => {
    const { email } = await signUp();
    const res = await signIn(email, "wrong-password-123");
    expect(res.status).toBe(401);
  });

  it("anonymous request resolves to user null and no roles", async () => {
    expect(await me()).toEqual({ user: null, roles: [], via: "anonymous" });
  });

  it("garbage session cookie and bearer resolve to anonymous", async () => {
    expect((await me({ cookie: "better-auth.session_token=nope.nope" })).via).toBe("anonymous");
    expect((await me({ authorization: "Bearer not-a-real-token" })).via).toBe("anonymous");
  });

  it("mirrors a public profile row into users", async () => {
    const { email, userId } = await signUp(undefined, undefined, "Mirror Me");
    const row = await env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?").bind(userId).first();
    expect(row).toEqual({ id: userId, email, name: "Mirror Me" });
  });

  it("updates the users mirror when the profile changes", async () => {
    const { cookie, userId } = await signUp(undefined, undefined, "Before");
    const res = await fetchApp("/api/auth/update-user", {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie },
      body: JSON.stringify({ name: "After" }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first();
    expect(row).toEqual({ name: "After" });
  });
});

describe("roles", () => {
  it("assigned role appears in ctx and opens the role-gated route", async () => {
    const { cookie, userId } = await signUp();
    expect((await adminPing({ cookie })).status).toBe(403);

    await assignRole(env.DB, userId, "admin", ROLES);
    await assignRole(env.DB, userId, "admin", ROLES); // idempotent
    expect(await getRoles(env.DB, userId)).toEqual(["admin"]);
    expect((await me({ cookie })).roles).toEqual(["admin"]);

    const res = await adminPing({ cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });

    expect(await revokeRole(env.DB, userId, "admin")).toBe(true);
    expect((await adminPing({ cookie })).status).toBe(403);
  });

  it("without the role → 403 problem+json", async () => {
    const { cookie, userId } = await signUp();
    await assignRole(env.DB, userId, "member", ROLES);
    const res = await adminPing({ cookie });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ type: "about:blank", title: "Forbidden", status: 403 });
  });

  it("anonymous → 401 problem+json", async () => {
    const res = await adminPing();
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ title: "Unauthorized", status: 401 });
  });

  it("rejects roles outside the configured list", async () => {
    const { userId } = await signUp();
    await expect(assignRole(env.DB, userId, "superuser", ROLES)).rejects.toBeInstanceOf(UnknownRoleError);
  });

  it("ignores grants for roles no longer configured", async () => {
    const { cookie, userId } = await signUp();
    await env.DB.prepare("INSERT INTO _castra_roles (user_id, role) VALUES (?, 'legacy')").bind(userId).run();
    expect((await me({ cookie })).roles).toEqual([]);
  });

  it("never trusts roles sent by the client", async () => {
    const { cookie } = await signUp();
    const res = await adminPing({ cookie, "x-castra-roles": "admin", "x-roles": "admin" });
    expect(res.status).toBe(403);
  });
});

describe("session revocation (D1 is the source of truth)", () => {
  it("sign-out stops the session working immediately", async () => {
    const { cookie, token } = await signUp();
    expect((await me({ cookie })).via).toBe("session");
    const res = await fetchApp("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: BASE } });
    expect(res.status).toBe(200);
    expect(await me({ cookie })).toEqual({ user: null, roles: [], via: "anonymous" });
    expect((await me({ authorization: `Bearer ${token}` })).via).toBe("anonymous");
  });

  it("a session deleted in D1 is anonymous on the next request", async () => {
    const { cookie, userId } = await signUp();
    await assignRole(env.DB, userId, "admin", ROLES);
    expect((await adminPing({ cookie })).status).toBe(200);
    await env.DB.prepare('DELETE FROM "session" WHERE "userId" = ?').bind(userId).run();
    expect((await me({ cookie })).via).toBe("anonymous");
    expect((await adminPing({ cookie })).status).toBe(401);
  });

  it("an expired session is anonymous", async () => {
    const { cookie, userId } = await signUp();
    const past = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "userId" = ?').bind(past, userId).run();
    expect((await me({ cookie })).via).toBe("anonymous");
  });
});

describe("API keys", () => {
  it("valid key → apiKey ctx with the user's roles", async () => {
    const { userId, email } = await signUp();
    await assignRole(env.DB, userId, "admin", ROLES);
    const { key } = await createApiKey(env.DB, { userId, name: "ci" }, ROLES);
    expect(key.startsWith("castra_ak_")).toBe(true);

    const viaHeader = await me({ "x-api-key": key });
    expect(viaHeader).toEqual({ user: { id: userId, email, name: "Test User" }, roles: ["admin"], via: "apiKey" });
    expect((await me({ authorization: `Bearer ${key}` })).via).toBe("apiKey");
    expect((await adminPing({ "x-api-key": key })).status).toBe(200);
  });

  it("stores only a hash of the key", async () => {
    const { userId } = await signUp();
    const { id, key } = await createApiKey(env.DB, { userId }, ROLES);
    const row = await env.DB.prepare("SELECT * FROM _castra_api_keys WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(Object.values(row!)).not.toContain(key);
    expect(JSON.stringify(row)).not.toContain(key.split("_").pop());
  });

  it("role subset narrows the user's roles and never adds roles", async () => {
    const { userId } = await signUp();
    await assignRole(env.DB, userId, "admin", ROLES);
    await assignRole(env.DB, userId, "member", ROLES);
    const memberOnly = await createApiKey(env.DB, { userId, roles: ["member"] }, ROLES);
    expect((await me({ "x-api-key": memberOnly.key })).roles).toEqual(["member"]);
    expect((await adminPing({ "x-api-key": memberOnly.key })).status).toBe(403);

    const editorKey = await createApiKey(env.DB, { userId, roles: ["editor"] }, ROLES);
    expect((await me({ "x-api-key": editorKey.key })).roles).toEqual([]);
  });

  it("rejects key roles outside the configured list", async () => {
    const { userId } = await signUp();
    await expect(createApiKey(env.DB, { userId, roles: ["root"] }, ROLES)).rejects.toBeInstanceOf(UnknownRoleError);
  });

  it("revoked key → denied", async () => {
    const { userId } = await signUp();
    await assignRole(env.DB, userId, "admin", ROLES);
    const { id, key } = await createApiKey(env.DB, { userId }, ROLES);
    expect((await adminPing({ "x-api-key": key })).status).toBe(200);
    expect(await revokeApiKey(env.DB, id)).toBe(true);
    expect((await me({ "x-api-key": key })).via).toBe("anonymous");
    expect((await adminPing({ "x-api-key": key })).status).toBe(401);
  });

  it("expired key → denied", async () => {
    const { userId } = await signUp();
    const { key } = await createApiKey(env.DB, { userId, expiresAt: new Date(Date.now() - 1000) }, ROLES);
    expect((await me({ "x-api-key": key })).via).toBe("anonymous");
    const future = await createApiKey(env.DB, { userId, expiresAt: new Date(Date.now() + 60_000) }, ROLES);
    expect((await me({ "x-api-key": future.key })).via).toBe("apiKey");
  });

  it("malformed or tampered key → denied", async () => {
    const { userId } = await signUp();
    const { key } = await createApiKey(env.DB, { userId }, ROLES);
    const last = key.at(-1) === "A" ? "B" : "A";
    const tampered = key.slice(0, -1) + last;
    for (const bad of ["castra_ak_", "castra_ak_short", "garbage", key.slice(0, -1), tampered, `${key}x`]) {
      expect((await me({ "x-api-key": bad })).via, bad).toBe("anonymous");
      expect((await adminPing({ authorization: `Bearer ${bad}` })).status).toBe(401);
    }
  });

  it("an invalid API key does not fall back to a valid session", async () => {
    const { cookie } = await signUp();
    expect((await me({ cookie, "x-api-key": "castra_ak_bogus" })).via).toBe("anonymous");
  });

  it("deleting the user removes its keys and roles", async () => {
    const { userId } = await signUp();
    await assignRole(env.DB, userId, "admin", ROLES);
    const { key } = await createApiKey(env.DB, { userId }, ROLES);
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(userId).run();
    expect((await me({ "x-api-key": key })).via).toBe("anonymous");
    expect(await getRoles(env.DB, userId)).toEqual([]);
  });
});
