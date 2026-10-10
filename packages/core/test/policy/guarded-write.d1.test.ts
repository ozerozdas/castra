/**
 * ADR 0050: the authoritative write check runs on the stored row, after the write, in the same atomic
 * D1 batch. Allow AND deny cases for `writeGuard` + `runGuardedWrite` on real local D1, plus a property
 * test against a JS oracle that evaluates the rule on the row as D1 actually stored it.
 */
import { env } from "cloudflare:workers";
import fc from "fast-check";
import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import {
  authenticated,
  createPolicyEngine,
  introspect,
  isPublic,
  isWriteCheckError,
  owner,
  PolicyError,
  runGuardedWrite,
  WRITE_CHECK_MARKER,
  type CastraConfig,
  type PolicyEngine,
  type Rule,
  type SchemaSnapshot,
} from "../../src/index.js";
import { testDb } from "./db.js";
import { ROLES, user } from "./fixtures.js";

const db = testDb();
const u1 = user("u1");

const DDL = [
  `CREATE TABLE gw_posts (id TEXT PRIMARY KEY NOT NULL, author_id TEXT, title TEXT, status TEXT NOT NULL DEFAULT 'draft')`,
  `CREATE TABLE gw_coll (id INTEGER PRIMARY KEY, status TEXT COLLATE NOCASE)`,
  `CREATE TABLE gw_strict (id INTEGER PRIMARY KEY, x ANY, n INTEGER) STRICT`,
  `CREATE TABLE gw_aff (id INTEGER PRIMARY KEY, i INTEGER, created DATETIME)`,
  `CREATE TABLE gw_nopk (a TEXT, b TEXT)`,
  `CREATE TABLE gw_dflts (id INTEGER PRIMARY KEY, a INTEGER DEFAULT 5, b TEXT DEFAULT 5, c REAL DEFAULT 1, d TEXT DEFAULT 1.50,
     e NUMERIC DEFAULT TRUE, g TEXT DEFAULT 'it''s', h INTEGER DEFAULT -2.0, k DEFAULT 1e2, m INTEGER DEFAULT '07', f TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE gw_prop (id INTEGER PRIMARY KEY, i INTEGER, r REAL, n NUMERIC, t TEXT, c TEXT COLLATE NOCASE, b)`,
  `CREATE TABLE gw_scratch (id INTEGER PRIMARY KEY, i INTEGER, r REAL, n NUMERIC, t TEXT, c TEXT COLLATE NOCASE, b)`,
];

let snapshot: SchemaSnapshot;

beforeAll(async () => {
  for (const s of DDL) await env.DB.prepare(s).run();
  snapshot = await introspect(async (q, params = []) => (await env.DB.prepare(q).bind(...params).all()).results as Record<string, unknown>[]);
});

