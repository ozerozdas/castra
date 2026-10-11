/**
 * Remote MCP on the blog Worker (/mcp): token auth, audit, read-only tools, and rule 7 — the same
 * request through REST and through MCP `query_data` yields the identical status and body.
 */
import { assignRole, createApiKey } from "@castra-kit/auth";
import { createMcpToken, revokeMcpToken } from "@castra-kit/mcp";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { authOptions } from "../src/index";

const BASE = "http://localhost";

interface Who {
  id: string;
  bearer: string;
}

async function signUp(role?: string): Promise<Who> {
  const res = await exports.default.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: `mcp-${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "MCP" }),
  });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string } };
  if (role) await assignRole(env.DB, user.id, role, authOptions.roles);
  return { id: user.id, bearer: res.headers.get("set-auth-token")! };
}

let rpcId = 0;
async function mcp(token: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await exports.default.fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(token, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  expect(r.status).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: r.json.result.isError === true, data: r.json.result.structuredContent as any };
}

async function rest(path: string, bearer?: string) {
  const res = await exports.default.fetch(`${BASE}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

async function count(table: string) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

const ALL = "schema:read access:check data:read data:read:any_user";
let alice: Who, bob: Who, admin: Who, editor: Who;
let any: string; // token with every scope (owned by admin; `as` picks the identity)
const ids = { published: crypto.randomUUID(), draft: crypto.randomUUID(), bobPost: crypto.randomUUID(), c1: crypto.randomUUID() };

beforeAll(async () => {
  [alice, bob, admin, editor] = await Promise.all([signUp(), signUp(), signUp("admin"), signUp("editor")]);
  const p = env.DB.prepare("INSERT INTO posts (id, author_id, title, body, status, internal_notes) VALUES (?, ?, ?, ?, ?, ?)");
  await env.DB.batch([
    p.bind(ids.published, alice.id, "Published", "b", "published", "note"),
    p.bind(ids.draft, alice.id, "Draft", "b", "draft", "note"),
    p.bind(ids.bobPost, bob.id, "Bob", "b", "published", null),
    env.DB.prepare("INSERT INTO comments (id, post_id, user_id, body) VALUES (?, ?, ?, ?)").bind(ids.c1, ids.published, bob.id, "hi"),
  ]);
  any = (await createMcpToken(env.DB, { userId: admin.id, scopes: ALL, name: "test" })).token;
});

describe("transport and auth", () => {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  it("initialize + tools/list with a token", async () => {
    const init = await mcp(any, initialize);
    expect(init.status).toBe(200);
    expect(init.json.result.capabilities.tools).toBeDefined();
    const list = await mcp(any, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["check_access", "describe_schema", "explain_query", "query_data"]);
    for (const t of list.json.result.tools) expect(t.annotations.readOnlyHint).toBe(true);
  });
  it("401 for no token, sessions, API keys, revoked and expired MCP tokens", async () => {
    const key = (await createApiKey(env.DB, { userId: admin.id }, authOptions.roles)).key;
    const revoked = await createMcpToken(env.DB, { userId: alice.id, scopes: ALL });
    await revokeMcpToken(env.DB, revoked.id);
    const expired = await createMcpToken(env.DB, { userId: alice.id, scopes: ALL, expiresAt: new Date(Date.now() - 1000) });
    for (const t of [null, admin.bearer, key, revoked.token, expired.token, "castra_mcp_x"]) {
      expect((await mcp(t, initialize)).status).toBe(401);
    }
    const viaHeader = await exports.default.fetch(`${BASE}/mcp`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(initialize) });
    expect(viaHeader.status).toBe(401);
  });
  it("an MCP token is not a REST credential", async () => {
    const me = await exports.default.fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${any}` } });
    expect(((await me.json()) as { user: unknown }).user).toBeNull();
    expect((await rest("/api/users", any)).status).toBe(401);
    expect((await rest(`/api/posts/${ids.draft}`, any)).status).toBe(404);
  });
});

describe("audit", () => {
  it("one row per call, including scope denials and auth failures with a known token", async () => {
    const t = await createMcpToken(env.DB, { userId: bob.id, scopes: "schema:read" });
    const before = await count("_castra_audit");
    expect((await tool(t.token, "describe_schema")).isError).toBe(false);
    expect((await tool(t.token, "query_data", { path: "/api/posts" })).data.detail).toBe("missing scope: data:read");
    await revokeMcpToken(env.DB, t.id);
    await mcp(t.token, { jsonrpc: "2.0", id: 9, method: "tools/list" });
    const rows = (await env.DB.prepare("SELECT tool, outcome, status, user_id FROM _castra_audit WHERE token_id = ? ORDER BY rowid").bind(t.id).all()).results;
    expect(await count("_castra_audit")).toBe(before + 3);
    expect(rows).toEqual([
      { tool: "describe_schema", outcome: "ok", status: 200, user_id: bob.id },
      { tool: "query_data", outcome: "denied", status: 403, user_id: bob.id },
      { tool: null, outcome: "unauthorized:revoked", status: 401, user_id: bob.id },
    ]);
  });
});

describe("tools on the blog", () => {
  it("describe_schema lists exposed tables only, without hidden or reserved names", async () => {
    const r = await tool(any, "describe_schema");
    expect(Object.keys(r.data.tables).sort()).toEqual(["comments", "posts", "users"]);
    const text = JSON.stringify(r.data);
    for (const reserved of ["_castra_", "audit_logs", '"session"', '"account"', '"verification"', "token_hash", "key_hash"]) expect(text).not.toContain(reserved);
  });
  it("check_access: admin may delete posts, alice may not", async () => {
    expect((await tool(any, "check_access", { table: "posts", op: "delete", as: { userId: admin.id } })).data.allowed).toBe(true);
    expect((await tool(any, "check_access", { table: "posts", op: "delete", as: { userId: alice.id } })).data.allowed).toBe(false);
  });
  it("explain_query explains writes without executing them", async () => {
    const before = await count("posts");
    for (const [method, path, body] of [
      ["POST", "/api/posts", { title: "x", body: "y" }],
      ["PATCH", `/api/posts/${ids.published}`, { title: "changed" }],
      ["DELETE", `/api/posts/${ids.bobPost}`, undefined],
    ] as const) {
      const r = await tool(any, "explain_query", { method, path, body, as: { userId: admin.id } });
      expect(r.isError, `${method} ${path}`).toBe(false);
      expect(r.data.executed).toBe(false);
    }
    expect(await count("posts")).toBe(before);
    const row = await env.DB.prepare("SELECT title FROM posts WHERE id = ?").bind(ids.published).first<{ title: string }>();
    expect(row!.title).toBe("Published");
  });
});

describe("rule 7: REST ≡ MCP query_data", () => {
  const who = () => ({ anonymous: undefined, alice, bob, admin, editor }) as Record<string, Who | undefined>;
  const paths = () => [
    "/api/posts?limit=100&sort=-created_at&count=exact",
    "/api/posts?status=eq.published&sort=title&include=author",
    `/api/posts/${ids.draft}`,
    `/api/posts/${ids.published}?include=author`,
    `/api/comments/${ids.c1}?include=post`,
    "/api/posts?internal_notes=eq.note",
    "/api/users?limit=100",
    `/api/users/${alice.id}`,
    "/api/audit_logs",
    "/api/posts?limit=1&sort=-created_at",
  ];
  it("identical status and body for every identity × path", async () => {
    for (const [name, w] of Object.entries(who())) {
      for (const path of paths()) {
        const viaRest = await rest(path, w?.bearer);
        const viaMcp = await tool(any, "query_data", { path, as: w ? { userId: w.id } : "anonymous" });
        expect(viaMcp.data, `${name} ${path}`).toEqual({ status: viaRest.status, body: viaRest.body });
        expect(viaMcp.isError).toBe(viaRest.status >= 400);
        if (viaRest.body?.nextCursor) {
          const next = `/api/posts?limit=1&sort=-created_at&cursor=${encodeURIComponent(viaRest.body.nextCursor)}`;
          const r2 = await rest(next, w?.bearer);
          expect((await tool(any, "query_data", { path: next, as: w ? { userId: w.id } : "anonymous" })).data).toEqual({ status: r2.status, body: r2.body });
        }
      }
    }
  });
  it("a data:read token reads as its own user, exactly like that user's session", async () => {
    const t = (await createMcpToken(env.DB, { userId: alice.id, scopes: "data:read" })).token;
    for (const path of paths()) {
      const viaRest = await rest(path, alice.bearer);
      expect((await tool(t, "query_data", { path })).data, path).toEqual({ status: viaRest.status, body: viaRest.body });
    }
  });
});
