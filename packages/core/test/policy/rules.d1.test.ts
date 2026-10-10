/**
 * Allow AND deny tests for every rule type × every operation, executed against a real local D1.
 * read/update/delete run the compiled filter in real SELECT/UPDATE/DELETE statements;
 * create (and update's WITH CHECK) run checkRow on a candidate row.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authenticated,
  createPolicyEngine,
  custom,
  isPublic,
  owner,
  PolicyError,
  role,
  type CastraContext,
  type Operation,
  type Rule,
} from "../../src/index.js";
import { createTables, testDb } from "./db.js";
import { anon, blogSnapshot, ROLES, user } from "./fixtures.js";

const db = testDb();

const POSTS = [
  { id: "p1", author_id: "u1", title: "one", body: "", status: "published", internal_notes: null, views: 10, created_at: "t" },
  { id: "p2", author_id: "u2", title: "two", body: "", status: "draft", internal_notes: null, views: 0, created_at: "t" },
];

async function seed() {
  await db.deleteFrom("posts").execute();
  await db.insertInto("posts").values(POSTS).execute();
}

function engineWith(op: Operation, rule: Rule) {
  return createPolicyEngine({
    config: { database: "d1", roles: ROLES, tables: { posts: { [op]: rule } } },
    snapshot: blogSnapshot,
  });
}

/** Does `ctx` get to perform `op` on row `id` under `rule`? Uses real SQL for every op. */
async function permitted(op: Operation, rule: Rule, ctx: CastraContext, id: string): Promise<boolean> {
  const engine = engineWith(op, rule);
  const row = POSTS.find((p) => p.id === id)!;
  switch (op) {
    case "read": {
      const f = engine.readFilter("posts", "read", ctx);
      const rows = await db.selectFrom("posts").select("id").where("id", "=", id).where((eb) => f.apply(eb)).execute();
      return rows.length === 1;
    }
    case "update": {
      const f = engine.readFilter("posts", "update", ctx);
      const res = await db.updateTable("posts").set({ title: "changed" }).where("id", "=", id).where((eb) => f.apply(eb)).executeTakeFirst();
      const updated = Number(res.numUpdatedRows) === 1;
      const check = await engine.checkRow(db, "posts", "update", ctx, { ...row, title: "changed" });
      expect(check.allowed).toBe(updated); // USING and WITH CHECK agree when the patch is neutral
      return updated;
    }
    case "delete": {
      const f = engine.readFilter("posts", "delete", ctx);
      const res = await db.deleteFrom("posts").where("id", "=", id).where((eb) => f.apply(eb)).executeTakeFirst();
      return Number(res.numDeletedRows) === 1;
    }
    case "create": {
      const decision = await engine.checkRow(db, "posts", "create", ctx, { ...row, id: "new" });
      return decision.allowed;
    }
  }
}

interface Case {
  name: string;
  rule: Rule;
  allow: Array<[CastraContext, string]>;
  deny: Array<[CastraContext, string]>;
}

