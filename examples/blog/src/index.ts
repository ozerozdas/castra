import {
  authRoutes,
  castraContext,
  requireRole,
  type AuthEnv,
  type CastraAuthOptions,
  type CastraAuthVariables,
} from "@castra/auth";
import { createMcpRoute } from "@castra/mcp";
import { createPolicyEngine, createRestRouter, withProblemHandlers, type PolicyEngine, type SchemaSnapshot } from "castra";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import config from "../castra.config";
import schema from "../castra/schema.json";

export interface Env extends AuthEnv {
  DB: D1Database;
}

type AppEnv = { Bindings: Env; Variables: CastraAuthVariables };

/** Role list for the example (mirrors `roles` in castra.config.ts). */
export const authOptions: CastraAuthOptions = {
  roles: config.roles,
};

/** The committed schema snapshot (`castra generate`). */
export const snapshot = schema as unknown as SchemaSnapshot;

/** The policy engine shared by REST and MCP. */
export const engine: PolicyEngine = createPolicyEngine({ config, snapshot });

// One Kysely instance per D1 binding object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbs = new WeakMap<D1Database, Kysely<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kyselyFor(d1: D1Database): Kysely<any> {
  let db = dbs.get(d1);
  if (!db) {
    db = new Kysely({ dialect: new D1Dialect({ database: d1 }) });
    dbs.set(d1, db);
  }
  return db;
}

/** Builds the blog Worker. Tests pass their own engine; production uses {@link engine}. */
export function createApp(options: { engine?: PolicyEngine } = {}) {
  // Hono's route() does not carry notFound/onError over: set the problem+json fallbacks on the root app.
  const app = withProblemHandlers(new Hono<AppEnv>());

  app.get("/health", (c) => c.json({ ok: true }));

  // Remote MCP (read-only tools, MCP tokens only, every call audited). Mounted before the session /
  // API-key middleware: /mcp never accepts sessions or API keys.
  app.route("/", createMcpRoute<AppEnv>({ config, snapshot, engine: options.engine ?? engine, getD1: (c) => c.env.DB }));

  authRoutes(app, authOptions);
  app.use("*", castraContext(authOptions));

  app.get("/me", (c) => {
    const ctx = c.get("ctx");
    return c.json({ user: ctx.user, roles: ctx.roles, via: ctx.via });
  });

  // Demo of a role-gated custom route.
  app.get("/admin/ping", requireRole("admin"), (c) => c.json({ pong: true }));

  // Auto-CRUD + /openapi.json. Mounted after /api/auth/* so the auth handler wins on its paths.
  app.route(
    "/",
    createRestRouter<AppEnv>({
      config,
      snapshot,
      engine: options.engine ?? engine,
      getDb: (c) => kyselyFor(c.env.DB),
      getD1: (c) => c.env.DB,
      getContext: (c) => c.get("ctx"),
      openapi: { title: "Castra blog example" },
    }),
  );

  return app;
}

export default createApp();
