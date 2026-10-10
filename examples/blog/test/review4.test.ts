/**
 * Review 4 (M4, security): the remote /mcp route through real HTTP to the blog Worker on local D1.
 */
import { assignRole } from "@castra/auth";
import { createMcpToken } from "@castra/mcp";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { authOptions } from "../src/index";

const BASE = "http://localhost";
const ACCEPT = "application/json, text/event-stream";

interface Who {
  id: string;
  bearer: string;
  cookie: string;
}

async function signUp(role?: string): Promise<Who> {
  const res = await exports.default.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: `r4-${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "R4" }),
  });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string } };
  if (role) await assignRole(env.DB, user.id, role, authOptions.roles);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { id: user.id, bearer: res.headers.get("set-auth-token")!, cookie };
}

let rpcId = 0;
async function mcp(path: string, init: { token?: string; method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: ACCEPT, ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const method = init.method ?? "POST";
  const res = await exports.default.fetch(`${BASE}${path}`, { method, headers, body: method === "POST" ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get("content-type") };
}

const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });

async function auditCount(tokenId: string) {
  return (await env.DB.prepare("SELECT count(*) AS n FROM _castra_audit WHERE token_id = ?").bind(tokenId).first<{ n: number }>())!.n;
}

let alice: Who, editor: Who;
const draft = crypto.randomUUID();

beforeAll(async () => {
  [alice, editor] = await Promise.all([signUp(), signUp("editor")]);
  await env.DB.prepare("INSERT INTO posts (id, author_id, title, body, status, internal_notes) VALUES (?, ?, 'R4 draft', 'b', 'draft', 'r4-secret-note')")
    .bind(draft, alice.id)
    .run();
});

describe("review4 blog: /mcp credentials over HTTP", () => {
  it("held: session cookie, session bearer, and token in the query string are all 401 on /mcp", async () => {
    const t = await createMcpToken(env.DB, { userId: alice.id, scopes: "data:read" });
    const body = call("query_data", { path: `/api/posts/${draft}` });
    expect((await mcp("/mcp", { headers: { cookie: alice.cookie }, body })).status).toBe(401);
    expect((await mcp("/mcp", { token: alice.bearer, body })).status).toBe(401);
    const qs = await mcp(`/mcp?token=${t.token}`, { body });
    expect(qs.status).toBe(401);
    expect(qs.text).not.toContain("R4 draft");
  });

  it("held: an MCP token never authorizes REST writes or reads (it resolves to anonymous)", async () => {
    const t = await createMcpToken(env.DB, { userId: alice.id, scopes: "schema:read access:check data:read data:read:any_user" });
    const post = await exports.default.fetch(`${BASE}/api/posts`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ title: "via mcp token", body: "x" }),
    });
    expect(post.status).toBe(401);
    const read = await exports.default.fetch(`${BASE}/api/posts/${draft}`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(read.status).toBe(404);
  });

  it("held: path variants of /mcp do not reach MCP or leak data; GET/DELETE on /mcp are 405 and audited", async () => {
    const t = await createMcpToken(env.DB, { userId: alice.id, scopes: "data:read" });
    const body = call("query_data", { path: `/api/posts/${draft}` });
    for (const p of ["/mcp/", "/MCP", "/mcp/x", "/api/mcp"]) {
      const r = await mcp(p, { token: t.token, body });
      expect(r.status, p).toBe(404);
      expect(r.text).not.toContain("R4 draft");
    }
    const before = await auditCount(t.id);
    expect((await mcp("/mcp", { token: t.token, method: "GET" })).status).toBe(405);
    expect((await mcp("/mcp", { token: t.token, method: "DELETE" })).status).toBe(405);
    expect(await auditCount(t.id)).toBe(before + 2);
  });

  it("held: a data:read token sees its own draft and its admin-only field stays hidden; other users' tokens get 404", async () => {
    const own = await createMcpToken(env.DB, { userId: alice.id, scopes: "data:read" });
    const r = await mcp("/mcp", { token: own.token, body: call("query_data", { path: `/api/posts/${draft}` }) });
    expect(r.text).toContain("R4 draft");
    expect(r.text).not.toContain("r4-secret-note");
    const other = await createMcpToken(env.DB, { userId: editor.id, scopes: "data:read" });
    const o = await mcp("/mcp", { token: other.token, body: call("query_data", { path: `/api/posts/${draft}`, as: { userId: alice.id } }) });
    expect(o.text).toContain("missing scope: data:read:any_user");
    expect(o.text).not.toContain("R4 draft");
  });

  it("held: removing a role in _castra_roles applies to the token's very next call", async () => {
    const t = await createMcpToken(env.DB, { userId: editor.id, scopes: "access:check" });
    const check = async () => {
      const r = await mcp("/mcp", { token: t.token, body: call("check_access", { table: "posts", op: "update" }) });
      return JSON.parse(r.text).result.structuredContent as { allowed: unknown; as: { roles: string[] } };
    };
    expect(await check()).toMatchObject({ allowed: true, as: { roles: ["editor"] } });
    await env.DB.prepare("DELETE FROM _castra_roles WHERE user_id = ?").bind(editor.id).run();
    try {
      expect(await check()).toMatchObject({ allowed: "conditional", as: { roles: [] } });
    } finally {
      await assignRole(env.DB, editor.id, "editor", authOptions.roles);
    }
  });

  it("held: deleting the Better Auth user revokes their MCP tokens (FK cascade)", async () => {
    const temp = await signUp();
    const t = await createMcpToken(env.DB, { userId: temp.id, scopes: "data:read" });
    expect((await mcp("/mcp", { token: t.token, body: call("query_data", { path: "/api/posts" }) })).status).toBe(200);
    await env.DB.prepare(`DELETE FROM "user" WHERE id = ?`).bind(temp.id).run();
    expect((await mcp("/mcp", { token: t.token, body: call("query_data", { path: "/api/posts" }) })).status).toBe(401);
  });
});