function engineFor(tables: CastraConfig["tables"]): PolicyEngine {
  return createPolicyEngine({ config: { database: "d1", roles: ROLES, tables }, snapshot });
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

async function rowsOf(table: string, where: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  let q = db.selectFrom(table).selectAll();
  for (const [k, v] of Object.entries(where)) q = q.where(k, "=", v);
  return q.execute();
}

describe("error expression and batch atomicity on local D1", () => {
  it("the guard's error carries the marker, and a failed batch rolls back the earlier write", async () => {
    const err = await rejection(
      env.DB.batch([
        env.DB.prepare("INSERT INTO gw_posts (id, title) VALUES ('atomic', 'x')"),
        env.DB.prepare(`SELECT json_extract('{}', '${WRITE_CHECK_MARKER}')`),
      ]),
    );
    expect(isWriteCheckError(err)).toBe(true);
    expect(await rowsOf("gw_posts", { id: "atomic" })).toEqual([]);
  });

  it("other errors are not mistaken for a write check failure", async () => {
    const err = await rejection(env.DB.prepare("SELECT json('not json')").all());
    expect(isWriteCheckError(err)).toBe(false);
    expect(isWriteCheckError(new Error("bad JSON path: '$x'"))).toBe(false);
  });

  it("the guard binds every value and contains no interpolated identifiers beyond the snapshot", () => {
    const engine = engineFor({ gw_posts: { read: isPublic(), create: owner("author_id").where((q) => q.eb("status", "=", "draft")) } });
    const c = engine.writeGuard("gw_posts", "create", u1, { id: "p'); DROP TABLE x; --" }).compile();
    expect(c.sql).toContain(`'${WRITE_CHECK_MARKER}'`);
    expect(c.sql).not.toContain("DROP");
    expect(c.parameters).toEqual(expect.arrayContaining(["p'); DROP TABLE x; --", "u1", "draft"]));
  });
});

describe("create: column DEFAULTs are what the guard sees (finding C)", () => {
  it("allows a row whose omitted status defaults to the allowed value", async () => {
    const engine = engineFor({ gw_posts: { read: isPublic(), create: authenticated().where((q) => q.eb("status", "=", "draft")) } });
    const w = engine.prepareWrite("gw_posts", "create", u1, { id: "c1", title: "t" });
    await runGuardedWrite(env.DB, db.insertInto("gw_posts").values(w.values), engine.writeGuard("gw_posts", "create", u1, { id: "c1" }));
    expect(await rowsOf("gw_posts", { id: "c1" })).toEqual([{ id: "c1", author_id: null, title: "t", status: "draft" }]);
  });

  it("denies (403) and rolls back a row whose omitted status defaults to a forbidden value", async () => {
    const engine = engineFor({ gw_posts: { read: isPublic(), create: authenticated().where((q) => q.eb("status", "is not", "draft")) } });
    const err = await rejection(
      runGuardedWrite(env.DB, db.insertInto("gw_posts").values({ id: "c2", title: "t" }), engine.writeGuard("gw_posts", "create", u1, { id: "c2" })),
    );
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).status).toBe(403);
    expect((err as PolicyError).code).toBe("write_check_failed");
    expect((err as PolicyError).explanation).toMatchObject({ table: "gw_posts", op: "create", allowed: false });
    expect(await rowsOf("gw_posts", { id: "c2" })).toEqual([]);
  });

  it("owner(): allows the caller's own row, denies a row owned by someone else", async () => {
    const engine = engineFor({ gw_posts: { read: isPublic(), create: owner("author_id") } });
    await runGuardedWrite(
      env.DB,
      db.insertInto("gw_posts").values({ id: "o1", author_id: "u1" }),
      engine.writeGuard("gw_posts", "create", u1, { id: "o1" }),
    );
    expect(await rowsOf("gw_posts", { id: "o1" })).toHaveLength(1);
    const err = await rejection(
      runGuardedWrite(env.DB, db.insertInto("gw_posts").values({ id: "o2", author_id: "u2" }), engine.writeGuard("gw_posts", "create", u1, { id: "o2" })),
    );
    expect((err as PolicyError).status).toBe(403);
    expect(await rowsOf("gw_posts", { id: "o2" })).toEqual([]);
  });
});

describe("checkRow (dry run) fills omitted columns from literal defaults exactly as D1 stores them (finding C)", () => {
  const LITERAL = ["a", "b", "c", "d", "e", "g", "h", "k", "m"];

  it("allows: typeof and text of every literal default match the stored row", async () => {
    await db.insertInto("gw_dflts").values({ id: 1 }).execute();
    const stored = await db
      .selectFrom("gw_dflts")
      .select(LITERAL.map((c) => sql<string>`typeof(${sql.ref(c)}) || ':' || CAST(${sql.ref(c)} AS TEXT)`.as(c)))
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    for (const c of LITERAL) {
      const rule = authenticated().where((q) => sql<boolean>`typeof(${q.eb.ref(c)}) || ':' || CAST(${q.eb.ref(c)} AS TEXT) = ${stored[c]}`);
      const engine = engineFor({ gw_dflts: { read: isPublic(), create: rule } });
      const d = await engine.checkRow(db, "gw_dflts", "create", u1, { id: 2, f: "now" });
      expect({ c, stored: stored[c], allowed: d.allowed }).toEqual({ c, stored: stored[c], allowed: true });
      expect(d.explanation.reason).not.toMatch(/approximate/);
    }
  });

  it("denies: a rule that requires NULL in a defaulted column", async () => {
    const engine = engineFor({ gw_dflts: { read: isPublic(), create: authenticated().where((q) => q.eb("g", "is", null)) } });
    expect((await engine.checkRow(db, "gw_dflts", "create", u1, { id: 3 })).allowed).toBe(false);
    expect((await engine.checkRow(db, "gw_dflts", "create", u1, { id: 3, g: null })).allowed).toBe(true);
  });

  it("a non-literal default (CURRENT_TIMESTAMP) and an omitted rowid are flagged approximate", async () => {
    const engine = engineFor({ gw_dflts: { read: isPublic(), create: authenticated().where((q) => q.eb("a", "=", 5)) } });
    const reason = (await engine.checkRow(db, "gw_dflts", "create", u1, {})).explanation.reason;
    expect(reason).toMatch(/approximate dry run: .*rowid column "id".*non-literal default of "f"/);
  });
});

