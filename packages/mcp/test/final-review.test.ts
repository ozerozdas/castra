/**
 * Final v0.1 review fixes on the MCP side (same engine as REST, CLAUDE.md rule 7), allow and deny:
 * FR-1 (ADR 0066) an ON CONFLICT REPLACE table is reported as not writable. (FR-2 has no MCP surface:
 * the tools never execute a write, so no create response body exists there.)
 */
import { authenticated, defineConfig, introspect, owner, type CastraContext, type SchemaSnapshot } from "castra";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { castraTools, type ToolAccess, type ToolDefinition } from "../src/index.js";
import { testDb } from "./fixtures.js";

const config = defineConfig({
  database: "d1",
  roles: ["admin"],
  tables: {
    mfr_replace: { read: owner("owner_id"), create: authenticated(), update: owner("owner_id"), delete: owner("owner_id") },
    mfr_plain: { read: owner("owner_id"), create: authenticated(), update: owner("owner_id"), delete: owner("owner_id") },
  },
});

const alice: CastraContext = { user: { id: "mfr-alice" }, roles: [], session: null, request: null, via: "test" };
const access: ToolAccess = { authorize: async () => alice };

let tools: Map<string, ToolDefinition>;

beforeAll(async () => {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS mfr_replace (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, slug TEXT UNIQUE ON CONFLICT REPLACE)",
  ).run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS mfr_plain (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, slug TEXT UNIQUE)").run();
  const snapshot: SchemaSnapshot = await introspect(
    async (sql, params = []) => (await env.DB.prepare(sql).bind(...params).all()).results as Record<string, unknown>[],
  );
  tools = new Map(castraTools({ config, snapshot, db: testDb() }).map((t) => [t.name, t]));
});

const run = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args, access);

describe("FR-1 via MCP: ON CONFLICT REPLACE table", () => {
  it("describe_schema marks writes disabled (deny) and leaves the plain table alone (allow)", async () => {
    const r = await run("describe_schema", {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tables = (r.data as any).tables;
    expect(tables.mfr_replace.writesDisabled).toMatch(/unsafe_schema/);
    expect(tables.mfr_plain).not.toHaveProperty("writesDisabled");
  });

  it("check_access: create/update are not allowed with or without a row (deny); the plain table is (allow)", async () => {
    for (const op of ["create", "update"]) {
      for (const row of [undefined, { id: "x", owner_id: alice.user!.id, slug: "s" }]) {
        const r = await run("check_access", { table: "mfr_replace", op, ...(row ? { row } : {}) });
        expect(r.outcome, JSON.stringify(r.data)).toBe("ok");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = r.data as any;
        expect(d.allowed).toBe(false);
        expect(JSON.stringify(d.explanation)).toMatch(/ON CONFLICT REPLACE/);
      }
    }
    const ok = await run("check_access", { table: "mfr_plain", op: "create", row: { id: "x", slug: "s" } });
    expect((ok.data as { allowed: unknown }).allowed).toBe(true);
    const read = await run("check_access", { table: "mfr_replace", op: "read" });
    expect((read.data as { allowed: unknown }).allowed).toBe("conditional");
  });

  it("explain_query: a POST to the REPLACE table is the same 403 unsafe_schema as REST; the plain table plans", async () => {
    const denied = await run("explain_query", { method: "POST", path: "/api/mfr_replace", body: { slug: "s" } });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.data)).toContain("unsafe_schema");
    const planned = await run("explain_query", { method: "POST", path: "/api/mfr_plain", body: { slug: "s" } });
    expect(planned.outcome).toBe("ok");
  });
});
