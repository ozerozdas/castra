/** Tests for the security-review fixes: implicit server owner columns, hidden filterable, canFilter. */
import { describe, expect, it } from "vitest";
import {
  authenticated,
  CastraConfigError,
  createPolicyEngine,
  defineConfig,
  isPublic,
  owner,
  PolicyError,
  role,
} from "../../src/index.js";
import { anon, blogSnapshot, ROLES, user } from "./fixtures.js";

function rejection(fn: () => unknown): PolicyError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError);
    return e as PolicyError;
  }
  throw new Error("expected a PolicyError");
}

describe("owner() columns are implicitly setBy: server (ADR 0007 amendment)", () => {
  // No `fields` at all: the owner column is protected by being named in an owner() rule.
  const engine = createPolicyEngine({
    config: {
      database: "d1",
      roles: ROLES,
      tables: {
        posts: { read: isPublic(), create: authenticated(), update: owner("author_id").or(role("admin")) },
        // owner() only in `delete`: still covers create/update of that column
        comments: { read: isPublic(), create: authenticated(), update: authenticated(), delete: owner("user_id") },
      },
    },
    snapshot: blogSnapshot,
  });

  it("allow: fills the owner column from ctx.user.id on create", () => {
    expect(engine.prepareWrite("posts", "create", user("u1"), { title: "t" }).values).toEqual({ title: "t", author_id: "u1" });
  });

  it("allow: the caller's own id is accepted", () => {
    expect(engine.prepareWrite("posts", "create", user("u1"), { title: "t", author_id: "u1" }).values).toEqual({
      title: "t",
      author_id: "u1",
    });
  });

  it("deny: another user's id is 403 on create", () => {
    expect(rejection(() => engine.prepareWrite("posts", "create", user("u1"), { title: "t", author_id: "u2" })).status).toBe(403);
  });

  it("deny: anonymous cannot supply an owner value (401)", () => {
    const open = createPolicyEngine({
      config: { database: "d1", roles: ROLES, tables: { posts: { read: owner("author_id"), create: isPublic() } } },
      snapshot: blogSnapshot,
    });
    expect(rejection(() => open.prepareWrite("posts", "create", anon(), { title: "t", author_id: "u2" })).status).toBe(401);
  });

  it("update: the owner column is never written; a different value is 403, an admin cannot take ownership", () => {
    const admin = user("u9", ["admin"]);
    expect(engine.prepareWrite("posts", "update", admin, { title: "x" }, { author_id: "u1" }).values).toEqual({ title: "x" });
    expect(engine.prepareWrite("posts", "update", user("u1"), { title: "x", author_id: "u1" }, { author_id: "u1" }).values).toEqual({
      title: "x",
    });
    expect(rejection(() => engine.prepareWrite("posts", "update", admin, { author_id: "u9" }, { author_id: "u1" })).status).toBe(403);
    expect(rejection(() => engine.prepareWrite("posts", "update", user("u1"), { author_id: "u2" })).status).toBe(403);
  });

  it("covers a column referenced by owner() in any operation's rule", () => {
    expect(engine.prepareWrite("comments", "create", user("u1"), { body: "b" }).values).toEqual({ body: "b", user_id: "u1" });
    expect(rejection(() => engine.prepareWrite("comments", "create", user("u1"), { body: "b", user_id: "u2" })).status).toBe(403);
  });

  it("non-owner columns stay client-writable", () => {
    expect(engine.prepareWrite("posts", "create", user("u1"), { title: "t", status: "draft" }).values).toEqual({
      title: "t",
      status: "draft",
      author_id: "u1",
    });
  });
});

describe("filterable must not contain hidden columns", () => {
  const hiddenFilterable = {
    database: "d1" as const,
    roles: ROLES,
    tables: { users: { read: authenticated(), fields: { password_hash: { hidden: true as const } }, filterable: ["password_hash"] } },
  };

  it("deny: defineConfig and createPolicyEngine throw", () => {
    expect(() => defineConfig(hiddenFilterable)).toThrow(/hidden/);
    expect(() => createPolicyEngine({ config: hiddenFilterable, snapshot: blogSnapshot })).toThrow(CastraConfigError);
  });

  it("allow: a non-hidden filterable column next to a hidden column", () => {
    expect(() =>
      defineConfig({
        ...hiddenFilterable,
        tables: { users: { read: authenticated(), fields: { password_hash: { hidden: true } }, filterable: ["email"] } },
      }),
    ).not.toThrow();
  });
});

describe("canFilter", () => {
  const engine = createPolicyEngine({
    config: {
      database: "d1",
      roles: ROLES,
      tables: {
        posts: {
          read: isPublic(),
          fields: { internal_notes: { visibleTo: ["admin"] }, body: { hidden: true } },
          filterable: ["status", "created_at", "internal_notes"],
        },
        users: {
          read: authenticated(),
          fields: { password_hash: { hidden: true }, email: { visibleTo: ["self", "admin"] }, name: { visibleTo: ["self"] } },
        },
        comments: { read: isPublic() },
      },
    },
    snapshot: blogSnapshot,
  });

  it("allow: columns listed in filterable", () => {
    expect(engine.canFilter("posts", "status", anon())).toBe(true);
    expect(engine.canFilter("posts", "created_at", user("u1"))).toBe(true);
  });

  it("deny: columns not listed in filterable, unknown columns and unknown tables", () => {
    expect(engine.canFilter("posts", "title", user("u1", ["admin"]))).toBe(false);
    expect(engine.canFilter("posts", "nope", user("u1", ["admin"]))).toBe(false);
    expect(engine.canFilter("posts", "STATUS", anon())).toBe(false);
    expect(engine.canFilter("nope", "id", user("u1"))).toBe(false);
  });

  it("deny: hidden columns, for every role", () => {
    expect(engine.canFilter("users", "password_hash", user("u1", ["admin"]))).toBe(false);
    expect(engine.canFilter("posts", "body", user("u1", ["admin"]))).toBe(false);
  });

  it("deny: closed or reserved tables", () => {
    expect(engine.canFilter("audit_logs", "id", user("u1", ["admin"]))).toBe(false);
    expect(engine.canFilter("user", "id", user("u1", ["admin"]))).toBe(false);
  });

  it("visibleTo role: allowed for a listed role, denied otherwise", () => {
    expect(engine.canFilter("posts", "internal_notes", user("u1", ["admin"]))).toBe(true);
    expect(engine.canFilter("posts", "internal_notes", user("u1", ["editor"]))).toBe(false);
    expect(engine.canFilter("posts", "internal_notes", user("u1"))).toBe(false);
    expect(engine.canFilter("posts", "internal_notes", anon(["admin"]))).toBe(false); // anonymous roles grant nothing
  });

  it("visibleTo self is per-row: only a listed real role makes the column filterable", () => {
    expect(engine.canFilter("users", "email", user("u1"))).toBe(false);
    expect(engine.canFilter("users", "email", user("u1", ["editor"]))).toBe(false);
    expect(engine.canFilter("users", "email", user("u1", ["admin"]))).toBe(true);
    expect(engine.canFilter("users", "name", user("u1", ["admin"]))).toBe(false); // only "self" listed
    expect(engine.canFilter("users", "name", user("u1", ["self"]))).toBe(false); // a "self" role entry grants nothing
  });

  it("without filterable: any non-hidden, visible column", () => {
    expect(engine.canFilter("comments", "body", anon())).toBe(true);
    expect(engine.canFilter("users", "id", user("u1"))).toBe(true);
    expect(engine.canFilter("users", "created_at", anon())).toBe(true);
  });
});
