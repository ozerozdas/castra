import { defineConfig, introspect, isPublic, type RateLimiterLike } from "@castra-kit/core";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createCastraApp, type CastraAppOptions } from "../src/index.js";

const config = defineConfig({ database: "d1", roles: ["admin"], tables: { notes: { read: isPublic() } } });
const deny: RateLimiterLike = { limit: async () => ({ success: false }) };
let options: CastraAppOptions;

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)`).run();
  const snapshot = await introspect(
    async (sql, params = []) => (await env.DB.prepare(sql).bind(...params).all()).results as Record<string, unknown>[],
  );
  options = { config, snapshot, openapi: { title: "Test API" } };
});

const post = { method: "POST", headers: { "cf-connecting-ip": "1.1.1.1" } };

describe("createCastraApp (ADR 0077)", () => {
  it("validates forwarded MCP audit settings during construction", () => {
    expect(() => createCastraApp({ ...options, mcp: { audit: { retentionDays: 0 } } })).toThrow(/retentionDays/);
    expect(() => createCastraApp({ ...options, mcp: { audit: { retentionDays: 30 } } })).not.toThrow();
  });
  it("serves /health, problem+json fallbacks, /openapi.json and the table routes", async () => {
    const app = createCastraApp(options);
    expect(await (await app.request("/health", {}, env)).json()).toEqual({ ok: true });
    const missing = await app.request("/nope", {}, env);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(((await (await app.request("/openapi.json", {}, env)).json()) as { info: { title: string } }).info.title).toBe("Test API");
    expect((await app.request("/api/notes", {}, env)).status).toBe(200);
  });

  it("rate limits writes with RATE_LIMITER, after the before hook; rateLimit: false turns it off", async () => {
    const app = createCastraApp({
      ...options,
      before: (a) =>
        a.use("*", async (c, next) => {
          await next();
          c.res.headers.set("x-before", "1");
        }),
    });
    const limited = await app.request("/api/notes", post, { ...env, RATE_LIMITER: deny });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-before")).toBe("1");
    const off = createCastraApp({ ...options, rateLimit: false });
    expect((await off.request("/api/notes", post, { ...env, RATE_LIMITER: deny })).status).not.toBe(429);
  });

  it("auth writes use AUTH_RATE_LIMITER and the general bucket; other writes only the general one (ADR 0078)", async () => {
    const calls: string[] = [];
    const record = (name: string, success = true): RateLimiterLike => ({
      limit: async ({ key }) => (calls.push(`${name} ${key}`), { success }),
    });
    const app = createCastraApp(options);
    const bindings = { ...env, RATE_LIMITER: record("general"), AUTH_RATE_LIMITER: record("auth") };
    await app.request("http://x.dev/api/auth/sign-in/email", post, bindings);
    expect(calls).toEqual(["auth x.dev:1.1.1.1", "general x.dev:1.1.1.1"]);
    calls.length = 0;
    await app.request("http://x.dev/api/notes", post, bindings);
    expect(calls).toEqual(["general x.dev:1.1.1.1"]);
    const denied = { ...bindings, AUTH_RATE_LIMITER: record("auth", false) };
    expect((await app.request("http://x.dev/api/auth/sign-in/email", post, denied)).status).toBe(429);
  });

  it("rateLimit.key keys table writes after the request context, falling back to the IP; /mcp stays per IP", async () => {
    const calls: string[] = [];
    const general: RateLimiterLike = { limit: async ({ key }) => (calls.push(key), { success: true }) };
    const app = createCastraApp({
      ...options,
      rateLimit: { key: (c) => (c.get("ctx").via === "anonymous" ? undefined : c.get("ctx").user?.id) },
      routes: (a) => a.post("/whoami", (c) => c.json({ via: c.get("ctx").via })),
    });
    const bindings = { ...env, RATE_LIMITER: general };
    expect(await (await app.request("http://x.dev/whoami", post, bindings)).json()).toEqual({ via: "anonymous" });
    await app.request("http://x.dev/mcp", post, bindings);
    expect(calls).toEqual(["x.dev:1.1.1.1", "x.dev:1.1.1.1"]);
  });

  it("mounts /mcp unless mcp: false", async () => {
    expect((await createCastraApp(options).request("/mcp", { method: "POST" }, env)).status).toBe(401);
    expect((await createCastraApp({ ...options, mcp: false }).request("/mcp", { method: "POST" }, env)).status).toBe(404);
  });

  it("custom routes see the request context and win over table routes", async () => {
    const app = createCastraApp({
      ...options,
      routes: (a) => a.get("/api/notes", (c) => c.json({ via: c.get("ctx").via })),
    });
    expect(await (await app.request("/api/notes", {}, env)).json()).toEqual({ via: "anonymous" });
  });
});
