/**
 * Tokens, scopes and the remote handler (`handleMcpRequest`) on real D1: auth failures, the scope
 * matrix for every tool × scope combination, and one audit row per call (including denied calls).
 */
import type { SchemaSnapshot } from "castra";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AUDIT_ARGUMENTS_MAX,
  auditArguments,
  createMcpToken,
  handleMcpRequest,
  insertMcpTokenQuery,
  MCP_SCOPES,
  mintMcpToken,
  parseMcpToken,
  parseScopes,
  revokeMcpToken,
  revokeMcpTokenQuery,
  TOOL_SCOPES,
  verifyMcpToken,
  type D1Like,
  type McpScope,
  type ToolName,
} from "../src/index.js";
import { config, count, NOTES, setup, USERS } from "./fixtures.js";

let snapshot: SchemaSnapshot;
beforeAll(async () => {
  snapshot = await setup();
});

let rpcId = 0;
async function post(token: string | null, body: unknown, init: { method?: string; d1?: D1Like; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json", ...init.headers };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const req = new Request("http://localhost/mcp", { method: init.method ?? "POST", headers, body: init.method && init.method !== "POST" ? undefined : JSON.stringify(body) });
  const res = await handleMcpRequest(req, init.d1 ?? env.DB, { config, snapshot });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await post(token, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return { isError: r.json.result.isError === true, data: r.json.result.structuredContent };
}

async function lastAudit() {
  return env.DB.prepare("SELECT * FROM _castra_audit ORDER BY rowid DESC LIMIT 1").first<Record<string, unknown>>();
}

describe("tokens", () => {
  it("create → verify → revoke", async () => {
    const created = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read schema:read", name: "t" });
    expect(created.token).toMatch(/^castra_mcp_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(created.scopes).toEqual(["schema:read", "data:read"]);
    const stored = await env.DB.prepare("SELECT * FROM _castra_mcp_tokens WHERE id = ?").bind(created.id).first<Record<string, unknown>>();
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(await verifyMcpToken(env.DB, created.token)).toEqual({ ok: true, token: { id: created.id, userId: USERS.alice, scopes: ["schema:read", "data:read"] } });
    expect(await revokeMcpToken(env.DB, created.id)).toBe(true);
    expect(await revokeMcpToken(env.DB, created.id)).toBe(false);
    expect(await verifyMcpToken(env.DB, created.token)).toMatchObject({ ok: false, reason: "revoked", tokenId: created.id });
  });
  it("expired, unknown, tampered, malformed and API-key tokens are rejected", async () => {
    const past = await createMcpToken(env.DB, { userId: USERS.alice, scopes: ["schema:read"], expiresAt: new Date(Date.now() - 1000) });
    expect(await verifyMcpToken(env.DB, past.token)).toMatchObject({ ok: false, reason: "expired" });
    const good = await createMcpToken(env.DB, { userId: USERS.alice, scopes: ["schema:read"] });
    const tampered = good.token.slice(0, -1) + (good.token.endsWith("A") ? "B" : "A");
    expect(await verifyMcpToken(env.DB, tampered)).toMatchObject({ ok: false, reason: "invalid", tokenId: good.id });
    expect(await verifyMcpToken(env.DB, `castra_mcp_0123456789abcdef_${"A".repeat(43)}`)).toMatchObject({ ok: false, reason: "unknown", tokenId: null });
    for (const t of ["", "castra_mcp_", `castra_ak_${good.id}_${"A".repeat(43)}`, good.token.replace("castra_mcp_", "castra_xyz_"), `${good.token} `]) {
      expect((await verifyMcpToken(env.DB, t)).ok).toBe(false);
    }
  });
  it("a token row with unknown scopes grants nothing", async () => {
    const m = await mintMcpToken({ userId: USERS.alice, scopes: ["schema:read"] });
    const q = insertMcpTokenQuery({ ...m.row, scopes: "schema:read admin" });
    await env.DB.prepare(q.sql).bind(...q.parameters).run();
    expect(await verifyMcpToken(env.DB, m.token)).toMatchObject({ ok: false, reason: "invalid" });
  });
  it("scope parsing rejects unknown and empty scopes; tokens need an existing user", async () => {
    expect(() => parseScopes("schema:read admin")).toThrow(/unknown MCP scope "admin"/);
    expect(() => parseScopes("  ")).toThrow(/at least one/);
    await expect(createMcpToken(env.DB, { userId: "ghost", scopes: "schema:read" })).rejects.toThrow();
  });
  it("compiled revoke returns the id only when it revoked an active token", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read" });
    const q = revokeMcpTokenQuery(t.id);
    expect((await env.DB.prepare(q.sql).bind(...q.parameters).all()).results).toEqual([{ id: t.id }]);
    expect((await env.DB.prepare(q.sql).bind(...q.parameters).all()).results).toEqual([]);
    expect(parseMcpToken(t.token)).toEqual({ id: t.id });
  });
});

describe("remote auth", () => {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  it("401 for missing, malformed, unknown, revoked, expired tokens and API keys", async () => {
    const revoked = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read" });
    await revokeMcpToken(env.DB, revoked.id);
    const expired = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read", expiresAt: new Date(Date.now() - 1) });
    for (const t of [null, "garbage", `castra_ak_0123456789abcdef_${"A".repeat(43)}`, `castra_mcp_0123456789abcdef_${"A".repeat(43)}`, revoked.token, expired.token]) {
      const r = await post(t, initialize);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toMatch(/^Bearer /);
      expect(r.headers.get("content-type")).toBe("application/problem+json");
    }
  });
  it("auth failures with a known token id are audited, unknown ones are not", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.bob, scopes: "schema:read" });
    await revokeMcpToken(env.DB, t.id);
    const before = await count("_castra_audit");
    await post(t.token, initialize);
    expect(await count("_castra_audit")).toBe(before + 1);
    expect(await lastAudit()).toMatchObject({ token_id: t.id, user_id: USERS.bob, outcome: "unauthorized:revoked", status: 401, tool: null });
    await post(`castra_mcp_0123456789abcdef_${"A".repeat(43)}`, initialize);
    await post(null, initialize);
    expect(await count("_castra_audit")).toBe(before + 1);
  });
  it("initialize and tools/list work with any valid token; GET is 405 and audited", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read" });
    const init = await post(t.token, initialize);
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("castra");
    const list = await post(t.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.json.result.tools.map((x: { name: string }) => x.name).sort()).toEqual(["check_access", "describe_schema", "explain_query", "query_data"]);
    expect(await lastAudit()).toMatchObject({ token_id: t.id, tool: "tools/list", outcome: "ok", status: 200 });
    const get = await post(t.token, null, { method: "GET" });
    expect(get.status).toBe(405);
    expect(await lastAudit()).toMatchObject({ token_id: t.id, tool: null, outcome: "rejected", status: 405 });
  });
  it("malformed JSON and oversized batches are rejected and audited", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read" });
    const req = new Request("http://localhost/mcp", { method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{nope" });
    expect((await handleMcpRequest(req, env.DB, { config, snapshot })).status).toBe(400);
    expect(await lastAudit()).toMatchObject({ outcome: "rejected", status: 400 });
    const batch = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/list" }));
    expect((await post(t.token, batch)).status).toBe(400);
  });
});

