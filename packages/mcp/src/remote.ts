import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPolicyEngine, problemBody, type CastraConfig, type D1DatabaseLike, type PolicyEngine, type SchemaSnapshot } from "@castra-kit/core";
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

type RpcId = string | number;

/** The id of a request message, or `undefined` for a notification / `id: null`. */
function requestId(m: RpcMessage): RpcId | undefined {
  return typeof m.id === "string" || typeof m.id === "number" ? m.id : undefined;
}

/** True when two request messages of one batch share an id (JSON-RPC requires unique ids). */
function hasDuplicateIds(messages: RpcMessage[]): boolean {
  const seen = new Set<RpcId>();
  for (const m of messages) {
    const id = requestId(m);
    if (id === undefined) continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

/** HTTP-like status for a JSON-RPC error code (audit only). */
function statusForRpcError(code: unknown): number {
  if (code === -32601) return 404; // method not found
  if (code === -32700 || code === -32600 || code === -32602) return 400; // parse / invalid request / invalid params
  return 500;
}

/**
 * JSON-RPC `error` members of a JSON response, by request id. Ids are unique within a served batch
 * (duplicates are refused before any tool runs), so the map is unambiguous.
 */
async function rpcErrorsById(response: Response): Promise<Map<RpcId, { code?: unknown }>> {
  const errors = new Map<RpcId, { code?: unknown }>();
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").includes("application/json")) return errors;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return errors;
  }
  for (const r of Array.isArray(body) ? body : [body]) {
    if (typeof r !== "object" || r === null) continue;
    const { id, error } = r as { id?: unknown; error?: unknown };
    if ((typeof id === "string" || typeof id === "number") && typeof error === "object" && error !== null) {
      errors.set(id, error as { code?: unknown });
    }
  }
  return errors;
}

/**
 * One audit row per message, each with its OWN outcome:
 *
 * - `records[i]`: the tool of message `i` ran → its outcome and status.
 * - `rejectAll`: the batch was refused before anything ran (e.g. duplicate ids) → `rejected`.
 * - The transport refused the whole request (non-2xx) → the real HTTP status; `invalid` for a 400
 *   (malformed message), `rejected` otherwise (406 Accept, 415 Content-Type, ...).
 * - A `tools/call` whose tool never ran (unknown tool, invalid arguments, notification) → `invalid`.
 * - Any other message → `error` when its JSON-RPC response carries an `error` member, else `ok`.
 */
function auditEntriesFor(
  messages: RpcMessage[],
  records: (ToolCallRecord | undefined)[],
  rpcErrors: Map<RpcId, { code?: unknown }>,
  response: Response,
  who: { tokenId: string; userId: string },
  rejectAll: boolean,
): AuditEntry[] {
  if (messages.length === 0) {
    return [{ token_id: who.tokenId, user_id: who.userId, tool: null, arguments: null, outcome: "rejected", status: response.status }];
  }
  const refused = response.status >= 400;
  return messages.map((m, i) => {
    const params = (m.params ?? undefined) as { name?: unknown; arguments?: unknown } | undefined;
    const isCall = m.method === "tools/call";
    const tool = isCall ? String(params?.name ?? "") : typeof m.method === "string" ? m.method : null;
    const record = records[i];
    const id = requestId(m);
    const rpcError = id !== undefined ? rpcErrors.get(id) : undefined;
    let outcome: string;
    let status: number;
    if (record) {
      outcome = record.outcome;
      status = record.status;
    } else if (rejectAll) {
      outcome = "rejected";
      status = response.status;
    } else if (refused) {
      outcome = response.status === 400 ? "invalid" : "rejected";
      status = response.status;
    } else if (isCall) {
      // The SDK refused the call before the tool ran (unknown tool, invalid arguments, notification).
      outcome = "invalid";
      status = 400;
    } else if (rpcError) {
      outcome = "error";
      status = statusForRpcError(rpcError.code);
    } else {
      outcome = "ok";
      status = response.status;
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

/** Declared `Content-Length`, or `undefined` when absent or not a plain decimal number. */
function declaredLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/**
 * Handles one remote MCP request (Streamable HTTP, stateless, JSON responses; ADR 0062).
 *
 * 1. `Authorization: Bearer castra_mcp_...` is verified (format, constant-time hash, revoked,
 *    expiry). Missing / invalid → 401; API keys and sessions are never accepted here.
 * 2. Only `POST` (no SSE stream, no sessions). A fresh `McpServer` runs the shared tools with
 *    {@link remoteAccess} (token scopes, the user's current roles).
 *    A declared `Content-Length` over {@link MCP_MAX_BODY_BYTES} is a 413 before the body is read;
 *    the read body is checked again. A batch with duplicate request ids is refused before any tool runs.
 * 3. In `finally`, one `_castra_audit` row per JSON-RPC message, each with its own outcome and the
 *    real status (or one row for a rejected request, or for an auth failure whose token id is known).
 *    If the audit write fails, the response is replaced by a 500: no call is served without its audit row.
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
  const recordsById = new Map<RpcId, ToolCallRecord>();
  let messages: RpcMessage[] = [];
  let rejectAll = false;
  let response: Response = problem(500, "An unexpected error occurred.", "internal");
  const tooLarge = () => problem(413, `Request body exceeds ${MCP_MAX_BODY_BYTES} bytes.`, "payload_too_large");
  try {
    if (request.method !== "POST") {
      response = problem(405, "Only POST is supported (stateless Streamable HTTP).", "method_not_allowed", { allow: "POST" });
    } else if ((declaredLength(request) ?? 0) > MCP_MAX_BODY_BYTES) {
      // Refused before the body is read; the post-read check below covers a missing or lying header.
      response = tooLarge();
    } else {
      const text = await request.text();
      let parsed: unknown;
      let bad: Response | undefined;
      if (new TextEncoder().encode(text).length > MCP_MAX_BODY_BYTES) {
        bad = tooLarge();
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
      if (!bad) {
        messages = list.filter((m): m is RpcMessage => typeof m === "object" && m !== null && "method" in m);
        if (hasDuplicateIds(messages)) {
          // Refused as a whole before any tool runs: per-id results would be ambiguous (and so would the audit).
          rejectAll = true;
          bad = Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "Duplicate request ids in batch" }, id: null }, { status: 400 });
        }
      }
      if (bad) {
        response = bad;
      } else {
        const engine = options.engine ?? createPolicyEngine({ config: options.config, snapshot: options.snapshot });
        const server = createCastraMcpServer({
          config: options.config,
          snapshot: options.snapshot,
          engine,
          db,
          d1: d1 as unknown as D1DatabaseLike,
          basePath: options.basePath,
          access: remoteAccess(db, options.config, { tokenId: token.id, userId: token.userId, scopes: token.scopes }),
          onToolResult: (r) => recordsById.set(r.requestId, r),
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
      const records = messages.map((m) => {
        const id = requestId(m);
        return id === undefined ? undefined : recordsById.get(id);
      });
      const rpcErrors = rejectAll ? new Map<RpcId, { code?: unknown }>() : await rpcErrorsById(response);
      await writeAudit(db, auditEntriesFor(messages, records, rpcErrors, response, who, rejectAll), now);
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
