import { describe, expect, it } from "vitest";
import { authenticated, createPolicyEngine, owner, PolicyError, role } from "../../src/index.js";
import { anon, blogSnapshot, ROLES, user } from "./fixtures.js";

const engine = createPolicyEngine({
  config: {
    database: "d1",
    roles: ROLES,
    tables: {
      posts: {
        read: authenticated(),
        create: authenticated(),
        update: owner("author_id").or(role("editor", "admin")),
        fields: {
          author_id: { setBy: "server" },
          created_at: { setBy: "server" },
          id: { readonly: true },
          internal_notes: { hidden: true },
        },
      },
      comments: { create: role("member") },
    },
  },
  snapshot: blogSnapshot,
});

function rejection(fn: () => unknown): PolicyError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError);
    return e as PolicyError;
  }
  throw new Error("expected a PolicyError");
}

describe("prepareWrite: create", () => {
  it("fills the server-set owner column from ctx.user.id", () => {
    expect(engine.prepareWrite("posts", "create", user("u1"), { title: "t", body: "b" }).values).toEqual({
      title: "t",
      body: "b",
      author_id: "u1",
    });
  });

  it("rejects owner spoofing: a client author_id for someone else", () => {
    const e = rejection(() => engine.prepareWrite("posts", "create", user("u1"), { title: "t", author_id: "u2" }));
    expect(e.status).toBe(403);
    expect(e.code).toBe("forbidden");
    expect(e.explanation.reason).toMatch(/author_id/);
  });

  it("accepts a client author_id equal to the caller", () => {
    expect(engine.prepareWrite("posts", "create", user("u1"), { title: "t", author_id: "u1" }).values.author_id).toBe("u1");
  });

  it("rejects a different type for the owner value (no loose equality)", () => {
    const ctx = user("1");
    expect(rejection(() => engine.prepareWrite("posts", "create", ctx, { author_id: 1 })).status).toBe(403);
  });

  it("rejects non-owner server columns, readonly, hidden and unknown columns (never strips silently)", () => {
    const ctx = user("u1");
    expect(rejection(() => engine.prepareWrite("posts", "create", ctx, { created_at: "x" })).code).toBe("server_column");
    expect(rejection(() => engine.prepareWrite("posts", "create", ctx, { id: "p1" })).code).toBe("readonly_column");
    expect(rejection(() => engine.prepareWrite("posts", "create", ctx, { internal_notes: "x" })).code).toBe("hidden_column");
    expect(rejection(() => engine.prepareWrite("posts", "create", ctx, { "title; DROP TABLE posts": "x" })).code).toBe("unknown_column");
    expect(rejection(() => engine.prepareWrite("posts", "create", ctx, JSON.parse('{"__proto__": {"x": 1}}'))).status).toBe(400);
  });

  it("rejects non-scalar values", () => {
    expect(rejection(() => engine.prepareWrite("posts", "create", user("u1"), { title: { $gt: "" } })).code).toBe("invalid_input");
    expect(rejection(() => engine.prepareWrite("posts", "create", user("u1"), { title: ["a"] })).code).toBe("invalid_input");
  });

  it("rejects anonymous callers with 401 and wrong-role callers with 403", () => {
    expect(rejection(() => engine.prepareWrite("posts", "create", anon(), { title: "t" })).status).toBe(401);
    expect(rejection(() => engine.prepareWrite("comments", "create", user("u1", ["editor"]), { body: "x" })).status).toBe(403);
    expect(rejection(() => engine.prepareWrite("comments", "create", anon(["member"]), { body: "x" })).status).toBe(401);
  });

  it("rejects closed operations with 404", () => {
    expect(rejection(() => engine.prepareWrite("audit_logs", "create", user("u1", ["admin"]), {})).status).toBe(404);
    expect(rejection(() => engine.prepareWrite("comments", "update", user("u1", ["admin"]), {})).status).toBe(404);
  });
});

describe("prepareWrite: update", () => {
  it("never writes server columns on update and rejects a different value (spoofing)", () => {
    const e = rejection(() => engine.prepareWrite("posts", "update", user("u1"), { author_id: "u2", title: "x" }));
    expect(e.status).toBe(403);
    expect(engine.prepareWrite("posts", "update", user("u1"), { author_id: "u1", title: "x" }).values).toEqual({ title: "x" });
    expect(engine.prepareWrite("posts", "update", user("u1"), { title: "x" }).values).toEqual({ title: "x" });
  });

  it("compares with the stored value when the existing row is given (admin cannot take ownership)", () => {
    const existing = { author_id: "u2" };
    expect(rejection(() => engine.prepareWrite("posts", "update", user("adm", ["admin"]), { author_id: "adm" }, existing)).status).toBe(403);
    expect(engine.prepareWrite("posts", "update", user("adm", ["admin"]), { author_id: "u2", title: "y" }, existing).values).toEqual({
      title: "y",
    });
  });

  it("rejects readonly and hidden columns on update", () => {
    expect(rejection(() => engine.prepareWrite("posts", "update", user("u1"), { id: "p2" })).code).toBe("readonly_column");
    expect(rejection(() => engine.prepareWrite("posts", "update", user("u1"), { internal_notes: "" })).code).toBe("hidden_column");
  });
});