// Every non-empty subset of the four scopes.
const COMBOS: McpScope[][] = [];
for (let mask = 1; mask < 1 << MCP_SCOPES.length; mask++) COMBOS.push(MCP_SCOPES.filter((_, i) => mask & (1 << i)));

const CALLS: Record<ToolName, { self: Record<string, unknown>; other?: Record<string, unknown> }> = {
  describe_schema: { self: {} },
  check_access: { self: { table: "notes", op: "read" }, other: { table: "notes", op: "read", as: { userId: USERS.admin } } },
  explain_query: { self: { method: "GET", path: "/api/notes" }, other: { method: "GET", path: "/api/notes", as: "anonymous" } },
  query_data: { self: { path: "/api/notes" }, other: { path: "/api/notes", as: { userId: USERS.bob } } },
};

describe("scope matrix: every tool × every scope combination", () => {
  it.each(COMBOS.map((c) => [c.join(" ")]))("%s", async (scopes) => {
    const granted = parseScopes(scopes);
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: granted });
    for (const [name, c] of Object.entries(CALLS) as [ToolName, (typeof CALLS)[ToolName]][]) {
      const needed = TOOL_SCOPES[name];
      const before = await count("_castra_audit");
      const self = await tool(t.token, name, c.self);
      expect(await count("_castra_audit")).toBe(before + 1);
      if (granted.includes(needed)) {
        expect(self.isError, `${name} as self with ${scopes}`).toBe(false);
        expect((await lastAudit())!.outcome).toBe("ok");
      } else {
        expect(self.isError).toBe(true);
        expect(self.data).toMatchObject({ status: 403, scope: needed, detail: `missing scope: ${needed}` });
        expect(await lastAudit()).toMatchObject({ tool: name, outcome: "denied", status: 403, token_id: t.id, user_id: USERS.alice });
      }
      if (!c.other) continue;
      const other = await tool(t.token, name, c.other);
      const allowed = granted.includes(needed) && granted.includes("data:read:any_user");
      expect(other.isError, `${name} as other with ${scopes}`).toBe(!allowed);
      if (!allowed) expect(other.data.detail).toBe(`missing scope: ${granted.includes(needed) ? "data:read:any_user" : needed}`);
    }
  });
});

