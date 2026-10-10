/**
 * Security review: adversarial tests for the M1 policy engine (Node, no D1).
 *
 * Tests in the "FINDING" describe blocks assert the CORRECT behaviour and fail until the bug is
 * fixed. Everything else is a regression test for an attack that the engine currently resists.
 */
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
  type CastraConfig,
  type PolicyEngine,
} from "../../src/index.js";
import { anon, blogSnapshot, ROLES, user } from "./fixtures.js";

const ARCH_CONFIG: CastraConfig = {
  database: "d1",
  roles: ROLES,
  tables: {
    posts: {
      read: isPublic()
        .where((q) => q.eb("status", "=", "published"))
        .or(owner("author_id"))
        .or(role("admin")),
      create: authenticated(),
      update: owner("author_id").or(role("editor", "admin")),
      delete: role("admin"),
      fields: {
        author_id: { setBy: "server" },
        internal_notes: { visibleTo: ["admin"] },
        created_at: { readonly: true },
      },
      filterable: ["status", "created_at"],
    },
    comments: {
      read: isPublic(),
      create: authenticated(),
      update: owner("user_id"),
      delete: owner("user_id").or(role("admin")),
      fields: { user_id: { setBy: "server" } },
    },
    users: {
      read: authenticated(),
      fields: { email: { visibleTo: ["self", "admin"] }, password_hash: { hidden: true } },
    },
  },
};

const engine = createPolicyEngine({ config: ARCH_CONFIG, snapshot: blogSnapshot });

function rejection(fn: () => unknown): PolicyError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError);
    return e as PolicyError;
  }
  throw new Error("expected a PolicyError");
}

// ---------------------------------------------------------------------------------------------
// FINDINGS (fail until fixed)
// ---------------------------------------------------------------------------------------------

describe("FINDING: owner() columns are client-writable on create unless setBy: 'server' is declared", () => {
  // ARCHITECTURE §3: "Owner columns are set by the server (owner_id = ctx.user.id); a client-supplied
  // different value is rejected." The engine only enforces this when the column also carries
  // `setBy: "server"`. With the natural config below, u1 can create a post attributed to u2.
  it("rejects a create whose owner column names another user (or refuses the config)", () => {
    const cfg: CastraConfig = {
      database: "d1",
      roles: ROLES,
      tables: { posts: { read: owner("author_id"), create: authenticated(), update: owner("author_id") } },
    };
    let e: PolicyEngine;
    try {
      e = createPolicyEngine({ config: cfg, snapshot: blogSnapshot });
    } catch (err) {
      // Acceptable fix: refuse owner() columns without setBy: "server" at config time.
      expect(err).toBeInstanceOf(CastraConfigError);
      return;
    }
    const err = rejection(() => e.prepareWrite("posts", "create", user("u1"), { title: "t", body: "b", author_id: "u2" }));
    expect(err.status).toBe(403);
  });
});

describe("FINDING: hidden columns can be declared filterable", () => {
  // `hidden` means "never leaves the server", but a filter on it is a boolean oracle: with M2's
  // PostgREST-style filters (`password_hash=like.a*`) a caller can extract the value bit by bit
  // using row counts. The engine accepts this config silently.
  it("createPolicyEngine refuses a hidden column in filterable", () => {
    const cfg: CastraConfig = {
      database: "d1",
      roles: ROLES,
      tables: {
        users: { read: authenticated(), fields: { password_hash: { hidden: true } }, filterable: ["password_hash"] },
      },
    };
    expect(() => createPolicyEngine({ config: cfg, snapshot: blogSnapshot })).toThrow(CastraConfigError);
  });
});

// ---------------------------------------------------------------------------------------------
// Attacks that held (regression tests)
// ---------------------------------------------------------------------------------------------

