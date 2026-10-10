/**
 * FINDING F follow-up: Rule nodes and the captured snapshot are private, deep-frozen copies.
 * Allow and deny cases for the Rule constructor's validation.
 */
import { describe, expect, it } from "vitest";
import { createPolicyEngine, isPublic, role, Rule, type RuleNode, type SchemaSnapshot } from "../../src/index.js";
import { anon, blogSnapshot, ROLES, user } from "./fixtures.js";

describe("Rule constructor copies and freezes", () => {
  it("allows: a valid nested node is copied, deep-frozen and still describes the same rule", () => {
    const children = [
      { kind: "role", roles: ["admin"] },
      { kind: "owner", column: "author_id" },
    ];
    const node = { kind: "or", children } as unknown as RuleNode;
    const r = new Rule(node);
    expect(r.toString()).toBe("or(role(admin), owner(author_id))");
    expect(r.node).not.toBe(node);
    expect(Object.isFrozen(r.node)).toBe(true);
    children.push({ kind: "public" } as never);
    (children[0] as { roles: string[] }).roles.push("editor");
    expect(r.toString()).toBe("or(role(admin), owner(author_id))");
  });

  it("denies: malformed nodes are rejected at construction", () => {
    const bad: unknown[] = [
      null,
      { kind: "nope" },
      { kind: "role", roles: [] },
      { kind: "role", roles: [""] },
      { kind: "owner" },
      { kind: "custom", name: "x" },
      { kind: "where" },
      { kind: "and", children: [{ kind: "bogus" }] },
    ];
    for (const n of bad) expect(() => new Rule(n as RuleNode)).toThrow(TypeError);
  });

  it("combinators keep frozen copies", () => {
    const r = role("admin").or(isPublic());
    expect(Object.isFrozen((r.node as unknown as { children: unknown[] }).children)).toBe(true);
  });
});

describe("createPolicyEngine captures a frozen copy of the snapshot", () => {
  it("mutating the caller's snapshot after construction changes nothing", () => {
    const snap = structuredClone(blogSnapshot) as SchemaSnapshot;
    const engine = createPolicyEngine({ config: { database: "d1", roles: ROLES, tables: { posts: { read: isPublic() } } }, snapshot: snap });
    delete (snap.tables as Record<string, unknown>).posts;
    expect(engine.isOpen("posts", "read")).toBe(true);
    expect(engine.readFilter("posts", "read", anon()).explanation.allowed).toBe(true);
    expect(engine.canFilter("posts", "title", user("u1"))).toBe(true);
  });
});
