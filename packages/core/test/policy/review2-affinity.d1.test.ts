/**
 * Second security review: WITH CHECK (`checkRow`) must agree with what D1 actually stores.
 *
 * Every test inserts the candidate into a real table, re-reads it through the same rule compiled as a
 * read filter, and asserts `checkRow(candidate).allowed === stored row satisfies the rule`. A row that
 * checkRow allows but whose stored form violates the rule is a WITH CHECK bypass (CLAUDE.md rule 3).
 *
 * "held" blocks pass and are regressions. "FINDING" blocks assert the correct behaviour and fail until
 * the engine is fixed. Snapshots come from the real introspector, so they carry exactly what
 * `castra generate` would commit.
 */
import { env } from "cloudflare:workers";
import fc from "fast-check";
import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticated, createPolicyEngine, introspect, type Rule, type SchemaSnapshot } from "../../src/index.js";
import { testDb } from "./db.js";
import { ROLES, user } from "./fixtures.js";

const db = testDb();
const ctx = user("u1");
const NUM_RUNS = 300;

const DDL = [
  `CREATE TABLE IF NOT EXISTS r2_aff (id INTEGER PRIMARY KEY, i INTEGER, r REAL, n NUMERIC, t TEXT, b)`,
  `CREATE TABLE IF NOT EXISTS r2_dflt (id INTEGER PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'published')`,
  `CREATE TABLE IF NOT EXISTS r2_coll (id INTEGER PRIMARY KEY, status TEXT COLLATE NOCASE)`,
  `CREATE TABLE IF NOT EXISTS r2_strict (id INTEGER PRIMARY KEY, x ANY) STRICT`,
];

let snapshot: SchemaSnapshot;
let nextId = 1;

beforeAll(async () => {
  for (const s of DDL) await env.DB.prepare(s).run();
  snapshot = await introspect(async (q, params = []) => (await env.DB.prepare(q).bind(...params).all()).results as Record<string, unknown>[]);
});

type Outcome = { check: boolean | "threw"; stored: boolean | "threw" };

async function checkVsStored(tableName: string, rule: Rule, row: Record<string, unknown>): Promise<Outcome> {
  const engine = createPolicyEngine({
    config: { database: "d1", roles: ROLES, tables: { [tableName]: { read: rule, create: rule } } },
    snapshot,
  });
  let check: Outcome["check"];
  try {
    check = (await engine.checkRow(db, tableName, "create", ctx, row)).allowed;
  } catch {
    check = "threw";
  }
  const id = nextId++;
  try {
    await db.insertInto(tableName).values({ id, ...row }).execute();
  } catch {
    return { check, stored: "threw" };
  }
  const f = engine.readFilter(tableName, "read", ctx);
  const got = await db.selectFrom(tableName).select("id").where("id", "=", id).where((eb) => f.apply(eb)).execute();
  return { check, stored: got.length === 1 };
}

/** Never allow what storage denies; when the write itself fails there is nothing to compare. */
function expectAgreement(o: Outcome, label: Record<string, unknown>): void {
  if (o.stored === "threw") return;
  expect({ ...label, check: o.check }).toEqual({ ...label, check: o.stored });
}

const show = (v: unknown) =>
  typeof v === "bigint" ? `${v}n` : Object.is(v, -0) ? "-0" : typeof v === "number" && !Number.isFinite(v) ? String(v) : JSON.stringify(v);

