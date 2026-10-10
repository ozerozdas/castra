/**
 * Security review: adversarial tests for M3 auth, run against the blog Worker and a real local D1.
 *
 * The "FINDING" block asserts the CORRECT behaviour and fails until fixed; the rest are regression
 * tests for attacks that held.
 */
import { assignRole, buildAuthOptions, createApiKey, revokeRole } from "@castra/auth";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authOptions } from "../src/index";

const BASE = "http://localhost";
const ROLES = authOptions.roles;

function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, init);
}

function uniqueEmail(): string {
  return `rev-${crypto.randomUUID()}@example.com`;
}

async function signUpRaw(body: Record<string, unknown>): Promise<Response> {
  return fetchApp("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
  });
}

async function signUp(email = uniqueEmail()) {
  const res = await signUpRaw({ email, password: "correct-horse-battery", name: "Rev" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  const cookie = res.headers.getSetCookie().find((c) => c.includes("session_token="))!.split(";")[0]!;
  return { email, userId: body.user.id, cookie, token: res.headers.get("set-auth-token")! };
}

async function me(headers: HeadersInit = {}) {
  const res = await fetchApp("/me", { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as { user: { id: string } | null; roles: string[]; via: string };
}

describe("FINDING: the documented placeholder secret is accepted", () => {
  // examples/blog/.dev.vars.example ships BETTER_AUTH_SECRET=replace-me-with-at-least-32-random-characters
  // (45 chars). buildAuthOptions only checks the length, so a copied example file runs with a
  // publicly known secret (Better Auth uses it to sign session cookies and encrypt OAuth tokens).
  it("buildAuthOptions refuses the placeholder from .dev.vars.example", () => {
    expect(() =>
      buildAuthOptions({ DB: env.DB, BETTER_AUTH_SECRET: "replace-me-with-at-least-32-random-characters" }, authOptions),
    ).toThrow();
  });
});

describe("held: sign-up input cannot choose identity or privileges", () => {
  it("client-supplied id, emailVerified and role are ignored", async () => {
    const email = uniqueEmail();
    const chosenId = crypto.randomUUID();
    const res = await signUpRaw({
      email,
      password: "correct-horse-battery",
      name: "x",
      id: chosenId,
      emailVerified: true,
      role: "admin",
      roles: ["admin"],
    });
    // Better Auth may reject unknown fields or ignore them; either way nothing privileged is stored.
    if (res.status === 200) {
      const body = (await res.json()) as { user: { id: string } };
      expect(body.user.id).not.toBe(chosenId);
      const row = await env.DB.prepare('SELECT id, "emailVerified" AS v FROM "user" WHERE email = ?').bind(email).first<{ id: string; v: number }>();
      expect(row!.id).not.toBe(chosenId);
      expect(row!.v).toBe(0);
      const cookie = res.headers.getSetCookie().find((c) => c.includes("session_token="))!.split(";")[0]!;
      expect((await me({ cookie })).roles).toEqual([]);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("re-registering an existing email (any case) never yields the victim's session", async () => {
    const victim = await signUp();
    for (const email of [victim.email, victim.email.toUpperCase()]) {
      const res = await signUpRaw({ email, password: "attacker-password-123", name: "evil" });
      if (res.status === 200) {
        const cookie = res.headers.getSetCookie().find((c) => c.includes("session_token="))?.split(";")[0];
        if (cookie) expect((await me({ cookie })).user?.id).not.toBe(victim.userId);
      }
    }
    // the attacker's password does not open the victim's account
    const signIn = await fetchApp("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: victim.email, password: "attacker-password-123" }),
    });
    expect(signIn.status).not.toBe(200);
  });
});

describe("held: API key presentation tricks", () => {
  it("only x-api-key and Authorization: Bearer carry keys; query string, cookie and other schemes do not", async () => {
    const { userId } = await signUp();
    const { key } = await createApiKey(env.DB, { userId }, ROLES);
    expect((await fetchApp(`/me?api_key=${key}`).then((r) => r.json())) as { via: string }).toMatchObject({ via: "anonymous" });
    expect((await me({ cookie: `x-api-key=${key}` })).via).toBe("anonymous");
    expect((await me({ authorization: `Basic ${key}` })).via).toBe("anonymous");
    expect((await me({ authorization: `Token ${key}` })).via).toBe("anonymous");
    expect((await me({ "x-api-key": key.toUpperCase() })).via).toBe("anonymous");
    expect((await me({ "x-api-key": `${key} ${key}` })).via).toBe("anonymous");
    expect((await me({ "x-api-key": ` ${key} ` })).via).toBe("apiKey"); // trimmed, still the exact key
  });

  it("a key whose hash row belongs to another id is rejected (id and secret are bound together)", async () => {
    const a = await signUp();
    const b = await signUp();
    const ka = await createApiKey(env.DB, { userId: a.userId }, ROLES);
    const kb = await createApiKey(env.DB, { userId: b.userId }, ROLES);
    const secretA = ka.key.slice(`castra_ak_${ka.id}_`.length);
    const spliced = `castra_ak_${kb.id}_${secretA}`;
    expect((await me({ "x-api-key": spliced })).via).toBe("anonymous");
  });

  it("revoking a role takes effect immediately for API keys and sessions", async () => {
    const { userId, cookie } = await signUp();
    await assignRole(env.DB, userId, "admin", ROLES);
    const { key } = await createApiKey(env.DB, { userId, roles: ["admin"] }, ROLES);
    expect((await me({ "x-api-key": key })).roles).toEqual(["admin"]);
    await revokeRole(env.DB, userId, "admin");
    expect((await me({ "x-api-key": key })).roles).toEqual([]);
    expect((await me({ cookie })).roles).toEqual([]);
    expect((await fetchApp("/admin/ping", { headers: { "x-api-key": key } })).status).toBe(403);
  });
});

describe("held: session tokens", () => {
  it("a session of a deleted user is anonymous (cookie and bearer)", async () => {
    const { userId, cookie, token } = await signUp();
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(userId).run();
    expect((await me({ cookie })).via).toBe("anonymous");
    expect((await me({ authorization: `Bearer ${token}` })).via).toBe("anonymous");
  });

  it("a session cookie with a forged signature (user A's token, tampered) is anonymous", async () => {
    const { cookie } = await signUp();
    const [name, value] = cookie.split("=") as [string, string];
    const decoded = decodeURIComponent(value);
    const [token] = decoded.split(".");
    const forged = `${name}=${encodeURIComponent(`${token}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`)}`;
    expect((await me({ cookie: forged })).via).toBe("anonymous");
  });

  it("roles are never read from the client, including on API-key requests", async () => {
    const { userId } = await signUp();
    const { key } = await createApiKey(env.DB, { userId }, ROLES);
    const res = await fetchApp("/admin/ping", { headers: { "x-api-key": key, "x-castra-roles": "admin", "x-roles": "admin" } });
    expect(res.status).toBe(403);
  });
});
