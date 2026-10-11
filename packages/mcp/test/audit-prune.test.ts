import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { pruneAuditQuery } from "../src/index.js";
import { setup } from "./fixtures.js";

beforeAll(async () => {
  await setup();
});

async function prune(before: Date): Promise<number> {
  const q = pruneAuditQuery(before);
  const { results } = await env.DB.prepare(q.sql).bind(...q.parameters).all();
  return results.length;
}

describe("pruneAuditQuery", () => {
  it("deletes rows strictly older than the cutoff and keeps the rest", async () => {
    await env.DB.prepare("DELETE FROM _castra_audit").run();
    const insert = env.DB.prepare("INSERT INTO _castra_audit (id, at, outcome, status) VALUES (?, ?, 'ok', 200)");
    await env.DB.batch([
      insert.bind("old", "2026-01-01T00:00:00.000Z"),
      insert.bind("edge", "2026-02-01T00:00:00.000Z"),
      insert.bind("new", "2026-03-01T00:00:00.000Z"),
    ]);
    expect(await prune(new Date("2026-02-01T00:00:00.000Z"))).toBe(1);
    const left = await env.DB.prepare("SELECT id FROM _castra_audit ORDER BY at").all();
    expect(left.results.map((r) => r.id)).toEqual(["edge", "new"]);
    expect(await prune(new Date("2026-02-01T00:00:00.000Z"))).toBe(0);
  });
});
