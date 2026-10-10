import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { createPolicyEngine, defineConfig, type CastraContext } from "../../src/index.js";
import { createTables, testDb } from "./db.js";
import { blogSnapshot, ROLES } from "./fixtures.js";
import { ctxArb, evaluate, rowsArb, specArb, toRule, type ItemRow, type Spec } from "./oracle.js";

const db = testDb();
const NUM_RUNS = 300;

function engineFor(spec: Spec, op: "read" | "update" | "delete" | "create") {
  return createPolicyEngine({
    config: defineConfig({ database: "d1", roles: ROLES, tables: { items: { [op]: toRule(spec) } } }),
    snapshot: blogSnapshot,
  });
}

async function replaceRows(rows: ItemRow[]): Promise<void> {
  await db.deleteFrom("items").execute();
  if (rows.length > 0) await db.insertInto("items").values(rows).execute();
}

function expectedIds(spec: Spec, ctx: CastraContext, rows: ItemRow[]): number[] {
  return rows.filter((r) => evaluate(spec, ctx, r) === true).map((r) => r.id);
}

describe("policy property tests (compiled SQL vs JS oracle, real D1)", () => {
  beforeAll(createTables);

  it("readFilter selects exactly the rows the oracle allows", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, ctxArb, rowsArb, async (spec, ctx, rows) => {
        await replaceRows(rows);
        const filter = engineFor(spec, "read").readFilter("items", "read", ctx);
        const got = await db.selectFrom("items").select("id").where((eb) => filter.apply(eb)).orderBy("id").execute();
        expect(got.map((r) => r.id)).toEqual(expectedIds(spec, ctx, rows));
        // count stays correct under the filter (no post-filtering)
        const count = await db
          .selectFrom("items")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where((eb) => filter.apply(eb))
          .executeTakeFirstOrThrow();
        expect(Number(count.n)).toBe(expectedIds(spec, ctx, rows).length);
        // constant decisions are reported as such
        const e = filter.explanation;
        if (e.allowed === false) expect(got).toEqual([]);
        if (e.allowed === true) expect(got.length).toBe(rows.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("update/delete filters affect exactly the rows the oracle allows", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, ctxArb, rowsArb, fc.constantFrom<"update" | "delete">("update", "delete"), async (spec, ctx, rows, op) => {
        await replaceRows(rows);
        const filter = engineFor(spec, op).readFilter("items", op, ctx);
        if (op === "update") {
          await db.updateTable("items").set({ category: "TOUCHED" }).where((eb) => filter.apply(eb)).execute();
          const touched = await db.selectFrom("items").select("id").where("category", "=", "TOUCHED").orderBy("id").execute();
          expect(touched.map((r) => r.id)).toEqual(expectedIds(spec, ctx, rows));
        } else {
          await db.deleteFrom("items").where((eb) => filter.apply(eb)).execute();
          const left = await db.selectFrom("items").select("id").orderBy("id").execute();
          const allowed = new Set(expectedIds(spec, ctx, rows));
          expect(left.map((r) => r.id)).toEqual(rows.filter((r) => !allowed.has(r.id)).map((r) => r.id));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("checkRow agrees with the oracle for every candidate row", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, ctxArb, rowsArb, fc.constantFrom<"create" | "update">("create", "update"), async (spec, ctx, rows, op) => {
        const engine = engineFor(spec, op);
        for (const row of rows) {
          const decision = await engine.checkRow(db, "items", op, ctx, row);
          expect(decision.allowed).toBe(evaluate(spec, ctx, row) === true);
          expect(decision.explanation.allowed).toBe(decision.allowed);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
