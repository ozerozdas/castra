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