const CASES: Case[] = [
  {
    name: "isPublic",
    rule: isPublic(),
    allow: [
      [anon(), "p2"],
      [user("u9"), "p1"],
    ],
    deny: [], // isPublic has no denying context; its deny test is "other ops stay closed" below
  },
  {
    name: "authenticated",
    rule: authenticated(),
    allow: [[user("u3"), "p2"]],
    deny: [
      [anon(), "p2"],
      [anon(["admin"]), "p1"],
      [{ ...user(""), via: "test" }, "p1"],
    ],
  },
  {
    name: "role",
    rule: role("editor", "admin"),
    allow: [
      [user("u3", ["editor"]), "p2"],
      [user("u3", ["member", "admin"]), "p1"],
    ],
    deny: [
      [user("u3", ["member"]), "p2"],
      [user("u3"), "p2"],
      [anon(["editor"]), "p2"],
    ],
  },
  {
    name: "owner",
    rule: owner("author_id"),
    allow: [
      [user("u2"), "p2"],
      [user("u1"), "p1"],
    ],
    deny: [
      [user("u1"), "p2"],
      [anon(), "p2"],
      [user("u1", ["admin"]), "p2"],
    ],
  },
  {
    name: "custom",
    rule: custom("popular", (eb) => eb("views", ">", 5)),
    allow: [[anon(), "p1"]],
    deny: [[user("u2", ["admin"]), "p2"]],
  },
  {
    name: "custom using ctx",
    rule: custom("own-or-published", (eb, ctx) => eb.or([eb("status", "=", "published"), eb("author_id", "=", ctx.user?.id ?? null)])),
    allow: [
      [anon(), "p1"],
      [user("u2"), "p2"],
    ],
    deny: [
      [anon(), "p2"],
      [user("u1"), "p2"],
    ],
  },
  {
    name: "where",
    rule: isPublic().where((q) => q.eb("status", "=", "published")),
    allow: [[anon(), "p1"]],
    deny: [[user("u2", ["admin"]), "p2"]],
  },
  {
    name: "where using ctx",
    rule: authenticated().where((q) => q.eb("author_id", "<>", q.ctx.user?.id ?? "")),
    allow: [[user("u1"), "p2"]],
    deny: [
      [user("u2"), "p2"],
      [anon(), "p2"],
    ],
  },
  {
    name: "and",
    rule: authenticated().and(owner("author_id")),
    allow: [[user("u2"), "p2"]],
    deny: [
      [user("u1"), "p2"],
      [anon(), "p1"],
    ],
  },
  {
    name: "or",
    rule: role("admin").or(owner("author_id")),
    allow: [
      [user("u9", ["admin"]), "p2"],
      [user("u2"), "p2"],
    ],
    deny: [
      [user("u1", ["member"]), "p2"],
      [anon(["admin"]), "p2"],
    ],
  },
];

const OPS: Operation[] = ["read", "create", "update", "delete"];

describe("rule types × operations (real D1)", () => {
  beforeAll(createTables);
  beforeEach(seed);

  for (const c of CASES) {
    describe(c.name, () => {
      for (const op of OPS) {
        it(`${op}: allows`, async () => {
          for (const [ctx, id] of c.allow) {
            await seed();
            expect(await permitted(op, c.rule, ctx, id), `${JSON.stringify(ctx.user)} ${ctx.roles} on ${id}`).toBe(true);
          }
        });
        if (c.deny.length > 0) {
          it(`${op}: denies`, async () => {
            for (const [ctx, id] of c.deny) {
              await seed();
              expect(await permitted(op, c.rule, ctx, id), `${JSON.stringify(ctx.user)} ${ctx.roles} on ${id}`).toBe(false);
            }
          });
        }
      }
    });
  }

  it("isPublic deny: a public operation does not open the others", async () => {
    for (const op of OPS) {
      const engine = engineWith(op, isPublic());
      for (const other of OPS.filter((o) => o !== op)) {
        expect(engine.isOpen("posts", other)).toBe(false);
        if (other !== "create") expect(() => engine.readFilter("posts", other, anon())).toThrow(PolicyError);
        expect((await engine.checkRow(db, "posts", other, anon(), POSTS[0]!)).allowed).toBe(false);
      }
    }
  });

  it("denied deletes and updates leave the data untouched", async () => {
    const engine = engineWith("delete", owner("author_id"));
    const f = engine.readFilter("posts", "delete", user("u3"));
    await db.deleteFrom("posts").where((eb) => f.apply(eb)).execute();
    expect((await db.selectFrom("posts").select("id").execute()).length).toBe(2);
  });
});