describe("collation: COLLATE NOCASE columns compare as the table does (finding D)", () => {
  const engine = () => engineFor({ gw_coll: { read: isPublic(), create: authenticated().where((q) => q.eb("status", "!=", "published")) } });

  it("denies 'PUBLISHED' (equal to 'published' under NOCASE) and leaves no row", async () => {
    const err = await rejection(
      runGuardedWrite(env.DB, db.insertInto("gw_coll").values({ id: 1, status: "PUBLISHED" }), engine().writeGuard("gw_coll", "create", u1, { id: 1 })),
    );
    expect((err as PolicyError).status).toBe(403);
    expect(await rowsOf("gw_coll", { id: 1 })).toEqual([]);
  });

  it("allows 'Draft'", async () => {
    await runGuardedWrite(env.DB, db.insertInto("gw_coll").values({ id: 2, status: "Draft" }), engine().writeGuard("gw_coll", "create", u1, { id: 2 }));
    expect(await rowsOf("gw_coll", { id: 2 })).toHaveLength(1);
  });
});

describe("STRICT tables (finding E)", () => {
  const engine = () => engineFor({ gw_strict: { read: isPublic(), create: authenticated().where((q) => q.eb("x", "=", 7)) } });

  it("denies '007' in an ANY column (stored verbatim as text, not 7)", async () => {
    const err = await rejection(
      runGuardedWrite(env.DB, db.insertInto("gw_strict").values({ id: 1, x: "007" }), engine().writeGuard("gw_strict", "create", u1, { id: 1 })),
    );
    expect((err as PolicyError).status).toBe(403);
    expect(await rowsOf("gw_strict", { id: 1 })).toEqual([]);
  });

  it("allows 7", async () => {
    await runGuardedWrite(env.DB, db.insertInto("gw_strict").values({ id: 2, x: 7 }), engine().writeGuard("gw_strict", "create", u1, { id: 2 }));
    expect(await rowsOf("gw_strict", { id: 2 })).toHaveLength(1);
  });

  it("a STRICT type error is rethrown as-is (not a 403) and nothing is written", async () => {
    const err = await rejection(
      runGuardedWrite(env.DB, db.insertInto("gw_strict").values({ id: 3, x: 7, n: "abc" }), engine().writeGuard("gw_strict", "create", u1, { id: 3 })),
    );
    expect(err).not.toBeInstanceOf(PolicyError);
    expect(isWriteCheckError(err)).toBe(false);
    expect(await rowsOf("gw_strict", { id: 3 })).toEqual([]);
  });

  it("checkRow models the ANY column: '007' denied, 7 allowed", async () => {
    expect((await engine().checkRow(db, "gw_strict", "create", u1, { x: "007" })).allowed).toBe(false);
    expect((await engine().checkRow(db, "gw_strict", "create", u1, { x: 7 })).allowed).toBe(true);
  });
});

