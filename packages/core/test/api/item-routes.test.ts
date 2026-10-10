import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  authenticated,
  createPolicyEngine,
  createRestRouter,
  defineConfig,
  isPublic,
  parseRequest,
  PolicyError,
  planRequest,
  toProblem,
  withProblemHandlers,
  type CastraConfig,
} from "../../src/index.js";
import { anon, snapshot, user } from "./fixtures.js";

function cfgWith(idField: { hidden?: true; visibleTo?: string[] }): CastraConfig {
  return defineConfig({
    database: "d1",
    roles: ["admin", "editor", "member"],
    tables: {
      comments: {
        read: isPublic(),
        create: authenticated(),
        update: authenticated(),
        delete: authenticated(),
        fields: { id: idField },
      },
    },
  });
}

function run(cfg: CastraConfig, method: string, ctx = anon(), id?: string, body?: unknown) {
  const engine = createPolicyEngine({ config: cfg, snapshot });
  return planRequest(engine, snapshot, cfg, parseRequest({ method, table: "comments", id, query: new URLSearchParams(), body }), ctx);
}

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError || e instanceof PolicyError) return toProblem(e).status;
    throw e;
  }
  return 0;
}

describe("item routes on a table whose primary key the caller cannot read", () => {
  const gated = cfgWith({ visibleTo: ["admin"] });
  const hidden = cfgWith({ hidden: true });

  it("deny: GET/PATCH/DELETE /:id is a 404 for a ctx without the role", () => {
    for (const ctx of [anon(), user("u1"), user("u1", ["editor"])]) {
      expect(statusOf(() => run(gated, "GET", ctx, "c1"))).toBe(404);
      expect(statusOf(() => run(gated, "PATCH", ctx, "c1", { body: "x" }))).toBe(404);
      expect(statusOf(() => run(gated, "DELETE", ctx, "c1"))).toBe(404);
    }
  });

  it("allow: the listed role opens the item routes", () => {
    const admin = user("a", ["admin"]);
    expect(run(gated, "GET", admin, "c1").kind).toBe("get");
    expect(run(gated, "PATCH", admin, "c1", { body: "x" }).kind).toBe("update");
    expect(run(gated, "DELETE", admin, "c1").kind).toBe("delete");
  });

  it("deny: a hidden primary key closes the item routes for everyone, admins included", () => {
    for (const ctx of [anon(), user("a", ["admin"])]) {
      expect(statusOf(() => run(hidden, "GET", ctx, "c1"))).toBe(404);
      expect(statusOf(() => run(hidden, "DELETE", ctx, "c1"))).toBe(404);
    }
  });

  it("allow: list and create stay open, and a readable key keeps item routes working", () => {
    expect(run(hidden, "GET", anon()).kind).toBe("list");
    expect(run(gated, "GET", anon()).kind).toBe("list");
    expect(run(gated, "POST", user("u1"), undefined, { post_id: "p", user_id: "u1", body: "b", created_at: "t" }).kind).toBe("create");
    expect(run(cfgWith({}), "GET", anon(), "c1").kind).toBe("get");
  });
});

describe("problem+json fallbacks (notFound / onError)", () => {
  const cfg = cfgWith({});
  const mount = () =>
    createRestRouter({
      config: cfg,
      snapshot,
      getDb: () => {
        throw new Error("SELECT secret FROM boom -- SQLITE_ERROR");
      },
      getContext: () => anon(),
    });

  it("unmatched paths and methods under the prefix are problem+json 404", async () => {
    const app = mount();
    for (const [m, p] of [
      ["GET", "/api/comments/x/y"],
      ["GET", "/api/"],
      ["GET", "/api/comments/"],
      ["OPTIONS", "/api/comments"],
    ] as const) {
      const res = await app.request(p, { method: m });
      expect(res.status, `${m} ${p}`).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    }
  });

  it("an uncaught exception is a generic problem+json 500 without internals", async () => {
    const app = withProblemHandlers(new Hono());
    app.get("/boom", () => {
      throw new Error("SELECT secret FROM boom -- SQLITE_ERROR");
    });
    const res = await app.request("/boom");
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(text).not.toMatch(/SELECT|SQLITE|boom/);
  });

  it("a database failure inside the router never leaks", async () => {
    const res = await mount().request("/api/comments");
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toMatch(/SELECT|SQLITE|secret/);
  });

  it("withProblemHandlers on a root app covers routes mounted with route()", async () => {
    const root = withProblemHandlers(new Hono());
    root.route("/", mount());
    const res = await root.request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json/);
  });

  it("D1's 'LIKE or GLOB pattern too complex' maps to 400, other errors to 500", () => {
    expect(toProblem(new Error("D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR")).status).toBe(400);
    expect(toProblem(new Error("D1_ERROR: something else")).status).toBe(500);
  });
});
