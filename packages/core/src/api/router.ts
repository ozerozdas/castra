import { Hono, type Context, type Env } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Kysely } from "kysely";
import type { CastraConfig } from "../config.js";
import { createPolicyEngine, type PolicyEngine } from "../policy/engine.js";
import type { CastraContext, Operation, SchemaSnapshot } from "../types.js";
import type { D1DatabaseLike } from "../db/guarded-write.js";
import { apiModel } from "./model.js";
import { generateOpenApi, type JsonObject } from "./openapi.js";
import { parseRequest } from "./parse.js";
import { executePlan, planRequest } from "./plan.js";
import { ApiError, notFound, problemResponse, toProblem } from "./problem.js";

/** Default request body limit: 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** What `hooks.beforeRequest` learns about a table request before anything else runs. */
export interface RestRequestInfo {
  table: string;
  id: string | undefined;
  method: string;
  op: Operation | undefined;
}

/** Options of {@link createRestRouter}. */
export interface RestRouterOptions<E extends Env = Env> {
  config: CastraConfig;
  snapshot: SchemaSnapshot;
  /** Reuse an engine built for the same config + snapshot (e.g. shared with MCP). */
  engine?: PolicyEngine;
  /** Kysely over the request's D1 binding. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDb: (c: Context<E>) => Kysely<any>;
  /** The request's identity, e.g. `(c) => c.get("ctx")` after `castraContext()`. */
  getContext: (c: Context<E>) => CastraContext;
  /**
   * The D1 binding for creates and updates, e.g. `(c) => c.env.DB`: they run as one atomic
   * [write, guard] batch (ADR 0050). Without it, creates and updates fail closed (500).
   */
  getD1?: (c: Context<E>) => D1DatabaseLike;
  /** Prefix of the table routes. Default `/api`. */
  basePath?: string;
  /** Max request body in bytes (413 above). Default 1 MiB. */
  maxBodyBytes?: number;
  /** `info` of the OpenAPI document served at `/openapi.json`. */
  openapi?: { title?: string; version?: string };
  hooks?: {
    /**
     * Runs first on every table request (ADR 0003: the rate-limit hook point). Return a `Response`
     * to short-circuit (e.g. 429); return nothing to continue. No-op by default.
     */
    beforeRequest?(c: Context<E>, info: RestRequestInfo): void | Response | Promise<void | Response>;
  };
}

const OP_BY_METHOD: Record<string, (hasId: boolean) => Operation | undefined> = {
  GET: () => "read",
  POST: (hasId) => (hasId ? undefined : "create"),
  PATCH: (hasId) => (hasId ? "update" : undefined),
  DELETE: (hasId) => (hasId ? "delete" : undefined),
};

/**
 * The auto-CRUD REST router (ARCHITECTURE §4): `GET/POST {basePath}/:table`,
 * `GET/PATCH/DELETE {basePath}/:table/:id` and `GET /openapi.json`. A table × operation without a
 * policy answers exactly like an unknown table (404 problem). Every request goes
 * `parseRequest → planRequest → executePlan`, the same path MCP uses. Errors are
 * `application/problem+json` and never contain SQL, stack traces or policy explanations.
 */
export function createRestRouter<E extends Env = Env>(options: RestRouterOptions<E>): Hono<E> {
  const { config, snapshot } = options;
  const engine = options.engine ?? createPolicyEngine({ config, snapshot });
  apiModel(config, snapshot); // validate identifiers at startup
  const basePath = (options.basePath ?? "/api").replace(/\/+$/, "");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  let openapi: JsonObject | undefined;

  const app = new Hono<E>();

  app.get("/openapi.json", (c) => {
    openapi ??= generateOpenApi({ config, snapshot, engine, basePath, ...options.openapi });
    return c.json(openapi);
  });

  const limit = bodyLimit({
    maxSize: maxBodyBytes,
    onError: () => problemResponse(413, `Request body exceeds ${maxBodyBytes} bytes.`, "payload_too_large"),
  });

  const handle = async (c: Context<E>): Promise<Response> => {
    try {
      const table = c.req.param("table") ?? "";
      const id = c.req.param("id");
      const method = c.req.method.toUpperCase();
      const op = OP_BY_METHOD[method]?.(id !== undefined);
      const hookResponse = await options.hooks?.beforeRequest?.(c, { table, id, method, op });
      if (hookResponse instanceof Response) return hookResponse;
      // Closed and unknown tables answer identically, before the body or query is looked at.
      if (!op || !engine.isOpen(table, op)) throw notFound();

      let body: unknown;
      if (method === "POST" || method === "PATCH") {
        const type = c.req.header("content-type") ?? "";
        if (!/^application\/json\s*(;|$)/i.test(type)) throw new ApiError(415, "unsupported_media_type", "Request body must be application/json.");
        const text = await c.req.text();
        try {
          body = JSON.parse(text);
        } catch {
          throw new ApiError(400, "invalid_body", "Request body is not valid JSON.");
        }
      }
      const parsed = parseRequest({ method, table, id, query: new URL(c.req.url).searchParams, body });
      const plan = planRequest(engine, snapshot, config, parsed, options.getContext(c));
      const result = await executePlan(options.getDb(c), plan, { d1: options.getD1?.(c) });
      if (result.status === 204) return c.body(null, 204);
      return c.json(result.body as JsonObject, result.status);
    } catch (err) {
      const p = toProblem(err);
      if (p.status >= 500) console.error("castra: request failed", err);
      return new Response(JSON.stringify(p), { status: p.status, headers: { "content-type": "application/problem+json" } });
    }
  };

  app.get(`${basePath}/:table`, handle);
  app.post(`${basePath}/:table`, limit, handle);
  app.get(`${basePath}/:table/:id`, handle);
  app.patch(`${basePath}/:table/:id`, limit, handle);
  app.delete(`${basePath}/:table/:id`, handle);
  app.on(["PUT", "POST"], `${basePath}/:table/:id`, (c) => handle(c));
  app.on(["PUT", "PATCH", "DELETE"], `${basePath}/:table`, (c) => handle(c));

  return app;
}