describe("affinity conversions (findings A and B)", () => {
  it("A: denies '' in an INTEGER column against `i <= '100'` (stored text sorts after numbers)", async () => {
    const engine = engineFor({ gw_aff: { read: isPublic(), create: authenticated().where((q) => q.eb("i", "<=", "100")) } });
    const err = await rejection(
      runGuardedWrite(env.DB, db.insertInto("gw_aff").values({ id: 1, i: "" }), engine.writeGuard("gw_aff", "create", u1, { id: 1 })),
    );
    expect((err as PolicyError).status).toBe(403);
    await runGuardedWrite(env.DB, db.insertInto("gw_aff").values({ id: 2, i: "50" }), engine.writeGuard("gw_aff", "create", u1, { id: 2 }));
    expect(await rowsOf("gw_aff", { id: 2 })).toHaveLength(1);
  });

  it("B: typeof(i) = 'integer' allows 3 (bound REAL, stored INTEGER) and denies 3.5", async () => {
    const engine = engineFor({ gw_aff: { read: isPublic(), create: authenticated().where((q) => sql<boolean>`typeof(${q.eb.ref("i")}) = 'integer'`) } });
    await runGuardedWrite(env.DB, db.insertInto("gw_aff").values({ id: 3, i: 3 }), engine.writeGuard("gw_aff", "create", u1, { id: 3 }));
    expect((await engine.checkRow(db, "gw_aff", "create", u1, { i: 3 })).allowed).toBe(true);
    const err = await rejection(
      runGuardedWrite(env.DB, db.insertInto("gw_aff").values({ id: 4, i: 3.5 }), engine.writeGuard("gw_aff", "create", u1, { id: 4 })),
    );
    expect((err as PolicyError).status).toBe(403);
    expect((await engine.checkRow(db, "gw_aff", "create", u1, { i: 3.5 })).allowed).toBe(false);
  });

  it("A: checkRow flags non-numeric text in a numeric column as approximate", async () => {
    const engine = engineFor({ gw_aff: { read: isPublic(), create: authenticated().where((q) => q.eb("i", "<=", "100")) } });
    expect((await engine.checkRow(db, "gw_aff", "create", u1, { i: "" })).explanation.reason).toMatch(/approximate/);
    expect((await engine.checkRow(db, "gw_aff", "create", u1, { id: 9, i: "5" })).explanation.reason).not.toMatch(/approximate/);
  });

  it("A: prepareWrite rejects non-numeric text for numeric columns (400) and accepts numbers, numeric text and ISO dates", () => {
    const engine = engineFor({ gw_aff: { read: isPublic(), create: authenticated() } });
    for (const bad of ["", "abc", "0x10", "-", "5 apples", "１２"]) {
      let caught: unknown;
      try {
        engine.prepareWrite("gw_aff", "create", u1, { i: bad });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PolicyError);
      expect((caught as PolicyError).status).toBe(400);
    }
    for (const ok of [5, 2.5, "5", " 7 ", "1e2", null]) {
      expect(engine.prepareWrite("gw_aff", "create", u1, { i: ok }).values).toEqual({ i: ok });
    }
    expect(engine.prepareWrite("gw_aff", "create", u1, { created: "2026-10-10T00:00:00Z" }).values).toEqual({ created: "2026-10-10T00:00:00Z" });
  });

  it("last_insert_rowid target: allows and denies inserts whose key the database assigns", async () => {
    const engine = engineFor({ gw_aff: { read: isPublic(), create: authenticated().where((q) => q.eb("i", ">", 0)) } });
    const ok = await runGuardedWrite<{ id: number }>(
      env.DB,
      db.insertInto("gw_aff").values({ i: 10 }).returning("id"),
      engine.writeGuard("gw_aff", "create", u1, "last_insert_rowid"),
    );
    expect(await rowsOf("gw_aff", { id: ok.results[0]!.id })).toHaveLength(1);
    const before = await db.selectFrom("gw_aff").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow();
    const err = await rejection(
      runGuardedWrite(env.DB, db.insertInto("gw_aff").values({ i: -10 }), engine.writeGuard("gw_aff", "create", u1, "last_insert_rowid")),
    );
    expect((err as PolicyError).status).toBe(403);
    const after = await db.selectFrom("gw_aff").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });
});

