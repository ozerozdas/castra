import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPolicyEngine, problemBody, type CastraConfig, type PolicyEngine, type SchemaSnapshot } from "castra";
import { Hono, type Context, type Env } from "hono";
import { auditArguments, writeAudit, type AuditEntry } from "./audit.js";
import { mcpDb, type D1Like } from "./db.js";
import { remoteAccess } from "./identity.js";
import { createCastraMcpServer, type ToolCallRecord } from "./server.js";
import { verifyMcpToken } from "./tokens.js";

/** Max JSON-RPC body size of a remote MCP request. */
export const MCP_MAX_BODY_BYTES = 1024 * 1024;
/** Max JSON-RPC messages in one request body (a batch array). */
export const MCP_MAX_MESSAGES = 10;

/** Options of {@link handleMcpRequest}. */
export interface McpHandlerOptions {
  config: CastraConfig;
  snapshot: SchemaSnapshot;
  /** Reuse the engine of the REST router (recommended). */
  engine?: PolicyEngine;
  /** REST base path for `path` arguments. Default `/api`. */
  basePath?: string;
  /** Clock override for tests. */
  now?: () => Date;
}

/** Options of {@link createMcpRoute}. */
export interface McpRouteOptions<E extends Env = Env> extends McpHandlerOptions {
  /** The request's D1 binding, e.g. `(c) => c.env.DB`. Holds tokens, roles, audit and app data. */
  getD1: (c: Context<E>) => D1Like;
  /** Route path. Default `/mcp`. */
  path?: string;
}

function problem(status: number, detail: string, code: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(problemBody(status, detail, code)), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

interface RpcMessage {
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function auditEntriesFor(messages: RpcMessage[], records: Map<string | number, ToolCallRecord>, response: Response, who: { tokenId: string; userId: string }): AuditEntry[] {
  if (messages.length === 0) {
    return [{ token_id: who.tokenId, user_id: who.userId, tool: null, arguments: null, outcome: "rejected", status: response.status }];
  }
  return messages.map((m) => {
    const params = (m.params ?? undefined) as { name?: unknown; arguments?: unknown } | undefined;
    const isCall = m.method === "tools/call";
    const tool = isCall ? String(params?.name ?? "") : typeof m.method === "string" ? m.method : null;
    const record = m.id !== undefined && m.id !== null ? records.get(m.id) : undefined;
    let outcome: string = response.status < 400 ? "ok" : "error";
    let status = response.status;
    if (record) {
      outcome = record.outcome;
      status = record.status;
    } else if (isCall) {
      // The SDK refused the call before the tool ran (unknown tool, invalid arguments).
      outcome = "invalid";
      status = 400;
    }
    return {
      token_id: who.tokenId,
      user_id: who.userId,
      tool: tool === null ? null : tool.slice(0, 128),
      arguments: auditArguments(isCall ? params?.arguments : m.params),
      outcome,
      status,
    };
  });
}

/**
 * Handles one remote MCP request (Streamable HTTP, stateless, JSON responses; ADR 0062).
 *
 * 1. `Authorization: Bearer castra_mcp_...` is verified (format, constant-time hash, revoked,
 *    expiry). Missing / invalid → 401; API keys and sessions are never accepted here.
 * 2. Only `POST` (no SSE stream, no sessions). A fresh `McpServer` runs the shared tools with
 *    {@link remoteAccess} (token scopes, the user's current roles).
 * 3. In `finally`, one `_castra_audit` row per JSON-RPC message (or one for a rejected request, or
 *    for an auth failure whose token id is known). If the audit write fails, the response is
 *    replaced by a 500: no call is served without its audit row.
 */
export async function handleMcpRequest(request: Request, d1: D1Like, options: McpHandlerOptions): Promise<Response> {
  const db = mcpDb(d1);
  const now = options.now?.() ?? new Date();
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^bearer\s+(\S+)\s*$/i.exec(header)?.[1];
  const verified = await verifyMcpToken(db, bearer, now);
  if (!verified.ok) {
    if (verified.tokenId !== null) {
      try {
        await writeAudit(db, [{ token_id: verified.tokenId, user_id: verified.userId, tool: null, arguments: null, outcome: `unauthorized:${verified.reason}`, status: 401 }], now);
      } catch (err) {
        console.error("castra mcp: audit write failed", err);
      }
    }
    return problem(401, "A valid MCP token is required (Authorization: Bearer castra_mcp_...).", "unauthenticated", {
      "www-authenticate": 'Bearer realm="castra-mcp", error="invalid_token"',
    });
  }

  const token = verified.token;
  const who = { tokenId: token.id, userId: token.userId };
  const records = new Map<string | number, ToolCallRecord>();
  let messages: RpcMessage[] = [];
  let response: Response = problem(500, "An unexpected error occurred.", "internal");
  try {
    if (request.method !== "POST") {
      response = problem(405, "Only POST is supported (stateless Streamable HTTP).", "method_not_allowed", { allow: "POST" });
    } else {
      const text = await request.text();
      let parsed: unknown;
      let bad: Response | undefined;
      if (new TextEncoder().encode(text).length > MCP_MAX_BODY_BYTES) {
        bad = problem(413, `Request body exceeds ${MCP_MAX_BODY_BYTES} bytes.`, "payload_too_large");
      } else {
        try {
          parsed = JSON.parse(text);
        } catch {
          bad = Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, { status: 400 });
        }
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      if (!bad && list.length > MCP_MAX_MESSAGES) {
        bad = Response.json({ jsonrpc: "2.0", error: { code: -32600, message: `At most ${MCP_MAX_MESSAGES} messages per request` }, id: null }, { status: 400 });
      }
      if (bad) {
        response = bad;
      } else {
        messages = list.filter((m): m is RpcMessage => typeof m === "object" && m !== null && "method" in m);
        const engine = options.engine ?? createPolicyEngine({ config: options.config, snapshot: options.snapshot });
        const server = createCastraMcpServer({
          config: options.config,
          snapshot: options.snapshot,
          engine,
          db,
          basePath: options.basePath,
          access: remoteAccess(db, options.config, { tokenId: token.id, userId: token.userId, scopes: token.scopes }),
          onToolResult: (r) => records.set(r.requestId, r),
        });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        try {
          response = await transport.handleRequest(request, { parsedBody: parsed });
        } finally {
          await server.close();
        }
      }
    }
  } catch (err) {
    console.error("castra mcp: request failed", err);
    response = problem(500, "An unexpected error occurred.", "internal");
  } finally {
    try {
      await writeAudit(db, auditEntriesFor(messages, records, response, who), now);
    } catch (err) {
      console.error("castra mcp: audit write failed", err);
      response = problem(500, "The call could not be audited and was not served.", "audit_failed");
    }
  }
  return response;
}

/**
 * Hono sub-app serving the remote MCP endpoint at `path` (default `/mcp`). Mount it BEFORE any
 * session / API-key middleware: `/mcp` authenticates with MCP tokens only.
 *
 * ```ts
 * app.route("/", createMcpRoute({ config, snapshot, engine, getD1: (c) => c.env.DB }));
 * ```
 */
export function createMcpRoute<E extends Env = Env>(options: McpRouteOptions<E>): Hono<E> {
  const app = new Hono<E>();
  const engine = options.engine ?? createPolicyEngine({ config: options.config, snapshot: options.snapshot });
  app.all(options.path ?? "/mcp", (c) => handleMcpRequest(c.req.raw, options.getD1(c), { ...options, engine }));
  return app;
}
