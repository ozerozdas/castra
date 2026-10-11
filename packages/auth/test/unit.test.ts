import type { CastraContext } from "@castra-kit/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  anonymousContext,
  API_KEY_PREFIX,
  assertKnownRoles,
  buildAuthOptions,
  name,
  parseApiKey,
  problem,
  requireRole,
  sha256Hex,
  timingSafeEqual,
  UnknownRoleError,
  type AuthEnv,
} from "../src/index.js";

const SECRET = "unit-test-secret-not-real-0123456789abcdef";
const env = (extra: Partial<AuthEnv> = {}): AuthEnv => ({
  DB: {} as D1Database,
  BETTER_AUTH_SECRET: SECRET,
  ...extra,
});

describe("@castra-kit/auth", () => {
  it("exports its package name", () => {
    expect(name).toBe("@castra-kit/auth");
  });
});

describe("buildAuthOptions", () => {
  it("configures GitHub when client id and secret are present", () => {
    const opts = buildAuthOptions(env({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "sec" }), { roles: [] });
    expect(opts.socialProviders?.github).toEqual({ clientId: "id", clientSecret: "sec" });
  });

  it("leaves GitHub off when either value is missing", () => {
    expect(buildAuthOptions(env(), { roles: [] }).socialProviders).toBeUndefined();
    expect(buildAuthOptions(env({ GITHUB_CLIENT_ID: "id" }), { roles: [] }).socialProviders).toBeUndefined();
    expect(buildAuthOptions(env({ GITHUB_CLIENT_SECRET: "s" }), { roles: [] }).socialProviders).toBeUndefined();
  });

  it("enables email+password, uses D1 directly, never a session cache", () => {
    const db = {} as D1Database;
    const opts = buildAuthOptions(env({ DB: db }), { roles: [] });
    expect(opts.emailAndPassword?.enabled).toBe(true);
    expect(opts.database).toBe(db);
    expect(opts.secondaryStorage).toBeUndefined();
    expect(opts.session?.cookieCache?.enabled).toBe(false);
    expect(opts.basePath).toBe("/api/auth");
    expect(opts.secret).toBe(SECRET);
  });

  it("refuses a missing or short secret", () => {
    expect(() => buildAuthOptions(env({ BETTER_AUTH_SECRET: "" }), { roles: [] })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => buildAuthOptions(env({ BETTER_AUTH_SECRET: "short" }), { roles: [] })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("refuses placeholder and low-entropy secrets, accepts a generated one", () => {
    for (const bad of [
      "replace-me-with-at-least-32-random-characters",
      "CHANGEME-CHANGEME-CHANGEME-CHANGEME-1234",
      "this-is-an-Example-secret-0123456789abcdef",
      "a".repeat(40),
      "abababababababababababababababab",
    ]) {
      expect(() => buildAuthOptions(env({ BETTER_AUTH_SECRET: bad }), { roles: [] })).toThrow(/too weak.*openssl rand -base64 32/s);
    }
    const good = "q8Zr1xV0m3Kp9TgLw2YbN7cD5sHf4JuA+e6/Xo=";
    expect(buildAuthOptions(env({ BETTER_AUTH_SECRET: good }), { roles: [] }).secret).toBe(good);
  });

  it("installs the users mirror hooks unless disabled", () => {
    expect(buildAuthOptions(env(), { roles: [] }).databaseHooks?.user?.create?.after).toBeTypeOf("function");
    expect(buildAuthOptions(env(), { roles: [], mirrorUsers: false }).databaseHooks).toBeUndefined();
  });
});

describe("API key helpers", () => {
  it("parses only well-formed keys", () => {
    const secret = "A".repeat(43);
    expect(parseApiKey(`${API_KEY_PREFIX}0123456789abcdef_${secret}`)).toEqual({ id: "0123456789abcdef" });
    for (const bad of [
      "",
      API_KEY_PREFIX,
      `${API_KEY_PREFIX}0123456789abcdef_${secret}x`,
      `${API_KEY_PREFIX}0123456789ABCDEF_${secret}`,
      `${API_KEY_PREFIX}0123456789abcdef_${"A".repeat(42)}`,
      `x${API_KEY_PREFIX}0123456789abcdef_${secret}`,
      `${API_KEY_PREFIX}0123456789abcdef_${"A".repeat(42)}=`,
    ]) {
      expect(parseApiKey(bad), bad).toBeNull();
    }
  });

  it("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("ab", "abc")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("sha256Hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("roles validation", () => {
  it("accepts configured roles and rejects others", () => {
    expect(() => assertKnownRoles(["admin"], ["admin", "member"])).not.toThrow();
    expect(() => assertKnownRoles(["root"], ["admin"])).toThrow(UnknownRoleError);
  });
});

describe("requireRole", () => {
  const ctx = (user: CastraContext["user"], roles: string[]): CastraContext => ({
    ...anonymousContext(null),
    user,
    roles,
    via: user ? "session" : "anonymous",
  });

  function appWith(context: CastraContext | undefined) {
    const app = new Hono<{ Variables: { ctx: CastraContext } }>();
    app.use("*", async (c, next) => {
      if (context) c.set("ctx", context);
      await next();
    });
    // The generic env of requireRole is satisfied structurally at runtime; cast for the test app.
    app.get("/x", requireRole("admin", "editor") as never, (c) => c.text("ok"));
    return app;
  }

  it("401 for anonymous, and when no ctx middleware ran", async () => {
    for (const app of [appWith(ctx(null, [])), appWith(undefined)]) {
      const res = await app.request("/x");
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await res.json()).toEqual({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "Authentication required.",
      });
    }
  });

  it("403 without a matching role", async () => {
    const res = await appWith(ctx({ id: "u1" }, ["member"])).request("/x");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ title: "Forbidden", status: 403 });
  });

  it("allows any one of the listed roles", async () => {
    expect((await appWith(ctx({ id: "u1" }, ["editor"])).request("/x")).status).toBe(200);
    expect((await appWith(ctx({ id: "u1" }, ["admin"])).request("/x")).status).toBe(200);
  });

  it("requires at least one role", () => {
    expect(() => requireRole()).toThrow();
  });
});

describe("problem", () => {
  it("builds an RFC 9457 body", async () => {
    const res = problem(418, "Teapot", "short and stout");
    expect(res.status).toBe(418);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({ type: "about:blank", title: "Teapot", status: 418, detail: "short and stout" });
  });
});