describe("update: moving a row out of policy is rolled back", () => {
  const rule = () => owner("author_id").where((q) => q.eb("status", "=", "draft"));
  const engine = () => engineFor({ gw_posts: { read: isPublic(), update: rule() } });

  beforeAll(async () => {
    await db.insertInto("gw_posts").values({ id: "u-row", author_id: "u1", title: "before", status: "draft" }).execute();
  });

  it("denies status -> 'published' (403) and the row is unchanged", async () => {
    const e = engine();
    const f = e.readFilter("gw_posts", "update", u1);
    const patch = e.prepareWrite("gw_posts", "update", u1, { status: "published", title: "after" });
    const write = db.updateTable("gw_posts").set(patch.values).where("id", "=", "u-row").where((eb) => f.apply(eb));
    const err = await rejection(runGuardedWrite(env.DB, write, e.writeGuard("gw_posts", "update", u1, { id: "u-row" })));
    expect((err as PolicyError).status).toBe(403);
    expect(await rowsOf("gw_posts", { id: "u-row" })).toEqual([{ id: "u-row", author_id: "u1", title: "before", status: "draft" }]);
  });

  it("allows a title change that keeps the row in policy", async () => {
    const e = engine();
    const f = e.readFilter("gw_posts", "update", u1);
    const write = db.updateTable("gw_posts").set({ title: "renamed" }).where("id", "=", "u-row").where((eb) => f.apply(eb));
    const r = await runGuardedWrite(env.DB, write, e.writeGuard("gw_posts", "update", u1, { id: "u-row" }));
    expect(r.meta.changes).toBe(1);
    expect(await rowsOf("gw_posts", { id: "u-row" })).toEqual([{ id: "u-row", author_id: "u1", title: "renamed", status: "draft" }]);
  });

  it("changing the primary key with a guard on the old key fails closed", async () => {
    const e = engine();
    const write = db.updateTable("gw_posts").set({ id: "moved" }).where("id", "=", "u-row");
    const err = await rejection(runGuardedWrite(env.DB, write, e.writeGuard("gw_posts", "update", u1, { id: "u-row" })));
    expect((err as PolicyError).status).toBe(403);
    expect(await rowsOf("gw_posts", { id: "u-row" })).toHaveLength(1);
    expect(await rowsOf("gw_posts", { id: "moved" })).toEqual([]);
  });

  it("an update of someone else's row (0 rows changed) fails closed", async () => {
    await db.insertInto("gw_posts").values({ id: "u2-row", author_id: "u2", title: "x", status: "draft" }).execute();
    const e = engine();
    const f = e.readFilter("gw_posts", "update", u1);
    const write = db.updateTable("gw_posts").set({ title: "hijack" }).where("id", "=", "u2-row").where((eb) => f.apply(eb));
    const err = await rejection(runGuardedWrite(env.DB, write, e.writeGuard("gw_posts", "update", u1, { id: "u2-row" })));
    expect((err as PolicyError).status).toBe(403);
    expect(await rowsOf("gw_posts", { id: "u2-row" })).toEqual([{ id: "u2-row", author_id: "u2", title: "x", status: "draft" }]);
  });
});

describe("non-guard errors and bad targets", () => {
  it("a primary key conflict is rethrown unchanged, not mapped to 403", async () => {
    const engine = engineFor({ gw_posts: { read: isPublic(), create: authenticated() } });
    await db.insertInto("gw_posts").values({ id: "dup" }).execute();
    const err = await rejection(runGuardedWrite(env.DB, db.insertInto("gw_posts").values({ id: "dup" }), engine.writeGuard("gw_posts", "create", u1, { id: "dup" })));
    expect(err).not.toBeInstanceOf(PolicyError);
    expect(String((err as Error).message)).toMatch(/UNIQUE constraint failed/);
  });

  it("closed operations are 404; malformed targets are 400", () => {
    const engine = engineFor({ gw_posts: { read: isPublic(), create: authenticated() }, gw_nopk: { read: isPublic(), create: authenticated() } });
    const status = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as PolicyError).status;
      }
      return "ok";
    };
    expect(status(() => engine.writeGuard("gw_posts", "update", u1, { id: "x" }))).toBe(404);
    expect(status(() => engine.writeGuard("user", "create", u1, { id: "x" }))).toBe(404);
    expect(status(() => engine.writeGuard("gw_posts", "create", u1, {}))).toBe(400);
    expect(status(() => engine.writeGuard("gw_posts", "create", u1, { id: "x", title: "y" }))).toBe(400);
    expect(status(() => engine.writeGuard("gw_posts", "create", u1, { title: "y" }))).toBe(400);
    expect(status(() => engine.writeGuard("gw_posts", "create", u1, { id: null }))).toBe(400);
    expect(status(() => engine.writeGuard("gw_posts", "create", u1, [] as unknown as Record<string, unknown>))).toBe(400);
    expect(status(() => engine.writeGuard("gw_nopk", "create", u1, { a: "x" }))).toBe(400);
    expect(status(() => engine.writeGuard("gw_nopk", "create", u1, "last_insert_rowid"))).toBe("ok");
    expect(status(() => engine.writeGuard("gw_posts", "create", u1, { id: "x" }))).toBe("ok");
  });

  it("a constant-false rule for this caller always fires", async () => {
    const engine = engineFor({ gw_posts: { read: isPublic(), create: owner("author_id") } });
    const anonCtx = { ...u1, user: null, roles: [] };
    const err = await rejection(
      runGuardedWrite(env.DB, db.insertInto("gw_posts").values({ id: "anon-row" }), engine.writeGuard("gw_posts", "create", anonCtx, { id: "anon-row" })),
    );
    expect((err as PolicyError).status).toBe(403);
    expect(await rowsOf("gw_posts", { id: "anon-row" })).toEqual([]);
  });
});

