import { describe, expect, it } from "vitest";
import { authenticated, createPolicyEngine, owner, role } from "../../src/index.js";
import { anon, blogSnapshot, ROLES, user } from "./fixtures.js";

// ADR 0007 amendment 2: a visibleTo field may only be written by a ctx that could read it.
const engine = createPolicyEngine({
  config: {
    database: "d1",
    roles: ROLES,
    tables: {
      posts: {
        read: authenticated(),
        create: authenticated(),
        selfColumn: "author_id",
        update: owner("author_id").or(role("editor", "admin")),
        fields: {
          internal_notes: { visibleTo: ["admin"] },
          body: { visibleTo: ["self"] }, // selfColumn defaults to the single owner column author_id
          title: { visibleTo: ["editor", "self"] },
        },
      },
      users: {
        read: authenticated(),
        create: authenticated(),
        update: authenticated(),
        fields: { email: { visibleTo: ["self", "admin"] } }, // selfColumn defaults to id
      },
    },
  },
  snapshot: blogSnapshot,
});

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    return (e as { status: number }).status;
  }
  return 0;
};

describe("prepareWrite: visibleTo by role", () => {
  it("allow: a listed real role may create and update the field", () => {
    expect(engine.prepareWrite("posts", "create", user("a", ["admin"]), { title: "t", internal_notes: "n" }).values).toMatchObject({ internal_notes: "n" });
    const existing = { id: "p", author_id: "a" };
    expect(engine.prepareWrite("posts", "update", user("e", ["admin"]), { internal_notes: "n" }, existing).values).toEqual({ internal_notes: "n" });
  });

  it("deny: other roles and members get 403 on create and update, even as owner", () => {
    for (const roles of [[], ["member"], ["editor"]]) {
      expect(status(() => engine.prepareWrite("posts", "create", user("a", roles), { title: "t", internal_notes: "n" }))).toBe(403);
      expect(status(() => engine.prepareWrite("posts", "update", user("a", roles), { internal_notes: "n" }, { id: "p", author_id: "a" }))).toBe(403);
    }
  });

  it("deny: the message names only the column, no rule detail", () => {
    try {
      engine.prepareWrite("posts", "create", user("a"), { internal_notes: "n" });
    } catch (e) {
      expect((e as Error).message).toBe('column "internal_notes" cannot be written by this user');
      return;
    }
    throw new Error("expected 403");
  });

  it("deny: a role the ctx only claims while anonymous does not count", () => {
    expect(status(() => engine.prepareWrite("posts", "create", anon(["admin"]), { title: "t", internal_notes: "n" }))).toBe(401);
  });

  it("allow: fields without visibleTo are unaffected", () => {
    expect(engine.prepareWrite("posts", "create", user("a"), { views: 1 }).values).toMatchObject({ views: 1 });
  });
});

describe("prepareWrite: visibleTo with self", () => {
  it("allow: create of own row (owner column is filled from ctx.user.id)", () => {
    expect(engine.prepareWrite("posts", "create", user("a"), { body: "b" }).values).toMatchObject({ body: "b", author_id: "a" });
  });

  it("allow: update of an existing row the ctx owns", () => {
    expect(engine.prepareWrite("posts", "update", user("a"), { body: "b" }, { id: "p", author_id: "a" }).values).toEqual({ body: "b" });
  });

  it("deny: update of a row owned by someone else, even for an updater role", () => {
    expect(status(() => engine.prepareWrite("posts", "update", user("e", ["editor"]), { body: "b" }, { id: "p", author_id: "a" }))).toBe(403);
    expect(status(() => engine.prepareWrite("posts", "update", user("e", ["admin"]), { body: "b" }, { id: "p", author_id: "a" }))).toBe(403);
  });

  it("deny: update without the existing row cannot prove self", () => {
    expect(status(() => engine.prepareWrite("posts", "update", user("a"), { body: "b" }))).toBe(403);
  });

  it("allow: a listed role OR self suffices (title: editor or self)", () => {
    expect(engine.prepareWrite("posts", "update", user("e", ["editor"]), { title: "t" }, { id: "p", author_id: "a" }).values).toEqual({ title: "t" });
    expect(engine.prepareWrite("posts", "update", user("a"), { title: "t" }, { id: "p", author_id: "a" }).values).toEqual({ title: "t" });
    expect(status(() => engine.prepareWrite("posts", "update", user("e", ["admin"]), { title: "t" }, { id: "p", author_id: "a" }))).toBe(403);
  });

  it("self on the primary key: create with the own id / update of the own row", () => {
    expect(engine.prepareWrite("users", "create", user("u1"), { id: "u1", email: "a@x" }).values).toMatchObject({ email: "a@x" });
    expect(engine.prepareWrite("users", "update", user("u1"), { email: "a@x" }, { id: "u1" }).values).toEqual({ email: "a@x" });
  });

  it("self on the primary key: deny for another row or a missing id; admin may", () => {
    expect(status(() => engine.prepareWrite("users", "create", user("u1"), { id: "u2", email: "a@x" }))).toBe(403);
    expect(status(() => engine.prepareWrite("users", "create", user("u1"), { email: "a@x" }))).toBe(403);
    expect(status(() => engine.prepareWrite("users", "update", user("u1"), { email: "a@x" }, { id: "u2" }))).toBe(403);
    expect(engine.prepareWrite("users", "update", user("u1", ["admin"]), { email: "a@x" }, { id: "u2" }).values).toEqual({ email: "a@x" });
  });
});

describe("canReadColumn", () => {
  it("is true for plain columns, false for unknown and hidden ones", () => {
    const e = createPolicyEngine({
      config: { database: "d1", roles: ROLES, tables: { posts: { read: authenticated(), fields: { views: { hidden: true } } } } },
      snapshot: blogSnapshot,
    });
    expect(e.canReadColumn("posts", "id", anon())).toBe(true);
    expect(e.canReadColumn("posts", "views", user("a", ["admin"]))).toBe(false);
    expect(e.canReadColumn("posts", "nope", user("a"))).toBe(false);
    expect(e.canReadColumn("audit_logs", "id", user("a"))).toBe(false);
  });

  it("visibleTo columns need a listed real role; self does not count", () => {
    expect(engine.canReadColumn("posts", "internal_notes", user("a", ["admin"]))).toBe(true);
    expect(engine.canReadColumn("posts", "internal_notes", user("a", ["editor"]))).toBe(false);
    expect(engine.canReadColumn("users", "email", user("u1"))).toBe(false);
    expect(engine.canReadColumn("users", "email", user("u1", ["admin"]))).toBe(true);
  });
});
