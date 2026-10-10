import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authenticated, createPolicyEngine, isPublic, owner } from "../../src/index.js";
import { anon, blogSnapshot, ROLES, user } from "./fixtures.js";

const engine = createPolicyEngine({
  config: {
    database: "d1",
    roles: ROLES,
    tables: {
      users: {
        read: authenticated(),
        fields: {
          password_hash: { hidden: true },
          email: { visibleTo: ["self", "admin"] },
          name: { visibleTo: ["editor"] },
        },
      },
      posts: {
        read: isPublic().or(owner("author_id")),
        fields: { internal_notes: { visibleTo: ["self"] }, body: { hidden: true, visibleTo: ["admin"] } },
      },
      comments: {
        read: owner("user_id").or(owner("post_id")), // two owner columns → no default selfColumn
        fields: { body: { visibleTo: ["self"] } },
      },
    },
  },
  snapshot: blogSnapshot,
});

const userRow = { id: "u1", email: "a@x", name: "A", password_hash: "secret", created_at: "t" };

describe("projectRow: hidden fields", () => {
  it("hidden fields never appear, for any role including admin, even with visibleTo admin", () => {
    fc.assert(
      fc.property(fc.option(fc.constantFrom("u1", "u2"), { nil: null }), fc.subarray(ROLES), (id, roles) => {
        const ctx = id === null ? anon(roles) : user(id, roles);
        expect(engine.projectRow("users", ctx, userRow)).not.toHaveProperty("password_hash");
        const post = { id: "p", author_id: "u1", body: "b", title: "t", internal_notes: "n" };
        expect(engine.projectRow("posts", ctx, post)).not.toHaveProperty("body");
      }),
      { numRuns: 200 },
    );
  });

  it("drops columns that are not in the snapshot (default closed)", () => {
    expect(engine.projectRow("users", user("u1", ["admin"]), { ...userRow, injected: 1 })).not.toHaveProperty("injected");
  });

  it("projectRow on a table that is not exposed throws", () => {
    expect(() => engine.projectRow("audit_logs", user("u1", ["admin"]), { id: "x" })).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("projectRow: visibleTo and self", () => {
  it("visibleTo role: shown to the role, hidden from others", () => {
    expect(engine.projectRow("users", user("u2", ["editor"]), userRow)).toHaveProperty("name", "A");
    expect(engine.projectRow("users", user("u2", ["member"]), userRow)).not.toHaveProperty("name");
    expect(engine.projectRow("users", anon(["editor"]), userRow)).not.toHaveProperty("name"); // anonymous never holds roles
  });

  it("self on users defaults to the id column", () => {
    expect(engine.projectRow("users", user("u1"), userRow)).toEqual({ id: "u1", email: "a@x", created_at: "t" });
    expect(engine.projectRow("users", user("u2"), userRow)).toEqual({ id: "u1", created_at: "t" });
    expect(engine.projectRow("users", user("u2", ["admin"]), userRow)).toHaveProperty("email", "a@x");
    expect(engine.projectRow("users", anon(), userRow)).not.toHaveProperty("email");
  });

  it("self fails closed when the self column is null or missing from the row", () => {
    expect(engine.projectRow("users", user("u1"), { email: "a@x" })).not.toHaveProperty("email");
    expect(engine.projectRow("users", user("u1"), { id: null, email: "a@x" })).not.toHaveProperty("email");
  });

  it("self on other tables defaults to the single owner() column of the read rule", () => {
    const post = { id: "p", author_id: "u1", title: "t", internal_notes: "n" };
    expect(engine.projectRow("posts", user("u1"), post)).toHaveProperty("internal_notes", "n");
    expect(engine.projectRow("posts", user("u2"), post)).not.toHaveProperty("internal_notes");
  });

  it("self never matches when the read rule has more than one owner column", () => {
    const comment = { id: "c", post_id: "u1", user_id: "u1", body: "b" };
    expect(engine.projectRow("comments", user("u1"), comment)).not.toHaveProperty("body");
  });

  it("an explicit selfColumn wins", () => {
    const e = createPolicyEngine({
      config: {
        database: "d1",
        roles: ROLES,
        tables: { comments: { read: isPublic(), selfColumn: "user_id", fields: { body: { visibleTo: ["self"] } } } },
      },
      snapshot: blogSnapshot,
    });
    expect(e.projectRow("comments", user("u7"), { user_id: "u7", body: "b" })).toHaveProperty("body");
    expect(e.projectRow("comments", user("u8"), { user_id: "u7", body: "b" })).not.toHaveProperty("body");
  });

  it("explanations list hidden and self-conditional fields", () => {
    const f = engine.readFilter("users", "read", user("u2", ["member"]));
    expect(f.explanation.hiddenFields.sort()).toEqual(["name", "password_hash"]);
    expect(f.explanation.conditionalFields).toEqual(["email"]);
    const admin = engine.readFilter("users", "read", user("u2", ["admin"]));
    expect(admin.explanation.hiddenFields.sort()).toEqual(["name", "password_hash"]);
    expect(admin.explanation.conditionalFields).toBeUndefined();
  });
});