describe("remote identity", () => {
  it("data:read reads as the token's user with CURRENT roles", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.bob, scopes: "data:read" });
    const before = await tool(t.token, "query_data", { path: `/api/notes/${NOTES.aliceDraft}` });
    expect(before.data.status).toBe(404);
    await env.DB.prepare("INSERT INTO _castra_roles (user_id, role) VALUES (?, 'admin')").bind(USERS.bob).run();
    try {
      const after = await tool(t.token, "query_data", { path: `/api/notes/${NOTES.aliceDraft}` });
      expect(after.data).toMatchObject({ status: 200, body: { id: NOTES.aliceDraft } });
    } finally {
      await env.DB.prepare("DELETE FROM _castra_roles WHERE user_id = ? AND role = 'admin'").bind(USERS.bob).run();
    }
    const revokedRole = await tool(t.token, "query_data", { path: `/api/notes/${NOTES.aliceDraft}` });
    expect(revokedRole.data.status).toBe(404);
  });
  it("as the token's own user id is not 'another identity'; explicit roles are", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    expect((await tool(t.token, "query_data", { path: "/api/notes", as: { userId: USERS.alice } })).isError).toBe(false);
    expect((await tool(t.token, "query_data", { path: "/api/notes", as: { userId: USERS.alice, roles: ["admin"] } })).data.detail).toBe("missing scope: data:read:any_user");
    expect((await tool(t.token, "query_data", { path: "/api/notes", as: "anonymous" })).data.detail).toBe("missing scope: data:read:any_user");
  });
});

describe("audit", () => {
  it("records the tool, arguments, outcome and status of failing calls too", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    await tool(t.token, "query_data", { path: "/api/logs" });
    const row = await lastAudit();
    expect(row).toMatchObject({ token_id: t.id, user_id: USERS.alice, tool: "query_data", outcome: "error", status: 404 });
    expect(JSON.parse(row!.arguments as string)).toEqual({ path: "/api/logs" });
  });
  it("invalid arguments are audited as invalid", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "access:check" });
    const r = await tool(t.token, "check_access", { table: "notes", op: "drop" });
    expect(r.isError).toBe(true);
    expect(await lastAudit()).toMatchObject({ tool: "check_access", outcome: "invalid", status: 400 });
  });
  it("large arguments are truncated to valid JSON within the limit", async () => {
    const big = auditArguments({ path: "/api/notes", query: "x".repeat(10_000) + '"\\'.repeat(500) })!;
    expect(big.length).toBeLessThanOrEqual(AUDIT_ARGUMENTS_MAX);
    expect(JSON.parse(big)).toMatchObject({ truncated: true });
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    await tool(t.token, "query_data", { path: "/api/notes", query: "a=" + "y".repeat(6000) });
    expect(((await lastAudit())!.arguments as string).length).toBeLessThanOrEqual(AUDIT_ARGUMENTS_MAX);
  });
  it("a failing audit write fails the call closed (500, no data served)", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    // A D1 binding that refuses audit inserts; everything else passes through.
    const failing: D1Like = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/insert into "_castra_audit"/i.test(sql)) throw new Error("audit table unavailable");
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const r = await post(t.token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_data", arguments: { path: "/api/notes" } } }, { d1: failing });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain("Alice public");
  });
});
