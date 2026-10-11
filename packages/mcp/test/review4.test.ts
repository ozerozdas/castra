/**
 * Review 4 (M4, security): adversarial tests for the remote MCP handler on real local D1.
 * Passing tests pin behaviour that held; tests marked BUG assert the correct behaviour and fail
 * until the finding is fixed.
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
  MCP_MAX_MESSAGES,
  mintMcpToken,
  type D1Like,
} from "../src/index.js";
import { config, count, NOTES, SECRET, setup, USERS } from "./fixtures.js";

let snapshot: SchemaSnapshot;
beforeAll(async () => {
  snapshot = await setup();
});

const ACCEPT = "application/json, text/event-stream";

async function raw(token: string | null, body: string | null, init: { method?: string; headers?: Record<string, string>; d1?: D1Like; url?: string } = {}) {
  const headers: Record<string, string> = { accept: ACCEPT, "content-type": "application/json", ...init.headers };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const req = new Request(init.url ?? "http://localhost/mcp", { method: init.method ?? "POST", headers, body });
  const res = await handleMcpRequest(req, init.d1 ?? env.DB, { config, snapshot });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as any) : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const call = (id: unknown, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await raw(token, JSON.stringify(call(1, name, args)));
  expect(r.status).toBe(200);
  return { isError: r.json.result.isError === true, data: r.json.result.structuredContent, text: r.text };
}

async function auditRows(tokenId: string) {
  return (await env.DB.prepare("SELECT tool, outcome, status, arguments FROM _castra_audit WHERE token_id = ? ORDER BY rowid").bind(tokenId).all<{ tool: string | null; outcome: string; status: number; arguments: string | null }>()).results;
}

describe("review4: audit integrity", () => {
  it("BUG: duplicate JSON-RPC ids in a batch cannot rewrite the audited outcome of another call", async () => {
    // describe_schema (served, ok) and query_data of a missing row (404) share id 1. The handler keys
    // tool records by id, so the last call to finish overwrites the outcome of the other one.
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read data:read" });
    const r = await raw(t.token, JSON.stringify([call(1, "describe_schema", {}), call(1, "query_data", { path: "/api/notes/does-not-exist" })]));
    const rows = await auditRows(t.id);
    expect(rows.map((x) => x.tool)).toEqual(["describe_schema", "query_data"]);
    // Either the batch is refused as a whole (no tool ran), or every row carries its own outcome.
    if (r.status === 200) {
      expect(rows[0]).toMatchObject({ outcome: "ok", status: 200 });
      expect(rows[1]).toMatchObject({ outcome: "error", status: 404 });
    } else {
      for (const row of rows) expect(row.outcome).not.toBe("ok");
    }
  });

  it("BUG: transport-level rejections (406 Accept, 415 Content-Type) are audited with the real status", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    const body = JSON.stringify(call(1, "query_data", { path: "/api/notes" }));
    const a = await raw(t.token, body, { headers: { accept: "application/json" } });
    const b = await raw(t.token, body, { headers: { "content-type": "text/plain" } });
    expect([a.status, b.status]).toEqual([406, 415]);
    const rows = await auditRows(t.id);
    expect(rows.map((x) => x.status)).toEqual([406, 415]);
  });

  it("BUG: a JSON-RPC error response (unknown method) is not audited as ok", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read" });
    const r = await raw(t.token, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/list" }));
    expect(r.json.error.code).toBe(-32601);
    const [row] = await auditRows(t.id);
    expect(row!.tool).toBe("resources/list");
    expect(row!.outcome).not.toBe("ok");
  });

  it("held: notifications and id:null tools/call never execute a tool, yet are audited", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    const n = await raw(t.token, JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "query_data", arguments: { path: "/api/notes" } } }));
    expect(n.status).toBe(202);
    expect(n.text).toBe("");
    const nul = await raw(t.token, JSON.stringify(call(null, "query_data", { path: "/api/notes" })));
    expect(nul.status).toBe(400);
    expect(nul.text).not.toContain("Alice");
    const rows = await auditRows(t.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ tool: "query_data", outcome: "invalid" });
  });

  it("held: a full batch writes one row per message; an oversized batch runs nothing and writes one row", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    const full = Array.from({ length: MCP_MAX_MESSAGES }, (_, i) => call(i + 1, "query_data", { path: "/api/notes" }));
    const ok = await raw(t.token, JSON.stringify(full));
    expect(ok.status).toBe(200);
    expect(ok.json).toHaveLength(MCP_MAX_MESSAGES);
    expect(await auditRows(t.id)).toHaveLength(MCP_MAX_MESSAGES);
    const over = await raw(t.token, JSON.stringify([...full, call(99, "query_data", { path: "/api/notes" })]));
    expect(over.status).toBe(400);
    expect(over.text).not.toContain("Alice");
    const rows = await auditRows(t.id);
    expect(rows).toHaveLength(MCP_MAX_MESSAGES + 1);
    expect(rows.at(-1)).toMatchObject({ tool: null, outcome: "rejected", status: 400 });
  });

  it("held: non-POST methods, oversized and non-JSON bodies are rejected and audited", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) expect((await raw(t.token, null, { method })).status).toBe(405);
    expect((await raw(t.token, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } }))).status).toBe(413);
    expect((await raw(t.token, "[1,2,3]")).status).toBe(400);
    expect((await raw(t.token, "null")).status).toBe(400);
    const rows = await auditRows(t.id);
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.status)).toEqual([405, 405, 405, 405, 413, 400, 400]);
  });

  it("held: multibyte arguments are truncated to valid JSON within the limit (split surrogates included)", async () => {
    for (const unit of ["\u{1F600}", "é", "\u{1F600}a", '"\\\u{1F600}']) {
      const text = auditArguments({ path: "/api/notes", query: unit.repeat(5000) })!;
      expect(text.length).toBeLessThanOrEqual(AUDIT_ARGUMENTS_MAX);
      expect(JSON.parse(text)).toMatchObject({ truncated: true });
    }
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    await tool(t.token, "query_data", { path: "/api/notes", query: { q: "\u{1F600}".repeat(4000) } });
    const [row] = await auditRows(t.id);
    expect(row!.arguments!.length).toBeLessThanOrEqual(AUDIT_ARGUMENTS_MAX);
    expect(() => JSON.parse(row!.arguments!)).not.toThrow();
  });

  it("held: the bearer token is never written to the audit log", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read" });
    await tool(t.token, "query_data", { path: "/api/notes" });
    await raw(t.token, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }));
    const dump = JSON.stringify(await env.DB.prepare("SELECT * FROM _castra_audit WHERE token_id = ?").bind(t.id).all());
    expect(dump).not.toContain(t.token.slice("castra_mcp_".length + 17));
  });
});

describe("review4: tokens", () => {
  it("held: token only via Authorization header; query string, cookie, x-api-key, other schemes are 401", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read" });
    const body = JSON.stringify(call(1, "describe_schema", {}));
    expect((await raw(null, body, { url: `http://localhost/mcp?token=${t.token}&access_token=${t.token}` })).status).toBe(401);
    expect((await raw(null, body, { headers: { cookie: `token=${t.token}; better-auth.session_token=${t.token}` } })).status).toBe(401);
    expect((await raw(null, body, { headers: { "x-api-key": t.token } })).status).toBe(401);
    expect((await raw(null, body, { headers: { authorization: `Basic ${t.token}` } })).status).toBe(401);
    expect((await raw(null, body, { headers: { authorization: `Bearer ${t.token} extra` } })).status).toBe(401);
    expect((await raw(null, body, { headers: { authorization: `bearer ${t.token}` } })).status).toBe(200);
  });

  it("held: very long, prefix-confused and case-changed tokens are 401 without touching the row", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read" });
    const body = JSON.stringify(call(1, "describe_schema", {}));
    const secret = t.token.slice(`castra_mcp_${t.id}_`.length);
    for (const bad of [
      t.token + "A".repeat(100_000),
      `castra_mcp_${t.id.toUpperCase()}_${secret}`,
      `CASTRA_MCP_${t.id}_${secret}`,
      `castra_ak_${t.id}_${secret}`,
      `castra_mcp_${t.id}_${secret}x`,
      `castra_mcp_${t.id}__${secret}`,
    ]) {
      expect((await raw(bad, body)).status).toBe(401);
    }
  });

  it("held: deleting the user cascades to the token (401 afterwards)", async () => {
    const uid = `u-temp-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO "user" (id, name, email) VALUES (?, 'Temp', ?)`).bind(uid, `${uid}@example.com`).run();
    const t = await createMcpToken(env.DB, { userId: uid, scopes: "data:read" });
    expect((await tool(t.token, "query_data", { path: "/api/notes" })).isError).toBe(false);
    await env.DB.prepare(`DELETE FROM "user" WHERE id = ?`).bind(uid).run();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM _castra_mcp_tokens WHERE id = ?").bind(t.id).first("n")).toBe(0);
    expect((await raw(t.token, JSON.stringify(call(1, "query_data", { path: "/api/notes" })))).status).toBe(401);
  });

  it("held: stored scope tricks (case, unknown, whitespace/newlines, duplicates) never widen access", async () => {
    const make = async (scopes: string) => {
      const m = await mintMcpToken({ userId: USERS.alice, scopes: ["schema:read"] });
      const q = insertMcpTokenQuery({ ...m.row, scopes });
      await env.DB.prepare(q.sql).bind(...q.parameters).run();
      return m.token;
    };
    const body = JSON.stringify(call(1, "query_data", { path: `/api/notes/${NOTES.aliceDraft}`, as: { userId: USERS.alice, roles: ["admin"] } }));
    for (const scopes of ["DATA:READ data:read:any_user", "data:read data:read:ANY_USER", "data:read *", "data:read data:read:any_user,admin", ""]) {
      const r = await raw(await make(scopes), body);
      if (r.status === 200) expect(r.json.result.isError, scopes).toBe(true);
      else expect(r.status, scopes).toBe(401);
    }
    // Duplicates and odd whitespace parse to the same canonical set: still no any_user.
    const r = await raw(await make(" data:read\n\tdata:read  "), body);
    expect(r.json.result.structuredContent.detail).toBe("missing scope: data:read:any_user");
  });
});

describe("review4: no data path around the engine", () => {
  it("held: access:check / schema:read tokens never see row values (secret, other users' drafts)", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.bob, scopes: "schema:read access:check" });
    const outs = [
      await tool(t.token, "describe_schema", {}),
      await tool(t.token, "check_access", { table: "notes", op: "read", row: { id: NOTES.aliceDraft } }),
      await tool(t.token, "check_access", { table: "notes", op: "update", row: { id: NOTES.aliceDraft, owner_id: USERS.alice } }),
      await tool(t.token, "explain_query", { method: "GET", path: `/api/notes/${NOTES.aliceDraft}` }),
      await tool(t.token, "explain_query", { method: "GET", path: "/api/notes", query: "status=eq.draft&include=nope" }),
      await tool(t.token, "explain_query", { method: "PATCH", path: `/api/notes/${NOTES.aliceDraft}`, body: { title: "x" } }),
    ];
    for (const o of outs) {
      expect(o.text).not.toContain(SECRET);
      expect(o.text).not.toContain("Alice draft");
      expect(o.text).not.toContain("staff only");
    }
    // check_access evaluates the CANDIDATE row only: claiming alice's draft as bob's own does not reveal
    // anything stored (the decision depends on the supplied owner_id, not on the database row).
    const spoof = await tool(t.token, "check_access", { table: "notes", op: "read", row: { id: NOTES.aliceDraft, owner_id: USERS.bob, status: "draft" } });
    expect(spoof.data.allowed).toBe(true);
    expect(spoof.text).not.toContain("Alice draft");
  });

  it("BUG: check_access with an own __proto__ key agrees with REST (400 unknown column), not allowed:true", async () => {
    // REST/explain_query see the own "__proto__" key from JSON.parse and reject it; check_access's zod
    // record parse turns it into a prototype, the key disappears, and the dry run says allowed.
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "access:check" });
    const args = '{"table":"notes","op":"create","row":{"__proto__":{"owner_id":"u-bob"},"title":"x"}}';
    const explainArgs = '{"method":"POST","path":"/api/notes","body":{"__proto__":{"owner_id":"u-bob"},"title":"x"}}';
    const rpc = (name: string, a: string) => `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${name}","arguments":${a}}}`;
    const explain = await raw(t.token, rpc("explain_query", explainArgs));
    expect(explain.json.result.structuredContent).toMatchObject({ status: 400, detail: 'unknown column "__proto__"' });
    const check = await raw(t.token, rpc("check_access", args));
    expect(check.json.result.structuredContent.allowed).not.toBe(true);
  });

  it("held: unexpected D1 errors become a generic 500 problem without SQL or messages", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "data:read access:check" });
    const failing: D1Like = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/from "notes"|from \(select/i.test(sql)) throw new Error(`D1_ERROR: no such column: secret_hash in ${sql}`);
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    for (const [name, args] of [
      ["query_data", { path: "/api/notes" }],
      ["check_access", { table: "notes", op: "update", row: { id: "x", owner_id: USERS.bob } }],
    ] as const) {
      const r = await raw(t.token, JSON.stringify(call(1, name, args)), { d1: failing });
      expect(r.status).toBe(200);
      expect(r.text).not.toMatch(/D1_ERROR|select|secret_hash|stack/i);
      expect(r.json.result.isError).toBe(true);
      expect(JSON.stringify(r.json.result.structuredContent)).toContain("An unexpected error occurred.");
    }
  });
});

describe("review4: identity and scopes (design pins)", () => {
  it("pin: remote `as` never takes explicit roles and never falls back for an unknown user (ADR 0061 amendment 2026-10-11)", async () => {
    // ARCHITECTURE §5 says "no scope grants admin". Before the amendment, data:read:any_user + explicit
    // roles evaluated as ANY role set (admin-only fields readable by a non-admin owner). Now roles always
    // come from _castra_roles on /mcp, and an unknown user id is an error.
    const t = await createMcpToken(env.DB, { userId: USERS.bob, scopes: "data:read access:check data:read:any_user" });
    for (const as of [{ userId: USERS.bob, roles: ["admin"] }, { roles: ["admin"] }, { userId: USERS.alice, roles: [] }]) {
      const r = await tool(t.token, "query_data", { path: `/api/notes/${NOTES.alicePub}`, as });
      expect(r.isError).toBe(true);
      expect(r.data).toMatchObject({ status: 400, type: "https://castra.mehmetozer.dev/problems/roles_not_allowed" });
      expect(r.text).not.toContain("staff only");
    }
    const check = await tool(t.token, "check_access", { table: "notes", op: "delete", as: { userId: USERS.bob, roles: ["admin"] } });
    expect(check.data).toMatchObject({ status: 400, type: "https://castra.mehmetozer.dev/problems/roles_not_allowed" });
    const fake = await tool(t.token, "query_data", { path: "/api/notes", as: { userId: "no-such-user" } });
    expect(fake.isError).toBe(true);
    expect(fake.data).toMatchObject({ status: 400, type: "https://castra.mehmetozer.dev/problems/unknown_user" });
    // The token's own user and existing users still work, with their stored roles.
    expect((await tool(t.token, "query_data", { path: `/api/notes/${NOTES.alicePub}`, as: { userId: USERS.bob } })).data.status).toBe(200);
    expect((await tool(t.token, "query_data", { path: `/api/notes/${NOTES.alicePub}` })).text).not.toContain("staff only");
  });

  it("pin: access:check reveals hidden:true column names (explanation + planned SQL), never their values", async () => {
    // describe_schema omits hidden columns and REST masks them as unknown, but explanations name them
    // (ARCHITECTURE §3 "which fields were hidden") and explain_query shows the SELECT list.
    const t = await createMcpToken(env.DB, { userId: USERS.bob, scopes: "schema:read access:check" });
    const schema = await tool(t.token, "describe_schema", {});
    expect(schema.text).not.toContain("secret_hash");
    const check = await tool(t.token, "check_access", { table: "notes", op: "read" });
    expect(check.data.explanation.hiddenFields).toContain("secret_hash");
    const explain = await tool(t.token, "explain_query", { method: "GET", path: "/api/notes" });
    expect(explain.text).toContain("secret_hash");
    const hiddenRow = await tool(t.token, "check_access", { table: "notes", op: "create", row: { title: "x", secret_hash: "a" } });
    expect(hiddenRow.data.explanation.reason).toBe('column "secret_hash" cannot be written'); // REST says: unknown column
    for (const o of [schema, check, explain, hiddenRow]) expect(o.text).not.toContain(SECRET);
  });

  it("pin: a wrong secret for a known token id writes an audit row (unauthenticated writes are bounded only by id knowledge)", async () => {
    const t = await createMcpToken(env.DB, { userId: USERS.alice, scopes: "schema:read" });
    const before = await count("_castra_audit");
    for (let i = 0; i < 3; i++) await raw(`castra_mcp_${t.id}_${"A".repeat(43)}`, "{}");
    expect(await count("_castra_audit")).toBe(before + 3);
  });
});