describe("checkRow (WITH CHECK, real D1)", () => {
  beforeAll(createTables);
  beforeEach(seed);

  const engine = createPolicyEngine({
    config: {
      database: "d1",
      roles: ROLES,
      tables: {
        posts: {
          create: authenticated().and(owner("author_id")).where((q) => q.eb("status", "in", ["draft", "published"])),
          update: owner("author_id").where((q) => q.eb("status", "<>", "archived")),
          read: custom("popular", (eb) => eb("views", ">", 5)),
        },
      },
    },
    snapshot: blogSnapshot,
  });

  it("rejects an update whose merged row leaves the policy", async () => {
    const existing = POSTS[1]!;
    const patch = engine.prepareWrite("posts", "update", user("u2"), { status: "archived" }).values;
    const decision = await engine.checkRow(db, "posts", "update", user("u2"), { ...existing, ...patch });
    expect(decision.allowed).toBe(false);
    expect(decision.explanation.reason).toMatch(/row violates/);
    const ok = await engine.checkRow(db, "posts", "update", user("u2"), { ...existing, status: "published" });
    expect(ok.allowed).toBe(true);
  });

  it("create: owner and where are checked on the candidate (spoofed author fails even without prepareWrite)", async () => {
    const candidate = { id: "n", author_id: "u1", title: "t", body: "", status: "draft", created_at: "t" };
    expect((await engine.checkRow(db, "posts", "create", user("u1"), candidate)).allowed).toBe(true);
    expect((await engine.checkRow(db, "posts", "create", user("u2"), candidate)).allowed).toBe(false);
    expect((await engine.checkRow(db, "posts", "create", user("u1"), { ...candidate, status: "archived" })).allowed).toBe(false);
  });

  it("binds candidate values with the column's affinity, like stored values", async () => {
    // views is INTEGER: numeric text compares as a number, as it would once stored.
    expect((await engine.checkRow(db, "posts", "read", anon(), { views: "10" })).allowed).toBe(true);
    expect((await engine.checkRow(db, "posts", "read", anon(), { views: 3 })).allowed).toBe(false);
    // the same comparison on a real stored row agrees
    await db.updateTable("posts").set({ views: "10" }).where("id", "=", "p2").execute();
    const f = engine.readFilter("posts", "read", anon());
    const rows = await db.selectFrom("posts").select("id").where((eb) => f.apply(eb)).orderBy("id").execute();
    expect(rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    // author_id is TEXT: a JS number is converted to text exactly as storage would convert it.
    // (D1 binds JS numbers as REAL, so 42 is stored as '42.0'; checkRow must agree with storage.)
    const textEngine = createPolicyEngine({
      config: { database: "d1", roles: ROLES, tables: { posts: { create: owner("author_id"), read: owner("author_id") } } },
      snapshot: blogSnapshot,
    });
    for (const [uid, value] of [["42", 42], ["42.0", 42], ["u2", "u2"]] as const) {
      await seed();
      await db.updateTable("posts").set({ author_id: value }).where("id", "=", "p2").execute();
      const f = textEngine.readFilter("posts", "read", user(uid));
      const stored = await db.selectFrom("posts").select("id").where("id", "=", "p2").where((eb) => f.apply(eb)).execute();
      const checked = await textEngine.checkRow(db, "posts", "create", user(uid), { author_id: value });
      expect(checked.allowed, `${uid} vs ${value}`).toBe(stored.length === 1);
    }
  });

  it("rejects unknown candidate columns and unsupported values", async () => {
    await expect(engine.checkRow(db, "posts", "create", user("u1"), { author_id: "u1", "x\" = 1 or 1 --": 1 })).rejects.toMatchObject({
      status: 400,
      code: "unknown_column",
    });
    await expect(engine.checkRow(db, "posts", "create", user("u1"), { author_id: { a: 1 } })).rejects.toMatchObject({ status: 400 });
  });

  it("closed operations are denied without touching the database", async () => {
    const d = await engine.checkRow(db, "posts", "delete", user("u1", ["admin"]), POSTS[0]!);
    expect(d.allowed).toBe(false);
    expect(d.explanation.matchedRule).toBe("none");
  });

  it("explanation carries the compiled rule and the verdict", async () => {
    const d = await engine.checkRow(db, "posts", "create", user("u1"), { author_id: "u1", status: "draft" });
    expect(engine.explain(d)).toMatchObject({
      table: "posts",
      op: "create",
      allowed: true,
      matchedRule: "and(authenticated, owner(author_id), where)",
      where: { sql: '("posts"."author_id" = ? and "status" in (?, ?))', parameters: ["u1", "draft", "published"] },
    });
  });
});