describe("canFilter requires an open read", () => {
  it("false without a read rule, true with one", () => {
    expect(engineFor({ gw_posts: { create: authenticated() } }).canFilter("gw_posts", "title", u1)).toBe(false);
    expect(engineFor({ gw_posts: { read: isPublic() } }).canFilter("gw_posts", "title", u1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// Property: runGuardedWrite allows iff a JS oracle says the STORED row satisfies the rule.
// The stored form is obtained by a plain insert of the same values into a scratch table with the same
// DDL and read back with typeof(), so the oracle only models comparison, not storage conversion.

type Col = "i" | "r" | "n" | "t" | "c" | "b";
type Op = "=" | "!=" | "<" | "<=" | ">" | ">=" | "is" | "is not";
type Lit = number | string;
type Cmp = { col: Col; op: Op; lit: Lit };
type Spec = { kind: "one"; a: Cmp } | { kind: "and" | "or"; a: Cmp; b: Cmp };
type Stored = { cls: "null" | "num" | "text" | "blob"; v: number | string | null };

const COLS: Col[] = ["i", "r", "n", "t", "c", "b"];
const AFF: Record<Col, "num" | "text" | "none"> = { i: "num", r: "num", n: "num", t: "text", c: "text", b: "none" };
const TEXTS = ["", "5", "05", " 5", "5.5", "1e2", "-3", "abc", "ABC", "published", "PUBLISHED", "0x10", "-", "Z", "a"];
const NUMS = [-3, -1, 0, 1, 2, 2.5, 3, 5, 100];
const NUMERIC_TEXT = /^[ \t\n\v\f\r]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\v\f\r]*$/;

const litArb: fc.Arbitrary<Lit> = fc.oneof(fc.constantFrom(...NUMS), fc.constantFrom(...TEXTS));
const valArb: fc.Arbitrary<Lit | null> = fc.oneof(fc.constant(null), fc.constantFrom(...NUMS), fc.constantFrom(...TEXTS));
const cmpArb: fc.Arbitrary<Cmp> = fc.record({
  col: fc.constantFrom(...COLS),
  op: fc.constantFrom<Op>("=", "!=", "<", "<=", ">", ">=", "is", "is not"),
  lit: litArb,
});
const specArb: fc.Arbitrary<Spec> = fc.oneof(
  cmpArb.map((a) => ({ kind: "one" as const, a })),
  fc.tuple(fc.constantFrom<"and" | "or">("and", "or"), cmpArb, cmpArb).map(([kind, a, b]) => ({ kind, a, b })),
);
const rowArb = fc.record({ i: valArb, r: valArb, n: valArb, t: valArb, c: valArb, b: valArb });

function ruleOf(s: Spec): Rule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const one = (c: Cmp) => (q: { eb: any }) => q.eb(c.col, c.op, c.lit);
  if (s.kind === "one") return authenticated().where(one(s.a));
  return authenticated().where((q) => (s.kind === "and" ? q.eb.and([one(s.a)(q), one(s.b)(q)]) : q.eb.or([one(s.a)(q), one(s.b)(q)])));
}

/** A bound literal after the column's affinity is applied to it (sqlite.org/datatype3.html §4.2). */
function literalFor(col: Col, lit: Lit): Stored {
  if (typeof lit === "number") {
    // D1 binds JS numbers as REAL; TEXT affinity renders a REAL with a fractional part ("5.0").
    if (AFF[col] === "text") return { cls: "text", v: Number.isInteger(lit) ? `${lit}.0` : String(lit) };
    return { cls: "num", v: lit };
  }
  if (AFF[col] === "num" && NUMERIC_TEXT.test(lit)) return { cls: "num", v: Number(lit) };
  return { cls: "text", v: lit };
}

const RANK = { null: 0, num: 1, text: 2, blob: 3 } as const;

function compare(col: Col, a: Stored, b: Stored): number {
  if (a.cls !== b.cls) return RANK[a.cls] - RANK[b.cls];
  if (a.cls === "num") return (a.v as number) - (b.v as number);
  let x = a.v as string;
  let y = b.v as string;
  if (col === "c") {
    x = x.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
    y = y.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

type TV = boolean | null;
function evalCmp(c: Cmp, row: Record<Col, Stored>): TV {
  const left = row[c.col];
  const right = literalFor(c.col, c.lit);
  if (c.op === "is" || c.op === "is not") {
    const eq = left.cls === "null" ? false : compare(c.col, left, right) === 0;
    return c.op === "is" ? eq : !eq;
  }
  if (left.cls === "null") return null;
  const d = compare(c.col, left, right);
  switch (c.op) {
    case "=":
      return d === 0;
    case "!=":
      return d !== 0;
    case "<":
      return d < 0;
    case "<=":
      return d <= 0;
    case ">":
      return d > 0;
    case ">=":
      return d >= 0;
  }
}

function oracle(s: Spec, row: Record<Col, Stored>): boolean {
  const a = evalCmp(s.a, row);
  if (s.kind === "one") return a === true;
  const b = evalCmp(s.b, row);
  if (s.kind === "and") return a === true && b === true;
  return a === true || b === true;
}

let propId = 1;

describe("property: guarded write allows iff the stored row satisfies the rule (JS oracle, real D1)", () => {
  it("random rules over INTEGER/REAL/NUMERIC/TEXT/NOCASE/untyped columns and mixed values", async () => {
    const seen = { allowed: 0, denied: 0 };
    await fc.assert(
      fc.asyncProperty(specArb, rowArb, async (spec, values) => {
        const id = propId++;
        await db.insertInto("gw_scratch").values({ id, ...values }).execute();
        const back = await db
          .selectFrom("gw_scratch")
          .select(COLS.flatMap((c) => [sql.ref(c).as(c), sql<string>`typeof(${sql.ref(c)})`.as(`${c}_type`)]))
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        const stored = Object.fromEntries(
          COLS.map((c) => {
            const ty = back[`${c}_type`] as string;
            const cls = ty === "null" ? "null" : ty === "text" ? "text" : ty === "blob" ? "blob" : "num";
            return [c, { cls, v: back[c] as number | string | null }];
          }),
        ) as Record<Col, Stored>;
        const expected = oracle(spec, stored);

        const engine = engineFor({ gw_prop: { read: isPublic(), create: ruleOf(spec) } });
        let allowed: boolean;
        try {
          await runGuardedWrite(env.DB, db.insertInto("gw_prop").values({ id, ...values }), engine.writeGuard("gw_prop", "create", u1, { id }));
          allowed = true;
        } catch (e) {
          if (!(e instanceof PolicyError)) throw e;
          allowed = false;
        }
        const present = (await rowsOf("gw_prop", { id })).length === 1;
        seen[allowed ? "allowed" : "denied"]++;
        expect({ spec, values, allowed, present }).toEqual({ spec, values, allowed: expected, present: expected });
      }),
      { numRuns: 300 },
    );
    // Not vacuous: both outcomes occur.
    expect(seen.allowed).toBeGreaterThan(30);
    expect(seen.denied).toBeGreaterThan(30);
  });
});