const COLS = ["i", "r", "n", "t", "b"] as const;
const NUMERIC_COLS = ["i", "r", "n"] as const;
const ws = fc.constantFrom("", " ", "\t", "\n", "\r", "\v", "\f", " ", "　", "﻿");
const textBody = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }).map(String),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map(String),
  fc.constantFrom(
    "0", "-0", "+0", "-0.0", "007", "0.50", "1.", ".5", "+.5", "-.5", "1e5", "1E+5", "1e-5", "1e400", "-1e400", "1e-400",
    "1e", "e5", ".", "+", "-", "0x10", "0X1f", "0b1", "1_000", "1,5", "Infinity", "-Infinity", "NaN", "inf",
    "9007199254740993", "9223372036854775807", "9223372036854775808", "-9223372036854775809", "99999999999999999999",
    "0.1234567890123456789", "123456789012345678.5", "١٢٣", "１２３", "12abc", "abc", "", "3.0", "100", "100.0", "1e2",
  ),
);
const textArb = fc.oneof(fc.tuple(ws, textBody, ws).map(([a, b, c]) => a + b + c), fc.string({ maxLength: 6 }));
const numberArb = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.double(),
  fc.constantFrom(-0, NaN, Infinity, -Infinity, 2 ** 53, 2 ** 53 + 2, 2 ** 63, -(2 ** 63), 1e20, 0.1, 3, 1.5, 100, 100.5, 5e-324),
);
const valueArb: fc.Arbitrary<unknown> = fc.oneof(numberArb, fc.boolean(), fc.constant(null), fc.bigInt({ min: -10n, max: 10n }), textArb);
const opArb = fc.constantFrom("=", "!=", "<", "<=", ">", ">=", "is", "is not");