describe("held: prepareWrite key-name tricks", () => {
  const attempts: Array<[string, Record<string, unknown>]> = [
    ["__proto__ own key from JSON", JSON.parse('{"title":"t","__proto__":{"author_id":"u2"}}') as Record<string, unknown>],
    ["constructor", { title: "t", constructor: "x" }],
    ["upper-case column", { title: "t", AUTHOR_ID: "u2" }],
    ["mixed-case column", { title: "t", Author_Id: "u2" }],
    ["quoted identifier", { title: "t", '"author_id"': "u2" }],
    ["qualified identifier", { title: "t", "posts.author_id": "u2" }],
    ["trailing space", { title: "t", "author_id ": "u2" }],
    ["hidden via case", { title: "t", Internal_Notes: "x" }],
  ];
  for (const [name, input] of attempts) {
    it(`rejects ${name} on create and update`, () => {
      expect(rejection(() => engine.prepareWrite("posts", "create", user("u1"), input)).status).toBe(400);
      expect(rejection(() => engine.prepareWrite("posts", "update", user("u1"), input)).status).toBe(400);
    });
  }

  it("inherited (prototype) properties are never written", () => {
    const input = Object.create({ author_id: "u2", internal_notes: "x" }) as Record<string, unknown>;
    input.title = "t";
    const { values } = engine.prepareWrite("posts", "create", user("u1"), input);
    expect(values).toEqual({ title: "t", author_id: "u1" });
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
  });

  it("server owner column on update is never written, even when the client sends its own id", () => {
    const { values } = engine.prepareWrite("posts", "update", user("u9", ["editor"]), { title: "x", author_id: "u9" });
    expect(values).toEqual({ title: "x" });
  });

  it("server owner column on update with the stored row: an editor cannot take ownership", () => {
    const err = rejection(() =>
      engine.prepareWrite("posts", "update", user("u9", ["editor"]), { author_id: "u9" }, { author_id: "u1" }),
    );
    expect(err.status).toBe(403);
  });

  it("owner value type confusion is rejected (number, padded, case)", () => {
    for (const v of [1, "u1 ", " u1", "U1", null, true]) {
      expect(rejection(() => engine.prepareWrite("posts", "create", user("u1"), { author_id: v })).status).toBe(403);
    }
  });

  it("anonymous create on a table with a server owner column is 401, never a NULL owner", () => {
    const open = createPolicyEngine({
      config: {
        database: "d1",
        roles: ROLES,
        tables: { posts: { create: isPublic(), read: owner("author_id"), fields: { author_id: { setBy: "server" } } } },
      },
      snapshot: blogSnapshot,
    });
    expect(rejection(() => open.prepareWrite("posts", "create", anon(), { title: "t" })).status).toBe(401);
    expect(rejection(() => open.prepareWrite("posts", "create", anon(), { title: "t", author_id: null })).status).toBe(401);
  });
});

describe("held: projectRow leakage tricks", () => {
  const row = { id: "u1", email: "a@x", name: "A", password_hash: "h", created_at: "t" };

  it("case variants and extra keys of hidden/visibleTo columns never leak", () => {
    const tricky = { ...row, PASSWORD_HASH: "h", Password_Hash: "h", EMAIL: "a@x", "users.email": "a@x", '"email"': "a@x" };
    const out = engine.projectRow("users", user("u2"), tricky);
    expect(out).toEqual({ id: "u1", name: "A", created_at: "t" });
  });

  it("an own __proto__ key in a row is dropped and does not change the prototype", () => {
    const tricky = JSON.parse('{"id":"u1","__proto__":{"email":"a@x"}}') as Record<string, unknown>;
    const out = engine.projectRow("users", user("u2"), tricky);
    expect(Object.keys(out)).toEqual(["id"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { email?: unknown }).email).toBeUndefined();
  });

  it("self never matches for anonymous / empty-id / non-string-id callers, even when the row id is empty or null", () => {
    const malformed = [anon(), anon(["admin"]), user(""), { ...user("x"), user: { id: 1 as unknown as string } }];
    for (const ctx of malformed) {
      for (const id of ["", null, undefined]) {
        expect(engine.projectRow("users", ctx, { ...row, id })).not.toHaveProperty("email");
      }
    }
  });

  it("self is strict: 'u1 ' / 'U1' / numeric ids do not match", () => {
    expect(engine.projectRow("users", user("u1 "), row)).not.toHaveProperty("email");
    expect(engine.projectRow("users", user("U1"), row)).not.toHaveProperty("email");
    expect(engine.projectRow("users", user("1"), { ...row, id: 1 })).not.toHaveProperty("email");
    expect(engine.projectRow("users", user("u1"), row)).toHaveProperty("email", "a@x");
  });

  it("a 'self' entry in ctx.roles grants nothing", () => {
    expect(engine.projectRow("users", user("u2", ["self"]), row)).not.toHaveProperty("email");
    expect(engine.projectRow("posts", user("u2", ["self"]), { id: "p", internal_notes: "n" })).not.toHaveProperty("internal_notes");
  });
});

