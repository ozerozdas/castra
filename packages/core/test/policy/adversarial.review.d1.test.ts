/**
 * Security review: adversarial tests for the M1 policy engine against a real local D1.
 *
 * The "FINDING" block asserts the CORRECT behaviour and fails until the bug is fixed; the rest are
 * regression tests for attacks that held.
 */
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticated, createPolicyEngine, isPublic, owner, type CastraContext, type Rule } from "../../src/index.js";
import { createTables, testDb } from "./db.js";
import { anon, blogSnapshot, ROLES, user } from "./fixtures.js";

const db = testDb();
const esc = (v: string) => JSON.stringify(v).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
let nextId = 10_000;

function itemsEngine(rule: Rule) {
  return createPolicyEngine({
    config: { database: "d1", roles: ROLES, tables: { items: { read: rule, create: rule, update: rule } } },
    snapshot: blogSnapshot,
  });
}

/**
 * Runs the WITH CHECK (checkRow "create") for `row`, then really inserts it and asks the same rule,
 * compiled as a read filter, whether the STORED row satisfies it. Returns both answers.
 */
async function checkVsStored(rule: Rule, ctx: CastraContext, row: Record<string, unknown>) {
  const engine = itemsEngine(rule);
  const decision = await engine.checkRow(db, "items", "create", ctx, row);
  const id = nextId++;
  await db.insertInto("items").values({ ...row, id }).execute();
  const f = engine.readFilter("items", "read", ctx);
  const stored = await db.selectFrom("items").select("id").where("id", "=", id).where((eb) => f.apply(eb)).execute();
  return { check: decision.allowed, stored: stored.length === 1 };
}

beforeAll(createTables);
beforeEach(async () => {
  await db.deleteFrom("items").execute();
  await db.deleteFrom("posts").execute();
});

const capped = authenticated().where((q) => q.eb("score", "<=", 100));

describe("FINDING: WITH CHECK bypass with Unicode whitespace in numeric text", () => {
  // engine.ts NUMERIC_TEXT uses JS `\s`, which matches U+00A0, U+2028, U+FEFF, U+3000, ...
  // SQLite only skips ASCII whitespace. So checkRow wraps "\u00a09999" in CAST(... AS NUMERIC),
  // which SQLite evaluates to 0 (passes `score <= 100`), while the INSERT stores the TEXT
  // "\u00a09999" in the INTEGER column, which then FAILS `score <= 100` (TEXT sorts above every
  // number). The write check allows a row that violates the policy once stored.
  for (const v of ["\u00a09999", "\u20289999", "\ufeff9999", "\u30009999", "50\u00a0"]) {
    it(`checkRow agrees with the stored row for ${esc(v)}`, async () => {
      const r = await checkVsStored(capped, user("u1"), { owner_id: "u1", score: v });
      expect(r.check).toBe(r.stored);
    });
  }
});

describe("held: checkRow agrees with storage for ASCII numeric-looking text", () => {
  for (const v of [" 50 ", "\t50", "\n50\r", "50.", "+5", ".5", "5e2", "0x10", "1e999", "-0", "00050", "9223372036854775808", "abc", ""]) {
    it(`score = ${JSON.stringify(v)}`, async () => {
      const r = await checkVsStored(capped, user("u1"), { owner_id: "u1", score: v });
      expect(r.check).toBe(r.stored);
    });
  }
  for (const v of [50, 50.5, 101, -1, true, false, 2 ** 53]) {
    it(`score = ${String(v)} (${typeof v})`, async () => {
      const r = await checkVsStored(capped, user("u1"), { owner_id: "u1", score: v });
      expect(r.check).toBe(r.stored);
    });
  }
});

describe("held: owner() type confusion on a TEXT owner column", () => {
  for (const [uid, value] of [
    ["1", 1],
    ["1", 1.0],
    ["1", "1.0"],
    ["1", " 1"],
    ["1", true],
    ["u1", "U1"],
  ] as Array<[string, unknown]>) {
    it(`user ${JSON.stringify(uid)} vs owner_id ${JSON.stringify(value)}: WITH CHECK agrees with storage`, async () => {
      const r = await checkVsStored(owner("owner_id"), user(uid), { owner_id: value, score: 1 });
      expect(r.check).toBe(r.stored);
      if (typeof value !== "string" || value !== uid) expect(r.check).toBe(false);
    });
  }
});

describe("held: NULL owner rows and three-valued logic", () => {
  beforeEach(async () => {
    await db
      .insertInto("items")
      .values([
        { id: 1, owner_id: null, status: "draft", score: null },
        { id: 2, owner_id: "u1", status: "draft", score: 5 },
        { id: 3, owner_id: null, status: null, score: 5 },
      ])
      .execute();
  });

  async function visible(rule: Rule, ctx: CastraContext): Promise<number[]> {
    const f = itemsEngine(rule).readFilter("items", "read", ctx);
    const rows = await db.selectFrom("items").select("id").where((eb) => f.apply(eb)).orderBy("id").execute();
    return rows.map((r) => Number(r.id));
  }

  it("owner() never matches NULL owner rows, for anonymous or any user", async () => {
    for (const ctx of [anon(), anon(["admin"]), user("u2"), user("u2", ["admin"]), user("")]) {
      expect(await visible(owner("owner_id"), ctx)).toEqual([]);
    }
    expect(await visible(owner("owner_id"), user("u1"))).toEqual([2]);
  });

  it("or(owner, where on a NULL column) does not widen", async () => {
    const rule = owner("owner_id").or(isPublic().where((q) => q.eb("status", "=", "published")));
    expect(await visible(rule, anon())).toEqual([]);
    expect(await visible(rule, user("u2"))).toEqual([]);
  });

  it("where() built from ctx.user?.id ?? null does not match NULL rows for anonymous", async () => {
    const rule = isPublic().where((q) => q.eb("owner_id", "=", q.ctx.user?.id ?? null));
    expect(await visible(rule, anon())).toEqual([]);
  });

  it("injection-shaped user ids match nothing", async () => {
    for (const id of ["' OR 1=1 --", "u1' OR '1'='1", '" OR 1=1 --', "u1\u0000"]) {
      expect(await visible(owner("owner_id"), user(id))).toEqual([]);
    }
  });

  it("filter is correct inside UPDATE and DELETE (no row of another owner is touched)", async () => {
    const engine = createPolicyEngine({
      config: { database: "d1", roles: ROLES, tables: { items: { update: owner("owner_id"), delete: owner("owner_id") } } },
      snapshot: blogSnapshot,
    });
    const u = engine.readFilter("items", "update", user("u2"));
    const upd = await db.updateTable("items").set({ score: 999 }).where((eb) => u.apply(eb)).executeTakeFirst();
    expect(Number(upd.numUpdatedRows)).toBe(0);
    const d = engine.readFilter("items", "delete", anon());
    const del = await db.deleteFrom("items").where((eb) => d.apply(eb)).executeTakeFirst();
    expect(Number(del.numDeletedRows)).toBe(0);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM items").first<{ n: number }>();
    expect(count!.n).toBe(3);
  });
});
