import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { introspect } from "../../src/schema/index.js";
import type { SchemaSnapshot } from "../../src/types.js";
import { d1Query } from "./fixture.js";

let snapshot: SchemaSnapshot;

beforeAll(async () => {
  await env.DB.prepare("CREATE TABLE s_strict (id INTEGER PRIMARY KEY, x ANY, n INTEGER) STRICT").run();
  await env.DB.prepare("CREATE TABLE s_plain (id INTEGER PRIMARY KEY, x)").run();
  await env.DB.prepare(
    `CREATE TABLE "s ""coll" (id INTEGER PRIMARY KEY, "we""ird" TEXT COLLATE nocase, t TEXT COLLATE RTRIM, b TEXT COLLATE BINARY, n INTEGER COLLATE NOCASE)`,
  ).run();
  snapshot = await introspect(d1Query, { generatedAt: "2026-01-01T00:00:00.000Z" });
});

describe("introspect records STRICT tables (real D1)", () => {
  it("sets strict: true on a STRICT table", () => {
    expect(snapshot.tables.s_strict?.strict).toBe(true);
  });

  it("omits the flag on an ordinary table", () => {
    expect(snapshot.tables.s_plain).not.toHaveProperty("strict");
  });
});

describe("introspect records column collations (ADR 0075)", () => {
  it("NOCASE and RTRIM in any case, on any column type; BINARY is omitted", () => {
    const cols = Object.fromEntries(snapshot.tables['s "coll']!.columns.map((c) => [c.name, c.collation]));
    expect(cols).toEqual({ id: undefined, 'we"ird': "NOCASE", t: "RTRIM", b: undefined, n: "NOCASE" });
  });
});
