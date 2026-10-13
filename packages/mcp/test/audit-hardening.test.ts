import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { auditArguments, AUDIT_ARGUMENTS_MAX, createMcpToken, handleMcpRequest, mcpDb, retainAudit, validateAuditOptions, type McpDb } from "../src/index.js";
import { config, setup, USERS } from "./fixtures.js";

let snapshot: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { snapshot = await setup(); });

describe("argument redaction", () => {
  it("masks arbitrary nested values, paths, filters and arrays without changing the input", () => {
    const input = { path: "/api/notes/private@email.test", query: "email=secret@email.test", body: { nested: [{ password: "secret", age: 42, enabled: true, empty: null }] } };
    const original = JSON.stringify(input);
    expect(JSON.parse(auditArguments(input)!)).toEqual({ path: "[REDACTED]", query: "[REDACTED]", body: { nested: [{ password: "[REDACTED]", age: "[REDACTED]", enabled: "[REDACTED]", empty: "[REDACTED]" }] } });
    expect(JSON.stringify(input)).toBe(original);
  });
  it("can hide a whole subtree case-insensitively and never calls toJSON", () => {
    expect(JSON.parse(auditArguments({ Body: { secretField: "private" } }, { redactKeys: ["body"] })!)).toEqual({ Body: "[REDACTED]" });
    const toJSON = vi.fn(() => "secret");
    expect(auditArguments({ toJSON })).not.toContain("secret");
    expect(toJSON).not.toHaveBeenCalled();
    expect(auditArguments(undefined)).toBeNull();
  });
  it("bounds cyclic/deep structure and truncates large redacted structure to valid JSON", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(JSON.parse(auditArguments(cyclic)!)).toEqual({ self: "[REDACTED]" });
    const text = auditArguments(Array.from({ length: 2000 }, () => "secret"))!;
    expect(text.length).toBeLessThanOrEqual(AUDIT_ARGUMENTS_MAX);
    expect(JSON.parse(text)).toMatchObject({ truncated: true });
    expect(text).not.toContain("secret");
    let deep: unknown = "secret";
    for (let i = 0; i < 10000; i++) deep = { child: deep };
    expect(auditArguments(deep)).not.toContain("secret");
  });
  it.each(["denied", "invalid"])("never stores payload values for %s remote calls", async (kind) => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read" });
    const res = await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST", headers: { authorization: `Bearer ${t.token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: kind === "invalid" ? "unknown_tool" : "query_data",
        arguments: { path: "/api/notes/private@email.test", body: { nested: [{ password: "super-secret" }] } },
      } }),
    }), env.DB, { config, snapshot });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM _castra_audit WHERE token_id = ?").bind(t.id).first<Record<string, unknown>>();
    expect(row!.arguments).not.toContain("super-secret");
    expect(row!.arguments).not.toContain("private@email.test");
    expect(row!.outcome).toBe(kind === "invalid" ? "invalid" : "denied");
  });

});

describe("retention", () => {
  it("rejects invalid days instead of deleting with an invalid cutoff", () => {
    for (const days of [0, -1, 0.5, NaN, Infinity, 36501]) expect(() => validateAuditOptions({ retentionDays: days })).toThrow(/retentionDays/);
  });
  it("is disabled by default, runs one bounded batch when enabled, and keeps the cutoff row", async () => {
    await env.DB.prepare("DELETE FROM _castra_audit").run();
    await env.DB.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5001) INSERT INTO _castra_audit (id, at, outcome, status) SELECT 'old-' || x, '2026-01-01T00:00:00.000Z', 'ok', 200 FROM n").run();
    await env.DB.prepare("INSERT INTO _castra_audit (id, at, outcome, status) VALUES ('edge', '2026-02-01T00:00:00.000Z', 'ok', 200)").run();
    const now = new Date("2026-02-02T00:00:00.000Z");
    await retainAudit(mcpDb(env.DB), {}, now);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM _castra_audit").first("n")).toBe(5002);
    await retainAudit(mcpDb(env.DB), { retentionDays: 1 }, now);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM _castra_audit").first("n")).toBe(2);
    expect(await env.DB.prepare("SELECT id FROM _castra_audit WHERE id = 'edge'").first("id")).toBe("edge");
  });
  it("does not propagate cleanup failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(retainAudit({ executeQuery: async () => { throw new Error("unavailable"); } } as unknown as McpDb, { retentionDays: 30 })).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
  it("remote requests apply redaction options and retention after recording the outcome", async () => {
    await env.DB.prepare("DELETE FROM _castra_audit").run();
    await env.DB.prepare("INSERT INTO _castra_audit (id, at, outcome, status) VALUES ('old', '2020-01-01T00:00:00.000Z', 'ok', 200)").run();
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    const res = await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST", headers: { authorization: `Bearer ${t.token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_data", arguments: { path: "/api/notes", query: { title: "private@email.test" } } } }),
    }), env.DB, { config, snapshot, audit: { retentionDays: 30, redactKeys: ["query"] } });
    expect(res.status).toBe(200);
    const rows = (await env.DB.prepare("SELECT * FROM _castra_audit").all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token_id: t.id, user_id: USERS.alice, tool: "query_data" });
    expect(JSON.parse(rows[0]!.arguments as string)).toEqual({ path: "[REDACTED]", query: "[REDACTED]" });
  });
});