describe("held: checkRow agrees with storage for numeric literals on every affinity (property, real D1)", () => {
  it("col <op> <JS number> for INTEGER/REAL/NUMERIC/TEXT/BLOB and any value kind", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...COLS), opArb, numberArb, valueArb, async (col, op, lit, value) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rule = authenticated().where((q) => q.eb(col, op as any, lit));
        expectAgreement(await checkVsStored("r2_aff", rule, { [col]: value }), { col, op, lit: show(lit), value: show(value) });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("col <op> <text literal> for TEXT and BLOB columns and any value kind", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("t", "b"), opArb, textArb, valueArb, async (col, op, lit, value) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rule = authenticated().where((q) => q.eb(col, op as any, lit));
        expectAgreement(await checkVsStored("r2_aff", rule, { [col]: value }), { col, op, lit: show(lit), value: show(value) });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("numeric-looking text values against text literals agree on numeric columns", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...NUMERIC_COLS), opArb, textArb, fc.oneof(numberArb, fc.constantFrom("3", " 3 ", "+3", "3.0", "007", "1e2", ".5", "1.", "-0.0", "1e400")), async (col, op, lit, value) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rule = authenticated().where((q) => q.eb(col, op as any, lit));
        expectAgreement(await checkVsStored("r2_aff", rule, { [col]: value }), { col, op, lit: show(lit), value: show(value) });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("FINDING A: non-numeric text in a numeric-affinity column loses the column affinity in checkRow", () => {
  // Stored: '' sits in an INTEGER column, so the column's affinity converts the literal '100' to 100 and
  // TEXT > INTEGER makes `score <= '100'` false. In checkRow the candidate is bound without CAST, the
  // derived column has no affinity, '100' stays text, and '' <= '100' is true.
  for (const col of NUMERIC_COLS) {
    for (const value of ["", "-", "0x10"]) {
      it(`${col} <= '100' with ${JSON.stringify(value)}`, async () => {
        const rule = authenticated().where((q) => q.eb(col, "<=", "100"));
        expectAgreement(await checkVsStored("r2_aff", rule, { [col]: value }), { col, value });
      });
    }
  }

  it("property: any comparison with a text literal on a numeric-affinity column", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...NUMERIC_COLS), opArb, textArb, valueArb, async (col, op, lit, value) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rule = authenticated().where((q) => q.eb(col, op as any, lit));
        expectAgreement(await checkVsStored("r2_aff", rule, { [col]: value }), { col, op, lit: show(lit), value: show(value) });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("FINDING B: integral JS numbers are REAL in checkRow but INTEGER once stored in INTEGER/NUMERIC columns", () => {
  // D1 binds JS numbers as REAL; storage in an INTEGER/NUMERIC column converts 3.0 to INTEGER 3, but
  // CAST(3.0 AS NUMERIC) stays REAL. Comparisons agree; typeof()/CAST(... AS TEXT)/length()/LIKE do not.
  for (const col of ["i", "n"] as const) {
    it(`typeof(${col}) = 'real' for 3`, async () => {
      const rule = authenticated().where((q) => sql<boolean>`typeof(${q.eb.ref(col)}) = 'real'`);
      expectAgreement(await checkVsStored("r2_aff", rule, { [col]: 3 }), { col });
    });
    it(`CAST(${col} AS TEXT) LIKE '%.0' for 3`, async () => {
      const rule = authenticated().where((q) => sql<boolean>`CAST(${q.eb.ref(col)} AS TEXT) LIKE '%.0'`);
      expectAgreement(await checkVsStored("r2_aff", rule, { [col]: 3 }), { col });
    });
  }

  it("property: typeof / CAST AS TEXT / length predicates on every affinity", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...COLS), fc.constantFrom("typeof", "text", "length"), valueArb, fc.oneof(numberArb, textArb), async (col, p, value, lit) => {
        const rule = authenticated().where((q) => {
          const ref = q.eb.ref(col);
          if (p === "typeof") return sql<boolean>`typeof(${ref}) = ${typeof lit === "string" ? "text" : "real"}`;
          if (p === "text") return sql<boolean>`CAST(${ref} AS TEXT) = ${String(lit)}`;
          return sql<boolean>`length(${ref}) <= 3`;
        });
        expectAgreement(await checkVsStored("r2_aff", rule, { [col]: value }), { col, p, lit: show(lit), value: show(value) });
      }),
      { numRuns: 200 },
    );
  });
});

describe("FINDING C: checkRow on create treats omitted columns as NULL, but the stored row gets the column DEFAULT", () => {
  // CREATE TABLE r2_dflt (..., status TEXT NOT NULL DEFAULT 'published'); the snapshot records the default.
  it("bypass: create rule `status IS NOT 'published'` allows a row that is stored as published", async () => {
    const rule = authenticated().where((q) => q.eb("status", "is not", "published"));
    const o = await checkVsStored("r2_dflt", rule, { title: "x" });
    expect(o.stored).toBe(false);
    expect(o.check).toBe(false);
  });

  it("false denial: create rule `status = 'published'` denies a row that is stored as published", async () => {
    const rule = authenticated().where((q) => q.eb("status", "=", "published"));
    const o = await checkVsStored("r2_dflt", rule, { title: "x" });
    expect(o.stored).toBe(true);
    expect(o.check).toBe(true);
  });
});

describe("FINDING D: checkRow ignores column collation (COLLATE NOCASE)", () => {
  // CREATE TABLE r2_coll (..., status TEXT COLLATE NOCASE). The snapshot has no collation, the derived
  // table compares with BINARY, the real table with NOCASE.
  it("bypass: create rule `status != 'published'` allows 'PUBLISHED', which the table treats as published", async () => {
    const rule = authenticated().where((q) => q.eb("status", "!=", "published"));
    expectAgreement(await checkVsStored("r2_coll", rule, { status: "PUBLISHED" }), {});
  });

  it("bypass: `status NOT IN ('published', 'archived')` allows 'Archived'", async () => {
    const rule = authenticated().where((q) => q.eb("status", "not in", ["published", "archived"]));
    expectAgreement(await checkVsStored("r2_coll", rule, { status: "Archived" }), {});
  });
});

describe("FINDING E: STRICT tables: an ANY column stores values verbatim, checkRow casts them as NUMERIC", () => {
  it("snapshot affinity of a STRICT ANY column is NUMERIC (no strictness recorded)", () => {
    expect(snapshot.tables.r2_strict!.columns.find((c) => c.name === "x")!.affinity).toBe("NUMERIC");
  });

  it("bypass: rule `x = 7` allows '007', which is stored as the text '007'", async () => {
    const rule = authenticated().where((q) => q.eb("x", "=", 7));
    expectAgreement(await checkVsStored("r2_strict", rule, { x: "007" }), {});
  });
});
