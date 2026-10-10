/**
 * WITH CHECK must agree with what SQLite stores for numeric-looking text. Property-style sweep over
 * Unicode White_Space code points and ASCII controls as prefix/suffix of a numeric string.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticated, createPolicyEngine } from "../../src/index.js";
import { createTables, testDb } from "./db.js";
import { blogSnapshot, ROLES, user } from "./fixtures.js";

const db = testDb();
const rule = authenticated().where((q) => q.eb("score", "<=", 100));
const engine = createPolicyEngine({
  config: { database: "d1", roles: ROLES, tables: { items: { read: rule, create: rule } } },
  snapshot: blogSnapshot,
});
const ctx = user("u1");
let nextId = 50_000;

const whitespace = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x180e,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x200b,
].map((c) => String.fromCodePoint(c));

const shapes: Array<[string, (w: string) => string]> = [
  ["prefix", (w) => `${w}9999`],
  ["suffix", (w) => `50${w}`],
  ["prefix and suffix", (w) => `${w}50${w}`],
];

beforeAll(createTables);
beforeEach(async () => {
  await db.deleteFrom("items").execute();
});

describe("checkRow agrees with storage for whitespace around numeric text", () => {
  for (const ws of whitespace) {
    for (const [label, make] of shapes) {
      it(`U+${ws.codePointAt(0)!.toString(16).padStart(4, "0")} as ${label}`, async () => {
        const row = { owner_id: "u1", score: make(ws) };
        const decision = await engine.checkRow(db, "items", "create", ctx, row);
        const id = nextId++;
        await db.insertInto("items").values({ ...row, id }).execute();
        const f = engine.readFilter("items", "read", ctx);
        const stored = await db.selectFrom("items").select("id").where("id", "=", id).where((eb) => f.apply(eb)).execute();
        expect(decision.allowed).toBe(stored.length === 1);
      });
    }
  }
});
