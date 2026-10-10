import { describe, expect, it } from "vitest";
import { authenticated, createPolicyEngine, custom, isPublic, owner, role } from "../../src/index.js";
import { anon, blogSnapshot, ROLES, user } from "./fixtures.js";

const read = isPublic()
  .where((q) => q.eb("status", "=", "published"))
  .or(owner("author_id"))
  .or(role("admin"));

const engine = createPolicyEngine({
  config: {
    database: "d1",
    roles: ROLES,
    tables: {
      posts: {
        read,
        create: authenticated(),
        update: owner("author_id").or(role("editor", "admin")),
        delete: role("admin"),
        fields: { internal_notes: { visibleTo: ["admin"] } },
      },
      comments: {
        read: custom("on-published-post", (eb) =>
          eb.exists(eb.selectFrom("posts").select("posts.id").whereRef("posts.id", "=", "comments.post_id").where("posts.status", "=", "published")),
        ),
      },
    },
  },
  snapshot: blogSnapshot,
});

describe("rule tree strings", () => {
  it("flattens and/or chains", () => {
    expect(read.toString()).toBe("or(and(public, where), owner(author_id), role(admin))");
    expect(owner("a").and(role("x", "y")).and(custom("c", (eb) => eb.lit(true))).toString()).toBe("and(owner(a), role(x, y), custom(c))");
  });

  it("rules are immutable: combinators return new rules", () => {
    const base = authenticated();
    const combined = base.or(role("admin"));
    expect(base.toString()).toBe("authenticated");
    expect(combined.toString()).toBe("or(authenticated, role(admin))");
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.node)).toBe(true);
  });
});

describe("explain()", () => {
  it("anonymous: residual is the where predicate; SQL and params are reported", () => {
    const f = engine.readFilter("posts", "read", anon());
    const e = engine.explain(f);
    expect(e).toMatchObject({
      table: "posts",
      op: "read",
      allowed: "conditional",
      matchedRule: "or(and(public, where), owner(author_id), role(admin))",
      where: { sql: '"status" = ?', parameters: ["published"] },
      hiddenFields: ["internal_notes"],
    });
    expect(e.reason).toMatch(/residual for this context: where/);
  });

  it("authenticated: owner compiles to a table-qualified column bound to the user id", () => {
    const e = engine.explain(engine.readFilter("posts", "read", user("u1")));
    expect(e.allowed).toBe("conditional");
    expect(e.where).toEqual({ sql: '("status" = ? or "posts"."author_id" = ?)', parameters: ["published", "u1"] });
    expect(e.reason).toMatch(/or\(where, owner\(author_id\)\)/);
  });

  it("admin: constant true, no hidden visibleTo fields", () => {
    const e = engine.explain(engine.readFilter("posts", "read", user("a", ["admin"])));
    expect(e.allowed).toBe(true);
    expect(e.where).toEqual({ sql: "1 = 1", parameters: [] });
    expect(e.hiddenFields).toEqual([]);
  });

  it("fully false: filter is 1 = 0 and allowed is false", () => {
    const e = engine.explain(engine.readFilter("posts", "delete", user("u1", ["editor"])));
    expect(e).toMatchObject({ allowed: false, matchedRule: "role(admin)", where: { sql: "1 = 0", parameters: [] } });
  });

  it("custom predicates appear by name and compile to SQL", () => {
    const e = engine.explain(engine.readFilter("comments", "read", anon()));
    expect(e.matchedRule).toBe("custom(on-published-post)");
    expect(e.where?.sql).toContain('exists (select "posts"."id" from "posts" where "posts"."id" = "comments"."post_id"');
    expect(e.where?.parameters).toEqual(["published"]);
  });

  it("explain() returns a copy", () => {
    const f = engine.readFilter("posts", "read", anon());
    engine.explain(f).hiddenFields.push("x");
    expect(f.explanation.hiddenFields).toEqual(["internal_notes"]);
  });

  it("user ids are parameters, never spliced into SQL", () => {
    const evil = `x" OR 1=1 --`;
    const e = engine.explain(engine.readFilter("posts", "update", user(evil)));
    expect(e.where?.sql).toBe('"posts"."author_id" = ?');
    expect(e.where?.parameters).toEqual([evil]);
  });
});