describe("held: anonymous and malformed contexts", () => {
  it("anonymous with roles never gets role-gated access", () => {
    expect(engine.readFilter("posts", "delete", anon(["admin"])).explanation.allowed).toBe(false);
    expect(rejection(() => engine.prepareWrite("comments", "create", anon(["admin", "editor", "member"]), {})).status).toBe(401);
  });

  it("owner() for anonymous compiles to constant false, never to `col = NULL` / `IS NULL`", () => {
    const f = engine.readFilter("comments", "update", anon());
    expect(f.explanation.allowed).toBe(false);
    expect(f.explanation.where).toEqual({ sql: "1 = 0", parameters: [] });
  });

  it("authenticated().or(owner()) for anonymous does not fold to true", () => {
    const e2 = createPolicyEngine({
      config: { database: "d1", roles: ROLES, tables: { posts: { read: role("admin").or(owner("author_id")) } } },
      snapshot: blogSnapshot,
    });
    expect(e2.readFilter("posts", "read", anon(["admin"])).explanation.where).toEqual({ sql: "1 = 0", parameters: [] });
  });

  it("user ids are bound as parameters, never inlined (injection-shaped ids)", () => {
    const evil = `u1' OR 1=1 --`;
    const f = engine.readFilter("comments", "update", user(evil));
    expect(f.explanation.where!.sql).not.toContain("OR 1=1");
    expect(f.explanation.where!.parameters).toEqual([evil]);
  });

  it(".where() narrows the whole or-chain (precedence): admin does not escape the predicate", () => {
    const e2 = createPolicyEngine({
      config: {
        database: "d1",
        roles: ROLES,
        tables: { posts: { read: role("admin").or(owner("author_id")).where((q) => q.eb("status", "=", "published")) } },
      },
      snapshot: blogSnapshot,
    });
    const f = e2.readFilter("posts", "read", user("u1", ["admin"]));
    expect(f.explanation.allowed).toBe("conditional");
    expect(f.explanation.where!.sql).toContain("status");
  });

  it("unknown ops never open anything", () => {
    for (const op of ["constructor", "__proto__", "toString", "READ", "Read"]) {
      expect(engine.isOpen("posts", op as "read")).toBe(false);
      expect(() => engine.readFilter("posts", op as "read", user("u1"))).toThrow();
    }
  });
});

describe("held: reserved and unknown tables", () => {
  const reserved = ["user", "USER", "Session", "ACCOUNT", "Verification", "_castra_roles", "_CASTRA_api_keys", "sqlite_master", "SQLITE_sequence", "_cf_KV"];
  for (const t of reserved) {
    it(`config cannot expose "${t}"`, () => {
      expect(() => defineConfig({ database: "d1", roles: [], tables: { [t]: { read: isPublic() } } })).toThrow(CastraConfigError);
    });
  }

  it("lookalike names (whitespace, Unicode case folding, qualified) never resolve to a reserved table", () => {
    const lookalikes = ["user ", " user", "main.user", "VERİFİCATİON", "ſession", "user​"];
    const snap = { ...blogSnapshot, tables: { ...blogSnapshot.tables } };
    const tables: CastraConfig["tables"] = {};
    for (const t of lookalikes) tables[t] = { read: isPublic() };
    const e2 = createPolicyEngine({ config: { database: "d1", roles: [], tables }, snapshot: snap });
    for (const t of [...lookalikes, "user", "session", "audit_logs", "constructor", "__proto__"]) {
      expect(e2.isOpen(t, "read")).toBe(false);
      expect(() => e2.readFilter(t, "read", user("u1"))).toThrow(PolicyError);
    }
  });

  it("an engine never exposes a reserved table even if a snapshot names it", () => {
    for (const t of ["user", "_castra_roles"]) {
      expect(engine.isOpen(t, "read")).toBe(false);
      expect(() => engine.projectRow(t, user("u1", ["admin"]), { id: "x" })).toThrow(PolicyError);
    }
  });
});
