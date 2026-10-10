import { describe, expect, it } from "vitest";
import {
  authenticated,
  CastraConfigError,
  createPolicyEngine,
  custom,
  defineConfig,
  isPublic,
  owner,
  role,
  type CastraConfig,
  type Operation,
  type TableConfig,
} from "../../src/index.js";
import { blogSnapshot, ROLES } from "./fixtures.js";

const OPS: Operation[] = ["read", "create", "update", "delete"];

function cfg(tables: Record<string, TableConfig>, roles = ROLES): CastraConfig {
  return { database: "d1", roles, tables };
}

describe("defineConfig", () => {
  it("accepts the ARCHITECTURE §7 example", () => {
    const config = defineConfig({
      database: "d1",
      auth: { provider: "better-auth", methods: ["email", "github"] },
      storage: false,
      api: { maxLimit: 100 },
      roles: ["admin", "editor", "member"],
      tables: {
        posts: {
          read: isPublic()
            .where((q) => q.eb("status", "=", "published"))
            .or(owner("author_id"))
            .or(role("admin")),
          create: authenticated(),
          update: owner("author_id").or(role("editor", "admin")),
          delete: role("admin"),
          fields: { author_id: { setBy: "server" }, internal_notes: { visibleTo: ["admin"] } },
          filterable: ["status", "created_at"],
        },
        comments: {
          read: isPublic(),
          create: authenticated(),
          update: owner("user_id"),
          delete: owner("user_id").or(role("admin")),
          fields: { user_id: { setBy: "server" } },
        },
        users: { read: authenticated(), fields: { email: { visibleTo: ["self", "admin"] } } },
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.tables)).toBe(true);
  });

  it.each(["user", "session", "account", "verification", "User", "SESSION"])("rejects a policy on Better Auth table %s", (t) => {
    expect(() => defineConfig(cfg({ [t]: { read: isPublic() } }))).toThrow(CastraConfigError);
  });

  it.each(["_castra_roles", "_castra_audit", "_CASTRA_x", "sqlite_master", "_cf_KV", "d1_migrations", "D1_Migrations"])("rejects internal table %s", (t) => {
    expect(() => defineConfig(cfg({ [t]: { read: isPublic() } }))).toThrow(/reserved/);
  });

  it("rejects a reserved table even with no rules", () => {
    expect(() => defineConfig(cfg({ user: {} }))).toThrow(CastraConfigError);
  });

  it("rejects unknown roles in role(...)", () => {
    expect(() => defineConfig(cfg({ posts: { read: role("superuser") } }))).toThrow(/superuser/);
    expect(() => defineConfig(cfg({ posts: { read: isPublic().and(owner("author_id").or(role("root"))) } }))).toThrow(/root/);
  });

  it("rejects visibleTo naming unknown roles, but allows self", () => {
    expect(() => defineConfig(cfg({ posts: { read: isPublic(), fields: { title: { visibleTo: ["ghost"] } } } }))).toThrow(/ghost/);
    expect(() => defineConfig(cfg({ users: { read: isPublic(), fields: { email: { visibleTo: ["self"] } } } }))).not.toThrow();
  });

  it("rejects declaring the reserved role self, duplicate roles and empty roles", () => {
    expect(() => defineConfig(cfg({}, ["self"]))).toThrow(/reserved/);
    expect(() => defineConfig(cfg({}, ["admin", "admin"]))).toThrow(/duplicate/);
    expect(() => defineConfig(cfg({}, [""]))).toThrow(CastraConfigError);
  });

  it("rejects non-rule values in rule slots (a truthy value never opens a table)", () => {
    for (const bad of [true, "public", {}, { node: { kind: "public" } }, () => true]) {
      expect(() => defineConfig(cfg({ posts: { read: bad as never } }))).toThrow(/rule/);
    }
  });

  it("rejects unknown keys (typos never silently change policy)", () => {
    expect(() => defineConfig(cfg({ posts: { reads: isPublic() } as never }))).toThrow(/unknown key "reads"/);
    expect(() => defineConfig(cfg({ posts: { read: isPublic(), fields: { title: { hiden: true } as never } } }))).toThrow(/hiden/);
    expect(() => defineConfig({ ...cfg({}), polices: {} } as never)).toThrow(/polices/);
  });

  it("validates database, api.maxLimit and field flag values", () => {
    expect(() => defineConfig({ database: "postgres", roles: [], tables: {} } as never)).toThrow(/d1/);
    expect(() => defineConfig({ ...cfg({}), api: { maxLimit: 0 } })).toThrow(/maxLimit/);
    expect(() => defineConfig(cfg({ posts: { fields: { title: { setBy: "client" as never } } } }))).toThrow(/setBy/);
    expect(() => defineConfig(cfg({ posts: { fields: { title: { hidden: false as never } } } }))).toThrow(/hidden/);
  });

  it("rule builders validate their arguments", () => {
    expect(() => role()).toThrow();
    expect(() => owner("")).toThrow();
    expect(() => custom("", () => null as never)).toThrow();
    expect(() => isPublic().and({} as never)).toThrow();
  });
});

describe("createPolicyEngine: config vs snapshot", () => {
  const make = (tables: Record<string, TableConfig>) => createPolicyEngine({ config: cfg(tables), snapshot: blogSnapshot });

  it("throws on an unknown owner() column", () => {
    expect(() => make({ posts: { update: owner("auther_id") } })).toThrow(/auther_id/);
  });

  it("throws on unknown field, filterable and selfColumn columns", () => {
    expect(() => make({ posts: { read: isPublic(), fields: { nope: { hidden: true } } } })).toThrow(/nope/);
    expect(() => make({ posts: { read: isPublic(), filterable: ["status", "stat"] } })).toThrow(/stat/);
    expect(() => make({ posts: { read: isPublic(), selfColumn: "owner" } })).toThrow(/owner/);
  });

  it("throws on unknown columns and tables referenced by where/custom predicates", () => {
    expect(() => make({ posts: { read: isPublic().where((q) => q.eb("statuz", "=", "x")) } })).toThrow(/statuz/);
    expect(() =>
      make({
        posts: {
          read: custom("in-team", (eb, ctx) =>
            eb.exists(eb.selectFrom("teams").select("teams.id").where("teams.user_id", "=", ctx.user?.id ?? "")),
          ),
        },
      }),
    ).toThrow(/teams/);
  });

  it("accepts predicates referencing other snapshot tables", () => {
    expect(() =>
      make({
        posts: {
          read: custom("commented", (eb, ctx) =>
            eb.exists(
              eb
                .selectFrom("comments")
                .select("comments.id")
                .whereRef("comments.post_id", "=", "posts.id")
                .where("comments.user_id", "=", ctx.user?.id ?? ""),
            ),
          ),
        },
      }),
    ).not.toThrow();
  });

  it("throws when a predicate does not return an expression", () => {
    expect(() => make({ posts: { read: isPublic().where(() => true as never) } })).toThrow(/expression/);
  });

  it("re-validates the config (raw objects cannot bypass defineConfig)", () => {
    expect(() =>
      createPolicyEngine({ config: { database: "d1", roles: [], tables: { session: { read: isPublic() } } }, snapshot: blogSnapshot }),
    ).toThrow(/reserved/);
  });
});

describe("isOpen: default closed", () => {
  const engine = createPolicyEngine({
    config: cfg({
      posts: { read: isPublic() },
      comments: {},
      ghost_table: { read: isPublic() }, // not in snapshot
    }),
    snapshot: blogSnapshot,
  });

  it("a table without policy is closed for every op", () => {
    for (const op of OPS) {
      expect(engine.isOpen("comments", op)).toBe(false);
      expect(engine.isOpen("audit_logs", op)).toBe(false); // in snapshot, not in config
    }
  });

  it("only operations with a rule are open", () => {
    expect(engine.isOpen("posts", "read")).toBe(true);
    for (const op of ["create", "update", "delete"] as const) expect(engine.isOpen("posts", op)).toBe(false);
  });

  it("unknown tables, tables missing from the snapshot, reserved tables and bogus ops are closed", () => {
    for (const op of OPS) {
      expect(engine.isOpen("nope", op)).toBe(false);
      expect(engine.isOpen("ghost_table", op)).toBe(false);
      for (const t of ["user", "session", "account", "verification", "_castra_roles"]) expect(engine.isOpen(t, op)).toBe(false);
    }
    expect(engine.isOpen("posts", "READ" as never)).toBe(false);
    expect(engine.isOpen("__proto__", "read")).toBe(false);
    expect(engine.isOpen("constructor", "read")).toBe(false);
  });

  it("readFilter on a closed operation throws 404", () => {
    expect(() => engine.readFilter("comments", "read", { user: null, roles: [], session: null, request: null, via: "anonymous" })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});
