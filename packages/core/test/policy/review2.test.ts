/**
 * Second security review (unit, no D1): canFilter matrix, owner columns, rule tree edge cases,
 * immutability of config/rules after validation, predicate reference validation, explain copies.
 *
 * "held" blocks pass and are regressions. "FINDING" blocks assert the correct behaviour and fail until
 * the engine is fixed.
 */
import { describe, expect, it } from "vitest";
import {
  authenticated,
  CastraConfigError,
  createPolicyEngine,
  custom,
  defineConfig,
  isPublic,
  owner,
  PolicyError,
  role,
  Rule,
  type CastraContext,
  type FieldConfig,
  type RuleNode,
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

describe("held: canFilter over every combination of hidden / visibleTo / filterable / self / anonymous / roles", () => {
  const hiddenOpts = [false, true];
  const visibleToOpts: Array<string[] | undefined> = [undefined, [], ["self"], ["admin"], ["self", "admin"], ["editor", "admin"]];
  const filterableOpts: Array<string[] | undefined> = [undefined, ["internal_notes"], ["status"], ["internal_notes", "status"]];
  const selfOpts = [undefined, "author_id"];
  const ctxs: Array<[string, CastraContext]> = [
    ["anon", anon()],
    ["anon claiming admin", anon(["admin"])],
    ["empty id claiming admin", { user: { id: "" }, roles: ["admin"], session: null, request: null, via: "test" }],
    ["numeric id claiming admin", { user: { id: 7 as unknown as string }, roles: ["admin"], session: null, request: null, via: "test" }],
    ["user", user("u1")],
    ["user admin", user("u1", ["admin"])],
    ["user editor", user("u1", ["editor"])],
    ["user with 'self' role", user("u1", ["self"])],
    ["user with non-string roles", { user: { id: "u1" }, roles: [1, null, { toString: () => "admin" }] as unknown as string[], session: null, request: null, via: "test" }],
  ];

  for (const hidden of hiddenOpts)
    for (const visibleTo of visibleToOpts)
      for (const filterable of filterableOpts)
        for (const selfColumn of selfOpts) {
          const label = `hidden=${hidden} visibleTo=${JSON.stringify(visibleTo)} filterable=${JSON.stringify(filterable)} self=${selfColumn}`;
          it(label, () => {
            const field: FieldConfig = {};
            if (hidden) field.hidden = true;
            if (visibleTo) field.visibleTo = visibleTo;
            const build = () =>
              createPolicyEngine({
                config: {
                  database: "d1",
                  roles: ROLES,
                  tables: {
                    posts: {
                      read: isPublic(),
                      fields: { internal_notes: field },
                      ...(filterable ? { filterable } : {}),
                      ...(selfColumn ? { selfColumn } : {}),
                    },
                  },
                },
                snapshot: blogSnapshot,
              });
            if (hidden && filterable?.includes("internal_notes")) {
              expect(build).toThrow(CastraConfigError);
              return;
            }
            const engine = build();
            for (const [name, ctx] of ctxs) {
              const roles =
                ctx.user && typeof ctx.user.id === "string" && ctx.user.id.length > 0 ? ctx.roles.filter((r) => typeof r === "string") : [];
              const expected =
                !hidden &&
                (filterable === undefined || filterable.includes("internal_notes")) &&
                (visibleTo === undefined || visibleTo.some((r) => r !== "self" && roles.includes(r)));
              expect({ name, can: engine.canFilter("posts", "internal_notes", ctx) }).toEqual({ name, can: expected });
              // canFilter ⇒ the column is visible on EVERY row (no per-row oracle): own row, foreign row, NULL owner.
              if (expected) {
                for (const author_id of ["u1", "u2", null]) {
                  expect(engine.projectRow("posts", ctx, { id: "p", author_id, internal_notes: "n" })).toHaveProperty("internal_notes", "n");
                }
              }
            }
          });
        }
});

describe("held: owner() columns stay server-set on every path", () => {
  const engine = createPolicyEngine({
    config: {
      database: "d1",
      roles: ROLES,
      tables: {
        // owner() buried deep inside the delete rule only
        posts: {
          read: isPublic(),
          create: authenticated(),
          update: authenticated(),
          delete: role("admin").or(authenticated().and(isPublic().or(owner("author_id")).and(owner("author_id")))),
        },
      },
    },
    snapshot: blogSnapshot,
  });

  it("deep-nested owner() in delete still makes the column server-set on create and update", () => {
    expect(engine.prepareWrite("posts", "create", user("u1"), { title: "t" }).values).toEqual({ title: "t", author_id: "u1" });
    expect(rejection(() => engine.prepareWrite("posts", "create", user("u1"), { author_id: "u2" })).status).toBe(403);
    expect(rejection(() => engine.prepareWrite("posts", "update", user("u1"), { author_id: "u2" })).status).toBe(403);
  });

  it("update without `existing`: the caller's own id is accepted but never written (admin cannot take ownership)", () => {
    expect(engine.prepareWrite("posts", "update", user("adm", ["admin"]), { author_id: "adm", title: "x" }).values).toEqual({ title: "x" });
  });

  it("update with an `existing` row that lacks the owner key fails closed", () => {
    expect(rejection(() => engine.prepareWrite("posts", "update", user("u1"), { author_id: "u1" }, { id: "p" })).status).toBe(403);
  });

  it("case variants, padded and prototype keys of the owner column are rejected, never written", () => {
    for (const key of ["AUTHOR_ID", "Author_Id", "author_id ", " author_id", "posts.author_id", '"author_id"']) {
      expect(rejection(() => engine.prepareWrite("posts", "create", user("u1"), { [key]: "u2" })).code).toBe("unknown_column");
      expect(rejection(() => engine.prepareWrite("posts", "update", user("u1"), { [key]: "u2" })).code).toBe("unknown_column");
    }
  });

  it("anonymous update sending an owner value is 401 when no existing row is passed", () => {
    const open = createPolicyEngine({
      config: { database: "d1", roles: ROLES, tables: { posts: { read: owner("author_id"), update: isPublic() } } },
      snapshot: blogSnapshot,
    });
    expect(rejection(() => open.prepareWrite("posts", "update", anon(), { author_id: "u2" })).status).toBe(401);
  });

  it("owner() naming a column in a different case than the snapshot is a config error, not a silent bypass", () => {
    expect(() =>
      createPolicyEngine({ config: { database: "d1", roles: ROLES, tables: { posts: { read: owner("Author_Id") } } }, snapshot: blogSnapshot }),
    ).toThrow(CastraConfigError);
  });
});

describe("held: rule tree edge cases", () => {
  it("role() with no names is rejected at build time", () => {
    expect(() => role()).toThrow(TypeError);
  });

  it(".where() on a constant-false rule folds to false and the predicate never runs per request", () => {
    let calls = 0;
    const engine = createPolicyEngine({
      config: {
        database: "d1",
        roles: ROLES,
        tables: { posts: { read: role("admin").where((q) => (calls++, q.eb("status", "=", "published"))) } },
      },
      snapshot: blogSnapshot,
    });
    const afterValidation = calls;
    const f = engine.readFilter("posts", "read", user("u1", ["editor"]));
    expect(f.explanation.allowed).toBe(false);
    expect(f.explanation.where).toEqual({ sql: "1 = 0", parameters: [] });
    expect(calls).toBe(afterValidation);
  });

  it("duplicate rules do not change the decision", () => {
    const engine = createPolicyEngine({
      config: {
        database: "d1",
        roles: ROLES,
        tables: { posts: { read: owner("author_id").or(owner("author_id")).and(owner("author_id").or(owner("author_id"))) } },
      },
      snapshot: blogSnapshot,
    });
    expect(engine.readFilter("posts", "read", anon()).explanation.allowed).toBe(false);
    expect(engine.readFilter("posts", "read", user("u1")).explanation.allowed).toBe("conditional");
  });

  it("custom predicate with a subquery on a table missing from the snapshot is a config error", () => {
    expect(() =>
      createPolicyEngine({
        config: {
          database: "d1",
          roles: ROLES,
          tables: { posts: { read: custom("ghost", (eb) => eb.exists(eb.selectFrom("ghost_table").select("id"))) } },
        },
        snapshot: blogSnapshot,
      }),
    ).toThrow(CastraConfigError);
  });
});

describe("held: config is immutable after defineConfig", () => {
  it("tables, fields, visibleTo, filterable and roles cannot be changed, and the engine is unaffected", () => {
    const config = defineConfig({
      database: "d1",
      roles: ["admin", "editor", "member"],
      tables: { posts: { read: role("admin"), fields: { internal_notes: { visibleTo: ["admin"] } }, filterable: ["status"] } },
    });
    const engine = createPolicyEngine({ config, snapshot: blogSnapshot });
    const attempts: Array<() => void> = [
      () => ((config.tables as Record<string, unknown>).comments = { read: isPublic() }),
      () => ((config.tables.posts as Record<string, unknown>).read = isPublic()),
      () => config.tables.posts!.fields!.internal_notes!.visibleTo!.push("member"),
      () => config.tables.posts!.filterable!.push("internal_notes"),
      () => config.roles.push("x"),
      () => ((config.tables.posts!.read as unknown as { node: unknown }).node = { kind: "public" }),
      () => ((config.tables.posts!.read!.node as { kind: string }).kind = "public"),
    ];
    for (const a of attempts) expect(a).toThrow(TypeError);
    expect(engine.readFilter("posts", "read", anon()).explanation.allowed).toBe(false);
    expect(engine.isOpen("comments", "read")).toBe(false);
    expect(engine.canFilter("posts", "internal_notes", user("u1", ["member"]))).toBe(false);
  });

  it("explain() and filter explanations are copies: mutating them changes nothing", () => {
    const engine = createPolicyEngine({
      config: { database: "d1", roles: ROLES, tables: { posts: { read: owner("author_id"), fields: { body: { hidden: true } } } } },
      snapshot: blogSnapshot,
    });
    const f = engine.readFilter("posts", "read", user("u1"));
    const e = engine.explain(f);
    e.hiddenFields.length = 0;
    e.where!.parameters[0] = "u2";
    expect(engine.explain(f).hiddenFields).toEqual(["body"]);
    expect(engine.explain(f).where!.parameters).toEqual(["u1"]);
  });
});

describe("FINDING F: rule nodes passed to the exported Rule constructor are not frozen; policy can change after validation", () => {
  it("mutating the node after createPolicyEngine does not open the table", () => {
    const node = { kind: "role", roles: ["admin"] } as { kind: string; roles?: string[] };
    const engine = createPolicyEngine({
      config: { database: "d1", roles: ROLES, tables: { posts: { read: new Rule(node as RuleNode) } } },
      snapshot: blogSnapshot,
    });
    expect(engine.readFilter("posts", "read", anon()).explanation.allowed).toBe(false);
    try {
      node.kind = "public";
    } catch {
      /* frozen: fine */
    }
    expect(engine.readFilter("posts", "read", anon()).explanation.allowed).toBe(false);
  });

  it("defineConfig validates role names on a node that can be swapped to an undeclared role afterwards", () => {
    const roles = ["admin"];
    const config = defineConfig({ database: "d1", roles: ROLES, tables: { posts: { read: new Rule({ kind: "role", roles } as RuleNode) } } });
    try {
      roles[0] = "ghost";
    } catch {
      /* frozen: fine */
    }
    expect((config.tables.posts!.read!.node as unknown as { roles: string[] }).roles).toEqual(["admin"]);
  });
});
